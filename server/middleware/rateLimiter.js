/**
 * Rate limiter middleware — enforces per-tier daily limits
 */
const db = require('../db');

async function rateLimiter(req, res, next) {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const user = await db.findUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'User not found.' });

    const { allowed, remaining, limit, used } = await db.checkRateLimit(user.id, user.plan);

    res.set('X-RateLimit-Limit', limit === 'unlimited' ? 'unlimited' : String(limit));
    res.set('X-RateLimit-Remaining', String(remaining));

    if (!allowed) {
      return res.status(429).json({
        error: 'Daily rate limit exceeded.',
        plan: user.plan,
        limit,
        used,
        upgrade_url: '/checkout-pro.html',
      });
    }

    await db.logUsage(user.id, req.path);
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = rateLimiter;
