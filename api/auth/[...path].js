// All auth routes in one function (stays under Vercel's per-deploy function limit):
//   GET  /api/auth/google            → redirect to Google consent
//   GET  /api/auth/google/callback   → exchange code, set session, redirect /app
//   GET  /api/auth/github            → redirect to GitHub consent
//   GET  /api/auth/github/callback   → exchange code, set session, redirect /app
//   GET  /api/auth/me                → current user or 401
//   POST /api/auth/logout            → clear session cookie
//   POST /api/auth/login             → 501 (email/password not offered; OAuth only)
import crypto from 'node:crypto';
import {
  getUser, upsertUser, sessionCookie, clearSessionCookie,
  stateCookie, parseCookies
} from '../../lib/auth.js';

const baseUrl = () => process.env.BASE_URL || `https://${process.env.VERCEL_URL}`;
const googleRedirect = () => process.env.GOOGLE_CALLBACK_URL || `${baseUrl()}/api/auth/google/callback`;
const githubRedirect = () => `${baseUrl()}/api/auth/github/callback`;

export default async function handler(req, res) {
  const route = [].concat(req.query.path || []).join('/');

  try {
    switch (route) {
      case 'google':          return startGoogle(req, res);
      case 'google/callback': return googleCallback(req, res);
      case 'github':          return startGithub(req, res);
      case 'github/callback': return githubCallback(req, res);
      case 'me':              return me(req, res);
      case 'logout':          return logout(req, res);
      case 'login':
        return res.status(501).json({
          error: 'Email/password sign-in isn’t available — use Google or GitHub',
          code: 'NOT_IMPLEMENTED'
        });
      default:
        return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    }
  } catch (err) {
    console.error(`[auth/${route}]`, err);
    return res.status(500).json({ error: 'Authentication failed — try again', code: 'AUTH_ERROR' });
  }
}

function requireMethod(req, res, method) {
  if (req.method === method) return true;
  res.setHeader('Allow', method);
  res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  return false;
}

function newState(res) {
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', stateCookie(state));
  return state;
}

function checkState(req, res) {
  const cookieState = parseCookies(req).wc_oauth_state;
  if (!cookieState || cookieState !== req.query.state) {
    res.status(400).json({ error: 'Invalid OAuth state — start over from /login', code: 'BAD_STATE' });
    return false;
  }
  return true;
}

// --- Google ---

function startGoogle(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirect(),
    response_type: 'code',
    scope: 'openid email profile',
    state: newState(res)
  });
  res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

async function googleCallback(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  if (!checkState(req, res)) return;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      code: req.query.code || '',
      grant_type: 'authorization_code',
      redirect_uri: googleRedirect()
    })
  });
  if (!tokenRes.ok) throw new Error(`Google token exchange failed (${tokenRes.status})`);
  const { access_token } = await tokenRes.json();

  const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${access_token}` }
  });
  if (!infoRes.ok) throw new Error(`Google userinfo failed (${infoRes.status})`);
  const info = await infoRes.json();
  if (!info.email) throw new Error('Google account has no email');

  const user = await upsertUser({
    email: info.email,
    name: info.name || '',
    avatarUrl: info.picture || '',
    provider: 'google',
    providerId: info.sub
  });
  finishLogin(res, user);
}

// --- GitHub ---

function startGithub(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: githubRedirect(),
    scope: 'read:user user:email',
    state: newState(res)
  });
  res.redirect(302, `https://github.com/login/oauth/authorize?${params}`);
}

async function githubCallback(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  if (!checkState(req, res)) return;

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code: req.query.code || '',
      redirect_uri: githubRedirect()
    })
  });
  if (!tokenRes.ok) throw new Error(`GitHub token exchange failed (${tokenRes.status})`);
  const { access_token } = await tokenRes.json();
  if (!access_token) throw new Error('GitHub returned no access token');

  const gh = (path) => fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'wavecrest-pro' }
  });

  const userRes = await gh('/user');
  if (!userRes.ok) throw new Error(`GitHub user fetch failed (${userRes.status})`);
  const info = await userRes.json();

  let email = info.email;
  if (!email) {
    const emailsRes = await gh('/user/emails');
    if (emailsRes.ok) {
      const emails = await emailsRes.json();
      email = emails.find(e => e.primary && e.verified)?.email || emails[0]?.email;
    }
  }
  if (!email) throw new Error('GitHub account has no accessible email');

  const user = await upsertUser({
    email,
    name: info.name || info.login || '',
    avatarUrl: info.avatar_url || '',
    provider: 'github',
    providerId: info.id
  });
  finishLogin(res, user);
}

// --- session ---

function finishLogin(res, user) {
  res.setHeader('Set-Cookie', [sessionCookie(user.id), stateCookie('')]);
  res.redirect(302, '/app');
}

async function me(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  res.setHeader('Cache-Control', 'no-store');
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in', code: 'UNAUTHENTICATED' });
  return res.status(200).json({ user });
}

function logout(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  res.setHeader('Set-Cookie', clearSessionCookie());
  return res.status(200).json({ ok: true });
}
