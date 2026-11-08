import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_admin_customers_test";
process.env.STRIPE_PRICE_ID_MONTHLY = "price_monthly";
process.env.STRIPE_PRICE_ID_YEARLY = "price_yearly";

const { pool } = await import("../lib/db.js");
const {
  getAdminCustomer,
  listAdminCustomers,
  parseCustomerListQuery,
} = await import("../api-functions/adminCustomers.js");

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

function customerRow(overrides = {}) {
  return {
    id: 4,
    name: "Soap Co",
    slug: "soap-co",
    email: "billing@soap.test",
    phone: null,
    active: true,
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-03T00:00:00.000Z",
    current_period_end: "2026-02-02T00:00:00.000Z",
    subscription_status: "active",
    past_due_started_at: null,
    stripe_price_id: "price_monthly",
    user_count: 2,
    item_count: 5,
    batch_count: 1,
    users_updated_at: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

after(async () => {
  await pool.end();
});

describe("admin customer list query", () => {
  it("defaults the page and clamps a huge limit", () => {
    assert.deepEqual(parseCustomerListQuery({}), { limit: 25, offset: 0, q: "" });
    assert.deepEqual(parseCustomerListQuery({ limit: "500", offset: "-4", q: "  ada " }), {
      limit: 100,
      offset: 0,
      q: "ada",
    });
    assert.equal(parseCustomerListQuery({ search: "soap" }).q, "soap");
  });
});

describe("GET /api/admin/customers", { concurrency: 1 }, () => {
  it("searches name and email, pages, and omits secrets", async () => {
    const queries = [];
    pool.query = async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      assert.equal(/password|token_hash|reset_token/i.test(text), false);
      if (text.includes("COUNT(*)::int AS total")) {
        return { rows: [{ total: 12 }] };
      }
      return { rows: [customerRow()] };
    };

    const res = mockRes();
    await listAdminCustomers(
      { query: { q: "50%_off", limit: "10", offset: "10" } },
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.page.total, 12);
    assert.deepEqual(res.body.page, { limit: 10, offset: 10, total: 12 });
    assert.equal(queries[0].params[0], "50%_off");
    assert.equal(queries[0].params[1], "%50\\%\\_off%");
    assert.match(queries[0].sql, /ESCAPE/);
    assert.equal(queries[1].params[2], 10);
    assert.equal(queries[1].params[3], 10);
    const customer = res.body.customers[0];
    assert.equal(customer.name, "Soap Co");
    assert.equal(customer.signed_up_at, "2026-01-02T00:00:00.000Z");
    assert.equal(customer.last_active_at.toISOString(), "2026-04-01T00:00:00.000Z");
    assert.equal(customer.plan, "monthly");
    assert.equal(customer.subscription_status, "active");
    assert.equal(customer.item_count, 5);
    assert.equal(customer.batch_count, 1);
    assert.equal(customer.user_count, 2);
    assert.equal(JSON.stringify(res.body).includes("password"), false);
    assert.equal(customer.stripe_customer_id, undefined);
  });
});

describe("GET /api/admin/customers/:id", { concurrency: 1 }, () => {
  it("returns the account and capped read-only lists", async () => {
    const queries = [];
    pool.query = async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      assert.equal(/password_hash|token_hash|password_reset/i.test(text), false);
      if (text.includes("FROM clients")) return { rows: [customerRow({ stripe_price_id: "price_yearly" })] };
      if (text.includes("FROM users")) {
        return {
          rows: [
            {
              id: 8,
              name: "Ada",
              email: "ada@soap.test",
              role: "founder",
              active: true,
              created_at: "2026-01-02T00:00:00.000Z",
              updated_at: "2026-04-01T00:00:00.000Z",
              password_hash: "secret-hash",
              token_version: 3,
              total: 1,
            },
          ],
        };
      }
      if (text.includes("FROM items")) {
        return {
          rows: [
            {
              id: 11,
              name: "Oil",
              sku: "OIL-1",
              make_or_buy: "buy",
              unit_of_measure: "fl_oz",
              active: true,
              created_at: "2026-01-04T00:00:00.000Z",
              total: 1,
            },
          ],
        };
      }
      if (text.includes("FROM vendors")) {
        return {
          rows: [
            {
              id: 2,
              name: "Mill",
              email: "mill@example.com",
              phone: null,
              site_link: "https://mill.example",
              created_at: "2026-01-05T00:00:00.000Z",
              total: 1,
            },
          ],
        };
      }
      if (text.includes("client_router_phase_templates")) {
        return {
          rows: [
            {
              id: 6,
              name: "Mix",
              description: null,
              estimated_minutes: 15,
              created_at: "2026-01-06T00:00:00.000Z",
              total: 4,
            },
          ],
        };
      }
      if (text.includes("FROM batches")) {
        return {
          rows: [
            {
              id: 9,
              sku: "LOT-1",
              status: "planned",
              quantity: 3,
              item_id: 11,
              item_name: "Oil",
              created_at: "2026-01-07T00:00:00.000Z",
              updated_at: null,
              start_date: null,
              end_date: null,
              total: 1,
            },
          ],
        };
      }
      throw new Error(`unexpected sql: ${text}`);
    };

    const res = mockRes();
    await getAdminCustomer({ params: { id: "4" } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.customer.id, 4);
    assert.equal(res.body.customer.plan, "yearly");
    assert.equal(res.body.customer.members[0].email, "ada@soap.test");
    assert.equal(res.body.customer.members[0].password_hash, undefined);
    assert.equal(res.body.customer.members[0].token_version, undefined);
    assert.equal(res.body.items.limit, 100);
    assert.equal(res.body.items.total, 1);
    assert.equal(res.body.items.rows[0].name, "Oil");
    assert.equal(res.body.vendors.rows[0].name, "Mill");
    assert.equal(res.body.phases.total, 4);
    assert.equal(res.body.phases.rows[0].name, "Mix");
    assert.equal(res.body.batches.limit, 50);
    assert.equal(res.body.batches.rows[0].sku, "LOT-1");
    assert.equal(JSON.stringify(res.body).includes("secret-hash"), false);
    const usersQuery = queries.find((query) => query.sql.includes("CASE role"));
    assert.deepEqual(usersQuery.params, [4, 100]);
    const batchQuery = queries.find((query) => query.sql.includes("LEFT JOIN items"));
    assert.equal(batchQuery.params[1], 50);
    assert.match(batchQuery.sql, /i\.client_id = b\.client_id/);
  });

  it("returns 404 for an unknown account and 400 for a bad id", async () => {
    let queried = false;
    pool.query = async () => {
      queried = true;
      return { rows: [] };
    };
    const missing = mockRes();
    await getAdminCustomer({ params: { id: "99" } }, missing);
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.body.error, "Customer not found");
    assert.equal(queried, true);

    queried = false;
    const bad = mockRes();
    await getAdminCustomer({ params: { id: "nope" } }, bad);
    assert.equal(bad.statusCode, 400);
    assert.equal(queried, false);
  });
});
