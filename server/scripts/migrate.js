#!/usr/bin/env node
/**
 * Migration script — creates/updates database tables.
 * Run with: npm run migrate
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

if (!process.env.DATABASE_URL && process.env.NODE_ENV === 'production') {
  console.error('[FATAL] DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/wavecrest',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Each statement is run individually for Neon pooler compatibility.
// DO $$ blocks are kept intact (not split on inner semicolons).
const statements = [
  // Drop any broken tables from failed previous runs (safe — CASCADE handles deps)
  `DROP TABLE IF EXISTS api_keys CASCADE`,
  `DROP TABLE IF EXISTS usage_log CASCADE`,
  `DROP TABLE IF EXISTS subscriptions CASCADE`,
  `DROP TABLE IF EXISTS trends CASCADE`,
  `DROP TABLE IF EXISTS session CASCADE`,
  `DROP TABLE IF EXISTS users CASCADE`,

  // Users
  `CREATE TABLE users (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email              TEXT NOT NULL UNIQUE,
    password_hash      TEXT,
    name               TEXT,
    avatar_url         TEXT,
    plan               TEXT NOT NULL DEFAULT 'free',
    provider           TEXT NOT NULL DEFAULT 'email',
    stripe_customer_id VARCHAR(255),
    is_beta            BOOLEAN DEFAULT false,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // Subscriptions
  `CREATE TABLE subscriptions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan               TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'active',
    stripe_sub_id      VARCHAR(255),
    stripe_session_id  TEXT,
    team_size          INTEGER DEFAULT 1,
    trial_ends_at      TIMESTAMPTZ,
    intro_ends_at      TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cancelled_at       TIMESTAMPTZ
  )`,
  `CREATE INDEX idx_sub_user ON subscriptions(user_id)`,

  // Trends
  `CREATE TABLE trends (
    id         SERIAL PRIMARY KEY,
    topic      TEXT NOT NULL,
    score      VARCHAR(10) NOT NULL,
    platform   VARCHAR(20),
    traffic    INTEGER DEFAULT 0,
    fetched_at DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX idx_trends_date ON trends(fetched_at)`,

  // API keys
  `CREATE TABLE api_keys (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service    VARCHAR(50) NOT NULL,
    api_key    TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, service)
  )`,

  // Usage log
  `CREATE TABLE usage_log (
    id       SERIAL PRIMARY KEY,
    user_id  UUID REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT,
    used_at  TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX idx_usage_user_date ON usage_log(user_id, used_at)`,

  // Sessions
  `CREATE TABLE session (
    sid    VARCHAR PRIMARY KEY,
    sess   JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL
  )`,
  `CREATE INDEX idx_session_expire ON session(expire)`,
];

(async () => {
  const client = await pool.connect();
  try {
    console.log('🗄️  Running migrations...');
    for (const stmt of statements) {
      await client.query(stmt);
    }
    console.log('✓ All tables created/verified.');
    process.exit(0);
  } catch (err) {
    console.error('✗ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
