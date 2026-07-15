/**
 * Creates item_routers, item_router_phases, and batch_phases tables.
 * Usage: node scripts/setup-item-routers.js
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

    if (!(await tableExists(client, "item_routers"))) {
      await client.query(`
        CREATE TABLE item_routers (
          id SERIAL PRIMARY KEY,
          client_id INTEGER NOT NULL REFERENCES clients(id),
          item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          name TEXT,
          active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (item_id)
        )
      `);
      await client.query(
        "CREATE INDEX idx_item_routers_client_id ON item_routers (client_id)"
      );
      console.log("Created item_routers table");
    }

    if (!(await tableExists(client, "item_router_phases"))) {
      await client.query(`
        CREATE TABLE item_router_phases (
          id SERIAL PRIMARY KEY,
          router_id INTEGER NOT NULL REFERENCES item_routers(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          estimated_minutes INTEGER,
          UNIQUE (router_id, sequence)
        )
      `);
      await client.query(
        "CREATE INDEX idx_item_router_phases_router_id ON item_router_phases (router_id)"
      );
      console.log("Created item_router_phases table");
    }

    if (!(await tableExists(client, "batch_phases"))) {
      await client.query(`
        CREATE TABLE batch_phases (
          id SERIAL PRIMARY KEY,
          batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          source_phase_id INTEGER REFERENCES item_router_phases(id) ON DELETE SET NULL,
          source_item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
          source_item_name TEXT,
          source_item_qty NUMERIC,
          group_order INTEGER,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'in_progress', 'complete', 'skipped')),
          started_at TIMESTAMP,
          completed_at TIMESTAMP,
          completed_by INTEGER REFERENCES users(id),
          UNIQUE (batch_id, sequence)
        )
      `);
      await client.query(
        "CREATE INDEX idx_batch_phases_batch_id ON batch_phases (batch_id)"
      );
      console.log("Created batch_phases table");
    }

    if (!(await tableExists(client, "batch_components"))) {
      await client.query(`
        CREATE TABLE batch_components (
          id SERIAL PRIMARY KEY,
          batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
          item_id INTEGER NOT NULL REFERENCES items(id),
          quantity_allocated NUMERIC,
          unit_of_measure TEXT
        )
      `);
      console.log("Created batch_components table");
    }

    await client.query("COMMIT");
    console.log("Item router schema ready.");
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
