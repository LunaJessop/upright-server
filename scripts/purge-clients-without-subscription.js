/**
 * Purge clients that never completed a Stripe subscription
 * (stripe_subscription_id IS NULL), including all tenant data.
 *
 * Usage:
 *   node scripts/purge-clients-without-subscription.js          # dry-run
 *   node scripts/purge-clients-without-subscription.js --execute
 *
 * Optional:
 *   --keep-ids=1,2     Skip these client ids even if they match
 *   --ids=16,18        Purge only these client ids (ignores subscription filter)
 */
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const execute = process.argv.includes("--execute");
const keepArg = process.argv.find((a) => a.startsWith("--keep-ids="));
const keepIds = new Set(
  (keepArg?.slice("--keep-ids=".length) ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
);
const idsArg = process.argv.find((a) => a.startsWith("--ids="));
const onlyIds = (idsArg?.slice("--ids=".length) ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

const pool = new Pool({
  connectionString,
  ...(connectionString.includes("neon.tech")
    ? { ssl: { rejectUnauthorized: true } }
    : {}),
});

async function listTargets(db) {
  if (onlyIds.length > 0) {
    const { rows } = await db.query(
      `SELECT
         c.id,
         c.name,
         c.email,
         c.subscription_status,
         c.stripe_customer_id IS NOT NULL AS has_customer,
         (SELECT COUNT(*)::int FROM users u WHERE u.client_id = c.id) AS users,
         (SELECT COUNT(*)::int FROM items i WHERE i.client_id = c.id) AS items,
         (SELECT COUNT(*)::int FROM batches b WHERE b.client_id = c.id) AS batches
       FROM clients c
       WHERE c.id = ANY($1::int[])
       ORDER BY c.id`,
      [onlyIds]
    );
    return rows.filter((row) => !keepIds.has(row.id));
  }

  const { rows } = await db.query(
    `SELECT
       c.id,
       c.name,
       c.email,
       c.subscription_status,
       c.stripe_customer_id IS NOT NULL AS has_customer,
       (SELECT COUNT(*)::int FROM users u WHERE u.client_id = c.id) AS users,
       (SELECT COUNT(*)::int FROM items i WHERE i.client_id = c.id) AS items,
       (SELECT COUNT(*)::int FROM batches b WHERE b.client_id = c.id) AS batches
     FROM clients c
     WHERE c.stripe_subscription_id IS NULL
     ORDER BY c.id`
  );
  return rows.filter((row) => !keepIds.has(row.id));
}

async function purgeClient(db, clientId) {
  // Drop user FKs that block deletes
  await db.query(
    `UPDATE items SET created_by = NULL, updated_by = NULL WHERE client_id = $1`,
    [clientId]
  );
  await db.query(
    `UPDATE purchase_lots SET created_by = NULL WHERE client_id = $1`,
    [clientId]
  );
  await db.query(
    `UPDATE batch_phases bp
     SET completed_by = NULL
     FROM batches b
     WHERE b.id = bp.batch_id AND b.client_id = $1`,
    [clientId]
  );
  await db.query(
    `UPDATE batches SET created_by = NULL, updated_by = NULL WHERE client_id = $1`,
    [clientId]
  );

  // item_skus.batch_id is NO ACTION
  await db.query(
    `UPDATE item_skus SET batch_id = NULL WHERE client_id = $1`,
    [clientId]
  );
  await db.query(`DELETE FROM batches WHERE client_id = $1`, [clientId]);

  await db.query(
    `DELETE FROM bom_items
     WHERE parent_item_id IN (SELECT id FROM items WHERE client_id = $1)
        OR component_item_id IN (SELECT id FROM items WHERE client_id = $1)`,
    [clientId]
  );

  await db.query(`DELETE FROM item_skus WHERE client_id = $1`, [clientId]);
  await db.query(`DELETE FROM item_routers WHERE client_id = $1`, [clientId]);
  await db.query(`DELETE FROM purchase_lots WHERE client_id = $1`, [clientId]);
  await db.query(`DELETE FROM items WHERE client_id = $1`, [clientId]);
  await db.query(
    `DELETE FROM client_router_phase_templates WHERE client_id = $1`,
    [clientId]
  );
  await db.query(`DELETE FROM users WHERE client_id = $1`, [clientId]);

  // Cascades: inventory, goals, tags, vendors, remaining purchase_lots
  await db.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
}

async function main() {
  const client = await pool.connect();
  try {
    const targets = await listTargets(client);

    if (targets.length === 0) {
      console.log("No clients match (stripe_subscription_id IS NULL).");
      return;
    }

    console.log(
      execute
        ? `Purging ${targets.length} client(s)…`
        : onlyIds.length > 0
          ? `Dry-run: ${targets.length} client(s) from --ids (pass --execute to delete):\n`
          : `Dry-run: ${targets.length} client(s) would be purged (pass --execute to delete):\n`
    );
    console.table(
      targets.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        status: row.subscription_status,
        has_customer: row.has_customer,
        users: row.users,
        items: row.items,
        batches: row.batches,
      }))
    );

    if (keepIds.size > 0) {
      console.log(`Keeping ids: ${[...keepIds].join(", ")}`);
    }

    if (!execute) {
      console.log("\nRe-run with --execute to permanently delete these clients and their data.");
      return;
    }

    await client.query("BEGIN");
    for (const row of targets) {
      await purgeClient(client, row.id);
      console.log(`Deleted client ${row.id} (${row.name})`);
    }
    await client.query("COMMIT");
    console.log(`\nDone. Purged ${targets.length} client(s).`);
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
