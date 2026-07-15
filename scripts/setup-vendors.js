/**
 * Creates vendors table and links items.vendor to it.
 * Usage: node scripts/setup-vendors.js
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

async function constraintExists(client, name) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema = 'public' AND constraint_name = $1`,
    [name]
  );
  return rows.length > 0;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (!(await tableExists(client, "vendors"))) {
      await client.query(`
        CREATE TABLE vendors (
          id SERIAL PRIMARY KEY,
          client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          email TEXT,
          site_link TEXT,
          phone TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (client_id, name)
        )
      `);
      await client.query(
        "CREATE INDEX idx_vendors_client_id ON vendors (client_id)"
      );
      console.log("Created vendors table");
    } else {
      console.log("vendors table already exists");
    }

    // Drop placeholder vendor ids that aren't real vendor rows
    await client.query(`
      UPDATE items
      SET vendor = NULL
      WHERE vendor IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM vendors v
          WHERE v.id = items.vendor AND v.client_id = items.client_id
        )
    `);

    if (!(await constraintExists(client, "items_vendor_fkey"))) {
      await client.query(`
        ALTER TABLE items
        ADD CONSTRAINT items_vendor_fkey
        FOREIGN KEY (vendor) REFERENCES vendors(id) ON DELETE SET NULL
      `);
      console.log("Added items.vendor → vendors(id) FK");
    } else {
      console.log("items_vendor_fkey already exists");
    }

    await client.query("COMMIT");
    console.log("Vendors setup complete.");
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
