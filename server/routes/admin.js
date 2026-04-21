/**
 * Wavecrest Pro — Admin routes
 * Protected by ADMIN_SECRET header or query param.
 * Mount at /api/admin
 */
const express = require('express');
const db = require('../db');
const router = express.Router();

function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  const ip     = req.ip || req.connection?.remoteAddress || 'unknown';
  const route  = `${req.method} ${req.path}`;

  if (!secret) {
    console.warn(`[Admin] ${route} from ${ip} — ADMIN_SECRET not configured`);
    return res.status(503).json({ error: 'Admin access not configured. Set ADMIN_SECRET env var.' });
  }
  const provided = req.headers['x-admin-secret'];
  if (provided !== secret) {
    console.warn(`[Admin] Unauthorized attempt: ${route} from ${ip}`);
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  console.log(`[Admin] Access granted: ${route} from ${ip}`);
  next();
}

// ── GET /api/admin/stats ───────────────────────────
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const [users, plans, betaCount, dau, trends, recentSignups] = await Promise.all([
      // Total users
      db.pool.query(`SELECT COUNT(*) AS total FROM users`),
      // Users by plan
      db.pool.query(`SELECT plan, COUNT(*) AS count FROM users GROUP BY plan ORDER BY count DESC`),
      // True beta user count
      db.pool.query(`SELECT COUNT(*) AS total FROM users WHERE is_beta = true`),
      // DAU (distinct users who logged usage today)
      db.pool.query(`SELECT COUNT(DISTINCT user_id) AS dau FROM usage_log WHERE used_at >= CURRENT_DATE`),
      // Trend pipeline health
      db.pool.query(`
        SELECT fetched_at::text AS date, COUNT(*) AS count,
               SUM(CASE WHEN score='hot' THEN 1 ELSE 0 END) AS hot,
               SUM(CASE WHEN score='rising' THEN 1 ELSE 0 END) AS rising,
               SUM(CASE WHEN score='warm' THEN 1 ELSE 0 END) AS warm
        FROM trends
        GROUP BY fetched_at
        ORDER BY fetched_at DESC
        LIMIT 14
      `),
      // Recent signups (last 10)
      db.pool.query(`
        SELECT email, name, plan, provider, is_beta, created_at
        FROM users
        ORDER BY created_at DESC
        LIMIT 10
      `),
    ]);

    const planBreakdown = {};
    plans.rows.forEach(r => { planBreakdown[r.plan] = parseInt(r.count); });

    res.json({
      users: {
        total: parseInt(users.rows[0].total),
        by_plan: planBreakdown,
        beta: parseInt(betaCount.rows[0].total),
        beta_limit: parseInt(process.env.BETA_USER_LIMIT || '500'),
      },
      dau: parseInt(dau.rows[0].dau),
      trend_pipeline: trends.rows.map(r => ({
        date: r.date,
        total: parseInt(r.count),
        hot: parseInt(r.hot),
        rising: parseInt(r.rising),
        warm: parseInt(r.warm),
      })),
      recent_signups: recentSignups.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Admin] Stats error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/admin/users — search users ───────────
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const { q, plan, limit = 50 } = req.query;
    const where = []; const vals = []; let i = 1;
    if (q) { where.push(`(email ILIKE $${i} OR name ILIKE $${i})`); vals.push(`%${q}%`); i++; }
    if (plan) { where.push(`plan = $${i}`); vals.push(plan); i++; }
    vals.push(Math.min(parseInt(limit) || 50, 200));
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await db.pool.query(
      `SELECT id, email, name, plan, provider, is_beta, digest_enabled, email_verified, created_at
       FROM users ${w} ORDER BY created_at DESC LIMIT $${i}`, vals
    );
    res.json({ users: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /api/admin/users/:id/plan — change plan ──
router.post('/users/:id/plan', requireAdmin, async (req, res) => {
  try {
    const { plan } = req.body;
    const validPlans = ['free', 'plus', 'pro', 'max', 'teams', 'enterprise'];
    if (!validPlans.includes(plan)) return res.status(400).json({ error: `Invalid plan. Must be one of: ${validPlans.join(', ')}` });
    const user = await db.updateUser(req.params.id, { plan });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ message: `Plan updated to ${plan}.`, user });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
