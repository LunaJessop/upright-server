/**
 * Rewrites items, bom_items, and batch_components unit codes to the
 * canonical spellings in lib/units.js. Known aliases are updated. Values
 * that do not map are left unchanged and printed.
 *
 * Safe to re-run.
 *
 * Usage:
 *   DATABASE_URL="postgresql://…" node scripts/normalize-unit-codes.js
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  classifyStoredUnit,
  sqlNormalizeUnitColumn,
  sqlUnmappedUnits,
} from "../lib/units.js";

const { Pool } = pg;

const UNIT_COLUMNS = [
  { table: "items", column: "unit_of_measure" },
  { table: "bom_items", column: "unit_of_measure" },
  { table: "batch_components", column: "unit_of_measure" },
];

export const NORMALIZE_UNIT_SQL = Object.fromEntries(
  UNIT_COLUMNS.map(({ table, column }) => [
    table,
    sqlNormalizeUnitColumn(table, column),
  ])
);

export const UNMAPPED_UNIT_SQL = Object.fromEntries(
  UNIT_COLUMNS.map(({ table, column }) => [
    table,
    sqlUnmappedUnits(table, column),
  ])
);

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

export async function normalizeStoredUnitCodes(client) {
  const summary = [];

  for (const { table, column } of UNIT_COLUMNS) {
    if (!(await tableExists(client, table))) {
      console.log(`${table}: skipped (table does not exist)`);
      summary.push({ table, skipped: "table does not exist" });
      continue;
    }
    if (!(await columnExists(client, table, column))) {
      console.log(`${table}: skipped (${column} does not exist)`);
      summary.push({ table, skipped: `${column} does not exist` });
      continue;
    }

    const { rows } = await client.query(
      `SELECT ${column} AS unit, COUNT(*)::int AS n
       FROM ${table}
       WHERE ${column} IS NOT NULL
       GROUP BY ${column}`
    );

    let updated = 0;
    let alreadyCanonical = 0;
    let blank = 0;
    const unmapped = [];

    for (const row of rows) {
      const classified = classifyStoredUnit(row.unit);
      if (classified.kind === "empty") {
        blank += row.n;
        continue;
      }
      if (classified.kind === "unmapped") {
        unmapped.push({ value: classified.value, count: row.n });
        continue;
      }
      if (classified.kind === "canonical") {
        alreadyCanonical += row.n;
        continue;
      }

      const result = await client.query(
        `UPDATE ${table}
         SET ${column} = $1
         WHERE ${column} = $2`,
        [classified.value, row.unit]
      );
      updated += result.rowCount ?? row.n;
    }

    unmapped.sort((a, b) => String(a.value).localeCompare(String(b.value)));
    console.log(
      `${table}: updated ${updated}, already canonical ${alreadyCanonical}, unmapped ${unmapped.reduce((sum, row) => sum + row.count, 0)}`
    );
    for (const row of unmapped) {
      console.log(`  unmapped ${JSON.stringify(row.value)} (${row.count})`);
    }

    summary.push({
      table,
      updated,
      alreadyCanonical,
      blank,
      unmapped,
    });
  }

  return summary;
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
    await normalizeStoredUnitCodes(client);
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
