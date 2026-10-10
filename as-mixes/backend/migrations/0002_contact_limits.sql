CREATE TABLE IF NOT EXISTS contact_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK (count > 0),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS contact_limits_expiry ON contact_limits(expires_at);
