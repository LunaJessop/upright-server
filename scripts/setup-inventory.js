/**
 * Ensures inventory table has unique (client_id, item_id)
 * and creates item_inventory_goals.
 * Usage: node scripts/setup-inventory.js
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

async function indexExists(client, name) {
  const { rows } = await client.query(
    `SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = $1`,
    [name]
  );
  return rows.length > 0;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (!(await tableExists(client, "inventory"))) {
      await client.query(`
        CREATE TABLE inventory (
          id SERIAL PRIMARY KEY,
          client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
          item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          location_id INTEGER,
          quantity NUMERIC NOT NULL DEFAULT 0,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (client_id, item_id)
        )
      `);
      await client.query(
        "CREATE INDEX idx_inventory_client_id ON inventory (client_id)"
      );
      await client.query(
        "CREATE INDEX idx_inventory_item_id ON inventory (item_id)"
      );
      console.log("Created inventory table");
    } else {
      console.log("inventory table already exists");

      // Deduplicate before unique index (keep highest quantity / latest row)
      await client.query(`
        DELETE FROM inventory a
        USING inventory b
        WHERE a.client_id = b.client_id
          AND a.item_id = b.item_id
          AND a.id < b.id
      `);

      if (!(await indexExists(client, "inventory_client_id_item_id_key"))) {
        // Prefer unique constraint name style
        const { rows: existing } = await client.query(`
          SELECT 1 FROM pg_constraint
          WHERE conname = 'inventory_client_id_item_id_key'
        `);
        if (existing.length === 0) {
          try {
            await client.query(`
              ALTER TABLE inventory
              ADD CONSTRAINT inventory_client_id_item_id_key
              UNIQUE (client_id, item_id)
            `);
            console.log("Added UNIQUE (client_id, item_id) on inventory");
          } catch (err) {
            if (err.code !== "23505" && err.code !== "42710") throw err;
            console.log("Inventory unique constraint already present");
          }
        }
      }
    }

    if (!(await tableExists(client, "item_inventory_goals"))) {
      await client.query(`
        CREATE TABLE item_inventory_goals (
          id SERIAL PRIMARY KEY,
          client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
          item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          goal_min NUMERIC NOT NULL DEFAULT 0,
          goal_max NUMERIC NOT NULL DEFAULT 0,
          updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (item_id),
          CHECK (goal_min >= 0 AND goal_max >= goal_min)
        )
      `);
      await client.query(
        "CREATE INDEX idx_item_inventory_goals_client_id ON item_inventory_goals (client_id)"
      );
      console.log("Created item_inventory_goals table");
    } else {
      console.log("item_inventory_goals table already exists");
    }

    await client.query("COMMIT");
    console.log("Inventory setup complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
