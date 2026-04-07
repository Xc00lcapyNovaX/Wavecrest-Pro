/**
 * Wavecrest Pro — Express Server
 * PostgreSQL-backed. Supports real Stripe (when keys are set) or mock mode.
 */
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Fail fast if required env vars are missing in production
if (isProd) {
  const missing = ['DATABASE_URL', 'SESSION_SECRET', 'BASE_URL'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error('[FATAL] Missing required env vars:', missing.join(', '));
    process.exit(1);
  }
}

// ── Trust proxy (required behind Vercel/nginx) ─────
if (isProd) app.set('trust proxy', 1);

// ── Middleware ──────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: isProd ? (process.env.BASE_URL || 'https://wavecrest.pro') : true,
  credentials: true,
}));
app.use((req, res, next) => {
  // Skip JSON parsing for Stripe webhooks — they need raw body
  if (req.originalUrl === '/api/stripe/webhook') return next();
  express.json()(req, res, next);
});
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new pgSession({ pool: db.pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'wavecrest-dev-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
  },
}));

// ── Static files (landing page, checkout pages, public assets) ──
app.use(express.static(path.join(__dirname, '..')));       // serves index.html, checkout-*.html, trends.json
app.use(express.static(path.join(__dirname, '..', 'public'))); // serves signin.html, dashboard.html, etc.

// ── API Routes ─────────────────────────────────────
const trendsRouter = require('./routes/trends');
app.use('/api/auth', require('./routes/auth'));
app.use('/api/trends', trendsRouter);
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/analytics', require('./routes/analytics'));

// ── Health check ───────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: process.env.MODE || 'mock',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ── 404 handler ────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ── Global error handler ───────────────────────────
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ──────────────────────────────────────────
if (process.env.VERCEL) {
  // Vercel serverless — export app, no listen()
  module.exports = app;
} else {
  app.listen(PORT, async () => {
    // Only auto-seed in development
    if (!isProd) {
      await trendsRouter.seedTrendsFromFile();
    }
    console.log('');
    console.log('  🌊 Wavecrest Pro Server');
    console.log(`  ✓ Running on http://localhost:${PORT}`);
    console.log(`  ✓ Mode: ${isProd ? 'production' : 'development'}`);
    console.log(`  ✓ DB: ${process.env.DATABASE_URL ? '***connected***' : 'postgresql://localhost:5432/wavecrest'}`);
    console.log(`  ✓ Stripe: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'LIVE' : process.env.STRIPE_SECRET_KEY?.startsWith('sk_test') ? 'TEST' : 'mock'}`);
    if (!isProd) {
      console.log(`  ✓ Landing: http://localhost:${PORT}/index.html`);
      console.log(`  ✓ Dashboard: http://localhost:${PORT}/dashboard.html`);
      console.log(`  ✓ Health: http://localhost:${PORT}/api/health`);
    }
    console.log('');
  });
}
