// Stateless sessions: HMAC-signed cookie (no session table — serverless-friendly).
// Cookie value = base64url({uid, exp}) + "." + HMAC-SHA256(payload, SESSION_SECRET).
// API keys: HMAC hash stored in api_keys; plaintext shown once at creation.
import crypto from 'node:crypto';
import { getPool } from './db.js';

const COOKIE_NAME = 'wc_session';
const MAX_AGE_SECS = 30 * 24 * 3600;

function sessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET not set');
  return s;
}

function keySecret() {
  return process.env.API_KEY_ENCRYPTION_KEY || sessionSecret();
}

function hmac(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

// --- session cookie ---

export function createSessionValue(userId, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: now + MAX_AGE_SECS * 1000 })).toString('base64url');
  return `${payload}.${hmac(payload, sessionSecret())}`;
}

export function verifySessionValue(value, now = Date.now()) {
  if (typeof value !== 'string') return null;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return null;
  const expected = hmac(payload, sessionSecret());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.uid || now > data.exp) return null;
    return data.uid;
  } catch {
    return null;
  }
}

function cookieAttrs(maxAge) {
  // Secure is dropped for `vercel dev` (plain http on localhost)
  const secure = process.env.VERCEL_ENV === 'development' ? '' : 'Secure; ';
  return `Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=${maxAge}`;
}

export function sessionCookie(userId) {
  return `${COOKIE_NAME}=${createSessionValue(userId)}; ${cookieAttrs(MAX_AGE_SECS)}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; ${cookieAttrs(0)}`;
}

export function stateCookie(state) {
  return `wc_oauth_state=${state}; ${cookieAttrs(600)}`;
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export async function getUser(req) {
  const uid = verifySessionValue(parseCookies(req)[COOKIE_NAME]);
  if (!uid) return null;
  const r = await getPool().query(
    'SELECT id, email, name, avatar_url, plan, created_at FROM users WHERE id = $1',
    [uid]
  );
  return r.rows[0] || null;
}

// --- users ---

export async function upsertUser({ email, name, avatarUrl, provider, providerId }) {
  const db = getPool();
  try {
    const r = await db.query(
      `INSERT INTO users (email, name, avatar_url, provider, provider_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, provider_id)
       DO UPDATE SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url
       RETURNING id, email, name, avatar_url, plan`,
      [email, name, avatarUrl, provider, String(providerId)]
    );
    return r.rows[0];
  } catch (err) {
    // Same email arriving via the other provider: link to the existing account.
    if (err.code === '23505') {
      const r = await db.query(
        'SELECT id, email, name, avatar_url, plan FROM users WHERE email = $1',
        [email]
      );
      if (r.rows[0]) return r.rows[0];
    }
    throw err;
  }
}

// --- API keys ---

export function hashApiKey(key) {
  return hmac(key, keySecret());
}

export function generateApiKey() {
  const key = `wc_live_${crypto.randomBytes(24).toString('hex')}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 16) };
}

export async function getUserByApiKey(key) {
  if (!key || !key.startsWith('wc_live_')) return null;
  const r = await getPool().query(
    `SELECT u.id, u.email, u.name, u.avatar_url, u.plan, k.id AS key_id
     FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [hashApiKey(key)]
  );
  const row = r.rows[0];
  if (!row) return null;
  // Best-effort usage timestamp; never block the request on it
  getPool().query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.key_id]).catch(() => {});
  return row;
}
