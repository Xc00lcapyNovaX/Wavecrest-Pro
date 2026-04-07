/**
 * Wavecrest Pro — Express Server
 * In-memory DB + mock OAuth/Stripe. Replace with real services later.
 */
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'wavecrest-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure: false, // Set to true in production with HTTPS
    sameSite: 'lax',
  },
}));

// ── Static files (landing page, checkout pages, public assets) ──
app.use(express.static(path.join(__dirname, '..')));       // serves index.html, checkout-*.html, trends.json
app.use(express.static(path.join(__dirname, '..', 'public'))); // serves signin.html, dashboard.html, etc.

// ── API Routes ─────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/trends', require('./routes/trends'));
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/dashboard', require('./routes/dashboard'));

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
app.listen(PORT, () => {
  console.log('');
  console.log('  🌊 Wavecrest Pro Server');
  console.log(`  ✓ Running on http://localhost:${PORT}`);
  console.log(`  ✓ Mode: ${process.env.MODE || 'mock'} (in-memory DB, dummy OAuth/Stripe)`);
  console.log(`  ✓ Landing page: http://localhost:${PORT}/index.html`);
  console.log(`  ✓ Dashboard: http://localhost:${PORT}/dashboard.html`);
  console.log(`  ✓ API Health: http://localhost:${PORT}/api/health`);
  console.log('');
});
