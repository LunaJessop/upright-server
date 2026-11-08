-- Admin activity for server errors and auth events.
-- Outgoing mail stays in email_log. Do not store passwords, reset tokens, or email bodies.
--
-- Retention: drop rows older than 90 days when the table gets large.
--   DELETE FROM admin_activity WHERE created_at < now() - interval '90 days';
--
-- Safe to run more than once. It does not change rows already stored.

CREATE TABLE IF NOT EXISTS admin_activity (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event_type TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email TEXT,
  message TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS admin_activity_created_at_idx
  ON admin_activity (created_at DESC);

CREATE INDEX IF NOT EXISTS admin_activity_client_created_at_idx
  ON admin_activity (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_activity_type_created_at_idx
  ON admin_activity (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_activity_email_idx
  ON admin_activity (lower(email));
