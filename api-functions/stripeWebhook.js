import { pool } from "../lib/db.js";
import {
  cancelAndRefundDuplicateSubscription,
  getStripe,
  isLiveSubscriptionStatus,
  liveSubscriptionStatusSqlList,
  periodEndFromSubscription,
} from "../lib/billing.js";
import { sendEmail } from "../lib/email/index.js";

function subscriptionGuard(paramIndex) {
  return `(
    stripe_subscription_id IS NULL
    OR stripe_subscription_id = $${paramIndex}
    OR subscription_status NOT IN (${liveSubscriptionStatusSqlList()})
  )`;
}

/**
 * Write subscription fields only when this event belongs to the subscription
 * already on the account, or the account has no live subscription yet.
 * A lost race or a second subscription returns no row.
 */
async function updateClientSubscription(clientId, sql, params, subscription) {
  const result = await pool.query(sql, params);
  if (result.rows?.length > 0) return true;
  await handleUnclaimedSubscription(clientId, subscription);
  return false;
}

function formatMoney(amountCents, currency = "usd") {
  const cents = Number(amountCents);
  if (!Number.isFinite(cents) || cents <= 0) return null;
  const code = String(currency || "usd").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}

async function loadBillingRecipient(clientId) {
  const { rows } = await pool.query(
    `SELECT
       u.id AS user_id,
       u.email,
       u.name,
       c.name AS company_name
     FROM clients c
     JOIN users u ON u.client_id = c.id AND u.active = TRUE
     WHERE c.id = $1
     ORDER BY CASE u.role WHEN 'founder' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.id
     LIMIT 1`,
    [clientId]
  );
  return rows[0] ?? null;
}

async function notifyBilling(clientId, template, data) {
  try {
    const recipient = await loadBillingRecipient(clientId);
    if (!recipient?.email) return;
    await sendEmail({
      to: recipient.email,
      template,
      data: {
        name: recipient.name,
        companyName: recipient.company_name,
        ...data,
      },
      clientId,
      userId: recipient.user_id,
    });
  } catch (err) {
    console.error("Billing email failed:", err);
  }
}

async function handleUnclaimedSubscription(clientId, subscription) {
  const incomingId = subscription?.id ?? null;
  const { rows } = await pool.query(
    `SELECT stripe_subscription_id, subscription_status
     FROM clients
     WHERE id = $1`,
    [clientId]
  );
  const row = rows[0];
  if (!row) {
    console.warn(
      "Stripe subscription event for missing client",
      clientId,
      incomingId
    );
    return;
  }

  const keptId = row.stripe_subscription_id;
  const differentLive =
    incomingId &&
    keptId &&
    keptId !== incomingId &&
    isLiveSubscriptionStatus(row.subscription_status);

  if (!differentLive) {
    console.error(
      `Stripe subscription ${incomingId ?? "?"} (${subscription?.status ?? "?"}) for client ${clientId} was not saved.`
    );
    return;
  }

  if (!isLiveSubscriptionStatus(subscription?.status)) {
    console.error(
      `Ignoring ${subscription?.status ?? "unknown"} subscription ${incomingId} for client ${clientId}; keeping ${keptId}.`
    );
    return;
  }

  console.error(
    `Duplicate Stripe subscription ${incomingId} for client ${clientId}; keeping ${keptId}. Canceling and refunding the duplicate.`
  );
  await cancelAndRefundDuplicateSubscription(getStripe(), subscription);
}

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

  return updateClientSubscription(
    clientId,
    `UPDATE clients SET
       stripe_subscription_id = COALESCE($2, stripe_subscription_id),
       stripe_price_id = COALESCE($3, stripe_price_id),
       subscription_status = 'active',
       past_due_started_at = NULL,
       current_period_end = $4,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
       AND ${subscriptionGuard(2)}
     RETURNING id`,
    [
      clientId,
      subscription?.id ?? null,
      priceId,
      periodEndFromSubscription(subscription),
    ],
    subscription
  );
}

