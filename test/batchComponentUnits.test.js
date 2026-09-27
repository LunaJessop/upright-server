import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_batch_units_test";

const { pool } = await import("../lib/db.js");
const { createBatch } = await import("../api-functions/batches.js");
const {
  ADD_BATCH_COMPONENT_UNIT_SQL,
  BACKFILL_BATCH_COMPONENT_UNITS_SQL,
  backfillBatchComponentUnits,
} = await import("../scripts/backfill-batch-component-units.js");

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

function item(row) {
  return {
    unit_sell_price: null,
    default_unit_price: null,
    ...row,
  };
}

/**
 * @param {Map<number, object>} items
 * @param {Map<number, object[]>} bomByParent
 */
function installBatchDb(items, bomByParent) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [] };
      }
      if (text.includes("unit_sell_price")) {
        const row = items.get(params[0]);
        return {
          rows: row
            ? [
                {
                  id: row.id,
                  make_or_buy: row.make_or_buy,
                  unit_sell_price: row.unit_sell_price,
                  default_unit_price: row.default_unit_price,
                },
              ]
            : [],
        };
      }
      if (text.includes("FROM bom_items")) {
        return { rows: bomByParent.get(params[0]) ?? [] };
      }
      if (text.includes("item_router_phases")) return { rows: [] };
      if (text.includes("INSERT INTO batch_components")) return { rows: [] };
      if (text.includes("id = ANY")) {
        const ids = params[1] ?? [];
        return {
          rows: ids
            .map((id) => items.get(id))
            .filter(Boolean)
            .map((row) => ({
              id: row.id,
              make_or_buy: row.make_or_buy,
              unit_cost: row.unit_cost ?? null,
              default_unit_price: row.default_unit_price ?? null,
            })),
        };
      }
      if (text.includes("INSERT INTO batches")) {
        return { rows: [{ id: 50, item_id: params[1], quantity: params[2] }] };
      }
      if (
        text.includes("INSERT INTO batch_components") ||
        text.includes("INSERT INTO item_skus") ||
        text.includes("UPDATE batches")
      ) {
        return { rows: [] };
      }
      if (text.includes("FROM items")) {
        const row = items.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      throw new Error(`unexpected sql: ${text}`);
    },
    release() {},
  };
  pool.connect = async () => client;
  pool.query = async () => ({ rows: [{ id: 50 }] });
  return queries;
}

function bomLine({
  component_item_id,
  quantity,
  bom_unit_of_measure,
  component_name,
  make_or_buy,
  unit_of_measure,
}) {
  return {
    component_item_id,
    quantity,
    bom_unit_of_measure,
    component_name,
    make_or_buy,
    unit_of_measure,
  };
}

function componentInserts(queries) {
  return queries.filter((query) =>
    query.sql.includes("INSERT INTO batch_components")
  );
}

after(async () => {
  await pool.end();
});

