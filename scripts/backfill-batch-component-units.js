/**
 * Fills batch_components.unit_of_measure where it is NULL.
 * The unit is the BOM line unit (the unit the recipe was entered in),
 * falling back to the component item's stock unit. Same rule as batch creation.
 *
 * Safe to re-run. Does not change rows that already have a unit.
 *
 * Usage:
 *   DATABASE_URL="postgresql://…" node scripts/backfill-batch-component-units.js
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import pg from "pg";

const { Pool } = pg;

export const ADD_BATCH_COMPONENT_UNIT_SQL = `
ALTER TABLE batch_components
  ADD COLUMN IF NOT EXISTS unit_of_measure TEXT
`;

/**
 * Recipe unit when every BOM line for that component in the batch's make
 * tree agrees; otherwise the item stock unit. Blank units count as missing.
 * Only NULL batch_components.unit_of_measure rows are updated.
 */
export const BACKFILL_BATCH_COMPONENT_UNITS_SQL = `
WITH RECURSIVE make_tree AS (
  SELECT
    b.id AS batch_id,
    b.item_id AS item_id,
    ARRAY[b.item_id] AS path
  FROM batches b
  UNION ALL
  SELECT
    t.batch_id,
    bom.component_item_id,
    t.path || bom.component_item_id
  FROM make_tree t
  JOIN bom_items bom ON bom.parent_item_id = t.item_id
  JOIN items child ON child.id = bom.component_item_id
  WHERE LOWER(TRIM(child.make_or_buy::text)) IN ('make', 'true')
    AND NOT bom.component_item_id = ANY (t.path)
),
line_units AS (
  SELECT
    t.batch_id,
    bom.component_item_id,
    COALESCE(
      NULLIF(bom.unit_of_measure, ''),
      NULLIF(comp.unit_of_measure, '')
    ) AS entered_unit
  FROM make_tree t
  JOIN bom_items bom ON bom.parent_item_id = t.item_id
  JOIN items comp ON comp.id = bom.component_item_id
),
agreed AS (
  SELECT
    batch_id,
    component_item_id,
    CASE
      WHEN COUNT(DISTINCT entered_unit) = 1 THEN MIN(entered_unit)
      ELSE NULL
    END AS entered_unit
  FROM line_units
  WHERE entered_unit IS NOT NULL
  GROUP BY batch_id, component_item_id
),
resolved AS (
  SELECT
    bc.id,
    COALESCE(a.entered_unit, NULLIF(i.unit_of_measure, '')) AS unit
  FROM batch_components bc
  JOIN items i ON i.id = bc.item_id
  LEFT JOIN agreed a
    ON a.batch_id = bc.batch_id
   AND a.component_item_id = bc.item_id
  WHERE bc.unit_of_measure IS NULL
    AND COALESCE(a.entered_unit, NULLIF(i.unit_of_measure, '')) IS NOT NULL
)
UPDATE batch_components bc
SET unit_of_measure = resolved.unit
FROM resolved
WHERE bc.id = resolved.id
RETURNING bc.id
`;

function createPool(connectionString) {
  return new Pool({
    connectionString,
    ...(connectionString.includes("neon.tech")
      ? { ssl: { rejectUnauthorized: true } }
      : {}),
  });
}

async function tableExists(client, table) {
  const { rows } = await client.query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return rows.length > 0;
}

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

export async function backfillBatchComponentUnits(client) {
  if (!(await tableExists(client, "batch_components"))) {
    throw new Error(
      "batch_components does not exist. Run: node scripts/setup-item-routers.js"
    );
  }

  const alreadyHadColumn = await columnExists(
    client,
    "batch_components",
    "unit_of_measure"
  );
  await client.query(ADD_BATCH_COMPONENT_UNIT_SQL);
  console.log(
    alreadyHadColumn
      ? "batch_components.unit_of_measure already exists"
      : "Added batch_components.unit_of_measure"
  );

  const updated = await client.query(BACKFILL_BATCH_COMPONENT_UNITS_SQL);
  const updatedCount = updated.rowCount ?? updated.rows.length;
  console.log(`Updated ${updatedCount} batch_components row(s)`);

  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS remaining
     FROM batch_components
     WHERE unit_of_measure IS NULL`
  );
  console.log(
    `${rows[0].remaining} batch_components row(s) still have no unit`
  );

  return updatedCount;
}

async function main() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = createPool(connectionString);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await backfillBatchComponentUnits(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main();
}
