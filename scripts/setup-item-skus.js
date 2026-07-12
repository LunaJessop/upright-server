/**
 * Creates item_skus table and makes items.sku optional (vendor part # for buy items).
 * Usage: node scripts/setup-item-skus.js
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

    await client.query("ALTER TABLE items ALTER COLUMN sku DROP NOT NULL");

    await client.query(`
      ALTER TABLE items DROP CONSTRAINT IF EXISTS items_client_id_sku_key
    `);
    await client.query(`
      DROP INDEX IF EXISTS items_client_vendor_sku
    `);
    await client.query(`
      CREATE UNIQUE INDEX items_client_vendor_sku
        ON items (client_id, sku)
        WHERE sku IS NOT NULL AND sku <> ''
    `);

    if (!(await tableExists(client, "batches"))) {
      await client.query(`
        CREATE TABLE batches (
          id SERIAL PRIMARY KEY,
          client_id INTEGER NOT NULL REFERENCES clients(id),
          item_id INTEGER NOT NULL REFERENCES items(id),
          quantity NUMERIC NOT NULL,
          status TEXT DEFAULT 'planned',
          start_date TIMESTAMP,
          end_date TIMESTAMP,
          created_by INTEGER REFERENCES users(id),
          updated_by INTEGER REFERENCES users(id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log("Created batches table");
    }

    if (!(await tableExists(client, "item_skus"))) {
      await client.query(`
        CREATE TABLE item_skus (
          id SERIAL PRIMARY KEY,
          client_id INTEGER NOT NULL REFERENCES clients(id),
          item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          sku TEXT NOT NULL,
          batch_id INTEGER REFERENCES batches(id),
          source TEXT CHECK (source IN ('purchase', 'production')),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (client_id, sku)
        )
      `);
      await client.query("CREATE INDEX idx_item_skus_item_id ON item_skus (item_id)");
      await client.query("CREATE INDEX idx_item_skus_client_id ON item_skus (client_id)");
      console.log("Created item_skus table");
    }

    await client.query("UPDATE items SET sku = NULL WHERE make_or_buy = 'make'");

    await client.query("COMMIT");
    console.log("Item SKU schema ready.");
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
