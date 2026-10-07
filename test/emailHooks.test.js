import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_email_hooks_test";
process.env.JWT_SECRET ??= "test-jwt-secret-not-for-production";
process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test";
process.env.FRONTEND_URL = "https://app.example.com";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.RESEND_API_KEY;

const { pool } = await import("../lib/db.js");
const { setStripeClientForTests } = await import("../lib/billing.js");
const { resetEmailForTests, setResendForTests } = await import("../lib/email/index.js");
const { register } = await import("../api-functions/auth.js");
const { stripeWebhook } = await import("../api-functions/stripeWebhook.js");

pool.options.connectionTimeoutMillis = 500;

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
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

function installResend(sent, { fail = false } = {}) {
  setResendForTests({
    emails: {
      async send(payload) {
        if (fail) throw new Error("resend down");
        sent.push(payload);
        return { data: { id: "msg_hook" }, error: null };
      },
    },
  });
}

function installStripe() {
  setStripeClientForTests({
    webhooks: {
      constructEvent(body) {
        const raw = Buffer.isBuffer(body) ? body.toString() : body;
        return JSON.parse(raw);
      },
    },
    subscriptions: {
      async retrieve() {
        return { latest_invoice: null };
      },
      async cancel() {
        return { status: "canceled" };
      },
    },
    invoices: {
      async retrieve() {
        return { payments: { data: [] } };
      },
    },
  });
}

function webhookReq(event) {
  return {
    headers: { "stripe-signature": "sig" },
    body: JSON.stringify(event),
  };
}

function installWebhookPool({ saved = true, logFails = false } = {}) {
  const queries = [];
  pool.query = async (sql, params = []) => {
    const text = String(sql);
    queries.push({ sql: text, params });
    if (logFails && text.includes("INSERT INTO email_log")) {
      throw new Error("email_log missing");
    }
    if (text.includes("stripe_customer_id")) {
      return { rows: [{ id: 4 }] };
    }
    if (text.includes("JOIN users")) {
      return {
        rows: [
          {
            user_id: 8,
            email: "luna@example.com",
            name: "Luna",
            company_name: "Soap Co",
          },
        ],
      };
    }
    if (text.includes("UPDATE clients")) {
      return { rows: saved ? [{ id: 4 }] : [], rowCount: saved ? 1 : 0 };
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
    if (text.includes("INSERT INTO email_log")) return { rows: [{ id: 1 }] };
    return { rows: [], rowCount: 0 };
  };
  return queries;
}

after(async () => {
  resetEmailForTests();
  setStripeClientForTests(null);
  await pool.end();
});

describe("welcome email on registration", { concurrency: 1 }, () => {
  it("sends welcome after the account is created and still returns a session if email fails", async () => {
    const sent = [];
    installResend(sent, { fail: true });
    const queries = [];
    pool.query = async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes("FROM auth_rate_limits")) return { rows: [] };
      if (String(sql).includes("INSERT INTO auth_rate_limits")) {
        return { rows: [{ attempts: 1 }] };
      }
      if (String(sql).includes("INSERT INTO email_log")) {
        throw new Error("email_log missing");
      }
      return { rows: [] };
    };
    pool.connect = async () => ({
      async query(sql, params = []) {
        const text = String(sql);
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
          return { rows: [] };
        }
        if (text.includes("FROM users")) return { rows: [] };
        if (text.includes("FROM clients WHERE slug")) return { rows: [] };
        if (text.includes("INSERT INTO clients")) {
          return {
            rows: [
              {
                id: 9,
                name: params[0],
                email: params[2],
                subscription_status: "incomplete",
                past_due_started_at: null,
                stripe_price_id: null,
              },
            ],
          };
        }
        if (text.includes("INSERT INTO users")) {
          return {
            rows: [
              {
                id: 11,
                client_id: 9,
                name: params[1],
                email: params[2],
                role: "founder",
                active: true,
                token_version: 0,
              },
            ],
          };
        }
        throw new Error(`unexpected client sql: ${text}`);
      },
      release() {},
    });

    const res = mockRes();
    const original = console.error;
    console.error = () => {};
    try {
      await register(
        {
          body: {
            companyName: "Soap Co",
            name: "Luna",
            email: "luna@example.com",
            password: "Password1!",
          },
          headers: { "x-vercel-forwarded-for": "203.0.113.5" },
          ip: "10.0.0.1",
          socket: { remoteAddress: "10.0.0.1" },
        },
        res
      );
    } finally {
      console.error = original;
    }

    assert.equal(res.statusCode, 201);
    assert.equal(typeof res.body.token, "string");
    assert.equal(queries.filter((query) => query.sql.includes("INSERT INTO email_log")).length, 1);
  });
});

