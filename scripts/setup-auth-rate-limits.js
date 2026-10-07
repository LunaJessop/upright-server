/**
 * One-time setup: auth_rate_limits table for login/register throttling.
 * One row per action + scope (ip|email) + subject. The window resets in
 * place, so attempts do not append a new row.
 *
 * Usage: node scripts/setup-auth-rate-limits.js
 *
 * Required in production before rate limits actually enforce. Until this
 * runs, login and register fail open (they stay available and log an error).
 */
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ...(connectionString.includes("neon.tech")
    ? { ssl: { rejectUnauthorized: true } }
    : {}),
});

async function tableExists(client, table) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return rows.length > 0;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (!(await tableExists(client, "auth_rate_limits"))) {
      await client.query(`
        CREATE TABLE auth_rate_limits (
          action TEXT NOT NULL CHECK (action IN ('login', 'register', 'forgot_password')),
          scope TEXT NOT NULL CHECK (scope IN ('ip', 'email')),
          subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 320),
          window_start TIMESTAMPTZ NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (action, scope, subject)
        )
      `);
      console.log("Created auth_rate_limits table");
    } else {
      console.log("auth_rate_limits table already exists");
      await client.query(`
        DO $$
        DECLARE
          r record;
        BEGIN
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
        END $$
      `);
      await client.query(`
        ALTER TABLE auth_rate_limits
          ADD CONSTRAINT auth_rate_limits_action_check
          CHECK (action IN ('login', 'register', 'forgot_password'))
      `);
      console.log("Updated auth_rate_limits action check");
    }

    await client.query("COMMIT");
    console.log("Auth rate limit setup complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
