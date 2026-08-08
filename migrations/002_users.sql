-- Users (OAuth-only: Google / GitHub) + plan column.
-- Plan is flipped manually (or by admin endpoint) until Stripe is wired up;
-- a future Stripe webhook only needs to UPDATE users SET plan = ...
CREATE TABLE IF NOT EXISTS users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text UNIQUE NOT NULL,
  name         text,
  avatar_url   text,
  provider     text NOT NULL,
  provider_id  text NOT NULL,
  plan         text NOT NULL DEFAULT 'free',
  created_at   timestamptz DEFAULT now(),
  UNIQUE (provider, provider_id)
);

ALTER TABLE reports ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id);
CREATE INDEX IF NOT EXISTS reports_user_created_idx ON reports (user_id, created_at);
