import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_billing_test";
process.env.STRIPE_PRICE_ID ??= "price_monthly";
process.env.STRIPE_PRICE_ID_YEARLY ??= "price_yearly";
process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test";
process.env.FRONTEND_URL ??= "http://localhost:3000";

const { pool } = await import("../lib/db.js");
const {
  ALREADY_SUBSCRIBED_MESSAGE,
  setStripeClientForTests,
} = await import("../lib/billing.js");
const { createCheckout } = await import("../api-functions/billing.js");
const { stripeWebhook } = await import("../api-functions/stripeWebhook.js");

pool.options.connectionTimeoutMillis = 500;

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

function clientRow(overrides = {}) {
  return {
    id: 4,
    name: "Soap Co",
    email: "luna@example.com",
    stripe_customer_id: "cus_123",
    stripe_subscription_id: null,
    stripe_price_id: null,
    subscription_status: "incomplete",
    past_due_started_at: null,
    current_period_end: null,
    active: true,
    ...overrides,
  };
}

function openSession({ id, plan, created }) {
  return {
    id,
    status: "open",
    mode: "subscription",
    url: `https://checkout.stripe.test/${id}`,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    created,
    metadata: { plan, client_id: "4" },
  };
}

function installStripe(handlers = {}) {
  const calls = {
    customersCreate: [],
    subscriptionList: [],
    sessionList: [],
    sessionCreate: [],
    sessionExpire: [],
    subscriptionCancel: [],
    refundsCreate: [],
    invoicesRetrieve: [],
    subscriptionsRetrieve: [],
  };
  const stripe = {
    customers: {
      async create(params, options) {
        calls.customersCreate.push({ params, options });
        return { id: "cus_new" };
      },
    },
    subscriptions: {
      async list(params) {
        calls.subscriptionList.push(params);
        const result = handlers.subscriptions
          ? await handlers.subscriptions(params, calls.subscriptionList.length)
          : { data: [] };
        return result;
      },
      async retrieve(id) {
        calls.subscriptionsRetrieve.push(id);
        return (
          handlers.subscription ?? {
            id,
            status: "active",
            customer: "cus_123",
            latest_invoice: "in_dup",
            current_period_end: 1_800_000_000,
            items: { data: [{ price: { id: "price_monthly" } }] },
            metadata: { client_id: "4" },
          }
        );
      },
      async cancel(id, params) {
        calls.subscriptionCancel.push({ id, params });
        return { id, status: "canceled" };
      },
    },
    checkout: {
      sessions: {
        async list(params) {
          calls.sessionList.push(params);
          return { data: handlers.sessions ?? [] };
        },
        async create(params, options) {
          calls.sessionCreate.push({ params, options });
          return { id: "cs_new", url: "https://checkout.stripe.test/cs_new" };
        },
        async expire(id) {
          calls.sessionExpire.push(id);
          return { id, status: "expired" };
        },
      },
    },
    invoices: {
      async retrieve(id, params) {
        calls.invoicesRetrieve.push({ id, params });
        return {
          id,
          payments: {
            data: [
              {
                status: "paid",
                payment: { type: "payment_intent", payment_intent: "pi_dup" },
              },
            ],
          },
        };
      },
    },
    refunds: {
      async create(params, options) {
        calls.refundsCreate.push({ params, options });
        return { id: "re_dup" };
      },
    },
    webhooks: {
      constructEvent(body) {
        const raw = Buffer.isBuffer(body) ? body.toString() : body;
        return JSON.parse(raw);
      },
    },
  };
  setStripeClientForTests(stripe);
  return calls;
}

function installPool(client) {
  const queries = [];
  pool.query = async (sql, params = []) => {
    const text = String(sql);
    queries.push({ sql: text, params });
    if (text.includes("FROM clients")) {
      return { rows: client ? [client] : [], rowCount: client ? 1 : 0 };
    }
    return { rows: [], rowCount: 1 };
  };
  return queries;
}

function checkoutReq(body = {}) {
  return {
    auth: { clientId: 4, role: "founder" },
    body,
  };
}

after(async () => {
  setStripeClientForTests(null);
  await pool.end();
});

