import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_admin_audit_test";
process.env.PLATFORM_ADMIN_EMAILS = "luna@example.com";

const { pool } = await import("../lib/db.js");
const {
  auditAdminRequests,
  describeAdminRequest,
  loadAdminAudit,
} = await import("../lib/adminAudit.js");
const { listAdminAudit } = await import("../api-functions/adminAudit.js");

pool.options.connectionTimeoutMillis = 500;

function mockRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.locals = {};
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

function finish(req, res) {
  auditAdminRequests(req, res, () => {});
  res.emit("finish");
}

after(async () => {
  await pool.end();
});

describe("admin audit", { concurrency: 1 }, () => {
describe("admin request audit", () => {
  it("records a customer view and ignores the customer list", () => {
    const view = describeAdminRequest({
      method: "GET",
      path: "/api/admin/customers/4",
    });
    assert.equal(view.action, "view_customer");
    assert.equal(view.clientId, 4);
    assert.equal(view.recordType, "customer");
    const billing = describeAdminRequest({
      method: "GET",
      path: "/api/admin/customers/4/billing",
    });
    assert.equal(billing.action, "view_customer_billing");
    assert.equal(billing.clientId, 4);
    assert.equal(billing.before, null);
    assert.equal(billing.after, null);
    assert.equal(
      describeAdminRequest({ method: "GET", path: "/api/admin/customers" }),
      null
    );
    assert.equal(
      describeAdminRequest({ method: "GET", path: "/api/admin/audit" }),
      null
    );
  });

  it("uses a handler before/after summary for an edit", () => {
    const spec = describeAdminRequest(
      {
        method: "PUT",
        path: "/api/items/12",
        auth: { clientId: 9, userId: 2, email: "luna@example.com" },
        body: { name: "Oil", password: "Secret1!", unit_of_measure: "oz" },
      },
      {
        locals: {
          adminAudit: {
            before: { name: "Old", password_hash: "hash" },
            after: { name: "Oil", password: "Secret1!" },
          },
        },
      }
    );
    assert.equal(spec.action, "put_item");
    assert.equal(spec.recordId, "12");
    assert.equal(spec.clientId, 9);
    assert.deepEqual(spec.before, { name: "Old", password_hash: "hash" });
    assert.equal(spec.after.password, "Secret1!");
  });
});

describe("audit writes", { concurrency: 1 }, () => {
  it("writes who, what, and a secret-free before/after when the response succeeds", async () => {
    const queries = [];
    pool.query = async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      return { rows: [] };
    };
    const req = {
      method: "PUT",
      path: "/api/items/12",
      auth: { userId: 2, clientId: 9, email: "luna@example.com" },
      body: { name: "Oil", password: "Secret1!" },
    };
    const res = mockRes();
    res.locals.adminAudit = {
      before: { name: "Old", password_hash: "hash" },
      message: "Renamed item",
    };
    finish(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(queries.length, 1);
    assert.equal(queries[0].params[0], "admin_action");
    assert.equal(queries[0].params[1], 9);
    assert.equal(queries[0].params[4], "Renamed item");
    const detail = JSON.parse(queries[0].params[5]);
    assert.equal(detail.adminUserId, 2);
    assert.equal(detail.adminEmail, "luna@example.com");
    assert.equal(detail.action, "put_item");
    assert.equal(detail.recordType, "item");
    assert.equal(detail.recordId, "12");
    assert.deepEqual(detail.before, { name: "Old" });
    assert.deepEqual(detail.after, { name: "Oil" });
    assert.equal(JSON.stringify(queries[0].params).includes("Secret1!"), false);
    assert.equal(JSON.stringify(queries[0].params).includes("hash"), false);
  });

  it("does not record a failed change or a non-admin", async () => {
    let called = false;
    pool.query = async () => {
      called = true;
      return { rows: [] };
    };
    const failed = mockRes();
    failed.statusCode = 500;
    finish(
      {
        method: "DELETE",
        path: "/api/items/12",
        auth: { userId: 2, email: "luna@example.com" },
      },
      failed
    );
    const other = mockRes();
    finish(
      {
        method: "PUT",
        path: "/api/items/12",
        auth: { userId: 3, email: "worker@example.com" },
        body: { name: "Oil" },
      },
      other
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(called, false);
  });

  it("skips the write when admin_activity is missing", async () => {
    const err = new Error('relation "admin_activity" does not exist');
    err.code = "42P01";
    pool.query = async () => {
      throw err;
    };
    const original = console.error;
    console.error = () => {};
    try {
      const res = mockRes();
      finish(
        {
          method: "GET",
          path: "/api/admin/customers/4",
          auth: { userId: 2, email: "luna@example.com" },
        },
        res
      );
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = original;
    }
  });
});

describe("GET /api/admin/audit", { concurrency: 1 }, () => {
  it("filters and pages admin actions", async () => {
    const queries = [];
    pool.query = async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes("COUNT(*)")) return { rows: [{ total: 3 }] };
      return {
        rows: [
          {
            id: "7",
            created_at: "2026-04-02T00:00:00.000Z",
            client_id: 4,
            user_id: null,
            email: null,
            message: "Viewed customer",
            detail: {
              adminUserId: 2,
              adminEmail: "luna@example.com",
              action: "view_customer",
              recordType: "customer",
              recordId: "4",
              before: null,
              after: null,
            },
          },
        ],
      };
    };

    const res = mockRes();
    await listAdminAudit(
      { query: { clientId: "4", adminUserId: "2", action: "view_customer", limit: "10" } },
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.events[0].admin_email, "luna@example.com");
    assert.equal(res.body.events[0].action, "view_customer");
    assert.equal(res.body.events[0].client_id, 4);
    assert.equal(res.body.events[0].record_id, "4");
    assert.equal(res.body.page.total, 3);
    assert.equal(res.body.page.limit, 10);
    assert.equal(res.body.sources.admin_activity, "ok");
    assert.equal(queries[0].params[0], 4);
    assert.equal(queries[0].params[2], "2");
    assert.equal(queries[0].params[3], "view_customer");
    assert.match(queries[0].sql, /event_type = 'admin_action'/);
  });

  it("returns an empty log when the table is not created yet", async () => {
    const err = new Error('relation "admin_activity" does not exist');
    err.code = "42P01";
    pool.query = async () => {
      throw err;
    };
    const res = mockRes();
    await listAdminAudit({ query: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.events, []);
    assert.equal(res.body.sources.admin_activity, "unavailable");
  });

  it("rejects a bad admin id", async () => {
    const res = mockRes();
    await listAdminAudit({ query: { adminUserId: "nope" } }, res);
    assert.equal(res.statusCode, 400);
  });
});

describe("loadAdminAudit", () => {
  it("is exported for the route", () => {
    assert.equal(typeof loadAdminAudit, "function");
  });
});
});
