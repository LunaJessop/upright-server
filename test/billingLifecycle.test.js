import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_billing_lifecycle_test";
process.env.STRIPE_SECRET_KEY ??= "sk_test_lifecycle";
process.env.STRIPE_PRICE_ID ??= "price_monthly";
process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test";
process.env.FRONTEND_URL ??= "https://uprightmrp.netlify.app";

const { pool } = await import("../lib/db.js");
const { setStripeClientForTests } = await import("../lib/billing.js");
const { createCheckout } = await import("../api-functions/billing.js");
const { stripeWebhook } = await import("../api-functions/stripeWebhook.js");

pool.options.connectionTimeoutMillis = 500;

const PERIOD_END = 1_800_000_000;
const LIVE = new Set([
  "active",
  "trialing",
  "past_due",
  "incomplete",
  "unpaid",
  "paused",
]);

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

function guardAllows(row, subscriptionId) {
  if (!row.stripe_subscription_id) return true;
  if (!subscriptionId) return false;
  if (row.stripe_subscription_id === subscriptionId) return true;
  return !LIVE.has(row.subscription_status);
}

function applyUpdate(row, sql, params) {
  if (sql.includes("stripe_customer_id = COALESCE") && sql.includes("subscription_status = 'active'")) {
    if (!guardAllows(row, params[2])) return false;
    row.stripe_customer_id = params[1] ?? row.stripe_customer_id;
    row.stripe_subscription_id = params[2] ?? row.stripe_subscription_id;
    row.stripe_price_id = params[3] ?? row.stripe_price_id;
    row.subscription_status = "active";
    row.past_due_started_at = null;
    row.current_period_end = params[4];
    return true;
  }
  if (sql.includes("subscription_status = 'past_due'")) {
    if (!guardAllows(row, params[1])) return false;
    if (params[1]) row.stripe_subscription_id = params[1];
    row.subscription_status = "past_due";
    if (!row.past_due_started_at) row.past_due_started_at = new Date();
    return true;
  }
  if (sql.includes("subscription_status = $4")) {
    if (!guardAllows(row, params[1])) return false;
    row.stripe_subscription_id = params[1];
    row.stripe_price_id = params[2] ?? row.stripe_price_id;
    row.subscription_status = params[3];
    if (!row.past_due_started_at) row.past_due_started_at = new Date();
    row.current_period_end = params[4];
    return true;
  }
  if (sql.includes("subscription_status = 'active'")) {
    if (sql.includes("subscription_status IN ('past_due', 'unpaid')")) {
      if (row.stripe_subscription_id !== params[1]) return false;
      if (row.subscription_status !== "past_due" && row.subscription_status !== "unpaid") {
        return false;
      }
      row.subscription_status = "active";
      row.past_due_started_at = null;
      return true;
    }
    if (!guardAllows(row, params[1])) return false;
    row.stripe_subscription_id = params[1] ?? row.stripe_subscription_id;
    row.stripe_price_id = params[2] ?? row.stripe_price_id;
    row.subscription_status = "active";
    row.past_due_started_at = null;
    row.current_period_end = params[3];
    return true;
  }
  if (sql.includes("subscription_status = 'canceled'")) {
    if (!guardAllows(row, params[1])) return false;
    row.stripe_subscription_id = params[1];
    row.subscription_status = "canceled";
    row.past_due_started_at = null;
    row.current_period_end = params[3];
    return true;
  }
  return false;
}

function installAccount() {
  const row = {
    id: 4,
    name: "Soap Co",
    email: "luna@example.com",
    stripe_customer_id: null,
    stripe_subscription_id: null,
    stripe_price_id: null,
    subscription_status: "incomplete",
    past_due_started_at: null,
    current_period_end: null,
    active: true,
  };
  pool.query = async (sql, params = []) => {
    const text = String(sql);
    if (
      text.includes("UPDATE clients") &&
      text.includes("stripe_customer_id = $1") &&
      !text.includes("subscription_status")
    ) {
      row.stripe_customer_id = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("SET stripe_price_id = $1") && !text.includes("subscription_status")) {
      row.stripe_price_id = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("UPDATE clients")) {
      const saved = applyUpdate(row, text, params);
      return { rows: saved ? [{ id: row.id }] : [], rowCount: saved ? 1 : 0 };
    }
    if (text.includes("JOIN users")) return { rows: [] };
    if (text.includes("WHERE stripe_customer_id")) {
      return {
        rows: row.stripe_customer_id === params[0] ? [{ id: row.id }] : [],
      };
    }
    if (text.includes("stripe_subscription_id, subscription_status")) {
      return {
        rows: [
          {
            stripe_subscription_id: row.stripe_subscription_id,
            subscription_status: row.subscription_status,
          },
        ],
      };
    }
    if (text.includes("FROM clients")) return { rows: [{ ...row }] };
    return { rows: [], rowCount: 0 };
  };
  return row;
}

