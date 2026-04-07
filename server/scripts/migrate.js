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

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  name          TEXT,
  avatar_url    TEXT,
  plan          TEXT NOT NULL DEFAULT 'free',
  provider      TEXT NOT NULL DEFAULT 'email',
  stripe_customer_id VARCHAR(255),
  is_beta           BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  stripe_sub_id       VARCHAR(255),
  stripe_session_id   TEXT,
  team_size           INTEGER DEFAULT 1,
  trial_ends_at       TIMESTAMPTZ,
  intro_ends_at       TIMESTAMPTZ,
  current_period_end  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sub_user ON subscriptions(user_id);

CREATE TABLE IF NOT EXISTS trends (
  id         SERIAL PRIMARY KEY,
  topic      TEXT NOT NULL,
  score      VARCHAR(10) NOT NULL,
  platform   VARCHAR(20),
  traffic    INTEGER DEFAULT 0,
  fetched_at DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trends_date ON trends(fetched_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service    VARCHAR(50) NOT NULL,
  api_key    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, service)
);

CREATE TABLE IF NOT EXISTS usage_log (
  id        SERIAL PRIMARY KEY,
  user_id   UUID REFERENCES users(id) ON DELETE CASCADE,
  endpoint  TEXT,
  used_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage_log(user_id, used_at);

CREATE TABLE IF NOT EXISTS session (
  sid     VARCHAR PRIMARY KEY,
  sess    JSON NOT NULL,
  expire  TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);

-- Safe column additions for existing databases
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN is_beta BOOLEAN DEFAULT false;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE users ADD COLUMN stripe_customer_id VARCHAR(255);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE subscriptions ADD COLUMN stripe_sub_id VARCHAR(255);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE subscriptions ADD COLUMN current_period_end TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
`;

(async () => {
  try {
    console.log('🗄️  Running migrations...');
    await pool.query(schema);
    console.log('✓ All tables created/verified.');
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('✗ Migration failed:', err.message);
    process.exit(1);
  }
})();
