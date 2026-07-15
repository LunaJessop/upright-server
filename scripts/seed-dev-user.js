/**
 * Creates a demo client + founder user for local development.
 * Usage: node scripts/seed-dev-user.js
 * Default login: founder@demo.com / password123
 * Demo client is marked subscription_status=active (billing bypass).
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
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

const EMAIL = "founder@demo.com";
const PASSWORD = "password123";

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  let clientId;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const defaultClient = await client.query(
      "SELECT id FROM clients ORDER BY id ASC LIMIT 1"
    );
    if (defaultClient.rows.length === 0) {
      const inserted = await client.query(
        `INSERT INTO clients (name, slug, email, active, subscription_status)
         VALUES ($1, $2, $3, TRUE, 'active')
         RETURNING id`,
        ["Demo Company", "demo", EMAIL]
      );
      clientId = inserted.rows[0].id;
    } else {
      clientId = defaultClient.rows[0].id;
      await client.query(
        `UPDATE clients
         SET subscription_status = 'active',
             name = COALESCE(NULLIF(name, ''), 'Demo Company'),
             slug = COALESCE(slug, 'demo'),
             email = COALESCE(email, $2)
         WHERE id = $1`,
        [clientId, EMAIL]
      );
    }

    await client.query(
      `INSERT INTO users (client_id, name, email, password_hash, role, active)
       VALUES ($1, $2, $3, $4, 'founder', TRUE)
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role = EXCLUDED.role,
             client_id = EXCLUDED.client_id,
             active = TRUE`,
      [clientId, "Demo Founder", EMAIL, passwordHash]
    );

    await client.query("COMMIT");
    console.log("Seed complete.");
    console.log(`  Client id: ${clientId}`);
    console.log(`  Email:     ${EMAIL}`);
    console.log(`  Password:  ${PASSWORD}`);
    console.log("  Billing:   subscription_status=active (demo bypass)");
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
