/**
 * One-time setup: clients + users tables, organization_id → client_id on items.
 * Usage: node scripts/setup-auth-schema.js
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

    if (!(await tableExists(client, "clients"))) {
      if (await tableExists(client, "organizations")) {
        await client.query("ALTER TABLE organizations RENAME TO clients");
        console.log("Renamed organizations → clients");
      } else {
        await client.query(`
          CREATE TABLE clients (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT UNIQUE,
            email TEXT,
            phone TEXT,
            active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
        console.log("Created clients table");
      }
    }

    const { rows: clientRows } = await client.query("SELECT id FROM clients ORDER BY id LIMIT 1");
    if (clientRows.length === 0) {
      await client.query(
        `INSERT INTO clients (name, slug, active) VALUES ('Default Company', 'default', TRUE)`
      );
      console.log("Inserted default client");
    }

    if (!(await tableExists(client, "users"))) {
      await client.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          client_id INTEGER NOT NULL REFERENCES clients(id),
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('founder', 'admin', 'user')),
          active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log("Created users table");
    } else {
      await client.query(`
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check
      `);
      await client.query(`
        ALTER TABLE users ADD CONSTRAINT users_role_check
          CHECK (role IN ('founder', 'admin', 'user'))
      `);
    }

    if (await tableExists(client, "items")) {
      if (await columnExists(client, "items", "organization_id")) {
        await client.query("ALTER TABLE items RENAME COLUMN organization_id TO client_id");
        console.log("Renamed items.organization_id → client_id");
      }

      const { rows: orphanItems } = await client.query(
        "SELECT COUNT(*)::int AS n FROM items WHERE client_id IS NULL"
      );
      if (orphanItems[0].n > 0) {
        const { rows: defaultClient } = await client.query(
          "SELECT id FROM clients ORDER BY id LIMIT 1"
        );
        await client.query("UPDATE items SET client_id = $1 WHERE client_id IS NULL", [
          defaultClient[0].id,
        ]);
      }
    }

    await client.query("COMMIT");
    console.log("Auth schema setup complete.");
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
