/**
 * Wavecrest Pro — PostgreSQL database layer
 * Same API surface as the old in-memory mock, backed by real SQL.
 */
const { Pool } = require('pg');

// Fail fast if DATABASE_URL is missing in production
if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  console.error('[FATAL] DATABASE_URL is required in production');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/wavecrest',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: process.env.VERCEL ? 5 : 20, // serverless needs fewer connections
  idleTimeoutMillis: process.env.VERCEL ? 10000 : 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[DB Pool] Unexpected error on idle client:', err.message);
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
    'SELECT * FROM users WHERE provider = $1 AND provider_id = $2', [provider, providerId]
  );
  return rows[0] || null;
};

db.createUser = async ({ email, passwordHash, name, provider = 'email', providerId, avatarUrl }) => {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, name, avatar_url, provider, provider_id, plan)
     VALUES ($1, $2, $3, $4, $5, $6, 'free') RETURNING *`,
    [email.toLowerCase(), passwordHash || null, name || email.split('@')[0], avatarUrl || null, provider, providerId || null]
  );
  return rows[0];
};

db.updateUser = async (id, fields) => {
  const allowed = ['plan', 'name', 'avatar_url', 'password_hash', 'stripe_customer_id', 'is_beta', 'provider_id'];
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

db.linkProviderToUser = async (userId, provider, providerId) => {
  const { rows } = await pool.query(
    `UPDATE users SET provider = $1, provider_id = $2 WHERE id = $3 RETURNING *`,
    [provider, providerId, userId]
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

// Warm cache if empty (called on every cold start in serverless)
db.ensureCacheWarmed = async () => {
  if (db.trends.length === 0) {
    await db._refreshTrendsCache();
  }
};

db.getTrends = async ({ date, platform, score, limit = 30, offset = 0 }) => {
  const where = []; const vals = []; let i = 1;
  if (date) { where.push(`fetched_at = $${i}`); vals.push(date); i++; }
  if (platform) { where.push(`platform = $${i}`); vals.push(platform); i++; }
  if (score) { where.push(`score = $${i}`); vals.push(score); i++; }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countRes = await pool.query(`SELECT COUNT(*) AS total FROM trends ${w}`, vals);
  vals.push(limit); vals.push(offset);
  const scoreOrder = `CASE score WHEN 'hot' THEN 0 WHEN 'rising' THEN 1 WHEN 'warm' THEN 2 ELSE 3 END`;
  const { rows } = await pool.query(
    `SELECT * FROM trends ${w} ORDER BY ${scoreOrder}, id DESC LIMIT $${i} OFFSET $${i + 1}`, vals
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

// ── Email Tokens ───────────────────────────────────
db.createEmailToken = async ({ userId, email, token, type, expiresAt }) => {
  // Invalidate any existing unused tokens of same type for this email
  await pool.query(
    `UPDATE email_tokens SET used_at = NOW() WHERE email = $1 AND type = $2 AND used_at IS NULL`,
    [email.toLowerCase(), type]
  );
  const { rows } = await pool.query(
    `INSERT INTO email_tokens (user_id, email, token, type, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId || null, email.toLowerCase(), token, type, expiresAt]
  );
  return rows[0];
};

db.findEmailToken = async (token) => {
  const { rows } = await pool.query(
    `SELECT * FROM email_tokens WHERE token = $1`, [token]
  );
  return rows[0] || null;
};

db.consumeEmailToken = async (tokenId) => {
  await pool.query(
    `UPDATE email_tokens SET used_at = NOW() WHERE id = $1`, [tokenId]
  );
};

db.markEmailVerified = async (userId) => {
  await pool.query(`UPDATE users SET email_verified = true WHERE id = $1`, [userId]);
};

