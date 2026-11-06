import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_tenant_test";
process.env.JWT_SECRET ??= "test-jwt-secret-not-for-production";
delete process.env.STRIPE_SECRET_KEY;

const { pool } = await import("../lib/db.js");
const { expandProductionTree } = await import("../lib/productionTree.js");
const { createCheckout, createPortal } = await import("../api-functions/billing.js");
const { createClientUser, getClient } = await import("../api-functions/clients.js");
const {
  cancelBatch,
  completeBatch,
  createBatch,
  getBatchById,
  getBatches,
  updateBatchPhase,
} = await import("../api-functions/batches.js");
const {
  getInventoryList,
  getItemInventory,
  updateItemInventory,
  updateItemInventoryGoal,
} = await import("../api-functions/inventory.js");
const {
  createItem,
  getItemById,
  getItemProductionTree,
  getItems,
  updateItem,
} = await import("../api-functions/items.js");
const {
  createPurchaseLot,
  deletePurchaseLot,
  getPurchaseLotsForItem,
} = await import("../api-functions/purchaseLots.js");
const {
  deleteRouterPhaseTemplate,
  getRouterPhaseTemplates,
  updateRouterPhaseTemplate,
} = await import("../api-functions/routerPhases.js");
const { deleteTag, getTags, updateTag } = await import("../api-functions/tags.js");
const { deleteVendor, getVendors, updateVendor } = await import("../api-functions/vendors.js");

pool.options.connectionTimeoutMillis = 500;

const CALLER = 1;
const FOREIGN_ID = 4242;
const SECRET = "Other Co Secret";

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    ended: false,
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
    end() {
      this.ended = true;
      return this;
    },
  };
}

function secretRow() {
  return {
    id: FOREIGN_ID,
    name: SECRET,
    client_id: 2,
    make_or_buy: "buy",
    unit_of_measure: "ea",
    status: "planned",
    quantity: 4,
    active: true,
    email: "secret@other.test",
    role: "founder",
    sku: "SECRET-SKU",
  };
}

function scopedToCaller(sql, params) {
  return /client_id/i.test(String(sql)) && params.includes(CALLER);
}

/**
 * A row from another company is returned only when the SQL is not limited
 * to the caller. A scoped read comes back empty. A scoped write changes
 * nothing. An unscoped write is recorded so the test can fail.
 */
