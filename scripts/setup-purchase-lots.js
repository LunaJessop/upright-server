/**
 * Creates purchase_lots (vendor lot receives for buy items).
 * Usage: node scripts/setup-purchase-lots.js
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

async function columnExists(client, table, column) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows.length > 0;
}

async function indexExists(client, name) {
  const { rows } = await client.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [name]
  );
  return rows.length > 0;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (!(await tableExists(client, "purchase_lots"))) {
      await client.query(`
        CREATE TABLE purchase_lots (
          id SERIAL PRIMARY KEY,
          client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
          item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          lot_number TEXT NOT NULL,
          quantity NUMERIC NOT NULL CHECK (quantity > 0),
          total_cost NUMERIC NOT NULL CHECK (total_cost >= 0),
          unit_cost NUMERIC NOT NULL CHECK (unit_cost >= 0),
          arrival_date DATE NOT NULL DEFAULT CURRENT_DATE,
          received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          created_by INTEGER REFERENCES users(id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log("Created purchase_lots table");
    } else {
      console.log("purchase_lots table already exists");
    }

    if (!(await columnExists(client, "purchase_lots", "total_cost"))) {
      await client.query(`
        ALTER TABLE purchase_lots
        ADD COLUMN total_cost NUMERIC
      `);
      await client.query(`
        UPDATE purchase_lots
        SET total_cost = quantity * unit_cost
        WHERE total_cost IS NULL
      `);
      await client.query(`
        ALTER TABLE purchase_lots
        ALTER COLUMN total_cost SET NOT NULL
      `);
      await client.query(`
        ALTER TABLE purchase_lots
        ADD CONSTRAINT purchase_lots_total_cost_check CHECK (total_cost >= 0)
      `);
      console.log("Added purchase_lots.total_cost (backfilled from qty × unit_cost)");
    }

    if (!(await columnExists(client, "purchase_lots", "arrival_date"))) {
      await client.query(`
        ALTER TABLE purchase_lots
        ADD COLUMN arrival_date DATE
      `);
      await client.query(`
        UPDATE purchase_lots
        SET arrival_date = COALESCE(received_at::date, CURRENT_DATE)
        WHERE arrival_date IS NULL
      `);
      await client.query(`
        ALTER TABLE purchase_lots
        ALTER COLUMN arrival_date SET DEFAULT CURRENT_DATE
      `);
      await client.query(`
        ALTER TABLE purchase_lots
        ALTER COLUMN arrival_date SET NOT NULL
      `);
      console.log("Added purchase_lots.arrival_date");
    }

    if (!(await indexExists(client, "idx_purchase_lots_item_id"))) {
      await client.query(
        "CREATE INDEX idx_purchase_lots_item_id ON purchase_lots (item_id)"
      );
      console.log("Created idx_purchase_lots_item_id");
    }

    if (!(await indexExists(client, "idx_purchase_lots_client_id"))) {
      await client.query(
        "CREATE INDEX idx_purchase_lots_client_id ON purchase_lots (client_id)"
      );
      console.log("Created idx_purchase_lots_client_id");
    }

    await client.query("COMMIT");
    console.log("Purchase lots setup complete.");
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
