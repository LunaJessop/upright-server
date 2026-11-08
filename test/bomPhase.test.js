import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_bom_phase_test";

const { pool } = await import("../lib/db.js");
const {
  hasBomPhaseColumn,
  resetBomPhaseColumnCacheForTests,
} = await import("../lib/bomPhase.js");
const { createItem, getItems } = await import("../api-functions/items.js");
const { getBatches } = await import("../api-functions/batches.js");

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

function authReq(body, extra = {}) {
  return {
    auth: { clientId: 4, userId: 9 },
    params: { id: "10" },
    query: {},
    body,
    ...extra,
  };
}

after(async () => {
  resetBomPhaseColumnCacheForTests();
  await pool.end();
});

describe("recipe line phase", { concurrency: 1 }, () => {
  it("ships an idempotent column that points at the company phase", () => {
    const sql = readFileSync(
      new URL("../scripts/sql/bom-line-phase.sql", import.meta.url),
      "utf8"
    );
    assert.match(sql, /ADD COLUMN IF NOT EXISTS phase_id INTEGER/);
    assert.match(sql, /REFERENCES client_router_phase_templates\(id\)/);
    assert.match(sql, /ON DELETE SET NULL/);
    assert.match(sql, /bom_items_phase_id_fkey/);
    assert.match(sql, /IF NOT EXISTS/);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS bom_items_phase_id_idx/);
  });

  it("stores a phase that belongs to the company and returns its name", async () => {
    resetBomPhaseColumnCacheForTests();
    await hasBomPhaseColumn({
      async query() {
        return { rows: [{}] };
      },
    });
    const queries = [];
    pool.connect = async () => ({
      async query(sql, params = []) {
        const text = String(sql);
        queries.push({ sql: text, params });
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO items")) {
          return { rows: [{ id: 10, name: params[1], client_id: params[0] }] };
        }
        if (text.includes("FROM client_router_phase_templates")) {
          assert.equal(params[0], 4);
          if (params[1].includes(9)) return { rows: [{ id: 9, name: "Mix" }] };
          return { rows: [] };
        }
        if (text.includes("SELECT id, unit_of_measure")) {
          return { rows: [{ id: 2, unit_of_measure: "fl_oz" }] };
        }
        if (text.includes("SELECT unit_of_measure FROM items")) {
          return { rows: [{ unit_of_measure: "fl_oz" }] };
        }
        if (text.includes("INSERT INTO bom_items")) return { rows: [] };
        return { rows: [] };
      },
      release() {},
    });

    const res = mockRes();
    await createItem(
      authReq({
        name: "Soap",
        make_or_buy: "make",
        unit_of_measure: "ea",
        bom_items: [
          { component_item_id: 2, quantity: 1, unit_of_measure: "fl_oz", phase_id: 9 },
        ],
      }),
      res
    );

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.bom_items[0].phase_id, 9);
    assert.equal(res.body.bom_items[0].phase_name, "Mix");
    const insert = queries.find((query) => query.sql.includes("INSERT INTO bom_items"));
    assert.match(insert.sql, /phase_id/);
    assert.deepEqual(insert.params, [10, 2, 1, "fl_oz", 9]);
  });

  it("rejects a phase from another company and an id that is not a phase", async () => {
    resetBomPhaseColumnCacheForTests();
    await hasBomPhaseColumn({
      async query() {
        return { rows: [{}] };
      },
    });
    const queries = [];
    pool.connect = async () => ({
      async query(sql, params = []) {
        queries.push(String(sql));
        if (String(sql) === "BEGIN" || String(sql) === "ROLLBACK" || String(sql) === "COMMIT") {
          return { rows: [] };
        }
        if (String(sql).includes("INSERT INTO items")) {
          return { rows: [{ id: 10, name: "Soap" }] };
        }
        if (String(sql).includes("SELECT id, unit_of_measure")) {
          return { rows: [{ id: 2, unit_of_measure: "ea" }] };
        }
        if (String(sql).includes("FROM client_router_phase_templates")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      release() {},
    });

    const foreign = mockRes();
    await createItem(
      authReq({
        name: "Soap",
        make_or_buy: "make",
        unit_of_measure: "ea",
        bom_items: [{ component_item_id: 2, quantity: 1, phase_id: 99 }],
      }),
      foreign
    );
    assert.equal(foreign.statusCode, 400);
    assert.equal(foreign.body.error, "Phase must belong to your company");
    assert.equal(queries.some((sql) => sql.includes("INSERT INTO bom_items")), false);

    const bad = mockRes();
    await createItem(
      authReq({
        name: "Soap",
        make_or_buy: "make",
        unit_of_measure: "ea",
        bom_items: [{ component_item_id: 2, quantity: 1, phase_id: "nope" }],
      }),
      bad
    );
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.error, "phase_id must be a company phase");
  });

  it("ignores phase_id when the column is not there yet", async () => {
    resetBomPhaseColumnCacheForTests();
    await hasBomPhaseColumn({
      async query() {
        return { rows: [] };
      },
    });
    const queries = [];
    pool.connect = async () => ({
      async query(sql, params = []) {
        const text = String(sql);
        queries.push({ sql: text, params });
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("INSERT INTO items")) return { rows: [{ id: 10, name: "Soap" }] };
        if (text.includes("SELECT id, unit_of_measure")) {
          return { rows: [{ id: 2, unit_of_measure: "ea" }] };
        }
        if (text.includes("SELECT unit_of_measure FROM items")) {
          return { rows: [{ unit_of_measure: "ea" }] };
        }
        if (text.includes("INSERT INTO bom_items")) return { rows: [] };
        return { rows: [] };
      },
      release() {},
    });

    const res = mockRes();
    await createItem(
      authReq({
        name: "Soap",
        make_or_buy: "make",
        unit_of_measure: "ea",
        bom_items: [{ component_item_id: 2, quantity: 1, phase_id: 9 }],
      }),
      res
    );
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.bom_items[0].phase_id, null);
    assert.equal(res.body.bom_items[0].phase_name, null);
    const insert = queries.find((query) => query.sql.includes("INSERT INTO bom_items"));
    assert.equal(insert.sql.includes("phase_id"), false);
    assert.equal(insert.params.length, 4);
  });

  it("includes phase_id and phase_name on item recipes and batch materials", async () => {
    resetBomPhaseColumnCacheForTests();
    const queries = [];
    pool.query = async (sql) => {
      const text = String(sql);
      queries.push(text);
      if (text.includes("information_schema.columns")) return { rows: [{}] };
      if (text.includes("WITH RECURSIVE")) {
        return {
          rows: [
            { batch_id: 7, component_item_id: 2, phase_id: 9, phase_name: "Mix" },
            { batch_id: 7, component_item_id: 3, phase_id: 9, phase_name: "Mix" },
            { batch_id: 7, component_item_id: 3, phase_id: 4, phase_name: "Cure" },
          ],
        };
      }
      if (text.includes("FROM batches")) {
        return {
          rows: [
            {
              id: 7,
              components: [
                { item_id: 2, name: "Oil" },
                { item_id: 3, name: "Lye" },
              ],
            },
          ],
        };
      }
      return {
        rows: [
          {
            id: 10,
            bom_items: [{ component_item_id: 2, phase_id: 9, phase_name: "Mix" }],
          },
        ],
      };
    };

    const items = mockRes();
    await getItems(authReq(undefined, { query: {} }), items);
    assert.equal(items.statusCode, 200);
    assert.match(queries[1], /'phase_id', b\.phase_id/);
    assert.match(queries[1], /'phase_name', ph\.name/);
    assert.match(queries[1], /ph\.client_id = i\.client_id/);
    assert.equal(items.body[0].bom_items[0].phase_name, "Mix");

    const again = mockRes();
    const before = queries.length;
    await getItems(authReq(undefined, { query: {} }), again);
    assert.equal(
      queries.slice(before).some((sql) => sql.includes("information_schema.columns")),
      false
    );

    queries.length = 0;
    const batches = mockRes();
    await getBatches(authReq(), batches);
    assert.equal(batches.statusCode, 200);
    assert.deepEqual(batches.body[0].components[0], {
      item_id: 2,
      name: "Oil",
      phase_id: 9,
      phase_name: "Mix",
    });
    assert.equal(batches.body[0].components[1].phase_id, null);
    assert.equal(batches.body[0].components[1].phase_name, null);
    assert.match(queries.find((sql) => sql.includes("WITH RECURSIVE")), /client_id = \$1/);
  });

  it("returns null phases on batch materials when the column is missing", async () => {
    resetBomPhaseColumnCacheForTests();
    const queries = [];
    pool.query = async (sql) => {
      const text = String(sql);
      queries.push(text);
      if (text.includes("information_schema.columns")) return { rows: [] };
      return {
        rows: [{ id: 7, components: [{ item_id: 2, name: "Oil" }] }],
      };
    };
    const res = mockRes();
    await getBatches(authReq(), res);
    assert.equal(res.body[0].components[0].phase_id, null);
    assert.equal(res.body[0].components[0].phase_name, null);
    assert.equal(queries.some((sql) => sql.includes("WITH RECURSIVE")), false);
  });
});
