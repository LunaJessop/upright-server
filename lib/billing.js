import Stripe from "stripe";
import { pool } from "./db.js";

const GRACE_DAYS = Number(process.env.BILLING_GRACE_DAYS ?? 7);

let stripeClient = null;

export function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
  if (!stripeClient) {
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}

export function getFrontendUrl() {
  return (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** @typedef {'monthly' | 'yearly'} PlanKey */

export const PLAN_KEYS = /** @type {const} */ (["monthly", "yearly"]);

export function resolveStripePriceId(plan) {
  const key = String(plan ?? "monthly").toLowerCase();
  if (key === "yearly") {
    const yearly =
      process.env.STRIPE_PRICE_ID_YEARLY?.trim() ||
      process.env.STRIPE_PRICE_ID_ANNUAL?.trim();
    if (!yearly) {
      throw new Error(
        "STRIPE_PRICE_ID_YEARLY is not configured (create a $250/year Price in Stripe)"
      );
    }
    return yearly;
  }

  const monthly =
    process.env.STRIPE_PRICE_ID_MONTHLY?.trim() ||
    process.env.STRIPE_PRICE_ID?.trim();
  if (!monthly) {
    throw new Error("STRIPE_PRICE_ID (monthly) is not configured");
  }
  return monthly;
}

/** @deprecated use resolveStripePriceId('monthly') */
export function getStripePriceId() {
  return resolveStripePriceId("monthly");
}

export function passwordMeetsPolicy(password) {
  if (typeof password !== "string" || password.length < 8) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[^A-Za-z0-9]/.test(password)) return false;
  return true;
}

export function slugify(name) {
  const base = String(name ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "company";
}

export async function uniqueSlug(db, companyName) {
  const base = slugify(companyName);
  let candidate = base;
  let n = 0;
  for (;;) {
    const { rows } = await db.query(
      "SELECT 1 FROM clients WHERE slug = $1 LIMIT 1",
      [candidate]
    );
    if (rows.length === 0) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
}

export function graceDaysRemaining(clientRow) {
  if (!clientRow || clientRow.subscription_status !== "past_due") return null;
  if (!clientRow.past_due_started_at) return GRACE_DAYS;

  const started = new Date(clientRow.past_due_started_at).getTime();
  if (Number.isNaN(started)) return GRACE_DAYS;

  const ends = started + GRACE_DAYS * 24 * 60 * 60 * 1000;
  const remainingMs = ends - Date.now();
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
}

export function clientHasAppAccess(clientRow) {
  if (!clientRow) return false;
  const status = clientRow.subscription_status;

  if (status === "active") return true;

  if (status === "past_due") {
    const remaining = graceDaysRemaining(clientRow);
    return remaining === null || remaining > 0;
  }

  return false;
}

/** Browse/export allowed; mutations still need clientHasAppAccess. */
export function clientHasReadAccess(clientRow) {
  if (!clientRow) return false;
  if (clientHasAppAccess(clientRow)) return true;

  const status = clientRow.subscription_status;
  if (
    status === "canceled" ||
    status === "unpaid" ||
    status === "past_due"
  ) {
    return true;
  }

  return false;
}

export async function getClientBilling(clientId) {
  const { rows } = await pool.query(
    `SELECT id, name, email, stripe_customer_id, stripe_subscription_id,
            stripe_price_id, subscription_status, past_due_started_at,
            current_period_end, active
     FROM clients
     WHERE id = $1`,
    [clientId]
  );
  return rows[0] ?? null;
}

export function billingFieldsFromClient(clientRow) {
  const grace = graceDaysRemaining(clientRow);
  const canWrite = clientHasAppAccess(clientRow);
  const hasRead = clientHasReadAccess(clientRow);
  return {
    subscription_status: clientRow?.subscription_status ?? "incomplete",
    grace_days_remaining: grace,
    has_app_access: canWrite,
    has_read_access: hasRead,
    can_write: canWrite,
    read_only: hasRead && !canWrite,
    plan_price_id: clientRow?.stripe_price_id ?? null,
  };
}

export async function requireActiveSubscription(req, res, next) {
  try {
    const client = await getClientBilling(req.auth.clientId);
    if (!clientHasAppAccess(client)) {
      const hasRead = clientHasReadAccess(client);
      return res.status(402).json({
        error: hasRead
          ? "Subscription inactive — account is read-only"
          : "Payment required to access this resource",
        code: hasRead ? "subscription_read_only" : "payment_required",
        subscription_status: client?.subscription_status ?? "incomplete",
        grace_days_remaining: graceDaysRemaining(client),
      });
    }
    req.billing = client;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to verify subscription" });
  }
}

export async function requireReadableSubscription(req, res, next) {
  try {
    const client = await getClientBilling(req.auth.clientId);
    if (!clientHasReadAccess(client)) {
      return res.status(402).json({
        error: "Payment required to access this resource",
        code: "payment_required",
        subscription_status: client?.subscription_status ?? "incomplete",
        grace_days_remaining: graceDaysRemaining(client),
      });
    }
    req.billing = client;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to verify subscription" });
  }
}

export function requireFounder(req, res, next) {
  if (req.auth?.role !== "founder") {
    return res.status(403).json({ error: "Founder role required" });
  }
  next();
}

const ROLE_RANK = { founder: 3, admin: 2, user: 1 };

export function requireAdminOrFounder(req, res, next) {
  const rank = ROLE_RANK[req.auth?.role] ?? 0;
  if (rank < ROLE_RANK.admin) {
    return res.status(403).json({ error: "Admin or founder role required" });
  }
  next();
}

export async function createCheckoutSessionForClient(clientRow, plan = "monthly") {
  const stripe = getStripe();
  const priceId = resolveStripePriceId(plan);
  const frontendUrl = getFrontendUrl();

  let customerId = clientRow.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: clientRow.email || undefined,
      name: clientRow.name || undefined,
      metadata: { client_id: String(clientRow.id) },
    });
    customerId = customer.id;
    await pool.query(
      `UPDATE clients
       SET stripe_customer_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [customerId, clientRow.id]
    );
  }

  await pool.query(
    `UPDATE clients
     SET stripe_price_id = $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [priceId, clientRow.id]
  );

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${frontendUrl}/register/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl}/register/plan`,
    client_reference_id: String(clientRow.id),
    metadata: { client_id: String(clientRow.id), plan: String(plan) },
    subscription_data: {
      metadata: { client_id: String(clientRow.id), plan: String(plan) },
    },
  });

  return session;
}

export async function createPortalSessionForClient(clientRow) {
  if (!clientRow.stripe_customer_id) {
    throw new Error("No Stripe customer on this account");
  }
  const stripe = getStripe();
  const frontendUrl = getFrontendUrl();
  return stripe.billingPortal.sessions.create({
    customer: clientRow.stripe_customer_id,
    return_url: `${frontendUrl}/items`,
  });
}

export function periodEndFromSubscription(subscription) {
  const end = subscription?.current_period_end;
  if (!end) return null;
  return new Date(end * 1000);
}
