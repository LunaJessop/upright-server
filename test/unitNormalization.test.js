import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_unit_normalization_test";

const { pool } = await import("../lib/db.js");
const { createItem, updateItem } = await import("../api-functions/items.js");
const { createBatch } = await import("../api-functions/batches.js");
const {
  NORMALIZE_UNIT_SQL,
  normalizeStoredUnitCodes,
} = await import("../scripts/normalize-unit-codes.js");

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

const UNKNOWN_UNIT_ERROR =
  'Unknown unit "widgets". Pick a unit from the list, like each, oz, lb, fl oz, cup, g, or mL.';

function installItemDb(storedUnit = "ea", componentUnit = null) {
  const queries = [];
  pool.connect = async () => ({
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [] };
      }
      if (text.includes("INSERT INTO items") || text.includes("UPDATE items")) {
        return {
          rows: [
            {
              id: 10,
              name: text.includes("INSERT INTO items") ? params[1] : params[0],
              unit_of_measure: text.includes("INSERT INTO items")
                ? params[5]
                : params[4],
            },
          ],
        };
      }
      if (text.includes("FOR UPDATE")) {
        return { rows: [{ unit_of_measure: storedUnit }] };
      }
      if (text.includes("FROM bom_items") && text.includes("parent_item_id")) {
        return { rows: [] };
      }
      if (text.includes("SELECT id, unit_of_measure")) {
        return {
          rows: [{ id: 2, unit_of_measure: componentUnit ?? "fl_oz" }],
        };
      }
      if (text.includes("SELECT unit_of_measure FROM items")) {
        return {
          rows: [{ unit_of_measure: componentUnit ?? "fl oz" }],
        };
      }
      if (text.includes("INSERT INTO bom_items")) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  });
  pool.query = async () => ({ rows: [{ id: 10 }] });
  return queries;
}

function itemBody(overrides = {}) {
  return {
    name: "Oil",
    make_or_buy: "buy",
    unit_of_measure: "ea",
    ...overrides,
  };
}

after(async () => {
  await pool.end();
});