async function syncSubscription(subscription) {
  const clientId = await findClientIdFromSubscription(subscription);
  if (!clientId) {
    console.warn("No client for subscription", subscription?.id);
    return { clientId: null, saved: false };
  }

  const status = subscription.status;
  const priceId = subscription?.items?.data?.[0]?.price?.id ?? null;
  const periodEnd = periodEndFromSubscription(subscription);

  if (status === "active" || status === "trialing") {
    const saved = await markActive(clientId, subscription);
    return { clientId, saved };
  }

  if (status === "past_due" || status === "unpaid") {
    const saved = await updateClientSubscription(
      clientId,
      `UPDATE clients SET
         stripe_subscription_id = $2,
         stripe_price_id = COALESCE($3, stripe_price_id),
         subscription_status = $4,
         past_due_started_at = COALESCE(past_due_started_at, CURRENT_TIMESTAMP),
         current_period_end = $5,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND ${subscriptionGuard(2)}
       RETURNING id`,
      [clientId, subscription.id, priceId, status, periodEnd],
      subscription
    );
    return { clientId, saved };
  }

  if (status === "canceled" || status === "incomplete_expired") {
    const saved = await updateClientSubscription(
      clientId,
      `UPDATE clients SET
         stripe_subscription_id = $2,
         stripe_price_id = COALESCE($3, stripe_price_id),
         subscription_status = 'canceled',
         past_due_started_at = NULL,
         current_period_end = $4,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND ${subscriptionGuard(2)}
       RETURNING id`,
      [clientId, subscription.id, priceId, periodEnd],
      { ...subscription, status: "canceled" }
    );
    return { clientId, saved };
  }

  return { clientId, saved: false };
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
    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription.id;
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
  }

  await updateClientSubscription(
    clientId,
    `UPDATE clients SET
       stripe_customer_id = COALESCE($2, stripe_customer_id),
       stripe_subscription_id = COALESCE($3, stripe_subscription_id),
       stripe_price_id = COALESCE($4, stripe_price_id),
       subscription_status = 'active',
       past_due_started_at = NULL,
       current_period_end = $5,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
       AND ${subscriptionGuard(3)}
     RETURNING id`,
    [
      clientId,
      session.customer ?? null,
      subscription?.id ?? null,
      subscription?.items?.data?.[0]?.price?.id ??
        process.env.STRIPE_PRICE_ID?.trim() ??
        null,
      periodEndFromSubscription(subscription),
    ],
    subscription
  );
}

async function handleInvoicePaymentFailed(invoice) {
  const customerId = invoice.customer;
  const clientId = await findClientIdFromCustomer(customerId);
  if (!clientId) return;

  const subscriptionId =
    typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription?.id ?? null;

  const saved = await updateClientSubscription(
    clientId,
    `UPDATE clients SET
       subscription_status = 'past_due',
       past_due_started_at = COALESCE(past_due_started_at, CURRENT_TIMESTAMP),
       stripe_subscription_id = COALESCE($2, stripe_subscription_id),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
       AND ${subscriptionGuard(2)}
     RETURNING id`,
    [clientId, subscriptionId],
    {
      id: subscriptionId,
      status: "past_due",
      latest_invoice: invoice.id ?? null,
    }
  );
  if (!saved) return;
  await notifyBilling(clientId, "payment_failed", {
    amount: formatMoney(invoice.amount_due, invoice.currency),
  });
}

async function handleInvoicePaid(invoice) {
  const clientId = await findClientIdFromCustomer(invoice.customer);
  if (!clientId) return;
  const amount = formatMoney(invoice.amount_paid, invoice.currency);
  if (!amount) return;
  await notifyBilling(clientId, "payment_succeeded", {
    amount,
    invoiceNumber: invoice.number ?? null,
    receiptUrl: invoice.hosted_invoice_url ?? null,
  });
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
      case "customer.subscription.deleted": {
        const outcome = await syncSubscription({
          ...event.data.object,
          status: "canceled",
        });
        if (outcome.saved) {
          await notifyBilling(outcome.clientId, "subscription_canceled", {});
        }
        break;
      }
      case "invoice.paid":
        await handleInvoicePaid(event.data.object);
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
