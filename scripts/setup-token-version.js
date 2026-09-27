/**
 * Adds users.token_version so issued JWTs can be revoked.
 *
 * Existing rows are set to 0. Tokens signed before this deploy have no `tv`
 * claim, so they stop working and those users need to log in again.
 * Lookup is the users primary key; no extra index is required.
 *
 * Usage: node scripts/setup-token-version.js
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

async function columnExists(client, table, column) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows.length > 0;
}

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

    if (!(await tableExists(client, "users"))) {
      throw new Error(
        "users table does not exist. Run scripts/setup-auth-schema.js first."
      );
    }

    if (!(await columnExists(client, "users", "token_version"))) {
      await client.query(
        `ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0`
      );
      console.log("Added users.token_version");
    } else {
      console.log("users.token_version already exists");
    }

    await client.query("COMMIT");
    console.log("Token version schema setup complete.");
    console.log(
      "Existing sessions were not migrated. Users must log in again."
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
