/**
 * Wavecrest Pro — Public API v1
 * Authenticated via Bearer token (user API key).
 * Rate limits match the user's plan.
 * Mount at /api/v1
 */
const express = require('express');
const db = require('../db');
const router = express.Router();

const PLAN_LIMITS = { free: 0, plus: 100, pro: 1000, max: -1, teams: -1, enterprise: -1 };

async function requireApiKey(req, res, next) {
  const auth = req.headers.authorization || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : req.query.api_key;
  if (!key) {
    return res.status(401).json({
      error: 'API key required. Pass as Authorization: Bearer <key> header or ?api_key= param.',
      docs: 'https://wavecrest.pro/api-docs',
    });
  }
  const user = await db.findUserByApiKey(key);
  if (!user) return res.status(401).json({ error: 'Invalid API key.' });

  const limit = PLAN_LIMITS[user.plan] ?? 0;
  if (limit === 0) {
    return res.status(403).json({
      error: 'API access requires Plus plan or higher.',
      upgrade_url: 'https://wavecrest.pro/checkout?plan=plus',
    });
  }

  const { allowed, remaining, used } = await db.checkRateLimit(user.id, user.plan);
  res.set('X-RateLimit-Limit',     limit === -1 ? 'unlimited' : String(limit));
  res.set('X-RateLimit-Remaining', String(remaining));

  if (!allowed) {
    return res.status(429).json({
      error: 'Daily API rate limit exceeded.',
      plan: user.plan,
      limit,
      used,
      upgrade_url: 'https://wavecrest.pro/checkout?plan=pro',
    });
  }

  req.apiUser = user;
  req.apiLimit = limit;
  next();
}

// ── GET /api/v1/trends ─────────────────────────────
router.get('/trends', requireApiKey, async (req, res) => {
  try {
    const { date, platform, score, limit = '30', offset = '0' } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const parsedLimit = Math.max(1, Math.min(parseInt(limit, 10) || 30, 100));
    const parsedOffset = Math.max(0, Math.min(parseInt(offset, 10) || 0, 10000));

    let result = await db.getTrends({
      date: date || today,
      platform: platform || undefined,
      score: score || undefined,
      limit: parsedLimit,
      offset: parsedOffset,
    });

    // Fall back to most recent date if no results
    if (result.total === 0 && !date && db.trends.length > 0) {
      const dates = [...new Set(db.trends.map(t => t.fetched_at))].sort().reverse();
      if (dates.length) {
        result = await db.getTrends({ date: dates[0], platform: platform || undefined, score: score || undefined, limit: parsedLimit, offset: parsedOffset });
      }
    }

    await db.logUsage(req.apiUser.id, '/api/v1/trends');

    res.set('X-Plan', req.apiUser.plan);
    res.set('X-RateLimit-Limit', req.apiLimit === -1 ? 'unlimited' : String(req.apiLimit));
    res.json({
      date: date || today,
      total: result.total,
      limit: parsedLimit,
      offset: parsedOffset,
      trends: result.trends,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/v1/trends/search ──────────────────────
router.get('/trends/search', requireApiKey, async (req, res) => {
  try {
    const { q, platform, limit = '20' } = req.query;
    if (!q || q.trim().length < 2)  return res.status(400).json({ error: 'Query must be at least 2 characters.' });
    if (q.trim().length > 200)       return res.status(400).json({ error: 'Query too long (max 200 characters).' });
    if (!['pro', 'max', 'teams', 'enterprise'].includes(req.apiUser.plan)) {
      return res.status(403).json({ error: 'Search requires Pro plan or higher.' });
    }
    await db.logUsage(req.apiUser.id, '/api/v1/trends/search');
    const results = await db.searchTrends(q.trim(), { platform: platform || undefined, limit: Math.min(parseInt(limit) || 20, 50) });
    res.json({ query: q.trim(), count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/v1/usage ──────────────────────────────
router.get('/usage', requireApiKey, async (req, res) => {
  try {
    const { remaining, limit, used } = await db.checkRateLimit(req.apiUser.id, req.apiUser.plan);
    res.json({ plan: req.apiUser.plan, limit, used, remaining });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
