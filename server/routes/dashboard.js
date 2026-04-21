/**
 * Dashboard routes — saved trends, alerts, exports, BYOAK
 */
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const { getCurrentTier, PLAN_RANK } = require('../middleware/gatekeeper');
const { assertNumericId } = require('../middleware/validate');
const router = express.Router();

// ── GET /api/dashboard — main dashboard data ──────
router.get('/', requireAuth, async (req, res) => {
  try {
    const user = await db.findUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });

    const today = new Date().toISOString().slice(0, 10);
    let { trends, total } = await db.getTrends({ date: today, limit: 30 });

    // Fall back to most recent date with data if today has none
    let displayDate = today;
    if (total === 0 && db.trends.length > 0) {
      const dates = [...new Set(db.trends.map(t => t.fetched_at))].sort().reverse();
      if (dates.length > 0) {
        displayDate = dates[0];
        ({ trends, total } = await db.getTrends({ date: displayDate, limit: 30 }));
      }
    }
    const sub = await db.findSubscription(user.id);
    const { remaining, limit } = await db.checkRateLimit(user.id, user.plan);

    // ── Trial progression via gatekeeper engine ────────────────────────
    // Use user.created_at as the authoritative join date for authenticated users.
    // Falls back to cookie-based gatekeeper tier if created_at is unavailable.
    const joinDate   = user.created_at || new Date().toISOString();
    const tierInfo   = getCurrentTier(joinDate) || { tier: 'free', day: 1 };
    const planRank   = (p) => PLAN_RANK[p] ?? 0;

    // Effective plan = highest of: paid plan, trial/rotation tier
    const trialPlan    = tierInfo.tier;
    const effectivePlan = planRank(user.plan) >= planRank(trialPlan) ? user.plan : trialPlan;
    const trialActive   = planRank(trialPlan) > planRank(user.plan);

    // Determine what's locked based on effectivePlan
    const isFreePlan = effectivePlan === 'free';
    const isPlusPlan = effectivePlan === 'plus';
    const lockedCount = isFreePlan ? Math.floor(trends.length * 0.3) : (isPlusPlan ? Math.floor(trends.length * 0.15) : 0);

    const visibleTrends = trends.map((t, i) => {
      if (i >= trends.length - lockedCount) {
        return { ...t, locked: true, topic: '🔒 Upgrade to unlock', score: 'locked' };
      }
      return { ...t, locked: false };
    });

    res.json({
      user: {
        id: user.id, name: user.name, email: user.email,
        plan: user.plan, avatar_url: user.avatar_url,
        effective_plan: effectivePlan,
        trial_day: tierInfo.day,      // 1-indexed
        trial_plan: trialPlan,
        trial_phase: tierInfo.phase,  // 'staircase' | 'rotation'
        trial_week: tierInfo.week,    // rotation week (null during staircase)
        trial_active: trialActive,
        trial_expired: tierInfo.trialExpired,
        is_beta: user.is_beta || false,
        email_verified: user.email_verified || false,
        digest_enabled: user.digest_enabled !== false,
        discord_connected: !!user.discord_webhook_url,
        discord_webhook_preview: user.discord_webhook_url || null,
      },
      subscription: sub ? {
        plan: sub.plan, status: sub.status,
        period_end: sub.current_period_end, trial_end: sub.trial_end,
      } : null,
      usage: { remaining, limit, plan: effectivePlan },
      trends: { date: displayDate, total, items: visibleTrends, locked_count: lockedCount },
      features: {
        niche_search: ['pro', 'max', 'teams', 'enterprise'].includes(effectivePlan),
        export_csv: effectivePlan !== 'free',
        api_access: ['max', 'teams', 'enterprise'].includes(effectivePlan),
        alerts: effectivePlan !== 'free',
        history_days: { free: 0, plus: 7, pro: 30, max: 90, teams: 90, enterprise: -1 }[effectivePlan] || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/dashboard/export — CSV export ─────────
router.get('/export', requireAuth, async (req, res) => {
  try {
    const user = await db.findUserById(req.session.userId);
    const CSV_PLANS = ['plus', 'pro', 'max', 'teams', 'enterprise'];
    if (!user || !CSV_PLANS.includes(user.plan)) {
      return res.status(403).json({ error: 'CSV export requires a Plus plan or higher.' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const { platform, score, date } = req.query;
    const { trends } = await db.getTrends({
      date: date || today,
      platform: platform || undefined,
      score: score || undefined,
      limit: 500,
    });

    function csvSafe(str) {
      let s = String(str).replace(/"/g, '""');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s + '"';
    }

    const csv = ['Topic,Score,Platform,Date']
      .concat(trends.map((t) => `${csvSafe(t.topic)},${csvSafe(t.score)},${csvSafe(t.platform)},${csvSafe(t.fetched_at)}`))
      .join('\n');

    const exportDate = date || today;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="wavecrest-trends-${exportDate}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Saved Trends (Bookmarks) ───────────────────────
router.get('/saved', requireAuth, async (req, res) => {
  try {
    const saved = await db.getSavedTrends(req.session.userId);
    res.json({ saved });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/saved', requireAuth, async (req, res) => {
  try {
    const { trend_id, topic, platform, score } = req.body;
    if (!trend_id || !topic) {
      return res.status(400).json({ error: 'trend_id and topic required.' });
    }
    const idErr = assertNumericId(trend_id, 'trend_id');
    if (idErr) return res.status(400).json({ error: idErr });
    const saved = await db.saveTrend(req.session.userId, {
      trendId: trend_id, topic, platform, score,
    });
    if (!saved) {
      // Already saved — return the existing record
      const existing = await db.isTrendSaved(req.session.userId, trend_id);
      return res.json({ saved: existing, already_saved: true });
    }
    res.status(201).json({ saved });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.delete('/saved/:id', requireAuth, async (req, res) => {
  try {
    const deleted = await db.unsaveTrend(req.session.userId, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Saved trend not found.' });
    res.json({ message: 'Removed from saved.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Discord Webhook ────────────────────────────────
router.post('/discord-webhook', requireAuth, async (req, res) => {
  try {
    const { url } = req.body;
    const DISCORD_WEBHOOK_RE = /^https:\/\/discord\.com\/api\/webhooks\/\d+\/[\w-]+$/;
    if (url && !DISCORD_WEBHOOK_RE.test(url)) {
      return res.status(400).json({ error: 'Invalid Discord webhook URL.' });
    }
    await db.setDiscordWebhook(req.session.userId, url || null);
    res.json({ message: url ? 'Webhook saved.' : 'Webhook removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/discord-webhook/test', requireAuth, async (req, res) => {
  try {
    const user = await db.findUserById(req.session.userId);
    if (!user?.discord_webhook_url) return res.status(400).json({ error: 'No webhook URL saved.' });
    await sendDiscordMessage(user.discord_webhook_url, {
      embeds: [{
        title: '🌊 Wavecrest Pro — Test Notification',
        description: 'Your Discord webhook is connected! You\'ll receive daily trend alerts here every morning.',
        color: 0x0071e3,
        footer: { text: 'Wavecrest Pro · wavecrest.pro' },
        timestamp: new Date().toISOString(),
      }]
    });
    res.json({ message: 'Test message sent!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send test message. Check your webhook URL.' });
  }
});

async function sendDiscordMessage(webhookUrl, payload) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i - 1)));
    try {
      const r = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) return;
      const text = await r.text();
      lastErr = new Error(`Discord error ${r.status}: ${text}`);
      if (r.status === 400 || r.status === 404) break;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ── BYOAK routes ───────────────────────────────────
router.get('/api-keys', requireAuth, async (req, res) => {
  try {
    const keys = await db.getApiKeys(req.session.userId);
    const masked = keys.map((k) => ({
      id: k.id, service: k.service,
      key_preview: (k.key_prefix || '') + '••••••••',
      created_at: k.created_at,
    }));
    res.json({ keys: masked });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/api-keys', requireAuth, async (req, res) => {
  try {
    const { service, api_key } = req.body;
    if (!service || !api_key) {
      return res.status(400).json({ error: 'Service name and API key required.' });
    }

    const allowed = ['google_trends', 'youtube', 'tiktok'];
    if (!allowed.includes(service)) {
      return res.status(400).json({ error: `Service must be one of: ${allowed.join(', ')}` });
    }

    await db.saveApiKey(req.session.userId, service, api_key);
    res.json({
      message: `API key saved for ${service}.`,
      key_preview: api_key.slice(0, 8) + '••••••••',
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.delete('/api-keys/:id', requireAuth, async (req, res) => {
  try {
    const deleted = await db.deleteApiKey(req.params.id, req.session.userId);
    if (!deleted) return res.status(404).json({ error: 'Key not found.' });
    res.json({ message: 'API key deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── User API Key management ────────────────────────
router.get('/my-api-key', requireAuth, async (req, res) => {
  try {
    const key = await db.getUserApiKey(req.session.userId);
    res.json({ key: key ? { prefix: key.key_prefix, label: key.label, created_at: key.created_at, last_used: key.last_used } : null });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/my-api-key', requireAuth, async (req, res) => {
  try {
    const user = await db.findUserById(req.session.userId);
    if (!['plus','pro','max','teams','enterprise'].includes(user?.plan)) {
      return res.status(403).json({ error: 'API key access requires Plus plan or higher.' });
    }
    const result = await db.createUserApiKey(req.session.userId, req.body.label);
    res.json({
      message: 'API key created. Save this — it will not be shown again.',
      key: result.raw_key,
      prefix: result.key_prefix,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.delete('/my-api-key', requireAuth, async (req, res) => {
  try {
    await db.deleteUserApiKey(req.session.userId);
    res.json({ message: 'API key revoked.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