describe("batch component units on create", { concurrency: 1 }, () => {
  it("stores the BOM line unit and keeps the converted stock quantity", async () => {
    const items = new Map([
      [
        1,
        item({
          id: 1,
          name: "Soap",
          make_or_buy: "make",
          unit_of_measure: "ea",
          unit_sell_price: 12,
        }),
      ],
      [
        2,
        item({
          id: 2,
          name: "Oil",
          make_or_buy: "buy",
          unit_of_measure: "fl_oz",
          unit_cost: 2,
        }),
      ],
    ]);
    const bomByParent = new Map([
      [
        1,
        [
          bomLine({
            component_item_id: 2,
            quantity: 2,
            bom_unit_of_measure: "tbsp",
            component_name: "Oil",
            make_or_buy: "buy",
            unit_of_measure: "fl_oz",
          }),
        ],
      ],
    ]);
    const queries = installBatchDb(items, bomByParent);
    const res = mockRes();

    await createBatch(
      {
        auth: { clientId: 7, userId: 9 },
        body: { item_id: 1, quantity: 3, sku: "LOT-1" },
      },
      res
    );

    assert.equal(res.statusCode, 201);
    const inserts = componentInserts(queries);
    assert.equal(inserts.length, 1);
    assert.match(inserts[0].sql, /unit_of_measure/);
    // 2 tbsp = 1 fl_oz, times batch quantity 3.
    assert.equal(inserts[0].params[1], 2);
    assert.equal(inserts[0].params[2], 3);
    assert.equal(inserts[0].params[5], "tbsp");
    assert.equal(
      queries.some((query) => query.sql.includes("INSERT INTO inventory")),
      false
    );
  });

  it("converts a metric recipe line into the imperial stock unit", async () => {
    const items = new Map([
      [
        1,
        item({
          id: 1,
          name: "Soap",
          make_or_buy: "make",
          unit_of_measure: "ea",
          unit_sell_price: 12,
        }),
      ],
      [
        2,
        item({
          id: 2,
          name: "Oil",
          make_or_buy: "buy",
          unit_of_measure: "fl_oz",
          unit_cost: 2,
        }),
      ],
      [
        3,
        item({
          id: 3,
          name: "Lye",
          make_or_buy: "buy",
          unit_of_measure: "oz",
          unit_cost: 1,
        }),
      ],
    ]);
    const bomByParent = new Map([
      [
        1,
        [
          bomLine({
            component_item_id: 2,
            quantity: 29.5735295625,
            bom_unit_of_measure: "mL",
            component_name: "Oil",
            make_or_buy: "buy",
            unit_of_measure: "fl_oz",
          }),
          bomLine({
            component_item_id: 3,
            quantity: 453.59237,
            bom_unit_of_measure: "g",
            component_name: "Lye",
            make_or_buy: "buy",
            unit_of_measure: "oz",
          }),
        ],
      ],
    ]);
    const queries = installBatchDb(items, bomByParent);
    const res = mockRes();

    await createBatch(
      {
        auth: { clientId: 7, userId: 9 },
        body: { item_id: 1, quantity: 2, sku: "LOT-MIX" },
      },
      res
    );

    assert.equal(res.statusCode, 201);
    const inserts = componentInserts(queries);
    const byItem = new Map(inserts.map((query) => [query.params[1], query.params]));
    // 29.5735295625 mL = 1 fl oz, times batch quantity 2.
    assert.ok(Math.abs(byItem.get(2)[2] - 2) < 1e-9);
    assert.equal(byItem.get(2)[5], "mL");
    // 453.59237 g = 16 oz, times batch quantity 2.
    assert.ok(Math.abs(byItem.get(3)[2] - 32) < 1e-9);
    assert.equal(byItem.get(3)[5], "g");
  });

  it("falls back to the item stock unit when the BOM line unit is blank", async () => {
    const items = new Map([
      [
        1,
        item({
          id: 1,
          name: "Soap",
          make_or_buy: "make",
          unit_of_measure: "ea",
        }),
      ],
      [
        3,
        item({
          id: 3,
          name: "Salt",
          make_or_buy: "buy",
          unit_of_measure: "oz",
          unit_cost: 1,
        }),
      ],
    ]);
    const bomByParent = new Map([
      [
        1,
        [
          bomLine({
            component_item_id: 3,
            quantity: 4,
            bom_unit_of_measure: "",
            component_name: "Salt",
            make_or_buy: "buy",
            unit_of_measure: "oz",
          }),
        ],
      ],
    ]);
    const queries = installBatchDb(items, bomByParent);
    const res = mockRes();

    await createBatch(
      {
        auth: { clientId: 7, userId: 9 },
        body: { item_id: 1, quantity: 2, sku: "LOT-2" },
      },
      res
    );

    assert.equal(res.statusCode, 201);
    const inserts = componentInserts(queries);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].params[2], 8);
    assert.equal(inserts[0].params[5], "oz");
  });

  it("stores null when neither the BOM line nor the stock unit is set", async () => {
    const items = new Map([
      [
        1,
        item({
          id: 1,
          name: "Soap",
          make_or_buy: "make",
          unit_of_measure: "ea",
        }),
      ],
      [
        5,
        item({
          id: 5,
          name: "Mystery",
          make_or_buy: "buy",
          unit_of_measure: "",
        }),
      ],
    ]);
    const bomByParent = new Map([
      [
        1,
        [
          bomLine({
            component_item_id: 5,
            quantity: 4,
            bom_unit_of_measure: null,
            component_name: "Mystery",
            make_or_buy: "buy",
            unit_of_measure: "",
          }),
        ],
      ],
    ]);
    const queries = installBatchDb(items, bomByParent);
    const res = mockRes();

    await createBatch(
      {
        auth: { clientId: 7, userId: 9 },
        body: { item_id: 1, quantity: 1, sku: "LOT-3" },
      },
      res
    );

    assert.equal(res.statusCode, 201);
    const inserts = componentInserts(queries);
    assert.equal(inserts[0].params[2], 4);
    assert.equal(inserts[0].params[5], null);
  });

  it("keeps one recipe unit when nested and direct lines agree", async () => {
    const items = new Map([
      [
        1,
        item({
          id: 1,
          name: "Soap",
          make_or_buy: "make",
          unit_of_measure: "ea",
        }),
      ],
      [
        2,
        item({
          id: 2,
          name: "Oil",
          make_or_buy: "buy",
          unit_of_measure: "fl_oz",
          unit_cost: 2,
        }),
      ],
      [
        4,
        item({
          id: 4,
          name: "Blend",
          make_or_buy: "make",
          unit_of_measure: "ea",
        }),
      ],
    ]);
    const bomByParent = new Map([
      [
        1,
        [
          bomLine({
            component_item_id: 4,
            quantity: 1,
            bom_unit_of_measure: "ea",
            component_name: "Blend",
            make_or_buy: "make",
            unit_of_measure: "ea",
          }),
          bomLine({
            component_item_id: 2,
            quantity: 6,
            bom_unit_of_measure: "tbsp",
            component_name: "Oil",
            make_or_buy: "buy",
            unit_of_measure: "fl_oz",
          }),
        ],
      ],
      [
        4,
        [
          bomLine({
            component_item_id: 2,
            quantity: 6,
            bom_unit_of_measure: "tbsp",
            component_name: "Oil",
            make_or_buy: "buy",
            unit_of_measure: "fl_oz",
          }),
        ],
      ],
    ]);
    const queries = installBatchDb(items, bomByParent);
    const res = mockRes();

    await createBatch(
      {
        auth: { clientId: 7, userId: 9 },
        body: { item_id: 1, quantity: 1, sku: "LOT-4" },
      },
      res
    );

    assert.equal(res.statusCode, 201);
    const byItem = new Map(
      componentInserts(queries).map((query) => [query.params[1], query.params])
    );
    assert.equal(byItem.size, 2);
    assert.deepEqual(byItem.get(4).slice(1), [4, 1, null, null, "ea"]);
    // 6 tbsp + 6 tbsp = 3 fl_oz + 3 fl_oz. Unit stays tbsp.
    assert.equal(byItem.get(2)[2], 6);
    assert.equal(byItem.get(2)[5], "tbsp");
  });

  it("falls back to the stock unit when rolled-up recipe units disagree", async () => {
    const items = new Map([
      [
        1,
        item({
          id: 1,
          name: "Soap",
          make_or_buy: "make",
          unit_of_measure: "ea",
        }),
      ],
      [
        2,
        item({
          id: 2,
          name: "Oil",
          make_or_buy: "buy",
          unit_of_measure: "fl_oz",
          unit_cost: 2,
        }),
      ],
      [
        4,
        item({
          id: 4,
          name: "Blend",
          make_or_buy: "make",
          unit_of_measure: "ea",
        }),
      ],
    ]);
    const bomByParent = new Map([
      [
        1,
        [
          bomLine({
            component_item_id: 4,
            quantity: 1,
            bom_unit_of_measure: null,
            component_name: "Blend",
            make_or_buy: "make",
            unit_of_measure: "ea",
          }),
          bomLine({
            component_item_id: 2,
            quantity: 2,
            bom_unit_of_measure: "fl_oz",
            component_name: "Oil",
            make_or_buy: "buy",
            unit_of_measure: "fl_oz",
          }),
        ],
      ],
      [
        4,
        [
          bomLine({
            component_item_id: 2,
            quantity: 6,
            bom_unit_of_measure: "tbsp",
            component_name: "Oil",
            make_or_buy: "buy",
            unit_of_measure: "fl_oz",
          }),
        ],
      ],
    ]);
    const queries = installBatchDb(items, bomByParent);
    const res = mockRes();

    await createBatch(
      {
        auth: { clientId: 7, userId: 9 },
        body: { item_id: 1, quantity: 1, sku: "LOT-5" },
      },
      res
    );

    assert.equal(res.statusCode, 201);
    const byItem = new Map(
      componentInserts(queries).map((query) => [query.params[1], query.params])
    );
    assert.equal(byItem.get(4)[5], "ea");
    // 6 tbsp = 3 fl_oz, plus 2 fl_oz.
    assert.equal(byItem.get(2)[2], 5);
    assert.equal(byItem.get(2)[5], "fl_oz");
  });
});

