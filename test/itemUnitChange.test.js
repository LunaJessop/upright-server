import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_item_unit_change_test";

const { pool } = await import("../lib/db.js");
const { changeItemUnit, updateItem } = await import("../api-functions/items.js");
const { convertQuantity } = await import("../lib/units.js");

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

function installChangeDb({
  storedUnit = "lb",
  found = true,
  openBatchIds = [],
  failOn = null,
} = {}) {
  const queries = [];
  pool.connect = async () => ({
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [] };
      }
      if (failOn && text.includes(failOn)) {
        throw new Error("db down");
      }
      if (text.includes("FOR UPDATE") && text.includes("FROM items")) {
        return found
          ? { rows: [{ id: 10, unit_of_measure: storedUnit }] }
          : { rows: [] };
      }
      if (text.includes("FROM batches")) {
        return { rows: openBatchIds.map((id) => ({ id })) };
      }
      if (text.includes("json_agg")) {
        return {
          rows: [{ id: 10, name: "Oil", unit_of_measure: "oz" }],
        };
      }
      return { rows: [] };
    },
    release() {},
  });
  return queries;
}

function changeReq(unit, { clientId = 4, id = "10" } = {}) {
  return {
    auth: { clientId, userId: 9 },
    params: { id },
    body: { unit_of_measure: unit },
  };
}

function updateOf(queries, table) {
  return queries.find((query) => query.sql.includes(`UPDATE ${table}`));
}

after(async () => {
  await pool.end();
});

