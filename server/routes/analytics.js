/**
 * Analytics routes — velocity, platform breakdown, top trends, stats
 * Pro/Max/Teams/Enterprise only.
 */
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const router = express.Router();

const PRO_PLANS = ['pro', 'max', 'teams', 'enterprise'];

async function requirePro(req, res, next) {
  try {
    const user = await db.findUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    if (!PRO_PLANS.includes(user.plan)) {
      return res.status(403).json({
        error: 'Analytics requires Pro plan or higher.',
        current_plan: user.plan,
        upgrade_url: '/checkout-pro.html',
      });
    }
    req.user = user;
    next();
  } catch (err) { next(err); }
}

// Ensure in-memory cache is populated (critical for serverless cold starts)
async function ensureCache() {
  await db.ensureCacheWarmed();
}

// ── GET /api/analytics/velocity ─────────────────────────────────────────────
router.get('/velocity', requireAuth, requirePro, async (req, res) => {
  try {
    await ensureCache();
    const numDays = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);

    // Build a day-by-day array
    const days = [];
    for (let i = numDays - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const count = db.trends.filter(t => t.fetched_at === dateStr).length;
      days.push({ date: dateStr, count });
    }

    const counts = days.map(d => d.count);
    const nonZero = counts.filter(c => c > 0);
    const average = nonZero.length
      ? +(nonZero.reduce((a, b) => a + b, 0) / nonZero.length).toFixed(1)
      : 0;

    const synthetic = !db.trends.some(t => {
      const today = new Date().toISOString().slice(0, 10);
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      return t.fetched_at >= weekAgo && t.fetched_at <= today && t.fetched_at !== today;
    });

    res.json({ days, average, synthetic, numDays });
  } catch (err) {
    console.error('[Analytics/velocity]', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/analytics/platforms ────────────────────────────────────────────
router.get('/platforms', requireAuth, requirePro, async (req, res) => {
  try {
    await ensureCache();

    // Use last available date's data
    const dates = [...new Set(db.trends.map(t => t.fetched_at))].sort().reverse();
    const targetDate = dates[0] || new Date().toISOString().slice(0, 10);
    const todayTrends = db.trends.filter(t => t.fetched_at === targetDate);

    const counts = {};
    todayTrends.forEach(t => {
      counts[t.platform] = (counts[t.platform] || 0) + 1;
    });

    const total = todayTrends.length || 1;
    const platforms = Object.entries(counts)
      .map(([name, count]) => ({
        name,
        count,
        percent: Math.round((count / total) * 100),
      }))
      .sort((a, b) => b.count - a.count);

    res.json({ date: targetDate, total: todayTrends.length, platforms });
  } catch (err) {
    console.error('[Analytics/platforms]', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/analytics/top-trends ───────────────────────────────────────────
router.get('/top-trends', requireAuth, requirePro, async (req, res) => {
  try {
    await ensureCache();
    const numDays = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const since = new Date();
    since.setDate(since.getDate() - numDays);
    const sinceStr = since.toISOString().slice(0, 10);

    const pool = db.trends.filter(t => t.fetched_at >= sinceStr);

    // Count occurrences per topic
    const topicMap = {};
    pool.forEach(t => {
      const key = t.topic.toLowerCase();
      if (!topicMap[key]) {
        topicMap[key] = { topic: t.topic, score: t.score, platform: t.platform, count: 0 };
      }
      topicMap[key].count++;
      const scoreOrder = { hot: 0, rising: 1, warm: 2 };
      if ((scoreOrder[t.score] || 3) < (scoreOrder[topicMap[key].score] || 3)) {
        topicMap[key].score = t.score;
      }
    });

    const all = Object.values(topicMap);
    const byScore = (score) => all
      .filter(t => t.score === score)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(t => ({ topic: t.topic, platform: t.platform, count: t.count }));

    const groups = [
      { label: 'Hot', items: byScore('hot') },
      { label: 'Rising', items: byScore('rising') },
      { label: 'Warm', items: byScore('warm') },
    ].filter(g => g.items.length > 0);

    res.json({ numDays, groups });
  } catch (err) {
    console.error('[Analytics/top-trends]', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/analytics/stats ─────────────────────────────────────────────────
router.get('/stats', requireAuth, requirePro, async (req, res) => {
  try {
    await ensureCache();

    const dates = [...new Set(db.trends.map(t => t.fetched_at))].sort().reverse();
    const uniqueDays = dates.length || 1;
    const totalTrends = db.trends.length;
    const avgVelocity = +(totalTrends / uniqueDays).toFixed(1);

    // Top platform
    const platformCounts = {};
    db.trends.forEach(t => {
      platformCounts[t.platform] = (platformCounts[t.platform] || 0) + 1;
    });
    const topEntry = Object.entries(platformCounts).sort((a, b) => b[1] - a[1])[0];
    const topPlatform = topEntry
      ? { name: topEntry[0], count: topEntry[1], percentage: Math.round((topEntry[1] / totalTrends) * 100) }
      : null;

    // User search count
    const user = req.user;
    const { rows: usageRows } = await db.pool.query(
      `SELECT COUNT(*) AS cnt FROM usage_log WHERE user_id = $1 AND endpoint = '/api/trends/search'`,
      [user.id]
    );
    const userSearches = parseInt(usageRows[0].cnt, 10);

    res.json({
      week_total: totalTrends,
      avg_velocity: avgVelocity,
      unique_days: uniqueDays,
      top_platform: topPlatform,
      user_searches: userSearches,
      dates_available: dates.slice(0, 10),
    });
  } catch (err) {
    console.error('[Analytics/stats]', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