describe("batch component unit backfill", { concurrency: 1 }, () => {
  it("adds the column if needed and updates only NULL units", async () => {
    assert.match(
      ADD_BATCH_COMPONENT_UNIT_SQL,
      /ADD COLUMN IF NOT EXISTS unit_of_measure TEXT/
    );
    assert.match(
      BACKFILL_BATCH_COMPONENT_UNITS_SQL,
      /NULLIF\(bom\.unit_of_measure, ''\)/
    );
    assert.match(
      BACKFILL_BATCH_COMPONENT_UNITS_SQL,
      /NULLIF\(i\.unit_of_measure, ''\)/
    );
    assert.match(
      BACKFILL_BATCH_COMPONENT_UNITS_SQL,
      /bc\.unit_of_measure IS NULL/
    );

    const calls = [];
    const client = {
      async query(sql) {
        const text = String(sql);
        calls.push(text);
        if (text.includes("information_schema.tables")) {
          return { rows: [{ exists: 1 }] };
        }
        if (text.includes("information_schema.columns")) {
          return { rows: [] };
        }
        if (text.includes("ADD COLUMN IF NOT EXISTS")) {
          return { rows: [] };
        }
        if (text.includes("UPDATE batch_components")) {
          return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
        }
        if (text.includes("COUNT(*)")) {
          return { rows: [{ remaining: 1 }] };
        }
        throw new Error(`unexpected sql: ${text}`);
      },
    };

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      const updated = await backfillBatchComponentUnits(client);
      assert.equal(updated, 2);
    } finally {
      console.log = originalLog;
    }

    assert.equal(
      calls.some((sql) => sql.includes("ADD COLUMN IF NOT EXISTS")),
      true
    );
    assert.equal(
      calls.some((sql) => sql.includes("UPDATE batch_components")),
      true
    );
    assert.deepEqual(logs, [
      "Added batch_components.unit_of_measure",
      "Updated 2 batch_components row(s)",
      "1 batch_components row(s) still have no unit",
    ]);
  });

  it("reports zero updates when every row already has a unit", async () => {
    const client = {
      async query(sql) {
        const text = String(sql);
        if (text.includes("information_schema.tables")) return { rows: [{}] };
        if (text.includes("information_schema.columns")) return { rows: [{}] };
        if (text.includes("ADD COLUMN IF NOT EXISTS")) return { rows: [] };
        if (text.includes("UPDATE batch_components")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("COUNT(*)")) return { rows: [{ remaining: 0 }] };
        throw new Error(`unexpected sql: ${text}`);
      },
    };

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      const updated = await backfillBatchComponentUnits(client);
      assert.equal(updated, 0);
    } finally {
      console.log = originalLog;
    }

    assert.deepEqual(logs, [
      "batch_components.unit_of_measure already exists",
      "Updated 0 batch_components row(s)",
      "0 batch_components row(s) still have no unit",
    ]);
  });
});
