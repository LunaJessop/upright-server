/**
 * Make batch_phases.source_phase_id ON DELETE SET NULL so item router edits
 * don't fail when historical batches still point at old phase rows.
 * Usage: node scripts/fix-batch-phases-source-fk.js
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

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "ALTER TABLE batch_phases DROP CONSTRAINT IF EXISTS batch_phases_source_phase_id_fkey"
    );
    await client.query(`
      ALTER TABLE batch_phases
      ADD CONSTRAINT batch_phases_source_phase_id_fkey
      FOREIGN KEY (source_phase_id)
      REFERENCES item_router_phases(id)
      ON DELETE SET NULL
    `);
    await client.query("COMMIT");
    console.log("batch_phases.source_phase_id is now ON DELETE SET NULL");
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
