-- API keys: only the HMAC-SHA256 hash is stored; the prefix (wc_live_xxxxxxxx)
-- is kept for display in a key-management UI.
CREATE TABLE IF NOT EXISTS api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash     text UNIQUE NOT NULL,
  prefix       text NOT NULL,
  name         text,
  created_at   timestamptz DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);
