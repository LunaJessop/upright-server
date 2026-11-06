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

function changeReq(unit, { clientId = 4, id = "10", ...extra } = {}) {
  return {
    auth: { clientId, userId: 9 },
    params: { id },
    body: { unit_of_measure: unit, ...extra },
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

  it("changes kind when the item has no stock, recipes, or batches", async () => {
    const queries = installChangeDb({ storedUnit: "fl_oz" });
    const res = mockRes();
    await changeItemUnit(changeReq("ea"), res);

    assert.equal(res.statusCode, 200);
    const itemUpdate = updateOf(queries, "items");
    assert.deepEqual(itemUpdate.params, ["ea", 10, 4]);
    assert.equal(itemUpdate.sql.includes("unit_cost"), false);
    assert.equal(updateOf(queries, "inventory"), undefined);
    assert.equal(updateOf(queries, "purchase_lots"), undefined);
    assert.ok(queries.some((query) => query.sql === "COMMIT"));
    assert.equal(
      queries.some((query) => query.sql === "ROLLBACK"),
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

  function installCrossKindDb() {
    const queries = [];
    pool.connect = async () => ({
      async query(sql, params = []) {
        const text = String(sql);
        queries.push({ sql: text, params });
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
          return { rows: [] };
        }
        if (text.includes("unit_sell_price") && text.includes("FROM items")) {
          return {
            rows: [
              {
                id: 10,
                unit_of_measure: "fl_oz",
                unit_cost: 1,
                unit_sell_price: 4,
                default_unit_price: 1,
              },
            ],
          };
        }
        if (text.includes("FROM inventory")) return { rows: [{ quantity: 16 }] };
        if (text.includes("item_inventory_goals")) {
          return { rows: [{ goal_min: 8, goal_max: 24 }] };
        }
        if (text.includes("FROM purchase_lots")) {
          return { rows: [{ id: 5, lot_number: "L-1", quantity: 16, unit_cost: 1 }] };
        }
        if (text.includes("parent_name")) {
          return {
            rows: [
              {
                parent_item_id: 3,
                parent_name: "Soap",
                quantity: 2,
                unit_of_measure: "cup",
              },
            ],
          };
        }
        if (text.includes("component_name")) {
          return {
            rows: [
              {
                component_item_id: 6,
                component_name: "Oil",
                quantity: 1,
                unit_of_measure: "oz",
              },
            ],
          };
        }
        if (text.includes("projected_unit_cost")) {
          return {
            rows: [{ id: 9, sku: "LOT-1", status: "complete", quantity: 32 }],
          };
        }
        if (text.includes("quantity_allocated")) {
          return {
            rows: [
              {
                id: 4,
                batch_id: 9,
                sku: "LOT-1",
                status: "complete",
                quantity_allocated: 8,
                unit_of_measure: "fl_oz",
                unit_cost_snapshot: 1,
              },
            ],
          };
        }
        if (text.includes("json_agg")) {
          return { rows: [{ id: 10, name: "Tincture", unit_of_measure: "ea" }] };
        }
        return { rows: [] };
      },
      release() {},
    });
    return queries;
  }

  it("asks for a factor when stock, a recipe, or a batch still uses the old unit", async () => {
    const queries = installCrossKindDb();
    const res = mockRes();
    await changeItemUnit(changeReq("ea"), res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "CONVERSION_FACTOR_REQUIRED");
    assert.equal(res.body.fromUnit, "fl_oz");
    assert.equal(res.body.toUnit, "ea");
    assert.equal(res.body.error, "How many fl oz is 1 each?");
    assert.equal(res.body.counts.stock, 3);
    assert.equal(res.body.counts.recipes, 2);
    assert.equal(res.body.counts.batches, 1);
    assert.equal(updateOf(queries, "inventory"), undefined);
    assert.ok(queries.some((query) => query.sql === "ROLLBACK"));
    assert.equal(
      queries.some((query) => query.sql === "COMMIT"),
      false
    );
    const inventory = queries.find((query) => query.sql.includes("FROM inventory"));
    assert.deepEqual(inventory.params, [4, 10]);
  });

  it("rejects a factor that is not a finite number greater than zero", async () => {
    const queries = installCrossKindDb();
    const res = mockRes();
    await changeItemUnit(changeReq("ea", { factor: 0 }), res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "INVALID_CONVERSION_FACTOR");
    assert.match(res.body.error, /greater than zero/);
    assert.equal(updateOf(queries, "items"), undefined);
    assert.ok(queries.some((query) => query.sql === "ROLLBACK"));
  });

  it("previews the conversion and does not save", async () => {
    const queries = installCrossKindDb();
    const res = mockRes();
    await changeItemUnit(changeReq("ea", { factor: "8", dryRun: true }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.dryRun, true);
    assert.equal(res.body.converted, true);
    assert.equal(res.body.factor, 8);
    assert.deepEqual(res.body.stock.quantity, { before: 16, after: 2 });
    assert.deepEqual(res.body.stock.goalMin, { before: 8, after: 1 });
    assert.deepEqual(res.body.stock.unitCost, { before: 1, after: 8 });
    assert.deepEqual(res.body.stock.unitSellPrice, { before: 4, after: 32 });
    assert.equal(res.body.stock.purchaseLots[0].quantity.after, 2);
    assert.equal(res.body.stock.purchaseLots[0].unitCost.after, 8);
    assert.equal(res.body.recipes[0].parentName, "Soap");
    assert.equal(res.body.recipes[0].enteredUnit, "cup");
    assert.equal(res.body.recipes[0].before, 16);
    assert.equal(res.body.recipes[0].after, 2);
    assert.equal(res.body.recipes[0].unitAfter, "ea");
    assert.equal(res.body.ownRecipe[0].componentName, "Oil");
    assert.equal(res.body.ownRecipe[0].before, 1);
    assert.equal(res.body.ownRecipe[0].after, 8);
    assert.equal(res.body.ownRecipe[0].unit, "oz");
    const finished = res.body.batches.find((batch) => batch.role === "finished");
    const component = res.body.batches.find((batch) => batch.role === "component");
    assert.equal(finished.before, 32);
    assert.equal(finished.after, 4);
    assert.equal(component.before, 8);
    assert.equal(component.after, 1);
    assert.equal(updateOf(queries, "inventory"), undefined);
    assert.equal(updateOf(queries, "items"), undefined);
    assert.ok(queries.some((query) => query.sql === "ROLLBACK"));
    assert.equal(
      queries.some((query) => query.sql === "COMMIT"),
      false
    );
  });

  it("converts stock, recipes, and batch history in one company-scoped transaction", async () => {
    const queries = installCrossKindDb();
    const res = mockRes();
    await changeItemUnit(changeReq("ea", { factor: 8 }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.unit_of_measure, "ea");

    const inventory = updateOf(queries, "inventory");
    assert.match(inventory.sql, /quantity \/ \$1::numeric/);
    assert.deepEqual(inventory.params, [8, 4, 10]);

    const goals = updateOf(queries, "item_inventory_goals");
    assert.match(goals.sql, /goal_min \/ \$1::numeric/);
    assert.deepEqual(goals.params, [8, 4, 10]);

    const lots = updateOf(queries, "purchase_lots");
    assert.match(lots.sql, /quantity \/ \$1::numeric/);
    assert.match(lots.sql, /unit_cost \* \$1::numeric/);
    assert.equal(lots.sql.includes("total_cost"), false);
    assert.deepEqual(lots.params, [8, 4, 10]);

    const item = updateOf(queries, "items");
    assert.equal(item.params[0], "ea");
    assert.equal(item.params[1], 8);
    assert.match(item.sql, /unit_cost \* \$2::numeric/);
    assert.deepEqual(item.params.slice(2), [10, 4]);

    const ingredient = queries.find(
      (query) => query.sql.includes("UPDATE bom_items") && query.sql.includes("unit_of_measure")
    );
    assert.equal(ingredient.params[0], 2);
    assert.equal(ingredient.params[1], "ea");
    assert.equal(ingredient.params[5], 4);

    const own = queries.find(
      (query) =>
        query.sql.includes("UPDATE bom_items") && !query.sql.includes("unit_of_measure")
    );
    assert.equal(own.params[0], 8);
    assert.equal(own.params[4], 4);

    const batches = updateOf(queries, "batches");
    assert.match(batches.sql, /quantity \/ \$1::numeric/);
    assert.match(batches.sql, /projected_unit_cost \* \$1::numeric/);
    assert.deepEqual(batches.params, [8, 4, 10]);

    const components = updateOf(queries, "batch_components");
    assert.match(components.sql, /quantity_allocated \/ \$1::numeric/);
    assert.match(components.sql, /unit_cost_snapshot \* \$1::numeric/);
    assert.equal(components.params[1], "ea");
    assert.equal(components.params[3], 4);

    const commitAt = queries.findIndex((query) => query.sql === "COMMIT");
    const firstUpdate = queries.findIndex((query) => query.sql.includes("UPDATE"));
    assert.ok(firstUpdate > -1 && firstUpdate < commitAt);
    assert.equal(
      queries.some((query) => query.sql === "ROLLBACK"),
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
