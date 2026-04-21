/**
 * Wavecrest Pro — Express Server
 * PostgreSQL-backed. Supports real Stripe (when keys are set) or mock mode.
 *
 * Routing architecture:
 *   /public          → express.static (CSS, JS, images, JSON only — no .html)
 *   /private_views   → served explicitly via clean, extension-less URLs
 *   Gatekeeper       → signed cookie tracks 5-day staircase + weekly rotation
 *   .html requests   → 301-redirected to clean path
 */
'use strict';
require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const pgSession    = require('connect-pg-simple')(session);
const helmet       = require('helmet');
const compression  = require('compression');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const path         = require('path');
const db           = require('./db');
const passport     = require('passport');

const { gatekeeper, requireTier, exposeTierHeader } = require('./middleware/gatekeeper');
const { requireAuth } = require('./middleware/requireAuth');

const app    = express();
const PORT   = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// ── Fail-fast env check (production only) ───────────
if (isProd) {
  const missing = ['DATABASE_URL', 'SESSION_SECRET', 'ADMIN_SECRET', 'BASE_URL']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error('[FATAL] Missing required env vars:', missing.join(', '));
    process.exit(1);
  }
}

// ── Trust proxy (Vercel / nginx) ─────────────────────
if (isProd) app.set('trust proxy', 1);

// ── Security & compression ────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
// Compress responses > 1kb — Vercel handles it at CDN level but this
// covers non-CDN paths and local dev
app.use(compression({ threshold: 1024 }));

// ── CORS ─────────────────────────────────────────────
app.use(cors({
  origin: isProd ? (process.env.BASE_URL || 'https://wavecrest.pro') : true,
  credentials: true,
}));

// ── Body parsers ─────────────────────────────────────
app.use((req, res, next) => {
  // Stripe webhook needs raw body; skip JSON parsing for it
  if (req.originalUrl === '/api/stripe/webhook') return next();
  express.json()(req, res, next);
});
app.use(express.urlencoded({ extended: true }));

// ── Signed cookie parser (must run before gatekeeper & session) ──
// Uses ADMIN_SECRET so signed cookies cannot be forged without the secret.
const COOKIE_SECRET = process.env.COOKIE_SECRET || process.env.SESSION_SECRET || 'wavecrest-dev-cookie-secret';
app.use(cookieParser(COOKIE_SECRET));

// ── Session store (Postgres) ─────────────────────────
app.use(session({
  store: new pgSession({ pool: db.pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'wavecrest-dev-session-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure:   isProd,
    sameSite: 'lax',
  },
}));

// ── Static assets (CSS, JS, images, JSON) ─────────────
// index: false → no automatic index.html serving
// extensions: [] → no .html extension fallback
// HTML files are served explicitly via clean URL routes below.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  index:      false,
  extensions: [],
}));

// ── Redirect .html requests → clean URL (301) ─────────
// Old bookmarks and external links gracefully updated.
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    const clean = req.path.slice(0, -5) || '/';
    const qs    = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    return res.redirect(301, (clean || '/') + qs);
  }
  next();
});

// ── Gatekeeper (sets/reads WavecrestSession cookie) ───
// Non-blocking: always calls next(), just attaches req.betaTier etc.
app.use(gatekeeper);
app.use(exposeTierHeader);

// ── Passport (OAuth) ──────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

