// Plan limits — single source of truth. Stripe isn't wired up yet: plans are
// set manually via POST /api/admin/set-plan (guarded by ADMIN_SECRET). A future
// Stripe webhook only needs to update users.plan; nothing else changes.
import { getPool } from './db.js';

export const PLANS = {
  free:    { label: 'Free',    analysesPerMonth: 1 },
  starter: { label: 'Starter', analysesPerMonth: 25 },
  pro:     { label: 'Pro',     analysesPerMonth: 100 },
  team:    { label: 'Team',    analysesPerMonth: Infinity }
};

export function planFor(user) {
  return PLANS[user?.plan] || PLANS.free;
}

export async function getMonthlyUsage(userId) {
  const r = await getPool().query(
    `SELECT count(*)::int AS used FROM reports
     WHERE user_id = $1 AND created_at >= date_trunc('month', now())`,
    [userId]
  );
  return r.rows[0].used;
}

// Returns { allowed, used, limit } for a logged-in user.
export async function checkUsage(user) {
  const limit = planFor(user).analysesPerMonth;
  if (limit === Infinity) return { allowed: true, used: 0, limit: null };
  const used = await getMonthlyUsage(user.id);
  return { allowed: used < limit, used, limit };
}
