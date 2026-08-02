/**
 * Split item cost vs sell price; add batch economics snapshot columns.
 * Usage: node scripts/setup-item-pricing-and-batch-economics.js
 *
 * Migration:
 * - items.unit_cost, items.unit_sell_price
 * - backfill from default_unit_price (buy → cost, make → sell)
 * - batches projection fields
 * - batch_components unit_cost_snapshot + line_cost
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

async function addColumn(client, table, column, definition) {
  if (await columnExists(client, table, column)) {
    console.log(`${table}.${column} already exists`);
    return false;
  }
  await client.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`Added ${table}.${column}`);
  return true;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await addColumn(client, "items", "unit_cost", "NUMERIC");
    await addColumn(client, "items", "unit_sell_price", "NUMERIC");

    // Backfill once from default_unit_price when new cols are empty.
    const backfillBuy = await client.query(`
      UPDATE items
      SET unit_cost = COALESCE(unit_cost, default_unit_price)
      WHERE unit_cost IS NULL
        AND default_unit_price IS NOT NULL
        AND LOWER(TRIM(make_or_buy::text)) IN ('buy', 'false')
    `);
    const backfillMake = await client.query(`
      UPDATE items
      SET unit_sell_price = COALESCE(unit_sell_price, default_unit_price)
      WHERE unit_sell_price IS NULL
        AND default_unit_price IS NOT NULL
        AND LOWER(TRIM(make_or_buy::text)) IN ('make', 'true')
    `);
    console.log(
      `Backfilled unit_cost on ${backfillBuy.rowCount} buy item(s); unit_sell_price on ${backfillMake.rowCount} make item(s)`
    );

    if (await tableExists(client, "batches")) {
      await addColumn(client, "batches", "projected_cost", "NUMERIC");
      await addColumn(client, "batches", "projected_revenue", "NUMERIC");
      await addColumn(client, "batches", "projected_profit", "NUMERIC");
      await addColumn(client, "batches", "projected_margin", "NUMERIC");
      await addColumn(client, "batches", "projected_unit_cost", "NUMERIC");
      await addColumn(client, "batches", "projected_unit_sell", "NUMERIC");
    }

    if (await tableExists(client, "batch_components")) {
      await addColumn(client, "batch_components", "unit_cost_snapshot", "NUMERIC");
      await addColumn(client, "batch_components", "line_cost", "NUMERIC");
    }

    await client.query("COMMIT");
    console.log("Item pricing + batch economics setup complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
