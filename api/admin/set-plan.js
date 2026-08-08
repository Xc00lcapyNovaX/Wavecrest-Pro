// Manual plan switch — the "Stripe mock" until real billing lands.
// POST { email, plan } with header x-admin-secret: $ADMIN_SECRET
import crypto from 'node:crypto';
import { getPool } from '../../lib/db.js';
import { PLANS } from '../../lib/plans.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const secret = process.env.ADMIN_SECRET;
  const given = req.headers['x-admin-secret'] || '';
  const ok = secret && given.length === secret.length
    && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const email = (body?.email || '').trim().toLowerCase();
  const plan = body?.plan;

  if (!email) return res.status(400).json({ error: 'email required', code: 'INVALID_INPUT' });
  if (!PLANS[plan]) {
    return res.status(400).json({
      error: `plan must be one of: ${Object.keys(PLANS).join(', ')}`,
      code: 'INVALID_INPUT'
    });
  }

  const r = await getPool().query(
    'UPDATE users SET plan = $1 WHERE email = $2 RETURNING id, email, plan',
    [plan, email]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'No user with that email', code: 'NOT_FOUND' });

  return res.status(200).json({ ok: true, user: r.rows[0] });
}
