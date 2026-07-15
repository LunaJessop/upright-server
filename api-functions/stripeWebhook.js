import { pool } from "../lib/db.js";
import {
  getStripe,
  periodEndFromSubscription,
} from "../lib/billing.js";

async function findClientIdFromCustomer(customerId) {
  if (!customerId) return null;
  const { rows } = await pool.query(
    `SELECT id FROM clients WHERE stripe_customer_id = $1 LIMIT 1`,
    [customerId]
  );
  return rows[0]?.id ?? null;
}

async function findClientIdFromSubscription(subscription) {
  const metaId = subscription?.metadata?.client_id;
  if (metaId) {
    const n = Number(metaId);
    if (Number.isFinite(n)) return n;
  }
  return findClientIdFromCustomer(subscription?.customer);
}

async function markActive(clientId, subscription) {
  const priceId =
    subscription?.items?.data?.[0]?.price?.id ??
    process.env.STRIPE_PRICE_ID?.trim() ??
    null;

  await pool.query(
    `UPDATE clients SET
       stripe_subscription_id = COALESCE($2, stripe_subscription_id),
       stripe_price_id = COALESCE($3, stripe_price_id),
       subscription_status = 'active',
       past_due_started_at = NULL,
       current_period_end = $4,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      clientId,
      subscription?.id ?? null,
      priceId,
      periodEndFromSubscription(subscription),
    ]
  );
}

async function syncSubscription(subscription) {
  const clientId = await findClientIdFromSubscription(subscription);
  if (!clientId) {
    console.warn("No client for subscription", subscription?.id);
    return;
  }

  const status = subscription.status;
  const priceId = subscription?.items?.data?.[0]?.price?.id ?? null;
  const periodEnd = periodEndFromSubscription(subscription);

  if (status === "active" || status === "trialing") {
    await markActive(clientId, subscription);
    return;
  }

  if (status === "past_due" || status === "unpaid") {
    await pool.query(
      `UPDATE clients SET
         stripe_subscription_id = $2,
         stripe_price_id = COALESCE($3, stripe_price_id),
         subscription_status = $4,
         past_due_started_at = COALESCE(past_due_started_at, CURRENT_TIMESTAMP),
         current_period_end = $5,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [clientId, subscription.id, priceId, status, periodEnd]
    );
    return;
  }

  if (status === "canceled" || status === "incomplete_expired") {
    await pool.query(
      `UPDATE clients SET
         stripe_subscription_id = $2,
         stripe_price_id = COALESCE($3, stripe_price_id),
         subscription_status = 'canceled',
         past_due_started_at = NULL,
         current_period_end = $4,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [clientId, subscription.id, priceId, periodEnd]
    );
  }
}

async function handleCheckoutCompleted(session) {
  const clientId =
    Number(session.client_reference_id || session.metadata?.client_id) ||
    (await findClientIdFromCustomer(session.customer));

  if (!clientId) {
    console.warn("checkout.session.completed: no client", session.id);
    return;
  }

  const stripe = getStripe();
  let subscription = null;
  if (session.subscription) {
    subscription = await stripe.subscriptions.retrieve(session.subscription);
  }

  await pool.query(
    `UPDATE clients SET
       stripe_customer_id = COALESCE($2, stripe_customer_id),
       stripe_subscription_id = COALESCE($3, stripe_subscription_id),
       stripe_price_id = COALESCE($4, stripe_price_id),
       subscription_status = 'active',
       past_due_started_at = NULL,
       current_period_end = $5,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      clientId,
      session.customer ?? null,
      subscription?.id ?? session.subscription ?? null,
      subscription?.items?.data?.[0]?.price?.id ??
        process.env.STRIPE_PRICE_ID?.trim() ??
        null,
      periodEndFromSubscription(subscription),
    ]
  );
}

async function handleInvoicePaymentFailed(invoice) {
  const customerId = invoice.customer;
  const clientId = await findClientIdFromCustomer(customerId);
  if (!clientId) return;

  await pool.query(
    `UPDATE clients SET
       subscription_status = 'past_due',
       past_due_started_at = COALESCE(past_due_started_at, CURRENT_TIMESTAMP),
       stripe_subscription_id = COALESCE($2, stripe_subscription_id),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [clientId, invoice.subscription ?? null]
  );
}

export async function stripeWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET is not configured");
    return res.status(503).json({ error: "Webhook not configured" });
  }

  const signature = req.headers["stripe-signature"];
  let event;

  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(req.body, signature, secret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object);
        break;
      case "customer.subscription.updated":
        await syncSubscription(event.data.object);
        break;
      case "customer.subscription.deleted":
        await syncSubscription({
          ...event.data.object,
          status: "canceled",
        });
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event.data.object);
        break;
      default:
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.status(500).json({ error: "Webhook handler failed" });
  }
}
