import { pool } from "../lib/db.js";
import { billingFieldsFromClient } from "../lib/billing.js";

const DEFAULT_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const ITEM_LIMIT = 100;
const VENDOR_LIMIT = 100;
const PHASE_LIMIT = 100;
const BATCH_LIMIT = 50;
const MEMBER_LIMIT = 100;

export function parseCustomerListQuery(query = {}) {
  const limitRaw = Number(query.limit);
  const offsetRaw = Number(query.offset);
  const limit =
    Number.isInteger(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, MAX_LIST_LIMIT)
      : DEFAULT_LIMIT;
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
  const q = String(query.q ?? query.search ?? "")
    .trim()
    .slice(0, 200);
  return { limit, offset, q };
}

function likePattern(q) {
  const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

function planFromPriceId(priceId) {
  if (!priceId) return null;
  const monthly =
    process.env.STRIPE_PRICE_ID_MONTHLY?.trim() ||
    process.env.STRIPE_PRICE_ID?.trim() ||
    "";
  const yearly = process.env.STRIPE_PRICE_ID_YEARLY?.trim() || "";
  if (monthly && priceId === monthly) return "monthly";
  if (yearly && priceId === yearly) return "yearly";
  return null;
}

function customerSummary(row) {
  const billing = billingFieldsFromClient(row);
  const companyUpdated = row.updated_at ? new Date(row.updated_at).getTime() : null;
  const usersUpdated = row.users_updated_at
    ? new Date(row.users_updated_at).getTime()
    : null;
  const stamps = [companyUpdated, usersUpdated].filter((n) => Number.isFinite(n));
  const lastActive = stamps.length > 0 ? new Date(Math.max(...stamps)) : null;

  return {
    id: row.id,
    name: row.name,
    slug: row.slug ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    active: row.active ?? true,
    signed_up_at: row.created_at ?? null,
    // Newest company or user row update. Login does not record a separate
    // last-seen time, so this is the closest timestamp already stored.
    last_active_at: lastActive,
    user_count: row.user_count ?? 0,
    item_count: row.item_count ?? 0,
    batch_count: row.batch_count ?? 0,
    subscription_status: billing.subscription_status,
    grace_days_remaining: billing.grace_days_remaining,
    plan: planFromPriceId(row.stripe_price_id),
    plan_price_id: billing.plan_price_id,
    current_period_end: row.current_period_end ?? null,
    has_app_access: billing.has_app_access,
    read_only: billing.read_only,
  };
}

const LIST_FROM = `
  FROM clients c
  WHERE (
    $1::text = ''
    OR c.name ILIKE $2 ESCAPE '\\'
    OR COALESCE(c.email, '') ILIKE $2 ESCAPE '\\'
    OR EXISTS (
      SELECT 1 FROM users u
      WHERE u.client_id = c.id
        AND (
          u.name ILIKE $2 ESCAPE '\\'
          OR u.email ILIKE $2 ESCAPE '\\'
        )
    )
  )
`;

export async function listAdminCustomers(req, res) {
  const { limit, offset, q } = parseCustomerListQuery(req.query);
  const pattern = q ? likePattern(q) : "";

  try {
    const [countResult, listResult] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total ${LIST_FROM}`, [q, pattern]),
      pool.query(
        `SELECT c.id, c.name, c.slug, c.email, c.phone, c.active,
                c.created_at, c.updated_at, c.current_period_end,
                c.subscription_status, c.past_due_started_at, c.stripe_price_id,
                (SELECT COUNT(*)::int FROM users u WHERE u.client_id = c.id) AS user_count,
                (SELECT COUNT(*)::int FROM items i WHERE i.client_id = c.id) AS item_count,
                (SELECT COUNT(*)::int FROM batches b WHERE b.client_id = c.id) AS batch_count,
                (SELECT MAX(u.updated_at) FROM users u WHERE u.client_id = c.id) AS users_updated_at
         ${LIST_FROM}
         ORDER BY c.created_at DESC NULLS LAST, c.id DESC
         LIMIT $3 OFFSET $4`,
        [q, pattern, limit, offset]
      ),
    ]);

    res.json({
      customers: listResult.rows.map(customerSummary),
      page: {
        limit,
        offset,
        total: countResult.rows[0]?.total ?? 0,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list customers" });
  }
}

function memberPayload(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active ?? true,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function section(rows, total, limit) {
  return { rows, total, limit };
}

export async function getAdminCustomer(req, res) {
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return res.status(400).json({ error: "Invalid customer id" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.slug, c.email, c.phone, c.active,
              c.created_at, c.updated_at, c.current_period_end,
              c.subscription_status, c.past_due_started_at, c.stripe_price_id,
              (SELECT COUNT(*)::int FROM users u WHERE u.client_id = c.id) AS user_count,
              (SELECT COUNT(*)::int FROM items i WHERE i.client_id = c.id) AS item_count,
              (SELECT COUNT(*)::int FROM batches b WHERE b.client_id = c.id) AS batch_count,
              (SELECT MAX(u.updated_at) FROM users u WHERE u.client_id = c.id) AS users_updated_at
       FROM clients c
       WHERE c.id = $1`,
      [customerId]
    );
    const client = rows[0];
    if (!client) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const [members, items, vendors, phases, batches] = await Promise.all([
      pool.query(
        `SELECT id, name, email, role, active, created_at, updated_at,
                COUNT(*) OVER ()::int AS total
         FROM users
         WHERE client_id = $1
         ORDER BY
           CASE role WHEN 'founder' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
           name ASC
         LIMIT $2`,
        [customerId, MEMBER_LIMIT]
      ),
      pool.query(
        `SELECT id, name, sku, make_or_buy, unit_of_measure, active, created_at,
                COUNT(*) OVER ()::int AS total
         FROM items
         WHERE client_id = $1
         ORDER BY name ASC, id ASC
         LIMIT $2`,
        [customerId, ITEM_LIMIT]
      ),
      pool.query(
        `SELECT id, name, email, phone, site_link, created_at,
                COUNT(*) OVER ()::int AS total
         FROM vendors
         WHERE client_id = $1
         ORDER BY name ASC, id ASC
         LIMIT $2`,
        [customerId, VENDOR_LIMIT]
      ),
      pool.query(
        `SELECT id, name, description, estimated_minutes, created_at,
                COUNT(*) OVER ()::int AS total
         FROM client_router_phase_templates
         WHERE client_id = $1
         ORDER BY name ASC, id ASC
         LIMIT $2`,
        [customerId, PHASE_LIMIT]
      ),
      pool.query(
        `SELECT b.id, b.sku, b.status, b.quantity, b.item_id,
                i.name AS item_name, b.created_at, b.updated_at,
                b.start_date, b.end_date,
                COUNT(*) OVER ()::int AS total
         FROM batches b
         LEFT JOIN items i ON i.id = b.item_id AND i.client_id = b.client_id
         WHERE b.client_id = $1
         ORDER BY b.created_at DESC NULLS LAST, b.id DESC
         LIMIT $2`,
        [customerId, BATCH_LIMIT]
      ),
    ]);

    const dropTotal = (row) => {
      const copy = { ...row };
      delete copy.total;
      return copy;
    };
    const totalOf = (result) => result.rows[0]?.total ?? 0;

    res.json({
      customer: {
        ...customerSummary(client),
        members: members.rows.map((row) => memberPayload(dropTotal(row))),
      },
      items: section(items.rows.map(dropTotal), totalOf(items), ITEM_LIMIT),
      vendors: section(vendors.rows.map(dropTotal), totalOf(vendors), VENDOR_LIMIT),
      phases: section(phases.rows.map(dropTotal), totalOf(phases), PHASE_LIMIT),
      batches: section(batches.rows.map(dropTotal), totalOf(batches), BATCH_LIMIT),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load customer" });
  }
}
