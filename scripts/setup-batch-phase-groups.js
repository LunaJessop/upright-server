/**
 * Adds grouping columns on batch_phases for nested BOM production.
 * Usage: node scripts/setup-batch-phase-groups.js
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

    if (!(await columnExists(client, "batch_phases", "source_item_id"))) {
      await client.query(`
        ALTER TABLE batch_phases
        ADD COLUMN source_item_id INTEGER REFERENCES items(id) ON DELETE SET NULL
      `);
      console.log("Added batch_phases.source_item_id");
    }

    if (!(await columnExists(client, "batch_phases", "source_item_name"))) {
      await client.query(
        "ALTER TABLE batch_phases ADD COLUMN source_item_name TEXT"
      );
      console.log("Added batch_phases.source_item_name");
    }

    if (!(await columnExists(client, "batch_phases", "source_item_qty"))) {
      await client.query(
        "ALTER TABLE batch_phases ADD COLUMN source_item_qty NUMERIC"
      );
      console.log("Added batch_phases.source_item_qty");
    }

    if (!(await columnExists(client, "batch_phases", "group_order"))) {
      await client.query(
        "ALTER TABLE batch_phases ADD COLUMN group_order INTEGER"
      );
      console.log("Added batch_phases.group_order");
    }

    // Backfill from parent batch item when possible
    await client.query(`
      UPDATE batch_phases bp
      SET source_item_id = b.item_id,
          source_item_name = i.name,
          source_item_qty = b.quantity,
          group_order = COALESCE(bp.group_order, 1)
      FROM batches b
      JOIN items i ON i.id = b.item_id
      WHERE bp.batch_id = b.id
        AND bp.source_item_id IS NULL
    `);

    await client.query("COMMIT");
    console.log("batch_phases grouping columns ready.");
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
