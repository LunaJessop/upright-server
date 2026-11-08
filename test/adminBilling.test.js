import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_admin_billing_test";
process.env.STRIPE_PRICE_ID_MONTHLY = "price_monthly";

const { pool } = await import("../lib/db.js");
const { setStripeClientForTests } = await import("../lib/billing.js");
const { getAdminCustomerBilling } = await import("../api-functions/adminBilling.js");

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
  };
}

function company(overrides = {}) {
  return {
    id: 4,
    name: "Soap Co",
    email: "billing@soap.test",
    stripe_customer_id: "cus_123",
    stripe_subscription_id: "sub_123",
    stripe_price_id: "price_monthly",
    subscription_status: "past_due",
    past_due_started_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    current_period_end: "2026-05-01T00:00:00.000Z",
    active: true,
    ...overrides,
  };
}

after(async () => {
  setStripeClientForTests(null);
  delete process.env.STRIPE_SECRET_KEY;
  await pool.end();
});

describe("admin billing view", { concurrency: 1 }, () => {
  it("returns stored billing and skips Stripe when it is not configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const calls = [];
    setStripeClientForTests({
      invoices: {
        async list() {
          calls.push("list");
          return { data: [] };
        },
        async createPreview() {
          calls.push("preview");
          return {};
        },
      },
    });
    const row = company();
    pool.query = async () => ({ rows: [row] });

    const res = mockRes();
    await getAdminCustomerBilling({ params: { id: "4" } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.billing.subscription_status, "past_due");
    assert.equal(res.body.billing.plan, "monthly");
    assert.equal(res.body.billing.plan_price_id, "price_monthly");
    assert.equal(res.body.billing.current_period_end, "2026-05-01T00:00:00.000Z");
    assert.equal(res.body.billing.past_due_started_at, row.past_due_started_at);
    assert.ok(res.body.billing.grace_days_remaining > 0);
    assert.equal(res.body.billing.has_app_access, true);
    assert.equal(res.body.billing.read_only, false);
    assert.equal(res.body.stripe.configured, false);
    assert.deepEqual(res.body.stripe.invoices, []);
    assert.equal(res.body.stripe.payment_method, null);
    assert.equal(res.body.stripe.upcoming_invoice, null);
    assert.deepEqual(calls, []);
  });

  it("returns invoices, the card, and the upcoming invoice from Stripe", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_admin_billing";
    const calls = [];
    setStripeClientForTests({
      invoices: {
        async list(params) {
          calls.push(["list", params]);
          return {
            data: [
              {
                id: "in_1",
                created: 1711929600,
                total: 2900,
                currency: "usd",
                status: "paid",
                hosted_invoice_url: "https://invoice.stripe.com/i/in_1",
              },
            ],
          };
        },
        async createPreview(params) {
          calls.push(["preview", params]);
          return {
            created: 1714521600,
            total: 2900,
            currency: "usd",
            status: "draft",
          };
        },
      },
      customers: {
        async retrieve(id, params) {
          calls.push(["customer", id, params]);
          return {
            invoice_settings: {
              default_payment_method: { card: { brand: "visa", last4: "4242" } },
            },
          };
        },
      },
      paymentMethods: {
        async list() {
          calls.push("paymentMethods.list");
          return { data: [] };
        },
      },
    });
    pool.query = async () => ({ rows: [company()] });

    const res = mockRes();
    await getAdminCustomerBilling({ params: { id: "4" } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.stripe.configured, true);
    assert.equal(res.body.stripe.error, null);
    assert.deepEqual(res.body.stripe.invoices, [
      {
        id: "in_1",
        date: "2024-04-01T00:00:00.000Z",
        amount: 2900,
        currency: "usd",
        status: "paid",
        hosted_invoice_url: "https://invoice.stripe.com/i/in_1",
      },
    ]);
    assert.deepEqual(res.body.stripe.payment_method, { brand: "visa", last4: "4242" });
    assert.equal(res.body.stripe.upcoming_invoice.amount, 2900);
    assert.equal(res.body.stripe.upcoming_invoice.status, "draft");
    assert.equal(res.body.stripe.upcoming_invoice.hosted_invoice_url, undefined);
    assert.equal(
      calls.some((call) => Array.isArray(call) && call[0] === "list"),
      true
    );
    assert.equal(calls.includes("paymentMethods.list"), false);
    const names = calls.map((call) => (Array.isArray(call) ? call[0] : call));
    assert.deepEqual(names.sort(), ["customer", "list", "preview"]);
  });

  it("keeps the stored billing when Stripe fails", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_admin_billing";
    setStripeClientForTests({
      invoices: {
        async list() {
          throw new Error("stripe down");
        },
        async createPreview() {
          throw new Error("stripe down");
        },
      },
      customers: {
        async retrieve() {
          throw new Error("stripe down");
        },
      },
      paymentMethods: {
        async list() {
          throw new Error("stripe down");
        },
      },
    });
    pool.query = async () => ({ rows: [company({ subscription_status: "active", past_due_started_at: null })] });

    const res = mockRes();
    await getAdminCustomerBilling({ params: { id: "4" } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.billing.subscription_status, "active");
    assert.equal(res.body.billing.grace_days_remaining, null);
    assert.equal(res.body.billing.read_only, false);
    assert.equal(res.body.stripe.configured, true);
    assert.deepEqual(res.body.stripe.invoices, []);
    assert.equal(res.body.stripe.payment_method, null);
    assert.equal(res.body.stripe.upcoming_invoice, null);
    assert.match(res.body.stripe.error, /invoices/);
    assert.match(res.body.stripe.error, /payment_method/);
    assert.match(res.body.stripe.error, /upcoming_invoice/);
  });

  it("returns 404 for an unknown customer", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    pool.query = async () => ({ rows: [] });
    const res = mockRes();
    await getAdminCustomerBilling({ params: { id: "4" } }, res);
    assert.equal(res.statusCode, 404);
  });
});
