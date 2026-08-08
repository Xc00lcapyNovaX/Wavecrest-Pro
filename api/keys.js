// API key management for logged-in users.
//   GET    /api/keys        → list your keys (never the secret, just prefix)
//   POST   /api/keys {name} → create; plaintext key returned ONCE
//   DELETE /api/keys {id}   → revoke
import { getPool } from '../lib/db.js';
import { getUser, generateApiKey } from '../lib/auth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_KEYS = 5;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in to manage API keys', code: 'UNAUTHENTICATED' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const db = getPool();

  if (req.method === 'GET') {
    const r = await db.query(
      `SELECT id, prefix, name, created_at, last_used_at, revoked_at
       FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [user.id]
    );
    return res.status(200).json({ keys: r.rows });
  }

  if (req.method === 'POST') {
    const active = await db.query(
      'SELECT count(*)::int AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL',
      [user.id]
    );
    if (active.rows[0].n >= MAX_KEYS) {
      return res.status(400).json({ error: `Limit of ${MAX_KEYS} active keys — revoke one first`, code: 'KEY_LIMIT' });
    }
    const name = (body?.name || 'default').toString().slice(0, 60);
    const { key, hash, prefix } = generateApiKey();
    const r = await db.query(
      `INSERT INTO api_keys (user_id, key_hash, prefix, name)
       VALUES ($1, $2, $3, $4) RETURNING id, prefix, name, created_at`,
      [user.id, hash, prefix, name]
    );
    // Only moment the plaintext key is ever available
    return res.status(201).json({ key, ...r.rows[0] });
  }

  if (req.method === 'DELETE') {
    const id = body?.id;
    if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'Valid key id required', code: 'INVALID_INPUT' });
    const r = await db.query(
      `UPDATE api_keys SET revoked_at = now()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
      [id, user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Key not found or already revoked', code: 'NOT_FOUND' });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
}
