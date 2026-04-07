/**
 * Auth routes — email/password + mock OAuth
 */
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const router = express.Router();

// ── Email signup ───────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    if (await db.findUserByEmail(email)) {
      return res.status(409).json({ error: 'Email already registered.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await db.createUser({ email, passwordHash, name });
    req.session.userId = user.id;

    res.status(201).json({
      message: 'Account created successfully.',
      user: sanitize(user),
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Email login ────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required.' });
    }

    const user = await db.findUserByEmail(email);
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    req.session.userId = user.id;
    res.json({ message: 'Logged in.', user: sanitize(user) });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Logout ─────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('[Auth] Logout error:', err.message);
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out.' });
  });
});

// ── Current user ───────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    const user = await db.findUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'User not found.' });

    const sub = await db.findSubscription(user.id);
    const { remaining, limit } = await db.checkRateLimit(user.id, user.plan);

    res.json({
      user: sanitize(user),
      subscription: sub ? { plan: sub.plan, status: sub.status, period_end: sub.current_period_end, trial_end: sub.trial_end } : null,
      usage: { remaining, limit },
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Mock OAuth routes ──────────────────────────────
// These simulate OAuth login. In production, replace with real Passport strategies.
const OAUTH_PROVIDERS = ['google', 'apple', 'github', 'microsoft'];

OAUTH_PROVIDERS.forEach((provider) => {
  // Redirect to "OAuth" (mock: just show a form)
  router.get(`/${provider}`, (req, res) => {
    res.redirect(`${process.env.BASE_URL || ''}/signin.html?oauth=${provider}`);
  });

  // Callback (mock: create/find user by email)
  router.post(`/${provider}/callback`, async (req, res) => {
    try {
      const { email, name } = req.body;
      if (!email) {
        return res.status(400).json({ error: 'Email required for OAuth.' });
      }

      let user = await db.findUserByEmail(email);
      if (!user) {
        user = await db.createUser({
          email,
          name: name || email.split('@')[0],
          provider,
          providerId: `${provider}_${Date.now()}`,
        });
      }

      req.session.userId = user.id;
      res.json({
        message: `Signed in with ${provider}.`,
        user: sanitize(user),
      });
    } catch (err) {
      res.status(500).json({ error: 'Server error.' });
    }
  });
});

// ── Beta signup — free Pro access for early testers ──
router.post('/beta-signup', async (req, res) => {
  try {
    const { email, name, niche, platform } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    let user = await db.findUserByEmail(email);
    if (user) {
      // Existing user — upgrade to Pro beta if not already
      if (user.plan === 'free' || user.plan === 'plus') {
        await db.updateUser(user.id, { plan: 'pro', is_beta: true });
        user.plan = 'pro';
      }
      req.session.userId = user.id;
      return res.json({
        message: 'Welcome back! You now have free Pro access.',
        user: sanitize(user),
        beta: true,
      });
    }

    // New user — create with Pro plan
    const passwordHash = await bcrypt.hash('beta_' + Date.now(), 12);
    user = await db.createUser({ email, passwordHash, name: name || email.split('@')[0] });
    await db.updateUser(user.id, { plan: 'pro', is_beta: true });
    user.plan = 'pro';
    user.is_beta = true;

    // Store niche/platform preference as metadata (log it for now)
    if (niche || platform) {
      console.log(`[Beta] New signup: ${email} | niche: ${niche || 'none'} | platform: ${platform || 'all'}`);
    }

    req.session.userId = user.id;

    res.status(201).json({
      message: 'Welcome to the Wavecrest Pro beta!',
      user: sanitize(user),
      beta: true,
    });
  } catch (err) {
    console.error('[Beta Signup]', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Helper ─────────────────────────────────────────
function sanitize(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatar_url: user.avatar_url,
    plan: user.plan,
    is_beta: user.is_beta || false,
    provider: user.provider,
    created_at: user.created_at,
  };
}

module.exports = router;
