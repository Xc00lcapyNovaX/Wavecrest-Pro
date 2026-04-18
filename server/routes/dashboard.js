/**
 * Dashboard routes — saved trends, alerts, exports, BYOAK
 */
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
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

    // Determine what's locked
    const isFreePlan = user.plan === 'free';
    const isPlusPlan = user.plan === 'plus';
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
      },
      subscription: sub ? {
        plan: sub.plan, status: sub.status,
        period_end: sub.current_period_end, trial_end: sub.trial_end,
      } : null,
      usage: { remaining, limit, plan: user.plan },
      trends: { date: displayDate, total, items: visibleTrends, locked_count: lockedCount },
      features: {
        niche_search: ['pro', 'max', 'teams', 'enterprise'].includes(user.plan),
        export_csv: user.plan !== 'free',
        api_access: ['max', 'teams', 'enterprise'].includes(user.plan),
        alerts: user.plan !== 'free',
        history_days: { free: 0, plus: 7, pro: 30, max: 90, teams: 90, enterprise: -1 }[user.plan] || 0,
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
    if (!user || user.plan === 'free') {
      return res.status(403).json({ error: 'CSV export requires Plus plan or higher.' });
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

// ── BYOAK routes ───────────────────────────────────
router.get('/api-keys', requireAuth, async (req, res) => {
  try {
    const keys = await db.getApiKeys(req.session.userId);
    const masked = keys.map((k) => ({
      id: k.id, service: k.service,
      key_preview: k.api_key.slice(0, 8) + '••••••••',
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

module.exports = router;
