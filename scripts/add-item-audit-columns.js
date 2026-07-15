/**
 * Adds created_by / updated_by audit columns to items if missing.
 * Usage: node scripts/add-item-audit-columns.js
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

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (!(await columnExists(client, "items", "created_by"))) {
      await client.query(
        "ALTER TABLE items ADD COLUMN created_by INTEGER REFERENCES users(id)"
      );
      console.log("Added items.created_by");
    }

    if (!(await columnExists(client, "items", "updated_by"))) {
      await client.query(
        "ALTER TABLE items ADD COLUMN updated_by INTEGER REFERENCES users(id)"
      );
      console.log("Added items.updated_by");
    }

    await client.query("COMMIT");
    console.log("Item audit columns ready.");
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
