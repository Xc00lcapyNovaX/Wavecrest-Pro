/**
 * Wavecrest Pro — PostgreSQL database layer
 * Same API surface as the old in-memory mock, backed by real SQL.
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/wavecrest',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const db = { pool };

// ── Users ──────────────────────────────────────────
db.findUserByEmail = async (email) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  return rows[0] || null;
};

db.findUserById = async (id) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
};

db.findUserByProvider = async (provider, providerId) => {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE provider = $1 AND id = $2', [provider, providerId]
  );
  return rows[0] || null;
};

db.createUser = async ({ email, passwordHash, name, provider = 'email', providerId, avatarUrl }) => {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, name, avatar_url, provider, plan)
     VALUES ($1, $2, $3, $4, $5, 'free') RETURNING *`,
    [email.toLowerCase(), passwordHash || null, name || email.split('@')[0], avatarUrl || null, provider]
  );
  return rows[0];
};

db.updateUser = async (id, fields) => {
  const allowed = ['plan', 'name', 'avatar_url', 'password_hash', 'stripe_customer_id', 'is_beta'];
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = $${i}`); vals.push(v); i++; }
  }
  if (sets.length === 0) return db.findUserById(id);
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals
  );
  return rows[0] || null;
};

// ── Subscriptions ──────────────────────────────────
db.createSubscription = async ({ userId, plan, stripeSubId, status = 'active', trialEnd, periodEnd }) => {
  const sessionId = stripeSubId || `mock_sub_${Date.now()}`;
  const { rows } = await pool.query(
    `INSERT INTO subscriptions (user_id, plan, status, stripe_session_id, trial_ends_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, plan, status, sessionId, trialEnd || null]
  );
  await db.updateUser(userId, { plan });
  return rows[0];
};

db.findSubscription = async (userId) => {
  const { rows } = await pool.query(
    `SELECT * FROM subscriptions WHERE user_id = $1 AND status != 'cancelled'
     ORDER BY created_at DESC LIMIT 1`, [userId]
  );
  return rows[0] || null;
};

db.cancelSubscription = async (userId) => {
  const sub = await db.findSubscription(userId);
  if (sub) {
    await pool.query(
      `UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [sub.id]
    );
    await db.updateUser(userId, { plan: 'free' });
    sub.status = 'cancelled';
  }
  return sub;
};

// ── Stripe-specific queries ────────────────────────
db.findUserByStripeCustomerId = async (customerId) => {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE stripe_customer_id = $1', [customerId]
  );
  return rows[0] || null;
};

db.updateUserStripeId = async (userId, stripeCustomerId) => {
  return db.updateUser(userId, { stripe_customer_id: stripeCustomerId });
};

db.findSubscriptionByStripeId = async (stripeSubId) => {
  const { rows } = await pool.query(
    'SELECT * FROM subscriptions WHERE stripe_sub_id = $1', [stripeSubId]
  );
  return rows[0] || null;
};

db.updateSubscriptionFromStripe = async (stripeSubId, fields) => {
  const allowed = ['plan', 'status', 'current_period_end', 'trial_ends_at', 'cancelled_at'];
  const sets = []; const vals = []; let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = $${i}`); vals.push(v); i++; }
  }
  if (sets.length === 0) return null;
  vals.push(stripeSubId);
  const { rows } = await pool.query(
    `UPDATE subscriptions SET ${sets.join(', ')} WHERE stripe_sub_id = $${i} RETURNING *`, vals
  );
  return rows[0] || null;
};

db.createSubscriptionFromStripe = async ({ userId, plan, stripeSubId, stripeSessionId, status = 'active', trialEnd, periodEnd }) => {
  const { rows } = await pool.query(
    `INSERT INTO subscriptions (user_id, plan, status, stripe_sub_id, stripe_session_id, trial_ends_at, current_period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [userId, plan, status, stripeSubId || null, stripeSessionId || null, trialEnd || null, periodEnd || null]
  );
  await db.updateUser(userId, { plan });
  return rows[0];
};

// ── Trends ─────────────────────────────────────────
db.trends = []; // In-memory cache for analytics route compatibility

db.addTrends = async (trends, date) => {
  const dateStr = date || new Date().toISOString().slice(0, 10);
  const { rows: existing } = await pool.query(
    'SELECT COUNT(*) AS cnt FROM trends WHERE fetched_at = $1', [dateStr]
  );
  if (parseInt(existing[0].cnt, 10) > 0) return; // idempotent

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of trends) {
      await client.query(
        `INSERT INTO trends (topic, score, platform, traffic, fetched_at) VALUES ($1,$2,$3,$4,$5)`,
        [t.topic, t.score, t.platform || 'general', t.traffic || 0, dateStr]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await db._refreshTrendsCache();
};

db._refreshTrendsCache = async () => {
  const { rows } = await pool.query('SELECT * FROM trends ORDER BY id DESC');
  db.trends = rows.map(r => ({
    ...r,
    fetched_at: r.fetched_at instanceof Date ? r.fetched_at.toISOString().slice(0, 10) : String(r.fetched_at),
  }));
};

db.getTrends = async ({ date, platform, score, limit = 30, offset = 0 }) => {
  const where = []; const vals = []; let i = 1;
  if (date) { where.push(`fetched_at = $${i}`); vals.push(date); i++; }
  if (platform) { where.push(`platform = $${i}`); vals.push(platform); i++; }
  if (score) { where.push(`score = $${i}`); vals.push(score); i++; }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countRes = await pool.query(`SELECT COUNT(*) AS total FROM trends ${w}`, vals);
  vals.push(limit); vals.push(offset);
  const { rows } = await pool.query(
    `SELECT * FROM trends ${w} ORDER BY id DESC LIMIT $${i} OFFSET $${i + 1}`, vals
  );
  return {
    trends: rows.map(r => ({ ...r, fetched_at: r.fetched_at instanceof Date ? r.fetched_at.toISOString().slice(0, 10) : String(r.fetched_at) })),
    total: parseInt(countRes.rows[0].total, 10),
  };
};

db.searchTrends = async (query, { platform, limit = 20 } = {}) => {
  const where = ['topic ILIKE $1']; const vals = [`%${query}%`]; let i = 2;
  if (platform) { where.push(`platform = $${i}`); vals.push(platform); i++; }
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (LOWER(topic)) * FROM trends WHERE ${where.join(' AND ')} ORDER BY LOWER(topic), id DESC`, vals
  );
  const scoreOrder = { hot: 0, rising: 1, warm: 2 };
  rows.sort((a, b) => (scoreOrder[a.score] || 3) - (scoreOrder[b.score] || 3));
  return rows.slice(0, limit).map(r => ({
    ...r, fetched_at: r.fetched_at instanceof Date ? r.fetched_at.toISOString().slice(0, 10) : String(r.fetched_at),
  }));
};

// ── Usage / Rate Limits ────────────────────────────
const PLAN_LIMITS = { free: 10, plus: 50, pro: 500, max: -1, teams: -1, enterprise: -1 };

db.checkRateLimit = async (userId, plan) => {
  const limit = PLAN_LIMITS[plan] ?? 10;
  if (limit === -1) return { allowed: true, remaining: Infinity, limit: 'unlimited' };
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS used FROM usage_log WHERE user_id = $1 AND used_at >= $2::date AND used_at < ($2::date + interval '1 day')`,
    [userId, today]
  );
  const used = parseInt(rows[0].used, 10);
  return { allowed: used < limit, remaining: Math.max(0, limit - used), limit, used };
};

db.logUsage = async (userId, endpoint) => {
  await pool.query('INSERT INTO usage_log (user_id, endpoint) VALUES ($1, $2)', [userId, endpoint]);
};

// ── API Keys (BYOAK) ──────────────────────────────
db.saveApiKey = async (userId, service, key) => {
  const { rows } = await pool.query(
    `INSERT INTO api_keys (user_id, service, api_key) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, service) DO UPDATE SET api_key = $3 RETURNING *`,
    [userId, service, key]
  );
  return rows[0];
};

db.getApiKeys = async (userId) => {
  const { rows } = await pool.query('SELECT * FROM api_keys WHERE user_id = $1', [userId]);
  return rows;
};

module.exports = db;
