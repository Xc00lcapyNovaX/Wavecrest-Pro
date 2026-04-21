/**
 * Feedback & Voting routes
 *
 * POST /api/feedback/vote          — hot/cold vote on a trend
 * POST /api/feedback/submit        — bug / feature request submission
 * GET  /api/feedback               — admin: list all feedback
 */
const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const makeRateLimit = require('../middleware/inMemoryRateLimit');
const { assertPageUrl, assertNumericId } = require('../middleware/validate');
const router  = express.Router();

const feedbackRateLimit = makeRateLimit({ max: 5, windowMs: 60 * 60 * 1000, message: 'Too many feedback submissions. Try again in an hour.' });

// ── Discord embed helper ──────────────────────────────
async function sendAdminEmbed(payload) {
  const url = process.env.DISCORD_ADMIN_WEBHOOK;
  if (!url) return;
  let lastErr;
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i - 1)));
    try {
      const r = await fetch(url, {
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
  if (lastErr) console.warn('[Discord admin webhook] failed after retries:', lastErr.message);
}

const TYPE_COLOR  = { bug: 0xff453a, feature: 0x2997ff, other: 0x86868b };
const TYPE_EMOJI  = { bug: '🐛', feature: '✨', other: '💭' };
const TYPE_LABEL  = { bug: 'Bug Report', feature: 'Feature Request', other: 'Other' };

// ── POST /api/feedback/vote ───────────────────────────
router.post('/vote', requireAuth, async (req, res) => {
  try {
    const { trend_id, topic, vote } = req.body;

    if (!trend_id || !vote || !['hot', 'cold'].includes(vote)) {
      return res.status(400).json({ error: 'trend_id and vote (hot|cold) required.' });
    }
    const idErr = assertNumericId(trend_id, 'trend_id');
    if (idErr) return res.status(400).json({ error: idErr });

    const result = await db.castVote(req.session.userId, trend_id, topic || '', vote);
    res.json(result);
  } catch (err) {
    console.error('[vote]', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/feedback/votes?trend_ids=1,2,3 ──────────
// Called on dashboard load to pre-populate vote counts
router.get('/votes', requireAuth, async (req, res) => {
  try {
    const ids = (req.query.trend_ids || '')
      .split(',')
      .map(x => parseInt(x, 10))
      .filter(n => !isNaN(n));

    if (!ids.length) return res.json({ votes: {} });
    const votes = await db.getVoteCountsBatch(ids, req.session.userId);
    res.json({ votes });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /api/feedback/submit ─────────────────────────
router.post('/submit', feedbackRateLimit, async (req, res) => {
  try {
    const { type, title, body, page_url } = req.body;

    const urlErr = assertPageUrl(page_url);
    if (urlErr) return res.status(400).json({ error: urlErr });

    if (!type || !['bug', 'feature', 'other'].includes(type)) {
      return res.status(400).json({ error: 'type must be bug, feature, or other.' });
    }
    if (!title || title.trim().length < 3) {
      return res.status(400).json({ error: 'Title must be at least 3 characters.' });
    }
    if (title.trim().length > 200) {
      return res.status(400).json({ error: 'Title too long (200 chars max).' });
    }

    // Grab user info if authenticated
    const userId    = req.session?.userId || null;
    const visitorId = req.betaVisitorId   || null;
    const userAgent = req.headers['user-agent'] || '';

    const record = await db.saveFeedback({
      userId, visitorId, type,
      title:     title.trim(),
      body:      (body || '').trim().slice(0, 2000),
      pageUrl:   page_url || '',
      userAgent: userAgent.slice(0, 300),
    });

    // Send Discord embed to admin webhook
    let user = null;
    if (userId) {
      try { user = await db.findUserById(userId); } catch {}
    }

    await sendAdminEmbed({
      embeds: [{
        title:       `${TYPE_EMOJI[type]} ${TYPE_LABEL[type]}: ${title.trim().slice(0, 80)}`,
        description: body?.trim() ? body.trim().slice(0, 1000) : '*No description provided.*',
        color:       TYPE_COLOR[type] || 0x86868b,
        fields: [
          { name: 'Type',    value: TYPE_LABEL[type],           inline: true },
          { name: 'User',    value: user ? `${user.name || user.email} (${user.plan})` : `Anonymous · ${visitorId?.slice(0,8) || 'unknown'}`, inline: true },
          { name: 'Page',    value: page_url ? `[link](${page_url})` : 'Unknown', inline: true },
        ],
        footer:    { text: `Wavecrest Pro Feedback · ID: ${record.id.slice(0, 8)}` },
        timestamp: new Date().toISOString(),
      }],
    });

    res.status(201).json({ message: 'Feedback submitted. Thank you!', id: record.id });
  } catch (err) {
    console.error('[feedback/submit]', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/feedback — admin only ────────────────────
router.get('/', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  try {
    const { type, status, limit, offset } = req.query;
    const items = await db.getFeedback({
      type: type || undefined,
      status: status || undefined,
      limit:  Math.min(parseInt(limit  || 50, 10), 200),
      offset: parseInt(offset || 0, 10),
    });
    res.json({ items, count: items.length });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