function installLeakDb() {
  const queries = [];
  const unscopedWrites = [];

  async function query(sql, params = []) {
    const text = String(sql);
    queries.push({ sql: text, params });
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      return { rows: [] };
    }
    const kind = text.trim().split(/\s+/)[0].toUpperCase();
    const scoped = scopedToCaller(text, params);
    if (kind === "INSERT") {
      if (!scoped) unscopedWrites.push(text);
      return {
        rows: [{ ...secretRow(), id: 1, client_id: CALLER, name: "created" }],
        rowCount: 1,
      };
    }
    if (kind === "UPDATE" || kind === "DELETE") {
      if (!scoped) {
        unscopedWrites.push(text);
        return { rows: [secretRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (!scoped) return { rows: [secretRow()] };
    return { rows: [] };
  }

  pool.query = query;
  pool.connect = async () => ({
    query,
    release() {},
  });
  return { queries, unscopedWrites };
}

function authReq(extra = {}) {
  return {
    auth: { clientId: CALLER, userId: 7, role: "founder" },
    params: { id: String(FOREIGN_ID), lotId: String(FOREIGN_ID), phaseId: String(FOREIGN_ID) },
    query: {},
    body: {},
    ...extra,
  };
}

function leaked(res) {
  return JSON.stringify(res.body ?? "").includes(SECRET);
}

async function expectHidden(handler, req = authReq()) {
  const db = installLeakDb();
  const res = mockRes();
  await handler(req, res);
  assert.equal(leaked(res), false, JSON.stringify(res.body));
  assert.equal(db.unscopedWrites.length, 0, db.unscopedWrites.join("\n"));
  return { res, db };
}

after(async () => {
  await pool.end();
});

describe("cross-company reads", { concurrency: 1 }, () => {
  it("does not return another company's items, inventory, batches, vendors, tags, or phases", async () => {
    for (const handler of [
      getItems,
      getInventoryList,
      getBatches,
      getVendors,
      getTags,
      getRouterPhaseTemplates,
    ]) {
      const { res, db } = await expectHidden(handler);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, []);
      const lookup = db.queries.find((query) => /client_id/i.test(query.sql));
      assert.ok(lookup);
      assert.equal(lookup.params.includes(CALLER), true);
    }
  });

  it("filters items by a tag only when that tag belongs to the same company", async () => {
    const { db } = await expectHidden(
      getItems,
      authReq({ query: { tag_id: String(FOREIGN_ID) } })
    );
    const lookup = db.queries.find((query) => query.sql.includes("tag_id"));
    assert.match(lookup.sql, /tg\.client_id = i\.client_id/);
    assert.equal(lookup.params[0], CALLER);
    assert.equal(lookup.params[1], FOREIGN_ID);
  });

  it("returns 404 for another company's item, batch, inventory, and purchase lots", async () => {
    const cases = [
      getItemById,
      getItemProductionTree,
      getItemInventory,
      getPurchaseLotsForItem,
      getBatchById,
    ];
    for (const handler of cases) {
      const { res } = await expectHidden(handler);
      assert.equal(res.statusCode, 404, handler.name);
      assert.equal(leaked(res), false);
    }
  });

  it("keeps joined item fields inside the same company", async () => {
    const { db } = await expectHidden(getItems);
    const sql = db.queries.map((query) => query.sql).join("\n");
    assert.match(sql, /v\.id = i\.vendor AND v\.client_id = i\.client_id/);
    assert.match(sql, /t\.id = it\.tag_id AND t\.client_id = i\.client_id/);
    assert.match(sql, /s\.item_id = i\.id AND s\.client_id = i\.client_id/);
    assert.match(sql, /r\.item_id = i\.id AND r\.client_id = i\.client_id/);

    const batches = await expectHidden(getBatches);
    const batchSql = batches.db.queries.map((query) => query.sql).join("\n");
    assert.match(batchSql, /i\.id = b\.item_id AND i\.client_id = b\.client_id/);
    assert.match(
      batchSql,
      /ci\.id = bc\.item_id AND ci\.client_id = b\.client_id/
    );
  });

  it("does not expand another company's recipe line into the production tree", async () => {
    const queries = [];
    const db = {
      async query(sql, params = []) {
        const text = String(sql);
        queries.push({ sql: text, params });
        if (text.includes("FROM items") && text.includes("make_or_buy")) {
          if (params[0] === 10 && params[1] === CALLER) {
            return {
              rows: [
                {
                  id: 10,
                  name: "Our soap",
                  make_or_buy: "make",
                  unit_of_measure: "ea",
                },
              ],
            };
          }
          return { rows: [] };
        }
        if (text.includes("FROM bom_items")) {
          const scoped = /i\.client_id = \$2/.test(text) && params[1] === CALLER;
          if (!scoped) {
            return {
              rows: [
                {
                  component_item_id: FOREIGN_ID,
                  quantity: 1,
                  bom_unit_of_measure: "ea",
                  component_name: SECRET,
                  make_or_buy: "buy",
                  unit_of_measure: "ea",
                },
              ],
            };
          }
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    const tree = await expandProductionTree(db, CALLER, 10, 1);
    assert.equal(JSON.stringify(tree).includes(SECRET), false);
    assert.deepEqual(tree.needs, []);

    await assert.rejects(
      () => expandProductionTree(db, CALLER, FOREIGN_ID, 1),
      (err) => err.status === 404
    );
    const root = queries.find(
      (query) => query.params[0] === FOREIGN_ID && query.sql.includes("FROM items")
    );
    assert.deepEqual(root.params, [FOREIGN_ID, CALLER]);
  });

  it("loads the signed-in company only, ignoring an id in the request", async () => {
    const queries = [];
    pool.query = async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes("FROM clients")) {
        assert.deepEqual(params, [CALLER]);
        return {
          rows: [
            {
              id: CALLER,
              name: "Ours",
              slug: "ours",
              email: "ours@example.com",
              phone: null,
              active: true,
              created_at: "t",
              subscription_status: "active",
              past_due_started_at: null,
              stripe_price_id: null,
            },
          ],
        };
      }
      if (String(sql).includes("FROM users")) {
        assert.deepEqual(params, [CALLER]);
        return { rows: [] };
      }
      throw new Error(String(sql));
    };

    const res = mockRes();
    await getClient(
      authReq({
        body: { client_id: FOREIGN_ID },
        params: { id: String(FOREIGN_ID) },
      }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.client.id, CALLER);
    assert.equal(res.body.client.name, "Ours");
    assert.equal(JSON.stringify(res.body).includes(SECRET), false);
  });
});

describe("cross-company writes", { concurrency: 1 }, () => {
  it("returns 404 and does not change another company's records", async () => {
    const cases = [
      [updateItem, authReq({ body: { name: "Stolen", make_or_buy: "buy" } })],
      [updateItemInventory, authReq({ body: { quantity: 0 } })],
      [
        updateItemInventoryGoal,
        authReq({ body: { goal_min: 1, goal_max: 2 } }),
      ],
      [
        createPurchaseLot,
        authReq({
          body: { lot_number: "L-1", quantity: 1, total_cost: 5 },
        }),
      ],
      [deletePurchaseLot, authReq()],
      [cancelBatch, authReq()],
      [completeBatch, authReq()],
      [updateBatchPhase, authReq({ body: { status: "complete" } })],
      [
        updateVendor,
        authReq({ body: { name: "Stolen vendor" } }),
      ],
      [deleteVendor, authReq()],
      [updateTag, authReq({ body: { name: "Stolen tag" } })],
      [deleteTag, authReq()],
      [
        updateRouterPhaseTemplate,
        authReq({ body: { name: "Stolen phase", estimated_minutes: 5 } }),
      ],
      [deleteRouterPhaseTemplate, authReq()],
    ];

    for (const [handler, req] of cases) {
      const { res, db } = await expectHidden(handler, req);
      assert.equal(res.statusCode, 404, handler.name);
      assert.equal(
        db.queries.some((query) => query.sql === "COMMIT"),
        false,
        handler.name
      );
    }
  });

  it("refuses a batch for another company's item", async () => {
    const { res, db } = await expectHidden(
      createBatch,
      authReq({ body: { item_id: FOREIGN_ID, quantity: 1, sku: "LOT-1" } })
    );
    assert.equal(res.statusCode, 404);
    assert.equal(
      db.queries.some((query) => query.sql.includes("INSERT INTO batches")),
      false
    );
  });

  it("refuses another company's vendor or recipe component on an item", async () => {
    const vendor = await expectHidden(
      createItem,
      authReq({
        body: { name: "Oil", make_or_buy: "buy", vendor: FOREIGN_ID },
      })
    );
    assert.equal(vendor.res.statusCode, 400);
    assert.match(vendor.res.body.error, /Vendor not found/);
    assert.equal(
      vendor.db.queries.some((query) => query.sql === "COMMIT"),
      false
    );

    const bom = await expectHidden(
      createItem,
      authReq({
        body: {
          name: "Soap",
          make_or_buy: "make",
          bom_items: [{ component_item_id: FOREIGN_ID, quantity: 1 }],
        },
      })
    );
    assert.equal(bom.res.statusCode, 400);
    assert.match(bom.res.body.error, /belong to your company/);
    assert.equal(bom.db.queries.some((query) => query.sql === "COMMIT"), false);
    const componentLookup = bom.db.queries.find((query) =>
      query.sql.includes("id = ANY")
    );
    assert.equal(componentLookup.params[0], CALLER);
    assert.deepEqual(componentLookup.params[1], [FOREIGN_ID]);
  });

  it("creates a teammate on the signed-in company, not a company id in the body", async () => {
    let inserted = null;
    pool.query = async (sql, params = []) => {
      const text = String(sql);
      if (text.includes("FROM users")) return { rows: [] };
      if (text.includes("INSERT INTO users")) {
        inserted = params;
        return {
          rows: [
            {
              id: 8,
              name: params[1],
              email: params[2],
              role: params[4],
              active: true,
              created_at: "t",
            },
          ],
        };
      }
      throw new Error(text);
    };

    const res = mockRes();
    await createClientUser(
      authReq({
        body: {
          name: "New Person",
          email: "new-person@example.com",
          password: "Password1!",
          role: "user",
          client_id: FOREIGN_ID,
          clientId: FOREIGN_ID,
        },
      }),
      res
    );

    assert.equal(res.statusCode, 201);
    assert.equal(inserted[0], CALLER);
    assert.equal(inserted.includes(FOREIGN_ID), false);
  });

  it("starts billing for the signed-in company, not an id in the body", async () => {
    const queries = [];
    pool.query = async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      return { rows: [] };
    };

    const checkout = mockRes();
    await createCheckout(
      authReq({
        body: { plan: "monthly", clientId: FOREIGN_ID, client_id: FOREIGN_ID },
      }),
      checkout
    );
    assert.equal(checkout.statusCode, 404);
    assert.deepEqual(queries[0].params, [CALLER]);

    const portal = mockRes();
    await createPortal(
      authReq({ body: { clientId: FOREIGN_ID } }),
      portal
    );
    assert.equal(portal.statusCode, 404);
    assert.deepEqual(queries[1].params, [CALLER]);
    assert.equal(JSON.stringify(queries).includes(String(FOREIGN_ID)), false);
  });
});
