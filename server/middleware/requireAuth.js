/**
 * Auth middleware — checks if user is logged in
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.status(401).json({ error: 'Not authenticated. Please sign in.' });
}

/**
 * Plan guard — ensures user has at least the required plan
 */
function requirePlan(...allowedPlans) {
  return async (req, res, next) => {
    try {
      const db = require('../db');
      const user = await db.findUserById(req.session.userId);
      if (!user) return res.status(401).json({ error: 'Not authenticated.' });

      if (allowedPlans.includes(user.plan)) {
        req.user = user;
        return next();
      }
      return res.status(403).json({
        error: 'Plan upgrade required.',
        current_plan: user.plan,
        required_plans: allowedPlans,
      });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireAuth, requirePlan };