// ── User API Keys ──────────────────────────────────
db.createUserApiKey = async (userId, label) => {
  const crypto = require('crypto');
  const raw = 'wcp_' + crypto.randomBytes(28).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 12);
  // One key per user — upsert
  await pool.query(`DELETE FROM user_api_keys WHERE user_id = $1`, [userId]);
  const { rows } = await pool.query(
    `INSERT INTO user_api_keys (user_id, key_hash, key_prefix, label) VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, hash, prefix, label || 'Default']
  );
  return { ...rows[0], raw_key: raw }; // raw only returned once
};

db.getUserApiKey = async (userId) => {
  const { rows } = await pool.query(`SELECT * FROM user_api_keys WHERE user_id = $1`, [userId]);
  return rows[0] || null;
};

db.findUserByApiKey = async (rawKey) => {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const { rows } = await pool.query(
    `SELECT u.*, uk.id AS key_id FROM users u
     JOIN user_api_keys uk ON uk.user_id = u.id
     WHERE uk.key_hash = $1`, [hash]
  );
  if (rows[0]) {
    // Update last_used async
    pool.query(`UPDATE user_api_keys SET last_used = NOW() WHERE id = $1`, [rows[0].key_id]).catch(() => {});
  }
  return rows[0] || null;
};

db.deleteUserApiKey = async (userId) => {
  await pool.query(`DELETE FROM user_api_keys WHERE user_id = $1`, [userId]);
};

// ── Referrals ──────────────────────────────────────
db.ensureReferralCode = async (userId) => {
  const { rows } = await pool.query(`SELECT referral_code FROM users WHERE id = $1`, [userId]);
  if (rows[0]?.referral_code) return rows[0].referral_code;
  // Generate a short readable code
  const code = require('crypto').randomBytes(8).toString('hex').toUpperCase();
  await pool.query(`UPDATE users SET referral_code = $1 WHERE id = $2`, [code, userId]);
  return code;
};

db.findUserByReferralCode = async (code) => {
  const { rows } = await pool.query(`SELECT * FROM users WHERE referral_code = $1`, [code.toUpperCase()]);
  return rows[0] || null;
};

db.applyReferral = async (referrerId, refereeId) => {
  // Record referral (idempotent)
  const { rows } = await pool.query(
    `INSERT INTO referrals (referrer_id, referee_id) VALUES ($1, $2) ON CONFLICT (referee_id) DO NOTHING RETURNING *`,
    [referrerId, refereeId]
  );
  if (!rows[0]) return; // already referred
  // Give both users +10 bonus searches
  await pool.query(`UPDATE users SET bonus_searches = COALESCE(bonus_searches, 0) + 10, referred_by = $1 WHERE id = $2`, [referrerId, refereeId]);
  await pool.query(`UPDATE users SET bonus_searches = COALESCE(bonus_searches, 0) + 10 WHERE id = $1`, [referrerId]);
  await pool.query(`UPDATE referrals SET rewarded_at = NOW() WHERE referrer_id = $1 AND referee_id = $2`, [referrerId, refereeId]);
};

db.getReferralStats = async (userId) => {
  const { rows } = await pool.query(
    `SELECT r.*, u.email AS referee_email, u.plan AS referee_plan, u.created_at AS referee_joined
     FROM referrals r JOIN users u ON u.id = r.referee_id
     WHERE r.referrer_id = $1 ORDER BY r.created_at DESC`, [userId]
  );
  const { rows: user } = await pool.query(`SELECT referral_code, bonus_searches FROM users WHERE id = $1`, [userId]);
  return { referrals: rows, code: user[0]?.referral_code, bonus_searches: user[0]?.bonus_searches || 0 };
};

// ── Discord Webhook ────────────────────────────────
db.setDiscordWebhook = async (userId, url) => {
  await pool.query(`UPDATE users SET discord_webhook_url = $1 WHERE id = $2`, [url, userId]);
};

db.getDiscordWebhookUsers = async () => {
  const { rows } = await pool.query(
    `SELECT id, email, name, discord_webhook_url FROM users WHERE discord_webhook_url IS NOT NULL AND discord_webhook_url != ''`
  );
  return rows;
};

// ── Saved Trends (Bookmarks) ──────────────────────
db.saveTrend = async (userId, { trendId, topic, platform, score }) => {
  const { rows } = await pool.query(
    `INSERT INTO saved_trends (user_id, trend_id, topic, platform, score)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, trend_id) DO NOTHING RETURNING *`,
    [userId, trendId, topic, platform || 'general', score || 'warm']
  );
  return rows[0] || null;
};

db.unsaveTrend = async (userId, savedId) => {
  const { rowCount } = await pool.query(
    `DELETE FROM saved_trends WHERE id = $1 AND user_id = $2`, [savedId, userId]
  );
  return rowCount > 0;
};

db.getSavedTrends = async (userId) => {
  const { rows } = await pool.query(
    `SELECT * FROM saved_trends WHERE user_id = $1 ORDER BY saved_at DESC`, [userId]
  );
  return rows;
};

db.isTrendSaved = async (userId, trendId) => {
  const { rows } = await pool.query(
    `SELECT id FROM saved_trends WHERE user_id = $1 AND trend_id = $2`, [userId, trendId]
  );
  return rows[0] || null;
};

// ── Email Digest ───────────────────────────────────
db.getDigestSubscribers = async () => {
  const { rows } = await pool.query(
    `SELECT id, email, name, plan, digest_token FROM users
     WHERE digest_enabled = true AND email IS NOT NULL
     ORDER BY created_at ASC`
  );
  return rows;
};

db.setDigestEnabled = async (userId, enabled) => {
  await pool.query(`UPDATE users SET digest_enabled = $1 WHERE id = $2`, [enabled, userId]);
};

db.findUserByDigestToken = async (token) => {
  const { rows } = await pool.query(`SELECT * FROM users WHERE digest_token = $1`, [token]);
  return rows[0] || null;
};

db.ensureDigestToken = async (userId) => {
  // Generate a token if the user doesn't have one yet
  const { rows } = await pool.query(`SELECT digest_token FROM users WHERE id = $1`, [userId]);
  if (rows[0]?.digest_token) return rows[0].digest_token;
  const token = require('crypto').randomBytes(20).toString('hex');
  await pool.query(`UPDATE users SET digest_token = $1 WHERE id = $2`, [token, userId]);
  return token;
};

// ── API Keys (BYOAK) ──────────────────────────────
// Keys are encrypted at rest with AES-256-GCM via lib/crypto.js.
// Only a short prefix is stored plaintext for display ("sk-1234••••••••").
const { encrypt: encryptSecret, decrypt: decryptSecret, isEncrypted } = require('./lib/crypto');

db.saveApiKey = async (userId, service, key) => {
  const ciphertext = encryptSecret(key);
  const prefix = String(key).slice(0, 8);
  const { rows } = await pool.query(
    `INSERT INTO api_keys (user_id, service, api_key, key_prefix) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, service) DO UPDATE SET api_key = $3, key_prefix = $4 RETURNING id, service, key_prefix, created_at`,
    [userId, service, ciphertext, prefix]
  );
  return rows[0];
};

// Returns safe-to-expose fields only (no ciphertext). Use getDecryptedApiKey
// for internal callers that need to sign outbound requests.
db.getApiKeys = async (userId) => {
  const { rows } = await pool.query(
    'SELECT id, service, key_prefix, created_at FROM api_keys WHERE user_id = $1',
    [userId]
  );
  return rows;
};

db.getDecryptedApiKey = async (userId, service) => {
  const { rows } = await pool.query(
    'SELECT api_key FROM api_keys WHERE user_id = $1 AND service = $2',
    [userId, service]
  );
  if (!rows[0]) return null;
  const blob = rows[0].api_key;
  if (!isEncrypted(blob)) return blob;
  return decryptSecret(blob);
};

db.deleteApiKey = async (id, userId) => {
  const { rows } = await pool.query(
    'DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId]
  );
  return rows[0] || null;
};

// ── Trend Votes ───────────────────────────────────────
// Returns { hot, cold, userVote } for a trend
db.getVoteCounts = async (trendId, userId = null) => {
  const { rows } = await pool.query(
    `SELECT vote, COUNT(*) as count FROM trend_votes WHERE trend_id = $1 GROUP BY vote`,
    [trendId]
  );
  const counts = { hot: 0, cold: 0, userVote: null };
  rows.forEach(r => { counts[r.vote] = parseInt(r.count, 10); });
  if (userId) {
    const { rows: uv } = await pool.query(
      `SELECT vote FROM trend_votes WHERE trend_id = $1 AND user_id = $2`,
      [trendId, userId]
    );
    counts.userVote = uv[0]?.vote || null;
  }
  return counts;
};

// Returns { action: 'added'|'switched'|'removed', vote, hot, cold }
db.castVote = async (userId, trendId, topic, vote) => {
  // Check existing
  const { rows: existing } = await pool.query(
    `SELECT id, vote FROM trend_votes WHERE user_id = $1 AND trend_id = $2`,
    [userId, trendId]
  );
  let action;
  if (existing.length && existing[0].vote === vote) {
    // Same vote → toggle off
    await pool.query(`DELETE FROM trend_votes WHERE user_id = $1 AND trend_id = $2`, [userId, trendId]);
    action = 'removed';
  } else if (existing.length) {
    // Different vote → switch
    await pool.query(
      `UPDATE trend_votes SET vote = $1 WHERE user_id = $2 AND trend_id = $3`,
      [vote, userId, trendId]
    );
    action = 'switched';
  } else {
    // New vote
    await pool.query(
      `INSERT INTO trend_votes (user_id, trend_id, topic, vote) VALUES ($1, $2, $3, $4)`,
      [userId, trendId, topic, vote]
    );
    action = 'added';
  }
  const counts = await db.getVoteCounts(trendId, userId);
  return { action, ...counts };
};

// Batch-fetch vote counts for multiple trends (used by dashboard)
db.getVoteCountsBatch = async (trendIds, userId = null) => {
  if (!trendIds.length) return {};
  const { rows } = await pool.query(
    `SELECT trend_id, vote, COUNT(*) as count FROM trend_votes
     WHERE trend_id = ANY($1) GROUP BY trend_id, vote`,
    [trendIds]
  );
  const map = {};
  rows.forEach(r => {
    if (!map[r.trend_id]) map[r.trend_id] = { hot: 0, cold: 0, userVote: null };
    map[r.trend_id][r.vote] = parseInt(r.count, 10);
  });
  if (userId) {
    const { rows: uv } = await pool.query(
      `SELECT trend_id, vote FROM trend_votes WHERE trend_id = ANY($1) AND user_id = $2`,
      [trendIds, userId]
    );
    uv.forEach(r => {
      if (!map[r.trend_id]) map[r.trend_id] = { hot: 0, cold: 0, userVote: null };
      map[r.trend_id].userVote = r.vote;
    });
  }
  return map;
};

// ── Feedback ──────────────────────────────────────────
db.saveFeedback = async ({ userId, visitorId, type, title, body, pageUrl, userAgent }) => {
  const { rows } = await pool.query(
    `INSERT INTO feedback (user_id, visitor_id, type, title, body, page_url, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [userId || null, visitorId || null, type, title, body || '', pageUrl || '', userAgent || '']
  );
  return rows[0];
};

db.getFeedback = async ({ type, status, limit = 50, offset = 0 } = {}) => {
  let q = `SELECT f.*, u.email as user_email, u.name as user_name
           FROM feedback f LEFT JOIN users u ON f.user_id = u.id WHERE 1=1`;
  const params = [];
  if (type) { params.push(type); q += ` AND f.type = $${params.length}`; }
  if (status) { params.push(status); q += ` AND f.status = $${params.length}`; }
  params.push(limit, offset);
  q += ` ORDER BY f.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const { rows } = await pool.query(q, params);
  return rows;
};

module.exports = db;
