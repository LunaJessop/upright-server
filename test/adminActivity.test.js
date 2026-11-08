import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_admin_activity_test";
process.env.JWT_SECRET ??= "test-jwt-secret-not-for-production";

const { pool } = await import("../lib/db.js");
const {
  captureServerErrors,
  loadActivity,
  recordActivity,
} = await import("../lib/activityLog.js");
const { login } = await import("../api-functions/auth.js");
const {
  getAdminCustomerActivity,
  listAdminActivity,
} = await import("../api-functions/adminActivity.js");

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
  };
}

after(async () => {
  await pool.end();
});

describe("activity log", { concurrency: 1 }, () => {
  it("stores auth events without passwords, tokens, or message bodies", async () => {
    const queries = [];
    pool.query = async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      return { rows: [] };
    };

    await recordActivity({
      type: "login_failed",
      clientId: 4,
      userId: 8,
      email: "ada@example.com",
      message: "Invalid email or password token=abc",
      detail: {
        action: "login",
        password: "Secret1!",
        token: "reset-token",
        html: "<p>secret body</p>",
      },
    });

    const insert = queries[0];
    assert.match(insert.sql, /INSERT INTO admin_activity/);
    assert.equal(insert.params[0], "login_failed");
    assert.equal(insert.params[1], 4);
    assert.equal(insert.params[3], "ada@example.com");
    assert.match(insert.params[4], /token=\[redacted\]/);
    const detail = JSON.parse(insert.params[5]);
    assert.equal(detail.action, "login");
    assert.equal(detail.password, undefined);
    assert.equal(detail.token, undefined);
    assert.equal(detail.html, undefined);
    assert.equal(JSON.stringify(insert.params).includes("Secret1!"), false);
    assert.equal(JSON.stringify(insert.params).includes("reset-token"), false);
  });

  it("skips the write when admin_activity does not exist yet", async () => {
    const err = new Error('relation "admin_activity" does not exist');
    err.code = "42P01";
    pool.query = async () => {
      throw err;
    };
    const original = console.error;
    const lines = [];
    console.error = (...args) => lines.push(args.join(" "));
    try {
      await recordActivity({ type: "error", message: "Failed to load items" });
      await recordActivity({ type: "error", message: "Failed again" });
    } finally {
      console.error = original;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /admin-activity\.sql/);
  });

  it("records a 500 response without the request body", async () => {
    const queries = [];
    pool.query = async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      return { rows: [] };
    };
    const req = {
      method: "POST",
      originalUrl: "/api/items?token=secret",
      auth: { clientId: 4, userId: 8, email: "ada@example.com" },
      body: { password: "Secret1!", name: "Oil" },
    };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
      send(payload) {
        this.sent = payload;
        return this;
      },
    };
    captureServerErrors(req, res, () => {});
    res.status(500).json({ error: "Failed to create item", password: "Secret1!" });

    assert.equal(queries.length, 1);
    assert.equal(queries[0].params[0], "error");
    assert.equal(queries[0].params[4], "Failed to create item");
    const detail = JSON.parse(queries[0].params[5]);
    assert.equal(detail.path, "/api/items");
    assert.equal(detail.status, 500);
    assert.equal(JSON.stringify(queries[0].params).includes("Secret1!"), false);
  });
});

describe("admin activity endpoints", { concurrency: 1 }, () => {
  it("returns emails when the activity table is not created yet", async () => {
    pool.query = async (sql) => {
      const text = String(sql);
      if (text.includes("admin_activity")) {
        const err = new Error('relation "admin_activity" does not exist');
        err.code = "42P01";
        throw err;
      }
      if (text.includes("COUNT(*)")) return { rows: [{ total: 1 }] };
      if (text.includes("email_log")) {
        return {
          rows: [
            {
              id: "12",
              created_at: "2026-04-01T00:00:00.000Z",
              type: "email",
              client_id: 4,
              user_id: 8,
              email: "ada@example.com",
              message: "domain is not verified",
              detail: { template: "welcome", status: "failed" },
              source: "email",
            },
          ],
        };
      }
      throw new Error(text);
    };

    const res = mockRes();
    await listAdminActivity({ query: { type: "error,email", limit: "10" } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.sources.admin_activity, "unavailable");
    assert.equal(res.body.sources.email_log, "ok");
    assert.equal(res.body.events[0].type, "email");
    assert.equal(res.body.events[0].template, "welcome");
    assert.equal(res.body.events[0].email_status, "failed");
    assert.equal(res.body.events[0].message, "domain is not verified");
    assert.equal(res.body.page.limit, 10);
    assert.equal(JSON.stringify(res.body).includes("password"), false);
    assert.equal(JSON.stringify(res.body).includes("provider_message_id"), false);
  });

  it("filters a company feed and rejects an unknown type", async () => {
    const queries = [];
    pool.query = async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text.includes("FROM clients")) return { rows: [{ id: 4 }] };
      if (text.includes("COUNT(*)")) return { rows: [{ total: 0 }] };
      return { rows: [] };
    };

    const bad = mockRes();
    await getAdminCustomerActivity({ params: { id: "4" }, query: { type: "nope" } }, bad);
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body.error, /Unknown activity type/);

    const res = mockRes();
    await getAdminCustomerActivity(
      { params: { id: "4" }, query: { type: "login_failed,email" } },
      res
    );
    assert.equal(res.statusCode, 200);
    const scoped = queries.find((query) => query.sql.includes("admin_activity"));
    assert.equal(scoped.params[0], 4);
    assert.deepEqual(scoped.params[3], ["login_failed"]);
    assert.match(scoped.sql, /u\.client_id = \$1/);
  });

  it("returns 404 when the company does not exist", async () => {
    pool.query = async () => ({ rows: [] });
    const res = mockRes();
    await getAdminCustomerActivity({ params: { id: "99" }, query: {} }, res);
    assert.equal(res.statusCode, 404);
  });
});

describe("login does not write the password into the activity log", { concurrency: 1 }, () => {
  it("records a failed login without the password", async () => {
    const queries = [];
    pool.query = async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes("FROM auth_rate_limits")) return { rows: [] };
      if (String(sql).includes("INSERT INTO auth_rate_limits")) return { rows: [{ attempts: 1 }] };
      if (String(sql).includes("FROM users")) return { rows: [] };
      if (String(sql).includes("INSERT INTO admin_activity")) return { rows: [] };
      throw new Error(String(sql));
    };

    const res = mockRes();
    await login(
      {
        body: { email: "ada@example.com", password: "Secret1!" },
        headers: { "x-vercel-forwarded-for": "203.0.113.9" },
        ip: "10.0.0.1",
      },
      res
    );

    assert.equal(res.statusCode, 401);
    const insert = queries.find((query) => query.sql.includes("INSERT INTO admin_activity"));
    assert.equal(insert.params[0], "login_failed");
    assert.equal(insert.params[3], "ada@example.com");
    assert.equal(JSON.stringify(insert.params).includes("Secret1!"), false);
  });
});

describe("admin activity sql", () => {
  it("is idempotent, indexed, and does not store secrets", () => {
    const sql = readFileSync(
      new URL("../scripts/sql/admin-activity.sql", import.meta.url),
      "utf8"
    );
    assert.match(sql, /CREATE TABLE IF NOT EXISTS admin_activity/);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS admin_activity_created_at_idx/);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS admin_activity_client_created_at_idx/);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS admin_activity_type_created_at_idx/);
    assert.match(sql, /90 days/);
    assert.doesNotMatch(sql, /password_hash|token_hash|email_body/);
  });
});