describe("checkout refuses a second subscription", { concurrency: 1 }, () => {
  for (const status of ["active", "trialing", "past_due", "unpaid", "paused"]) {
    it(`returns a billing message when the local status is ${status}`, async () => {
      const calls = installStripe();
      installPool(clientRow({ subscription_status: status }));
      const res = mockRes();
      await createCheckout(checkoutReq({ plan: "monthly" }), res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, ALREADY_SUBSCRIBED_MESSAGE);
      assert.equal(calls.sessionCreate.length, 0);
      assert.equal(calls.subscriptionList.length, 0);
    });
  }

  it("returns a billing message when a local incomplete subscription id is already saved", async () => {
    const calls = installStripe();
    installPool(
      clientRow({
        subscription_status: "incomplete",
        stripe_subscription_id: "sub_incomplete",
      })
    );
    const res = mockRes();
    await createCheckout(checkoutReq({ plan: "monthly" }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, ALREADY_SUBSCRIBED_MESSAGE);
    assert.equal(calls.sessionCreate.length, 0);
    assert.equal(calls.subscriptionList.length, 0);
  });

  it("refuses when Stripe already has a live subscription the webhook has not saved", async () => {
    const calls = installStripe({
      subscriptions: async () => ({
        data: [{ id: "sub_live", status: "active" }],
      }),
    });
    installPool(
      clientRow({
        subscription_status: "incomplete",
        stripe_customer_id: "cus_123",
      })
    );
    const res = mockRes();
    await createCheckout(checkoutReq(), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, ALREADY_SUBSCRIBED_MESSAGE);
    assert.equal(calls.subscriptionList[0].customer, "cus_123");
    assert.equal(calls.subscriptionList[0].status, "all");
    assert.equal(calls.sessionCreate.length, 0);
  });

  it("creates one session with an idempotency key when the customer is new", async () => {
    const calls = installStripe();
    const queries = installPool(
      clientRow({
        subscription_status: "incomplete",
        stripe_customer_id: null,
      })
    );
    const res = mockRes();
    await createCheckout(checkoutReq({ plan: "yearly" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.checkoutUrl, "https://checkout.stripe.test/cs_new");
    assert.equal(res.body.plan, "yearly");
    assert.equal(calls.customersCreate[0].options.idempotencyKey, "customer:4");
    assert.equal(
      calls.sessionCreate[0].options.idempotencyKey,
      "checkout:4:yearly:none"
    );
    assert.equal(calls.sessionCreate[0].params.line_items[0].price, "price_yearly");
    assert.equal(
      queries.some((query) => query.sql.includes("stripe_customer_id")),
      true
    );
  });

  it("reuses an open checkout session and expires the other open one", async () => {
    const calls = installStripe({
      sessions: [
        openSession({ id: "cs_old", plan: "monthly", created: 10 }),
        openSession({ id: "cs_newish", plan: "monthly", created: 20 }),
        openSession({ id: "cs_year", plan: "yearly", created: 15 }),
      ],
    });
    installPool(clientRow());
    const res = mockRes();
    await createCheckout(checkoutReq({ plan: "monthly" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.checkoutUrl, "https://checkout.stripe.test/cs_newish");
    assert.equal(calls.sessionCreate.length, 0);
    assert.deepEqual(calls.sessionExpire.sort(), ["cs_old", "cs_year"]);
  });

  it("expires a different plan's open session before creating, and keys off that session", async () => {
    const calls = installStripe({
      sessions: [openSession({ id: "cs_year", plan: "yearly", created: 5 })],
    });
    installPool(clientRow());
    const res = mockRes();
    await createCheckout(checkoutReq({ plan: "monthly" }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.sessionExpire, ["cs_year"]);
    assert.equal(
      calls.sessionCreate[0].options.idempotencyKey,
      "checkout:4:monthly:cs_year"
    );
  });

  it("does not start checkout if a subscription appears before the new session is created", async () => {
    const calls = installStripe({
      sessions: [openSession({ id: "cs_year", plan: "yearly", created: 5 })],
      subscriptions: async (_params, n) =>
        n === 1
          ? { data: [] }
          : { data: [{ id: "sub_just_paid", status: "trialing" }] },
    });
    installPool(clientRow());
    const res = mockRes();
    await createCheckout(checkoutReq({ plan: "monthly" }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, ALREADY_SUBSCRIBED_MESSAGE);
    assert.equal(calls.sessionCreate.length, 0);
    assert.deepEqual(calls.sessionExpire, ["cs_year"]);
  });
});

describe("webhook keeps the first live subscription", { concurrency: 1 }, () => {
  function webhookReq(event) {
    return {
      headers: { "stripe-signature": "sig" },
      body: JSON.stringify(event),
    };
  }

  it("saves the first completed checkout onto the account", async () => {
    const calls = installStripe();
    const queries = [];
    pool.query = async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text.includes("UPDATE clients")) {
        return { rows: [{ id: 4 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const res = mockRes();
    await stripeWebhook(
      webhookReq({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_paid",
            client_reference_id: "4",
            customer: "cus_123",
            subscription: "sub_first",
          },
        },
      }),
      res
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { received: true });
    const update = queries.find((query) => query.sql.includes("UPDATE clients"));
    assert.match(update.sql, /subscription_status NOT IN/);
    assert.match(update.sql, /'active'/);
    assert.match(update.sql, /'incomplete'/);
    assert.equal(update.params[2], "sub_first");
    assert.equal(calls.subscriptionCancel.length, 0);
    assert.equal(calls.refundsCreate.length, 0);
  });

  it("cancels and refunds a second subscription instead of replacing the first", async () => {
    const calls = installStripe();
    const logs = [];
    const originalError = console.error;
    console.error = (...args) => logs.push(args.join(" "));
    const queries = [];
    pool.query = async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text.includes("UPDATE clients")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("stripe_subscription_id, subscription_status")) {
        return {
          rows: [
            {
              stripe_subscription_id: "sub_keep",
              subscription_status: "active",
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    };

    try {
      const res = mockRes();
      await stripeWebhook(
        webhookReq({
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_second",
              client_reference_id: "4",
              customer: "cus_123",
              subscription: "sub_dup",
            },
          },
        }),
        res
      );
      assert.equal(res.statusCode, 200);
    } finally {
      console.error = originalError;
    }

    const updates = queries.filter((query) => query.sql.includes("UPDATE clients"));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].params[2], "sub_dup");
    assert.equal(calls.subscriptionCancel.length, 1);
    assert.equal(calls.subscriptionCancel[0].id, "sub_dup");
    assert.deepEqual(calls.subscriptionCancel[0].params, {
      invoice_now: false,
      prorate: false,
    });
    assert.equal(calls.refundsCreate[0].params.payment_intent, "pi_dup");
    assert.equal(
      calls.refundsCreate[0].options.idempotencyKey,
      "refund-duplicate-sub_dup"
    );
    assert.ok(
      logs.some((line) =>
        line.includes(
          "Duplicate Stripe subscription sub_dup for client 4; keeping sub_keep"
        )
      )
    );
  });

  it("does not cancel the account when a different subscription is deleted", async () => {
    const calls = installStripe();
    const queries = [];
    pool.query = async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text.includes("UPDATE clients")) return { rows: [], rowCount: 0 };
      if (text.includes("stripe_subscription_id, subscription_status")) {
        return {
          rows: [
            {
              stripe_subscription_id: "sub_keep",
              subscription_status: "active",
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    };

    const res = mockRes();
    await stripeWebhook(
      webhookReq({
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_dup",
            status: "active",
            metadata: { client_id: "4" },
          },
        },
      }),
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(calls.subscriptionCancel.length, 0);
    assert.equal(calls.refundsCreate.length, 0);
    const update = queries.find((query) => query.sql.includes("UPDATE clients"));
    assert.equal(update.params[1], "sub_dup");
    assert.match(update.sql, /subscription_status = 'canceled'/);
    assert.match(update.sql, /subscription_status NOT IN/);
  });

  it("still updates the account when the event is for its own subscription", async () => {
    const calls = installStripe();
    let saved = null;
    pool.query = async (sql, params = []) => {
      const text = String(sql);
      if (text.includes("UPDATE clients")) {
        saved = params;
        return { rows: [{ id: 4 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const res = mockRes();
    await stripeWebhook(
      webhookReq({
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_keep",
            status: "active",
            metadata: { client_id: "4" },
            items: { data: [{ price: { id: "price_monthly" } }] },
            current_period_end: 1_800_000_000,
          },
        },
      }),
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(saved[1], "sub_keep");
    assert.equal(saved[2], "price_monthly");
    assert.equal(calls.subscriptionCancel.length, 0);
  });
});
