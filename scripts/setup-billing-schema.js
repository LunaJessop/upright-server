/**
 * Adds Stripe billing columns on clients.
 * Usage: node scripts/setup-billing-schema.js
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

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const columns = [
      ["stripe_customer_id", "TEXT UNIQUE"],
      ["stripe_subscription_id", "TEXT"],
      ["stripe_price_id", "TEXT"],
      ["subscription_status", "TEXT NOT NULL DEFAULT 'incomplete'"],
      ["past_due_started_at", "TIMESTAMP NULL"],
      ["current_period_end", "TIMESTAMP NULL"],
    ];

    for (const [name, definition] of columns) {
      if (!(await columnExists(client, "clients", name))) {
        await client.query(
          `ALTER TABLE clients ADD COLUMN ${name} ${definition}`
        );
        console.log(`Added clients.${name}`);
      } else {
        console.log(`clients.${name} already exists`);
      }
    }

    // Existing clients (e.g. demo) stay usable without Checkout.
    await client.query(
      `UPDATE clients
       SET subscription_status = 'active'
       WHERE subscription_status = 'incomplete'
         AND stripe_customer_id IS NULL`
    );

    await client.query("COMMIT");
    console.log("Billing schema setup complete.");
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
