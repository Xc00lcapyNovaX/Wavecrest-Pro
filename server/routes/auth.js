/**
 * Auth routes — email/password + real Google/GitHub OAuth + mock Apple/Microsoft
 */
const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const db = require('../db');
const { sendVerificationEmail, sendMagicLink } = require('../email');
const router = express.Router();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

const isNonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const baseUrl = process.env.BASE_URL;
const googleConfigured = isNonEmpty(process.env.GOOGLE_CLIENT_ID) && isNonEmpty(process.env.GOOGLE_CLIENT_SECRET);
const githubConfigured = isNonEmpty(process.env.GITHUB_CLIENT_ID) && isNonEmpty(process.env.GITHUB_CLIENT_SECRET);

if (!isNonEmpty(baseUrl)) {
  throw new Error('[Auth] BASE_URL is required.');
}

if (process.env.NODE_ENV === 'production') {
  const missing = [];
  if (!isNonEmpty(process.env.GOOGLE_CLIENT_ID)) missing.push('GOOGLE_CLIENT_ID');
  if (!isNonEmpty(process.env.GOOGLE_CLIENT_SECRET)) missing.push('GOOGLE_CLIENT_SECRET');
  if (!isNonEmpty(process.env.GITHUB_CLIENT_ID)) missing.push('GITHUB_CLIENT_ID');
  if (!isNonEmpty(process.env.GITHUB_CLIENT_SECRET)) missing.push('GITHUB_CLIENT_SECRET');
  if (missing.length) {
    throw new Error(`[Auth] Missing required OAuth env vars in production: ${missing.join(', ')}`);
  }
}

console.log(`[Auth] Google OAuth: ${googleConfigured ? 'ON' : 'OFF'}`);
console.log(`[Auth] GitHub OAuth: ${githubConfigured ? 'ON' : 'OFF'}`);
console.log(`[Auth] BASE_URL: ${baseUrl}`);