describe("billing emails", { concurrency: 1 }, () => {
  it("sends a receipt for a paid invoice", async () => {
    installStripe();
    const sent = [];
    installResend(sent);
    const queries = installWebhookPool();
    const res = mockRes();
    await stripeWebhook(
      webhookReq({
        type: "invoice.paid",
        data: {
          object: {
            customer: "cus_123",
            amount_paid: 2500,
            currency: "usd",
            number: "INV-9",
            hosted_invoice_url: "https://pay.stripe.test/receipt",
          },
        },
      }),
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "luna@example.com");
    assert.equal(sent[0].subject, "We received your Upright payment");
    assert.match(sent[0].text, /\$25\.00/);
    assert.match(sent[0].text, /INV-9/);
    assert.match(sent[0].html, /https:\/\/pay\.stripe\.test\/receipt/);
    const log = queries.find((query) => query.sql.includes("INSERT INTO email_log"));
    assert.equal(log.params[3], "payment_succeeded");
    assert.equal(log.params[4], "sent");
  });

  it("does not send a receipt for a zero-dollar invoice", async () => {
    installStripe();
    const sent = [];
    installResend(sent);
    installWebhookPool();
    const res = mockRes();
    await stripeWebhook(
      webhookReq({
        type: "invoice.paid",
        data: { object: { customer: "cus_123", amount_paid: 0, currency: "usd" } },
      }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 0);
  });

  it("sends payment failed only when the account was marked past due", async () => {
    installStripe();
    const sent = [];
    installResend(sent);
    installWebhookPool({ saved: true });
    const res = mockRes();
    await stripeWebhook(
      webhookReq({
        type: "invoice.payment_failed",
        data: {
          object: {
            id: "in_1",
            customer: "cus_123",
            subscription: "sub_keep",
            amount_due: 2500,
            currency: "usd",
          },
        },
      }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(sent[0].subject, "Your Upright payment didn't go through");
    assert.match(sent[0].text, /\$25\.00/);

    const skipped = [];
    installResend(skipped);
    installWebhookPool({ saved: false });
    const blocked = mockRes();
    await stripeWebhook(
      webhookReq({
        type: "invoice.payment_failed",
        data: {
          object: {
            id: "in_2",
            customer: "cus_123",
            subscription: "sub_dup",
            amount_due: 2500,
            currency: "usd",
          },
        },
      }),
      blocked
    );
    assert.equal(blocked.statusCode, 200);
    assert.equal(skipped.length, 0);
  });

  it("sends subscription canceled only when this account's subscription was deleted", async () => {
    installStripe();
    const sent = [];
    installResend(sent);
    installWebhookPool({ saved: true });
    const res = mockRes();
    await stripeWebhook(
      webhookReq({
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_keep",
            status: "canceled",
            metadata: { client_id: "4" },
          },
        },
      }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(sent[0].subject, "Your Upright subscription is canceled");
    assert.match(sent[0].text, /Soap Co/);

    const skipped = [];
    installResend(skipped);
    installWebhookPool({ saved: false });
    const other = mockRes();
    const original = console.error;
    console.error = () => {};
    try {
      await stripeWebhook(
        webhookReq({
          type: "customer.subscription.deleted",
          data: {
            object: {
              id: "sub_dup",
              status: "canceled",
              metadata: { client_id: "4" },
            },
          },
        }),
        other
      );
    } finally {
      console.error = original;
    }
    assert.equal(other.statusCode, 200);
    assert.equal(skipped.length, 0);
  });

  it("still accepts the webhook when email sending and logging fail", async () => {
    installStripe();
    installResend([], { fail: true });
    installWebhookPool({ logFails: true });
    const res = mockRes();
    const original = console.error;
    console.error = () => {};
    try {
      await stripeWebhook(
        webhookReq({
          type: "invoice.paid",
          data: {
            object: {
              customer: "cus_123",
              amount_paid: 2500,
              currency: "usd",
            },
          },
        }),
        res
      );
    } finally {
      console.error = original;
    }
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { received: true });
  });
});