// ── API routes ────────────────────────────────────────
const authRouter   = require('./routes/auth');
const trendsRouter = require('./routes/trends');
app.use('/api/auth',      authRouter);
app.use('/api/trends',    trendsRouter);
app.use('/api/stripe',    require('./routes/stripe'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/admin',     require('./routes/admin'));
app.use('/api/v1',        require('./routes/v1'));
app.use('/api/feedback',  require('./routes/feedback'));

// ── Health check ─────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:    'ok',
    mode:      process.env.MODE || 'mock',
    uptime:    process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ── Tier info endpoint (client-readable, no auth needed) ──
app.get('/api/me/tier', (req, res) => {
  res.json({
    tier:         req.betaTier,
    day:          req.betaDay,
    phase:        req.betaPhase,
    week:         req.betaWeek,
    trialActive:  req.betaTrialActive,
    trialExpired: req.betaTrialExpired,
    visitorId:    req.betaVisitorId,
  });
});

// ─────────────────────────────────────────────────────
// ── Clean URL page routes ─────────────────────────────
// ─────────────────────────────────────────────────────

// Helper: serve a file from /private_views
function view(name) {
  const filePath = path.join(__dirname, 'private_views', name + '.html');
  return (_req, res) => res.sendFile(filePath);
}

// Helper: serve a file from /public
function pub(name) {
  const filePath = path.join(__dirname, '..', 'public', name + '.html');
  return (_req, res) => res.sendFile(filePath);
}

// ── Public pages ─────────────────────────────────────
app.get('/',        pub('index'));
app.get('/signin',  pub('signin'));
app.get('/signup',  pub('signup'));
app.get('/privacy', pub('privacy'));
app.get('/terms',   pub('terms'));
app.get('/verify',  pub('verify'));

// ── Checkout — open to all, pre-selects plan via ?plan= ──
app.get('/checkout', view('checkout'));

// ── Auth-gated pages ─────────────────────────────────
// requireAuth redirects to /signin?next=<url> for HTML requests
app.get('/dashboard', requireAuth, view('dashboard'));
app.get('/calendar',  requireAuth, view('calendar'));
app.get('/analytics', requireAuth, view('analytics'));

// ── Admin — has its own client-side password gate ────
app.get('/admin', view('admin'));

// ─────────────────────────────────────────────────────
// ── Beta staircase tier pages ─────────────────────────
// requireTier(minPlan) → 302 to current tier if user tries to skip ahead
// ─────────────────────────────────────────────────────
app.get('/plus',  requireTier('plus'),  view('unlock'));
app.get('/pro',   requireTier('pro'),   view('unlock'));
app.get('/max',   requireTier('max'),   view('unlock'));
app.get('/teams', requireTier('teams'), view('unlock'));

// ── 404 ──────────────────────────────────────────────
app.use((req, res) => {
  // Return HTML 404 for page requests, JSON for API
  const wantsHtml = (req.headers.accept || '').includes('text/html');
  if (wantsHtml && !req.path.startsWith('/api/')) {
    return res.status(404).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><title>404 — Wavecrest Pro</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#000;color:#f5f5f7;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;text-align:center;padding:24px}h1{font-size:4rem;font-weight:700;opacity:.15}p{color:#86868b}a{color:#2997ff;text-decoration:none}a:hover{text-decoration:underline}</style>
</head><body>
<h1>404</h1><p>This page doesn't exist (yet).</p>
<a href="/">← Back to Wavecrest Pro</a>
</body></html>`);
  }
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ── Global error handler ──────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Error]', err.stack || err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Startup: seed trends + warm cache ─────────────────
async function onStartup() {
  try {
    await trendsRouter.seedTrendsFromFile();
    await db.ensureCacheWarmed();
    console.log(`  ✓ Trend cache warmed (${db.trends.length} trends in memory)`);
  } catch (err) {
    console.warn('  ⚠ Startup warning:', err.message || err);
  }
}

// ── Boot ─────────────────────────────────────────────
if (process.env.VERCEL) {
  // Serverless: fire startup tasks async, don't block first request
  onStartup().catch(err => console.error('[Startup]', err.message));
  module.exports = app;
} else {
  app.listen(PORT, async () => {
    await onStartup();
    console.log('');
    console.log('  🌊 Wavecrest Pro');
    console.log(`  ✓ http://localhost:${PORT}`);
    console.log(`  ✓ Mode:   ${isProd ? 'production' : 'development'}`);
    console.log(`  ✓ DB:     ${process.env.DATABASE_URL ? 'connected' : 'postgresql://localhost/wavecrest'}`);
    console.log(`  ✓ Stripe: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'LIVE 🔴' : process.env.STRIPE_SECRET_KEY?.startsWith('sk_test') ? 'TEST' : 'mock'}`);
    if (!isProd) {
      console.log('');
      console.log('  Pages:');
      console.log(`    /              http://localhost:${PORT}/`);
      console.log(`    /dashboard     http://localhost:${PORT}/dashboard`);
      console.log(`    /plus .. /teams  http://localhost:${PORT}/plus  (staircase)`);
      console.log(`    /checkout      http://localhost:${PORT}/checkout`);
      console.log(`    /api/me/tier   http://localhost:${PORT}/api/me/tier`);
    }
    console.log('');
  });
}