describe("unit writes are stored canonically", { concurrency: 1 }, () => {
  it("stores an alias as the canonical item unit and still allows a blank unit", async () => {
    const canonicalQueries = installItemDb();
    const canonical = mockRes();
    await createItem(
      {
        auth: { clientId: 4, userId: 9 },
        body: itemBody({ unit_of_measure: " gallons " }),
      },
      canonical
    );
    assert.equal(canonical.statusCode, 201);
    const insert = canonicalQueries.find((query) =>
      query.sql.includes("INSERT INTO items")
    );
    assert.equal(insert.params[5], "gal");

    const blankQueries = installItemDb();
    const blank = mockRes();
    await createItem(
      {
        auth: { clientId: 4, userId: 9 },
        body: itemBody({ unit_of_measure: "   " }),
      },
      blank
    );
    assert.equal(blank.statusCode, 201);
    const blankInsert = blankQueries.find((query) =>
      query.sql.includes("INSERT INTO items")
    );
    assert.equal(blankInsert.params[5], "");
  });

  it("rejects an unknown unit on item create", async () => {
    const queries = installItemDb();
    const res = mockRes();
    await createItem(
      {
        auth: { clientId: 4, userId: 9 },
        body: itemBody({ unit_of_measure: "widgets" }),
      },
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, UNKNOWN_UNIT_ERROR);
    assert.equal(
      queries.some((query) => query.sql.includes("INSERT INTO items")),
      false
    );
  });

  it("rejects an unknown unit on item update", async () => {
    const queries = installItemDb("ea");
    const res = mockRes();
    await updateItem(
      {
        auth: { clientId: 4, userId: 9 },
        params: { id: "10" },
        body: itemBody({ unit_of_measure: "widgets" }),
      },
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, UNKNOWN_UNIT_ERROR);
    assert.equal(
      queries.some((query) => query.sql.includes("UPDATE items")),
      false
    );
  });

  it("rejects an unknown unit on BOM insert", async () => {
    const queries = installItemDb();
    const res = mockRes();
    await createItem(
      {
        auth: { clientId: 4, userId: 9 },
        body: itemBody({
          name: "Soap",
          make_or_buy: "make",
          unit_of_measure: "ea",
          bom_items: [
            { component_item_id: 2, quantity: 1, unit_of_measure: "widgets" },
          ],
        }),
      },
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, UNKNOWN_UNIT_ERROR);
    assert.equal(
      queries.some((query) => query.sql.includes("INSERT INTO bom_items")),
      false
    );
  });

  it("lets a legacy unit stay when an update does not change it", async () => {
    const sameQueries = installItemDb("widgets");
    const same = mockRes();
    await updateItem(
      {
        auth: { clientId: 4, userId: 9 },
        params: { id: "10" },
        body: itemBody({ name: "Renamed oil", unit_of_measure: "widgets" }),
      },
      same
    );
    assert.equal(same.statusCode, 200);
    const sameUpdate = sameQueries.find((query) =>
      query.sql.includes("UPDATE items")
    );
    assert.equal(sameUpdate.params[0], "Renamed oil");
    assert.equal(sameUpdate.params[4], "widgets");

    const omittedBody = itemBody({ name: "Renamed again" });
    delete omittedBody.unit_of_measure;
    const omittedQueries = installItemDb("  widgets  ");
    const omitted = mockRes();
    await updateItem(
      {
        auth: { clientId: 4, userId: 9 },
        params: { id: "10" },
        body: omittedBody,
      },
      omitted
    );
    assert.equal(omitted.statusCode, 200);
    const omittedUpdate = omittedQueries.find((query) =>
      query.sql.includes("UPDATE items")
    );
    assert.equal(omittedUpdate.params[0], "Renamed again");
    assert.equal(omittedUpdate.params[4], "  widgets  ");
  });

  it("stores a canonical unit when an item is updated", async () => {
    const queries = installItemDb("lb");
    const res = mockRes();
    await updateItem(
      {
        auth: { clientId: 4, userId: 9 },
        params: { id: "10" },
        body: itemBody({ unit_of_measure: "Lbs" }),
      },
      res
    );
    assert.equal(res.statusCode, 200);
    const update = queries.find((query) => query.sql.includes("UPDATE items"));
    assert.equal(update.params[4], "lb");
  });

  it("stores the BOM line unit canonically, including a spaced alias of the stock unit", async () => {
    const queries = installItemDb();
    const res = mockRes();
    await createItem(
      {
        auth: { clientId: 4, userId: 9 },
        body: itemBody({
          name: "Soap",
          make_or_buy: "make",
          unit_of_measure: "ea",
          bom_items: [
            { component_item_id: 2, quantity: 2, unit_of_measure: "Tbsp" },
            { component_item_id: 2, quantity: 1, unit_of_measure: "fl oz" },
          ],
        }),
      },
      res
    );
    assert.equal(res.statusCode, 201);
    const bomInserts = queries.filter((query) =>
      query.sql.includes("INSERT INTO bom_items")
    );
    assert.deepEqual(
      bomInserts.map((query) => query.params[3]),
      ["tbsp", "fl_oz"]
    );
  });

  it("accepts a metric BOM line on an imperial stock unit", async () => {
    const queries = installItemDb("ea", "oz");
    const res = mockRes();
    await createItem(
      {
        auth: { clientId: 4, userId: 9 },
        body: itemBody({
          name: "Soap",
          make_or_buy: "make",
          unit_of_measure: "ea",
          bom_items: [
            { component_item_id: 2, quantity: 100, unit_of_measure: "g" },
          ],
        }),
      },
      res
    );
    assert.equal(res.statusCode, 201);
    const bomInsert = queries.find((query) =>
      query.sql.includes("INSERT INTO bom_items")
    );
    assert.equal(bomInsert.params[3], "g");
  });

  it("still rejects a weight line on a volume stock unit", async () => {
    installItemDb("ea", "fl_oz");
    const res = mockRes();
    await createItem(
      {
        auth: { clientId: 4, userId: 9 },
        body: itemBody({
          name: "Soap",
          make_or_buy: "make",
          unit_of_measure: "ea",
          bom_items: [
            { component_item_id: 2, quantity: 100, unit_of_measure: "g" },
          ],
        }),
      },
      res
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /not compatible with component stock unit/);
  });

  it("stores a canonical batch component unit without changing the converted quantity", async () => {
    const items = new Map([
      [
        1,
        {
          id: 1,
          name: "Soap",
          make_or_buy: "make",
          unit_of_measure: "ea",
          unit_sell_price: 12,
          default_unit_price: null,
        },
      ],
      [
        2,
        {
          id: 2,
          name: "Oil",
          make_or_buy: "buy",
          unit_of_measure: "FL OZ",
          unit_cost: 2,
          default_unit_price: null,
        },
      ],
    ]);
    const bomByParent = new Map([
      [
        1,
        [
          {
            component_item_id: 2,
            quantity: 2,
            bom_unit_of_measure: "Tbsp",
            component_name: "Oil",
            make_or_buy: "buy",
            unit_of_measure: "FL OZ",
          },
        ],
      ],
    ]);
    const queries = [];
    pool.connect = async () => ({
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
          return {
            rows: (params[1] ?? []).map((id) => {
              const row = items.get(id);
              return {
                id,
                make_or_buy: row.make_or_buy,
                unit_cost: row.unit_cost ?? null,
                default_unit_price: row.default_unit_price ?? null,
              };
            }),
          };
        }
        if (text.includes("INSERT INTO batches")) {
          return { rows: [{ id: 50, item_id: params[1], quantity: params[2] }] };
        }
        if (text.includes("FROM items")) {
          const row = items.get(params[0]);
          return { rows: row ? [row] : [] };
        }
        return { rows: [] };
      },
      release() {},
    });
    pool.query = async () => ({ rows: [{ id: 50 }] });

    const res = mockRes();
    await createBatch(
      {
        auth: { clientId: 7, userId: 9 },
        body: { item_id: 1, quantity: 3, sku: "LOT-1" },
      },
      res
    );

    assert.equal(res.statusCode, 201);
    const insert = queries.find((query) =>
      query.sql.includes("INSERT INTO batch_components")
    );
    assert.equal(insert.params[1], 2);
    // 2 tbsp = 1 fl_oz, times batch quantity 3. Alias spelling does not change that.
    assert.equal(insert.params[2], 3);
    assert.equal(insert.params[5], "tbsp");
  });

  it("creates a batch when a BOM line still has a legacy unknown unit", async () => {
    const items = new Map([
      [
        1,
        {
          id: 1,
          name: "Soap",
          make_or_buy: "make",
          unit_of_measure: "ea",
          unit_sell_price: 12,
          default_unit_price: null,
        },
      ],
      [
        2,
        {
          id: 2,
          name: "Oil",
          make_or_buy: "buy",
          unit_of_measure: "widgets",
          unit_cost: 2,
          default_unit_price: null,
        },
      ],
    ]);
    const bomByParent = new Map([
      [
        1,
        [
          {
            component_item_id: 2,
            quantity: 4,
            bom_unit_of_measure: "widgets",
            component_name: "Oil",
            make_or_buy: "buy",
            unit_of_measure: "widgets",
          },
        ],
      ],
    ]);
    const queries = [];
    pool.connect = async () => ({
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
          return {
            rows: (params[1] ?? []).map((id) => {
              const row = items.get(id);
              return {
                id,
                make_or_buy: row.make_or_buy,
                unit_cost: row.unit_cost ?? null,
                default_unit_price: row.default_unit_price ?? null,
              };
            }),
          };
        }
        if (text.includes("INSERT INTO batches")) {
          return { rows: [{ id: 50, item_id: params[1], quantity: params[2] }] };
        }
        if (text.includes("FROM items")) {
          const row = items.get(params[0]);
          return { rows: row ? [row] : [] };
        }
        return { rows: [] };
      },
      release() {},
    });
    pool.query = async () => ({ rows: [{ id: 50 }] });

    const res = mockRes();
    await createBatch(
      {
        auth: { clientId: 7, userId: 9 },
        body: { item_id: 1, quantity: 3, sku: "LOT-1" },
      },
      res
    );

    assert.equal(res.statusCode, 201);
    const insert = queries.find((query) =>
      query.sql.includes("INSERT INTO batch_components")
    );
    assert.equal(insert.params[1], 2);
    // Same unknown unit on the line and the stock item: quantity is unchanged.
    assert.equal(insert.params[2], 12);
    assert.equal(insert.params[5], "widgets");
  });
});

