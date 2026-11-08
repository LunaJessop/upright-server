import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_admin_actions_test";
process.env.FRONTEND_URL = "https://uprightmrp.netlify.app";
process.env.JWT_SECRET ??= "test-jwt-secret-not-for-production";

const { pool } = await import("../lib/db.js");
const { setResendForTests, resetEmailForTests } = await import("../lib/email/index.js");
const {
  extendCustomerGrace,
  resendMemberInvite,
  sendMemberPasswordReset,
  setCustomerActive,
  setMemberActive,
} = await import("../api-functions/adminAccountActions.js");

pool.options.connectionTimeoutMillis = 500;

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    locals: {},
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

function member() {
  return {
    id: 8,
    client_id: 4,
    name: "Ada",
    email: "ada@soap.test",
    role: "founder",
    active: true,
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    client_name: "Soap Co",
    password_hash: "secret-hash",
  };
}

after(async () => {
  resetEmailForTests();
  await pool.end();
});

describe("admin account actions", { concurrency: 1 }, () => {
  it("requires confirm before it sends a password reset", async () => {
    let queried = false;
    pool.query = async () => {
      queried = true;
      return { rows: [] };
    };
    const res = mockRes();
    await sendMemberPasswordReset(
      { params: { id: "4", userId: "8" }, body: {} },
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "CONFIRMATION_REQUIRED");
    assert.equal(queried, false);
  });

  it("emails a reset link and does not return the token", async () => {
    const queries = [];
    const sent = [];
    setResendForTests({
      emails: {
        async send(payload) {
          sent.push(payload);
          return { data: { id: "msg_1" }, error: null };
        },
      },
    });
    pool.query = async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes("FROM users")) return { rows: [member()] };
      if (String(sql).includes("INSERT INTO email_log")) return { rows: [{ id: 1 }] };
      throw new Error(String(sql));
    };
    pool.connect = async () => ({
      async query(sql, params = []) {
        queries.push({ sql: String(sql), params });
        return { rows: [] };
      },
      release() {},
    });

    const res = mockRes();
    await sendMemberPasswordReset(
      { params: { id: "4", userId: "8" }, body: { confirm: true } },
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.user.email, "ada@soap.test");
    assert.equal(res.body.user.password_hash, undefined);
    assert.equal(res.body.email.status, "sent");
    assert.equal(JSON.stringify(res.body).includes("token"), false);
    assert.match(sent[0].text, /reset-password\?token=/);
    assert.equal(sent[0].text.includes("secret-hash"), false);
    const tokenInsert = queries.find((query) =>
      query.sql.includes("INSERT INTO password_reset_tokens")
    );
    assert.equal(tokenInsert.params[0], 8);
    assert.notEqual(tokenInsert.params[1], sent[0].text);
    assert.equal(res.locals.adminAudit.action, "send_password_reset");
    assert.equal(res.locals.adminAudit.clientId, 4);
    assert.equal(res.locals.adminAudit.after.email, "ada@soap.test");
    assert.equal(JSON.stringify(res.locals.adminAudit).includes("token="), false);
  });

  it("resends the welcome email as the invite", async () => {
    const sent = [];
    setResendForTests({
      emails: {
        async send(payload) {
          sent.push(payload);
          return { data: { id: "msg_2" }, error: null };
        },
      },
    });
    pool.query = async (sql) => {
      if (String(sql).includes("FROM users")) return { rows: [member()] };
      if (String(sql).includes("INSERT INTO email_log")) return { rows: [{ id: 1 }] };
      throw new Error(String(sql));
    };
    const res = mockRes();
    await resendMemberInvite(
      { params: { id: "4", userId: "8" }, body: { confirm: true } },
      res
    );
    assert.equal(res.statusCode, 200);
    assert.match(sent[0].subject, /Welcome to Upright/);
    assert.equal(res.locals.adminAudit.action, "resend_invite");
    assert.equal(res.body.user.id, 8);
  });

  it("deactivates a member without returning the password hash", async () => {
    const queries = [];
    pool.query = async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes("FROM users")) return { rows: [member()] };
      if (String(sql).includes("UPDATE users")) {
        return {
          rows: [{ ...member(), active: false, updated_at: "2026-04-02T00:00:00.000Z" }],
        };
      }
      throw new Error(String(sql));
    };
    const res = mockRes();
    await setMemberActive(
      { params: { id: "4", userId: "8" }, body: { confirm: true, active: false } },
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.user.active, false);
    assert.equal(res.body.user.password_hash, undefined);
    const update = queries.find((query) => query.sql.includes("UPDATE users"));
    assert.match(update.sql, /token_version \+ 1/);
    assert.deepEqual(update.params, [8, 4, false]);
    assert.deepEqual(res.locals.adminAudit.before, { active: true });
    assert.deepEqual(res.locals.adminAudit.after, { active: false });
  });

  it("refuses a member who belongs to another company", async () => {
    pool.query = async () => ({ rows: [] });
    const res = mockRes();
    await setMemberActive(
      { params: { id: "4", userId: "8" }, body: { confirm: true, active: true } },
      res
    );
    assert.equal(res.statusCode, 404);
    assert.equal(res.locals.adminAudit, undefined);
  });

  it("soft-deactivates a company and does not delete it", async () => {
    const queries = [];
    const company = {
      id: 4,
      name: "Soap Co",
      slug: "soap-co",
      email: "billing@soap.test",
      active: true,
      subscription_status: "active",
      past_due_started_at: null,
      stripe_price_id: null,
      current_period_end: null,
    };
    pool.query = async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes("UPDATE clients")) {
        return { rows: [{ ...company, active: false }] };
      }
      if (String(sql).includes("FROM clients")) return { rows: [company] };
      throw new Error(String(sql));
    };
    const res = mockRes();
    await setCustomerActive(
      { params: { id: "4" }, body: { confirm: true, active: false } },
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.customer.active, false);
    assert.equal(res.body.customer.id, 4);
    assert.equal(
      queries.some((query) => /DELETE/i.test(query.sql)),
      false
    );
    assert.equal(res.locals.adminAudit.action, "deactivate_customer");
    assert.deepEqual(res.locals.adminAudit.before, { active: true });
    assert.deepEqual(res.locals.adminAudit.after, { active: false });
  });

  it("extends grace only while the subscription is past due", async () => {
    const started = "2026-04-01T00:00:00.000Z";
    const company = {
      id: 4,
      name: "Soap Co",
      slug: "soap-co",
      email: "billing@soap.test",
      active: true,
      subscription_status: "past_due",
      past_due_started_at: started,
      stripe_price_id: null,
      current_period_end: null,
    };
    pool.query = async (sql) => {
      if (String(sql).includes("UPDATE clients")) {
        return {
          rows: [{ ...company, past_due_started_at: "2026-04-08T00:00:00.000Z" }],
        };
      }
      return { rows: [company] };
    };
    const res = mockRes();
    await extendCustomerGrace(
      { params: { id: "4" }, body: { confirm: true, days: 7 } },
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.customer.subscription_status, "past_due");
    assert.equal(typeof res.body.customer.grace_days_remaining, "number");
    assert.equal(res.locals.adminAudit.action, "extend_grace");
    assert.equal(res.locals.adminAudit.before.past_due_started_at, started);
    assert.equal(res.locals.adminAudit.after.days, 7);

    pool.query = async () => ({
      rows: [{ ...company, subscription_status: "active" }],
    });
    const denied = mockRes();
    await extendCustomerGrace(
      { params: { id: "4" }, body: { confirm: true, days: 7 } },
      denied
    );
    assert.equal(denied.statusCode, 400);
    assert.equal(denied.body.code, "GRACE_NOT_APPLICABLE");
  });
});
