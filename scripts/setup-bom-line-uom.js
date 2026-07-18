/**
 * Adds unit_of_measure to bom_items (recipe entry UOM).
 * Usage: node scripts/setup-bom-line-uom.js
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
    if (!(await columnExists(client, "bom_items", "unit_of_measure"))) {
      await client.query(
        `ALTER TABLE bom_items
         ADD COLUMN unit_of_measure TEXT`
      );
      console.log("Added bom_items.unit_of_measure");
    } else {
      console.log("bom_items.unit_of_measure already exists");
    }

    // Backfill from component stock UOM where missing
    const { rowCount } = await client.query(
      `UPDATE bom_items b
       SET unit_of_measure = i.unit_of_measure
       FROM items i
       WHERE b.component_item_id = i.id
         AND (b.unit_of_measure IS NULL OR b.unit_of_measure = '')
         AND i.unit_of_measure IS NOT NULL
         AND i.unit_of_measure <> ''`
    );
    console.log(`Backfilled unit_of_measure on ${rowCount} BOM lines`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
