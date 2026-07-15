/**
 * Adds batches.sku and client_router_phase_templates table.
 * Usage: node scripts/setup-batch-sku-and-templates.js
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

    if (!(await columnExists(client, "batches", "sku"))) {
      await client.query("ALTER TABLE batches ADD COLUMN sku TEXT");
      console.log("Added batches.sku");
    }

    if (!(await tableExists(client, "client_router_phase_templates"))) {
      await client.query(`
        CREATE TABLE client_router_phase_templates (
          id SERIAL PRIMARY KEY,
          client_id INTEGER NOT NULL REFERENCES clients(id),
          name TEXT NOT NULL,
          description TEXT,
          estimated_minutes INTEGER,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (client_id, name)
        )
      `);
      await client.query(
        "CREATE INDEX idx_client_router_phase_templates_client_id ON client_router_phase_templates (client_id)"
      );
      console.log("Created client_router_phase_templates table");
    }

    await client.query("COMMIT");
    console.log("Batch SKU and router templates schema ready.");

    // Backfill templates from existing item routers
    const client2 = await pool.connect();
    try {
      const { rowCount } = await client2.query(`
        INSERT INTO client_router_phase_templates (client_id, name, description, estimated_minutes)
        SELECT DISTINCT r.client_id, p.name, p.description, p.estimated_minutes
        FROM item_router_phases p
        JOIN item_routers r ON r.id = p.router_id
        ON CONFLICT (client_id, name) DO NOTHING
      `);
      console.log(`Backfilled ${rowCount ?? 0} phase templates from existing routers.`);
    } finally {
      client2.release();
    }
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
