/**
 * Trend routes — list, search, and daily data
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const rateLimiter = require('../middleware/rateLimiter');
const router = express.Router();

// ── GET /api/trends — list today's trends ──────────
router.get('/', requireAuth, rateLimiter, async (req, res) => {
  try {
    const { date, platform, score, limit = '30', offset = '0' } = req.query;
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const parsedLimit = Math.max(1, Math.min(parseInt(limit, 10) || 30, 100));
    const parsedOffset = Math.max(0, parseInt(offset, 10) || 0);

    let result = await db.getTrends({
      date: targetDate,
      platform: platform || undefined,
      score: score || undefined,
      limit: parsedLimit,
      offset: parsedOffset,
    });

    // Fall back to most recent date if no results for requested date
    if (result.total === 0 && !date && db.trends.length > 0) {
      const dates = [...new Set(db.trends.map(t => t.fetched_at))].sort().reverse();
      if (dates.length > 0) {
        result = await db.getTrends({
          date: dates[0], platform: platform || undefined,
          score: score || undefined, limit: parsedLimit, offset: parsedOffset,
        });
        return res.json({ date: dates[0], ...result, user_plan: req.user.plan });
      }
    }

    res.json({ date: targetDate, ...result, user_plan: req.user.plan });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/trends/search — niche search (Pro+) ──
router.get('/search', requireAuth, async (req, res) => {
  try {
    const user = await db.findUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'User not found.' });
    const proPlanRequired = ['pro', 'max', 'teams', 'enterprise'];

    if (!proPlanRequired.includes(user.plan)) {
      return res.status(403).json({
        error: 'Niche search requires Pro plan or higher.',
        current_plan: user.plan,
        upgrade_url: '/checkout-pro.html',
      });
    }

    const { q, platform } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters.' });
    }

    await db.logUsage(user.id, '/api/trends/search');
    const results = await db.searchTrends(q.trim(), { platform: platform || undefined });

    res.json({
      query: q.trim(),
      platform: platform || 'all',
      count: results.length,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/trends/history — trend history ────────
router.get('/history', requireAuth, rateLimiter, (req, res) => {
  const { topic, days = 7 } = req.query;
  if (!topic) return res.status(400).json({ error: 'Topic parameter required.' });

  const d = Math.min(parseInt(days) || 7, 90);
  const since = new Date();
  since.setDate(since.getDate() - d);
  const sinceStr = since.toISOString().slice(0, 10);

  const q = topic.toLowerCase();
  const results = db.trends
    .filter((t) => t.topic.toLowerCase().includes(q) && t.fetched_at >= sinceStr)
    .sort((a, b) => a.fetched_at.localeCompare(b.fetched_at));

  // Group by date
  const history = {};
  results.forEach((t) => {
    if (!history[t.fetched_at]) history[t.fetched_at] = [];
    history[t.fetched_at].push({ topic: t.topic, score: t.score, platform: t.platform });
  });

  res.json({ topic, days: d, history });
});

// ── GET /api/trends/platforms — platform breakdown ─
router.get('/platforms', requireAuth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const todayTrends = db.trends.filter((t) => t.fetched_at === today);

  const platforms = {};
  todayTrends.forEach((t) => {
    if (!platforms[t.platform]) platforms[t.platform] = { hot: 0, rising: 0, warm: 0, total: 0 };
    platforms[t.platform][t.score] = (platforms[t.platform][t.score] || 0) + 1;
    platforms[t.platform].total++;
  });

  res.json({ date: today, platforms });
});

// ── Seed trends from trends.json — call explicitly from index.js ──
async function seedTrendsFromFile() {
  const trendsPath = path.join(__dirname, '..', '..', 'trends.json');
  try {
    const data = JSON.parse(fs.readFileSync(trendsPath, 'utf-8'));
    if (data && data.trends && data.trends.length) {
      await db.addTrends(data.trends, data.date);
      console.log(`  ✓ Seeded ${data.trends.length} trends from trends.json (${data.date})`);
    }
  } catch (err) {
    console.log('  ⚠ No trends.json found — run update-trends.py to generate');
  }
}

router.seedTrendsFromFile = seedTrendsFromFile;
module.exports = router;
