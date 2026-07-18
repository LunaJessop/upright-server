/**
 * Adds inventory_posted to batches (master complete posts stock once).
 * Usage: node scripts/setup-batch-inventory-posted.js
 */
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

async function columnExists(client, table, column) {
  const { rows } = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2`,
    [table, column]
  );
  return rows.length > 0;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    if (!(await columnExists(client, "batches", "inventory_posted"))) {
      await client.query(
        `ALTER TABLE batches
         ADD COLUMN inventory_posted BOOLEAN NOT NULL DEFAULT FALSE`
      );
      console.log("Added batches.inventory_posted");
    } else {
      console.log("batches.inventory_posted already exists");
    }

    // Existing complete batches: mark posted so we never double-apply if someone re-runs logic.
    // (Historical completes may not have moved stock — ops can adjust manually.)
    const { rowCount } = await client.query(
      `UPDATE batches
       SET inventory_posted = TRUE
       WHERE status = 'complete' AND inventory_posted = FALSE`
    );
    console.log(`Marked ${rowCount} existing complete batches as inventory_posted`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