function installStripe() {
  const calls = { sessionCreate: [] };
  setStripeClientForTests({
    customers: {
      async create() {
        return { id: "cus_new" };
      },
    },
    subscriptions: {
      async list() {
        return { data: [] };
      },
      async retrieve(id) {
        return modernSubscription(id, "active");
      },
    },
    checkout: {
      sessions: {
        async list() {
          return { data: [] };
        },
        async create(params) {
          calls.sessionCreate.push(params);
          return { id: "cs_new", url: "https://checkout.stripe.test/cs_new" };
        },
        async expire() {
          return { status: "expired" };
        },
      },
    },
    webhooks: {
      constructEvent(body) {
        const raw = Buffer.isBuffer(body) ? body.toString() : body;
        return JSON.parse(raw);
      },
    },
  });
  return calls;
}

function modernSubscription(id, status) {
  return {
    id,
    status,
    customer: "cus_new",
    metadata: { client_id: "4" },
    items: {
      data: [
        {
          price: { id: "price_monthly" },
          current_period_end: PERIOD_END,
        },
      ],
    },
  };
}

async function webhook(event) {
  const res = mockRes();
  await stripeWebhook(
    {
      headers: { "stripe-signature": "sig" },
      body: JSON.stringify(event),
    },
    res
  );
  return res;
}

after(async () => {
  setStripeClientForTests(null);
  await pool.end();
});

describe("stripe test-mode subscription lifecycle", { concurrency: 1 }, () => {
  it("creates a subscription, marks a failed payment past due, recovers, then cancels", async () => {
    const calls = installStripe();
    const account = installAccount();

    const checkout = mockRes();
    await createCheckout(
      { auth: { clientId: 4, role: "founder" }, body: { plan: "monthly" } },
      checkout
    );
    assert.equal(checkout.statusCode, 200);
    assert.equal(checkout.body.checkoutUrl, "https://checkout.stripe.test/cs_new");
    assert.equal(calls.sessionCreate[0].client_reference_id, "4");
    assert.equal(calls.sessionCreate[0].subscription_data.metadata.client_id, "4");
    assert.equal(account.stripe_customer_id, "cus_new");

    const started = await webhook({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_new",
          client_reference_id: "4",
          customer: "cus_new",
          subscription: "sub_live",
        },
      },
    });
    assert.equal(started.statusCode, 200);
    assert.equal(account.subscription_status, "active");
    assert.equal(account.stripe_subscription_id, "sub_live");
    assert.equal(account.stripe_price_id, "price_monthly");
    assert.equal(account.past_due_started_at, null);
    assert.equal(
      account.current_period_end.toISOString(),
      new Date(PERIOD_END * 1000).toISOString()
    );

    const failed = await webhook({
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_fail",
          customer: "cus_new",
          amount_due: 2900,
          currency: "usd",
          parent: { subscription_details: { subscription: "sub_live" } },
        },
      },
    });
    assert.equal(failed.statusCode, 200);
    assert.equal(account.subscription_status, "past_due");
    assert.ok(account.past_due_started_at instanceof Date);
    const startedAt = account.past_due_started_at;

    const stillDue = await webhook({
      type: "customer.subscription.updated",
      data: { object: modernSubscription("sub_live", "past_due") },
    });
    assert.equal(stillDue.statusCode, 200);
    assert.equal(account.subscription_status, "past_due");
    assert.equal(account.past_due_started_at, startedAt);

    const paid = await webhook({
      type: "invoice.paid",
      data: {
        object: {
          id: "in_paid",
          customer: "cus_new",
          amount_paid: 2900,
          currency: "usd",
          parent: { subscription_details: { subscription: "sub_live" } },
        },
      },
    });
    assert.equal(paid.statusCode, 200);
    assert.equal(account.subscription_status, "active");
    assert.equal(account.past_due_started_at, null);

    const canceled = await webhook({
      type: "customer.subscription.deleted",
      data: { object: modernSubscription("sub_live", "canceled") },
    });
    assert.equal(canceled.statusCode, 200);
    assert.equal(account.subscription_status, "canceled");
    assert.equal(account.stripe_subscription_id, "sub_live");
    assert.equal(account.past_due_started_at, null);
  });
});
