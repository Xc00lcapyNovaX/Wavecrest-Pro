/**
 * Wavecrest Pro — Express Server
 */

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const passport = require('passport');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';


// ── Trust proxy FIRST (required for HTTPS detection on Vercel) ──
if (isProd) app.set('trust proxy', 1);


// ── Force HTTPS (fixes OAuth redirect issues) ──
app.use((req, res, next) => {
  if (isProd && !req.secure) {
    return res.redirect(`https://${req.headers.host}${req.url}`);
  }
  next();
});


// ── Validate env vars in production ──
if (isProd) {
  const missing = ['DATABASE_URL', 'SESSION_SECRET', 'BASE_URL'].filter(
    (k) => !process.env[k]
  );

  if (missing.length) {
    console.error('[FATAL] Missing required env vars:', missing.join(', '));
    process.exit(1);
  }
}


// ── Security & parsing ──
app.use(helmet({ contentSecurityPolicy: false }));

app.use(cors({
  origin: isProd ? process.env.BASE_URL : true,
  credentials: true,
}));

app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') return next();
  express.json()(req, res, next);
});

app.use(express.urlencoded({ extended: true }));


// ── Session ──
app.use(session({
  store: new pgSession({
    pool: db.pool,
    tableName: 'session',
  }),
  secret: process.env.SESSION_SECRET || 'dev-secret',
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


// ── Passport (MUST come after session) ──
app.use(passport.initialize());
app.use(passport.session());


// ── Static files ──
app.use(express.static(path.join(__dirname, '..', 'public')));


// ── Routes ──
const authRouter = require('./routes/auth');
const trendsRouter = require('./routes/trends');

app.use('/api/auth', authRouter);
app.use('/api/trends', trendsRouter);
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/analytics', require('./routes/analytics'));


// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: process.env.MODE || 'mock',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});


// ── 404 ──
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});


// ── Global error handler ──
app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(500).json({ error: 'Internal server error' });
});


// ── Start ──
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, async () => {
    if (!isProd) {
      await trendsRouter.seedTrendsFromFile();
    }

    console.log('\n🌊 Wavecrest Pro Server');
    console.log(`✓ Running on http://localhost:${PORT}`);
    console.log(`✓ Mode: ${isProd ? 'production' : 'development'}`);
    console.log(`✓ DB: ${process.env.DATABASE_URL ? 'connected' : 'local'}`);
    console.log('');
  });
}