describe("normalize stored unit codes", { concurrency: 1 }, () => {
  it("rewrites known spellings, leaves unmapped values, and is idempotent in SQL", () => {
    for (const sql of Object.values(NORMALIZE_UNIT_SQL)) {
      assert.match(sql, /WHEN .+ IN \(.+'floz'.+\) THEN 'fl_oz'/s);
      assert.match(sql, /ELSE unit_of_measure/);
      assert.match(sql, /IS DISTINCT FROM/);
      assert.doesNotMatch(sql, /THEN 'widget'/);
    }
  });

  it("updates only mapped values and prints the ones it could not map", async () => {
    const grouped = {
      items: [
        { unit: "tbsp", n: 2 },
        { unit: "Tbsp", n: 1 },
        { unit: "mL", n: 4 },
        { unit: "  gal  ", n: 3 },
        { unit: "widget", n: 1 },
        { unit: "", n: 2 },
      ],
      bom_items: [{ unit: "fl_oz", n: 5 }],
      batch_components: [
        { unit: "floz", n: 2 },
        { unit: "  Custom Box  ", n: 1 },
      ],
    };
    const updates = [];
    const client = {
      async query(sql, params) {
        const text = String(sql);
        if (text.includes("information_schema.tables")) return { rows: [{}] };
        if (text.includes("information_schema.columns")) return { rows: [{}] };
        if (text.includes("GROUP BY")) {
          const table = text.match(/FROM (\w+)/)[1];
          return { rows: grouped[table] ?? [] };
        }
        if (text.startsWith("UPDATE")) {
          updates.push({ sql: text, params });
          return { rowCount: 1 };
        }
        throw new Error(`unexpected sql: ${text}`);
      },
    };

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    let summary;
    try {
      summary = await normalizeStoredUnitCodes(client);
    } finally {
      console.log = originalLog;
    }

    assert.deepEqual(
      updates.map((update) => update.params),
      [
        ["tbsp", "Tbsp"],
        ["gal", "  gal  "],
        ["fl_oz", "floz"],
      ]
    );
    assert.equal(summary[0].updated, 2);
    assert.equal(summary[0].alreadyCanonical, 6);
    assert.deepEqual(summary[0].unmapped, [{ value: "widget", count: 1 }]);
    assert.equal(summary[1].updated, 0);
    assert.equal(summary[1].alreadyCanonical, 5);
    assert.equal(summary[2].updated, 1);
    assert.deepEqual(summary[2].unmapped, [
      { value: "  Custom Box  ", count: 1 },
    ]);
    assert.ok(logs.some((line) => line.includes('unmapped "widget" (1)')));
    assert.ok(
      logs.some((line) => line.includes('unmapped "  Custom Box  " (1)'))
    );
  });
});
