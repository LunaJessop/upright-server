import { pool } from "../lib/db.js";
import { billingFieldsFromClient } from "../lib/billing.js";

export async function listClients(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.slug, c.email, c.phone, c.active, c.created_at,
              c.subscription_status, c.past_due_started_at, c.stripe_price_id,
              c.stripe_customer_id, c.stripe_subscription_id, c.current_period_end,
              (
                SELECT COUNT(*)::int FROM users u WHERE u.client_id = c.id
              ) AS user_count
       FROM clients c
       ORDER BY c.created_at DESC NULLS LAST, c.id DESC`
    );

    const clients = rows.map((row) => {
      const billing = billingFieldsFromClient(row);
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        email: row.email,
        phone: row.phone,
        active: row.active,
        created_at: row.created_at,
        user_count: row.user_count ?? 0,
        subscription_status: billing.subscription_status,
        grace_days_remaining: billing.grace_days_remaining,
        has_app_access: billing.has_app_access,
        has_read_access: billing.has_read_access,
        read_only: billing.read_only,
        plan_price_id: billing.plan_price_id,
        stripe_customer_id: row.stripe_customer_id ?? null,
        stripe_subscription_id: row.stripe_subscription_id ?? null,
        current_period_end: row.current_period_end ?? null,
      };
    });

    res.json({ clients });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list clients" });
  }
}