// Passport setup
if (googleConfigured) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${baseUrl}/api/auth/google/callback`,
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value;
      if (!email) return done(new Error('No email from Google'));
      let user = await db.findUserByEmail(email);
      if (!user) {
        user = await db.createUser({
          email,
          name: profile.displayName || email.split('@')[0],
          provider: 'google',
          providerId: profile.id,
          avatarUrl: profile.photos?.[0]?.value,
        });
      }
      done(null, user);
    } catch (err) {
      console.error('[Auth] Google strategy error:', err.message);
      done(err);
    }
  }));
}

if (githubConfigured) {
  passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: `${baseUrl}/api/auth/github/callback`,
    scope: ['user:email'],
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value || `${profile.username}@github.local`;
      let user = await db.findUserByEmail(email);
      if (!user) {
        user = await db.createUser({
          email,
          name: profile.displayName || profile.username,
          provider: 'github',
          providerId: String(profile.id),
          avatarUrl: profile.photos?.[0]?.value,
        });
      }
      done(null, user);
    } catch (err) {
      console.error('[Auth] GitHub strategy error:', err.message);
      done(err);
    }
  }));
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try { done(null, await db.findUserById(id)); }
  catch (err) { done(err); }
});

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

    // Send verification email (non-blocking — don't fail signup if email fails)
    try {
      const token = generateToken();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await db.createEmailToken({ userId: user.id, email, token, type: 'verify', expiresAt });
      await sendVerificationEmail({ to: email, token, baseUrl });
    } catch (emailErr) {
      console.error('[Auth] Failed to send verification email:', emailErr.message);
    }

    res.status(201).json({
      message: 'Account created! Check your email to verify your address.',
      user: sanitize(user),
      emailSent: true,
    });
  } catch (err) {
    console.error('[Auth] Signup error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

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

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('[Auth] Logout error:', err.message);
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out.' });
  });
});

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

// Google OAuth is now strict real OAuth only. No mock fallback route.
router.get('/google', (req, res, next) => {
  if (!googleConfigured) {
    return res.redirect('/signin.html?error=google_not_configured');
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

router.get('/google/callback', (req, res, next) => {
  if (!googleConfigured) {
    return res.redirect('/signin.html?error=google_not_configured');
  }
  passport.authenticate('google', { failureRedirect: '/signin.html?error=oauth_failed' })(req, res, (err) => {
    if (err) {
      console.error('[Auth] Google OAuth callback error:', err.message);
      return res.redirect('/signin.html?error=oauth_failed');
    }
    req.session.userId = req.user.id;
    const dest = req.user.is_beta ? '/dashboard.html?beta_login=true' : '/dashboard.html';
    return res.redirect(dest);
  });
});

router.get('/github', (req, res, next) => {
  if (githubConfigured) {
    passport.authenticate('github', { scope: ['user:email'] })(req, res, next);
  } else {
    res.redirect('/signin.html?error=github_not_configured');
  }
});

router.get('/github/callback', (req, res, next) => {
  if (githubConfigured) {
    passport.authenticate('github', { failureRedirect: '/signin.html?error=oauth_failed' })(req, res, (err) => {
      if (err) {
        console.error('[Auth] GitHub OAuth callback error:', err.message);
        return res.redirect('/signin.html?error=oauth_failed');
      }
      req.session.userId = req.user.id;
      const dest = req.user.is_beta ? '/dashboard.html?beta_login=true' : '/dashboard.html';
      return res.redirect(dest);
    });
  } else {
    res.redirect('/signin.html?error=github_not_configured');
  }
});

['apple', 'microsoft', 'github'].forEach((provider) => {
  if (provider === 'github' && githubConfigured) return;

  router.post(`/${provider}/callback`, async (req, res) => {
    try {
      const { email, name } = req.body;
      if (!email) return res.status(400).json({ error: 'Email required for OAuth.' });
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
      res.json({ message: `Signed in with ${provider} (mock).`, user: sanitize(user) });
    } catch (err) {
      res.status(500).json({ error: 'Server error.' });
    }
  });
});

router.post('/beta-signup', async (req, res) => {
  try {
    const { email, name, niche, platform } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    let user = await db.findUserByEmail(email);
    if (user) {
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

    const passwordHash = await bcrypt.hash(`beta_${Date.now()}`, 12);
    user = await db.createUser({ email, passwordHash, name: name || email.split('@')[0] });
    await db.updateUser(user.id, { plan: 'pro', is_beta: true });
    user.plan = 'pro';
    user.is_beta = true;

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

// ── Magic link request ─────────────────────────────────────────────────────
router.post('/magic-link', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Valid email required.' });
    }

    // Find or create user
    let user = await db.findUserByEmail(email);
    if (!user) {
      user = await db.createUser({ email, name: email.split('@')[0], provider: 'email' });
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    await db.createEmailToken({ userId: user.id, email, token, type: 'magic', expiresAt });
    await sendMagicLink({ to: email, token, baseUrl });

    res.json({ message: 'Sign-in link sent! Check your email.' });
  } catch (err) {
    console.error('[Auth] Magic link error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Verify token (both email verification + magic link) ────────────────────
router.get('/verify-token', async (req, res) => {
  try {
    const { token, type } = req.query;
    if (!token || !type) {
      return res.status(400).json({ error: 'Token and type required.' });
    }

    const record = await db.findEmailToken(token);

    if (!record) return res.status(400).json({ error: 'Invalid or expired link.' });
    if (record.type !== type) return res.status(400).json({ error: 'Invalid link type.' });
    if (record.used_at) return res.status(400).json({ error: 'This link has already been used.' });
    if (new Date() > new Date(record.expires_at)) {
      return res.status(400).json({ error: 'This link has expired. Please request a new one.' });
    }

    await db.consumeEmailToken(record.id);

    if (type === 'verify') {
      await db.markEmailVerified(record.user_id);
      return res.json({ message: 'Email verified successfully!', type: 'verify' });
    }

    if (type === 'magic') {
      const user = await db.findUserById(record.user_id);
      if (!user) return res.status(400).json({ error: 'User not found.' });
      await db.markEmailVerified(user.id);
      req.session.userId = user.id;
      return res.json({ message: 'Signed in!', type: 'magic', user: sanitize(user) });
    }

    res.status(400).json({ error: 'Unknown token type.' });
  } catch (err) {
    console.error('[Auth] Verify token error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Resend verification email ──────────────────────────────────────────────
router.post('/resend-verification', async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated.' });
    const user = await db.findUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'User not found.' });
    if (user.email_verified) return res.status(400).json({ error: 'Email already verified.' });

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.createEmailToken({ userId: user.id, email: user.email, token, type: 'verify', expiresAt });
    await sendVerificationEmail({ to: user.email, token, baseUrl });

    res.json({ message: 'Verification email resent.' });
  } catch (err) {
    console.error('[Auth] Resend verification error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

function sanitize(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatar_url: user.avatar_url,
    plan: user.plan,
    is_beta: user.is_beta || false,
    email_verified: user.email_verified || false,
    provider: user.provider,
    created_at: user.created_at,
  };
}

module.exports = router;
