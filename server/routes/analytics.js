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
  } catch (err) {
    next(err);
  }
}

// Helper: get all unique dates in trend data, sorted desc
function getAvailableDates() {
  const dates = [...new Set(db.trends.map(t => t.fetched_at))].sort().reverse();
  return dates;
}

// Helper: generate synthetic history if we only have 1 day of data
function generateSyntheticHistory(realDate, days) {
  const result = [];
  const realTrends = db.trends.filter(t => t.fetched_at === realDate);
  const baseCount = realTrends.length;

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    if (dateStr === realDate) {
      result.push({ date: dateStr, count: baseCount });
    } else {
      // Vary ±30% from base for realistic look
      const variance = 0.7 + Math.random() * 0.6;
      result.push({ date: dateStr, count: Math.round(baseCount * variance) });
    }
  }
  return result;
}

// ── GET /api/analytics/velocity ────────────────────
router.get('/velocity', requireAuth, requirePro, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
  const availDates = getAvailableDates();

  let history;
  if (availDates.length < 2) {
    // Synthetic data so the chart isn't empty
    history = generateSyntheticHistory(availDates[0] || new Date().toISOString().slice(0, 10), days);
  } else {
    history = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const count = db.trends.filter(t => t.fetched_at === dateStr).length;
      history.push({ date: dateStr, count });
    }
  }

  const counts = history.map(h => h.count);
  const avg = counts.length ? +(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1) : 0;

  res.json({
    days,
    dates: history.map(h => h.date),
    counts,
    avg,
    synthetic: availDates.length < 2,
  });
});

// ── GET /api/analytics/platforms ───────────────────
router.get('/platforms', requireAuth, requirePro, (req, res) => {
  const availDates = getAvailableDates();
  const targetDate = availDates[0] || new Date().toISOString().slice(0, 10);
  const todayTrends = db.trends.filter(t => t.fetched_at === targetDate);

  const platforms = {};
  todayTrends.forEach(t => {
    platforms[t.platform] = (platforms[t.platform] || 0) + 1;
  });

  const total = todayTrends.length || 1;
  const breakdown = {};
  Object.entries(platforms).forEach(([p, count]) => {
    breakdown[p] = { count, percent: Math.round((count / total) * 100) };
  });

  res.json({ date: targetDate, total: todayTrends.length, platforms: breakdown });
});

// ── GET /api/analytics/top-trends ─────────────────
router.get('/top-trends', requireAuth, requirePro, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);

  // Get all trends in range (or all if only 1 day)
  const availDates = getAvailableDates();
  let pool;
  if (availDates.length < 2) {
    pool = [...db.trends];
  } else {
    pool = db.trends.filter(t => t.fetched_at >= sinceStr);
  }

  // Count occurrences per topic
  const topicMap = {};
  pool.forEach(t => {
    const key = t.topic.toLowerCase();
    if (!topicMap[key]) topicMap[key] = { topic: t.topic, score: t.score, platform: t.platform, count: 0 };
    topicMap[key].count++;
    // Keep the most "intense" score
    const scoreOrder = { hot: 0, rising: 1, warm: 2 };
    if ((scoreOrder[t.score] || 3) < (scoreOrder[topicMap[key].score] || 3)) {
      topicMap[key].score = t.score;
    }
  });

  const all = Object.values(topicMap);
  const byScore = (score) => all.filter(t => t.score === score)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(t => ({ topic: t.topic, platform: t.platform, count: t.count }));

  res.json({
    days,
    hot: byScore('hot'),
    rising: byScore('rising'),
    warm: byScore('warm'),
  });
});

// ── GET /api/analytics/stats ──────────────────────
router.get('/stats', requireAuth, requirePro, async (req, res) => {
  try {
    const availDates = getAvailableDates();
    const totalTrends = db.trends.length;
    const uniqueDays = availDates.length || 1;
    const avgVelocity = +(totalTrends / uniqueDays).toFixed(1);

    // Top platform
    const platformCounts = {};
    db.trends.forEach(t => {
      platformCounts[t.platform] = (platformCounts[t.platform] || 0) + 1;
    });
    const topPlatform = Object.entries(platformCounts)
      .sort((a, b) => b[1] - a[1])[0];

    // User's search count (query from DB)
    const user = req.user;
    const { rows: usageRows } = await db.pool.query(
      `SELECT COUNT(*) AS cnt FROM usage_log WHERE user_id = $1 AND endpoint = '/api/trends/search'`,
      [user.id]
    );
    const searchCount = parseInt(usageRows[0].cnt, 10);

    res.json({
      week_total: totalTrends,
      avg_velocity: avgVelocity,
      unique_days: uniqueDays,
      top_platform: topPlatform ? { name: topPlatform[0], count: topPlatform[1] } : null,
      search_count: searchCount,
      dates_available: availDates,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
