-- Required before password reset and email logging work.
-- Paste this whole script into the Neon SQL Editor.
-- The last statement is the check. Neon only shows that result.

CREATE TABLE IF NOT EXISTS email_log (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  to_address TEXT NOT NULL,
  template TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  provider_message_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS email_log_client_id_created_at_idx
  ON email_log (client_id, created_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx
  ON password_reset_tokens (user_id);

-- Let forgot-password use the same rate-limit table as login.
-- No-op when auth_rate_limits has not been created yet.
DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.auth_rate_limits') IS NULL THEN
    RAISE NOTICE 'auth_rate_limits is missing. Run scripts/setup-auth-rate-limits.js, then run this script again.';
    RETURN;
  END IF;

  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'auth_rate_limits'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%action%'
  LOOP
    EXECUTE format('ALTER TABLE auth_rate_limits DROP CONSTRAINT %I', r.conname);
  END LOOP;

  ALTER TABLE auth_rate_limits
    ADD CONSTRAINT auth_rate_limits_action_check
    CHECK (action IN ('login', 'register', 'forgot_password'));
END $$;

SELECT
  to_regclass('public.email_log') AS email_log,
  to_regclass('public.password_reset_tokens') AS password_reset_tokens,
  (
    SELECT pg_get_constraintdef(c.oid)
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'auth_rate_limits'
      AND c.conname = 'auth_rate_limits_action_check'
  ) AS forgot_password_rate_limit;
