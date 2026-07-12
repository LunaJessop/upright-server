/**
 * Enforces multi-tenant item scoping at the database level.
 * Usage: node scripts/enforce-item-client-scoping.js
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

async function constraintExists(client, name) {
  const { rows } = await client.query(
    "SELECT 1 FROM pg_constraint WHERE conname = $1",
    [name]
  );
  return rows.length > 0;
}

async function indexExists(client, name) {
  const { rows } = await client.query(
    "SELECT 1 FROM pg_indexes WHERE indexname = $1",
    [name]
  );
  return rows.length > 0;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const orphans = await client.query(
      `SELECT COUNT(*)::int AS n FROM items i
       WHERE NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = i.client_id)`
    );
    if (orphans.rows[0].n > 0) {
      const { rows: defaultClient } = await client.query(
        "SELECT id FROM clients ORDER BY id ASC LIMIT 1"
      );
      await client.query(
        `UPDATE items SET client_id = $1
         WHERE NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = items.client_id)`,
        [defaultClient[0].id]
      );
      console.log(`Repaired ${orphans.rows[0].n} item(s) with invalid client_id`);
    }

    if (!(await constraintExists(client, "items_client_id_fkey"))) {
      await client.query(`
        ALTER TABLE items
          ADD CONSTRAINT items_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients(id)
      `);
      console.log("Added items.client_id foreign key");
    }

    if (!(await indexExists(client, "idx_items_client_id"))) {
      await client.query("CREATE INDEX idx_items_client_id ON items (client_id)");
      console.log("Added idx_items_client_id");
    }

    if (!(await constraintExists(client, "items_client_id_sku_key"))) {
      await client.query(`
        ALTER TABLE items
          ADD CONSTRAINT items_client_id_sku_key UNIQUE (client_id, sku)
      `);
      console.log("Added unique (client_id, sku)");
    }

    await client.query("COMMIT");
    console.log("Item client scoping enforced.");
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
