/**
 * Creates tags + item_tags (many-to-many, per client).
 * Usage: node scripts/setup-tags.js
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
    `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [name]
  );
  return rows.length > 0;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (!(await tableExists(client, "tags"))) {
      await client.query(`
        CREATE TABLE tags (
          id SERIAL PRIMARY KEY,
          client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log("Created tags table");
    } else {
      console.log("tags table already exists");
    }

    if (!(await indexExists(client, "idx_tags_client_id"))) {
      await client.query(
        "CREATE INDEX idx_tags_client_id ON tags (client_id)"
      );
      console.log("Created idx_tags_client_id");
    }

    if (!(await indexExists(client, "tags_client_lower_name_uidx"))) {
      await client.query(`
        CREATE UNIQUE INDEX tags_client_lower_name_uidx
        ON tags (client_id, lower(name))
      `);
      console.log("Created tags_client_lower_name_uidx");
    }

    if (!(await tableExists(client, "item_tags"))) {
      await client.query(`
        CREATE TABLE item_tags (
          item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY (item_id, tag_id)
        )
      `);
      console.log("Created item_tags table");
    } else {
      console.log("item_tags table already exists");
    }

    if (!(await indexExists(client, "idx_item_tags_tag_id"))) {
      await client.query(
        "CREATE INDEX idx_item_tags_tag_id ON item_tags (tag_id)"
      );
      console.log("Created idx_item_tags_tag_id");
    }

    await client.query("COMMIT");
    console.log("Tags setup complete.");
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