describe("POST /api/items/:id/change-unit", { concurrency: 1 }, () => {
  it("converts stock, goals, prices, and lot quantities from lb to oz", async () => {
    const queries = installChangeDb({ storedUnit: "lb" });
    const res = mockRes();
    await changeItemUnit(changeReq("oz"), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.id, 10);
    assert.equal(res.body.unit_of_measure, "oz");

    const inventory = updateOf(queries, "inventory");
    const goals = updateOf(queries, "item_inventory_goals");
    const lots = updateOf(queries, "purchase_lots");
    const item = updateOf(queries, "items");
    const bom = updateOf(queries, "bom_items");

    assert.equal(inventory.params[0], 16);
    assert.deepEqual(inventory.params.slice(1), [4, 10]);
    assert.match(inventory.sql, /quantity = quantity \* \$1::numeric/);

    assert.equal(goals.params[0], 16);
    assert.match(goals.sql, /goal_min = goal_min \* \$1::numeric/);
    assert.match(goals.sql, /goal_max = goal_max \* \$1::numeric/);

    assert.equal(lots.params[0], 16);
    assert.match(lots.sql, /quantity = quantity \* \$1::numeric/);
    assert.match(lots.sql, /unit_cost = unit_cost \/ \$1::numeric/);
    assert.equal(lots.sql.includes("total_cost"), false);

    assert.equal(item.params[0], "oz");
    assert.equal(item.params[1], 16);
    assert.match(item.sql, /unit_cost \/ \$2::numeric/);
    assert.match(item.sql, /unit_sell_price \/ \$2::numeric/);
    assert.match(item.sql, /default_unit_price \/ \$2::numeric/);

    assert.equal(bom.params[0], "lb");
    assert.match(bom.sql, /SET unit_of_measure = \$1/);
    assert.equal(bom.sql.includes("quantity"), false);
    assert.match(bom.sql, /unit_of_measure IS NULL OR btrim\(unit_of_measure\) = ''/);

    const commitAt = queries.findIndex((query) => query.sql === "COMMIT");
    const readAt = queries.findIndex((query) => query.sql.includes("json_agg"));
    assert.ok(readAt > -1 && readAt < commitAt);
  });

  it("converts grams to ounces with the shared weight factor", async () => {
    const queries = installChangeDb({ storedUnit: "g" });
    const res = mockRes();
    await changeItemUnit(changeReq("oz"), res);

    const factor = convertQuantity(1, "g", "oz");
    assert.equal(res.statusCode, 200);
    assert.equal(updateOf(queries, "inventory").params[0], factor);
    assert.equal(updateOf(queries, "item_inventory_goals").params[0], factor);
    assert.equal(updateOf(queries, "purchase_lots").params[0], factor);
    assert.equal(updateOf(queries, "items").params[1], factor);
    assert.notEqual(factor, 16);
    assert.ok(factor > 0 && factor < 1);
  });

  it("rejects a unit from a different dimension", async () => {
    const queries = installChangeDb({ storedUnit: "lb" });
    const res = mockRes();
    await changeItemUnit(changeReq("fl_oz"), res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Can't change this item from lb to fl_oz/);
    assert.match(res.body.error, /weight/);
    assert.match(res.body.error, /volume/);
    assert.equal(updateOf(queries, "inventory"), undefined);
    assert.ok(queries.some((query) => query.sql === "ROLLBACK"));
    assert.equal(
      queries.some((query) => query.sql === "COMMIT"),
      false
    );
  });

  it("returns 404 when the item belongs to another company", async () => {
    const queries = installChangeDb({ found: false });
    const res = mockRes();
    await changeItemUnit(changeReq("oz", { clientId: 99 }), res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, "Item not found");
    const lookup = queries.find(
      (query) => query.sql.includes("FOR UPDATE") && query.sql.includes("FROM items")
    );
    assert.deepEqual(lookup.params, [10, 99]);
    assert.equal(updateOf(queries, "inventory"), undefined);
    assert.ok(queries.some((query) => query.sql === "ROLLBACK"));
  });

  it("rolls back when a later update fails", async () => {
    const queries = installChangeDb({ failOn: "UPDATE purchase_lots" });
    const res = mockRes();
    await changeItemUnit(changeReq("oz"), res);

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, "Failed to change item unit");
    assert.ok(updateOf(queries, "inventory"));
    assert.ok(updateOf(queries, "item_inventory_goals"));
    const failAt = queries.findIndex((query) =>
      query.sql.includes("UPDATE purchase_lots")
    );
    const rollbackAt = queries.findIndex((query) => query.sql === "ROLLBACK");
    assert.ok(failAt > -1 && rollbackAt > failAt);
    assert.equal(
      queries.some((query) => query.sql === "COMMIT"),
      false
    );
  });

  it("refuses the change while an open batch still uses the item", async () => {
    const queries = installChangeDb({ openBatchIds: [7] });
    const res = mockRes();
    await changeItemUnit(changeReq("oz"), res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Finish or cancel open batches/);
    assert.match(res.body.error, /lb/);
    const open = queries.find((query) => query.sql.includes("FROM batches"));
    assert.match(open.sql, /b\.item_id = \$2/);
    assert.match(open.sql, /batch_components/);
    assert.match(open.sql, /'planned', 'in_progress'/);
    assert.equal(updateOf(queries, "inventory"), undefined);
    assert.ok(queries.some((query) => query.sql === "ROLLBACK"));
    assert.equal(
      queries.some((query) => query.sql === "COMMIT"),
      false
    );
  });
});

describe("item update does not silently change the stock unit", { concurrency: 1 }, () => {
  it("rejects a different unit and points at change-unit", async () => {
    const queries = [];
    pool.connect = async () => ({
      async query(sql, params = []) {
        const text = String(sql);
        queries.push({ sql: text, params });
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
          return { rows: [] };
        }
        if (text.includes("FOR UPDATE")) {
          return { rows: [{ unit_of_measure: "lb" }] };
        }
        return { rows: [] };
      },
      release() {},
    });

    const res = mockRes();
    await updateItem(
      {
        auth: { clientId: 4, userId: 9 },
        params: { id: "10" },
        body: {
          name: "Oil",
          make_or_buy: "buy",
          unit_of_measure: "oz",
        },
      },
      res
    );

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /stocked in lb/);
    assert.match(res.body.error, /POST \/api\/items\/:id\/change-unit/);
    assert.equal(
      queries.some((query) => query.sql.includes("UPDATE items")),
      false
    );
    assert.ok(queries.some((query) => query.sql === "ROLLBACK"));
  });
});
