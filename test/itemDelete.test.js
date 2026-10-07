import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_item_delete_test";

const { pool } = await import("../lib/db.js");
const { deleteItem } = await import("../api-functions/items.js");

pool.options.connectionTimeoutMillis = 500;

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
    end() {
      this.ended = true;
      return this;
    },
  };
}

function installDeleteDb({ found = true, recipes = [], batches = [] } = {}) {
  const queries = [];
  pool.connect = async () => ({
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [] };
      }
      if (text.includes("FROM bom_items")) {
        return { rows: recipes.map((name) => ({ name })) };
      }
      if (text.includes("FROM batches")) {
        return { rows: batches.map((label) => ({ label })) };
      }
      if (text.includes("FROM items")) {
        return { rows: found ? [{ id: Number(params[0]) }] : [] };
      }
      return { rows: [] };
    },
    release() {},
  });
  return queries;
}

function deleteReq(clientId = 4) {
  return {
    auth: { clientId, userId: 9 },
    params: { id: "10" },
  };
}

after(async () => {
  await pool.end();
});

describe("deleteItem refuses an item that is still in use", { concurrency: 1 }, () => {
  it("names the recipes that use the item and does not delete it", async () => {
    const queries = installDeleteDb({ recipes: ["Lotion", "Soap"] });
    const res = mockRes();
    await deleteItem(deleteReq(), res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, "Used in the recipe for: Lotion, Soap");
    const lookup = queries.find((query) => query.sql.includes("FROM bom_items"));
    assert.match(lookup.sql, /b\.component_item_id = \$1/);
    assert.match(lookup.sql, /p\.client_id = \$2/);
    assert.match(lookup.sql, /b\.parent_item_id <> \$1/);
    assert.deepEqual(lookup.params, ["10", 4]);
    assert.equal(
      queries.some((query) => query.sql.includes("DELETE FROM items")),
      false
    );
    assert.ok(queries.some((query) => query.sql === "ROLLBACK"));
    assert.equal(
      queries.some((query) => query.sql === "COMMIT"),
      false
    );
  });

  it("names the active batch and only treats planned and in-progress batches as active", async () => {
    const queries = installDeleteDb({ batches: ["LOT-9"] });
    const res = mockRes();
    await deleteItem(deleteReq(), res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, "Used in active batch: LOT-9");
    const lookup = queries.find((query) => query.sql.includes("FROM batches"));
    assert.match(lookup.sql, /b\.status IN \('planned', 'in_progress'\)/);
    assert.match(lookup.sql, /b\.item_id = \$1/);
    assert.match(lookup.sql, /batch_components/);
    assert.match(lookup.sql, /b\.client_id = \$2/);
    assert.equal(
      queries.some((query) => query.sql.includes("DELETE FROM items")),
      false
    );
  });

  it("names both the recipes and the active batches", async () => {
    const queries = installDeleteDb({
      recipes: ["Soap"],
      batches: ["LOT-1", "LOT-2"],
    });
    const res = mockRes();
    await deleteItem(deleteReq(), res);

    assert.equal(res.statusCode, 409);
    assert.equal(
      res.body.error,
      "Used in the recipe for: Soap. Used in active batch: LOT-1, LOT-2"
    );
    assert.equal(
      queries.some((query) => query.sql.includes("DELETE FROM items")),
      false
    );
  });

  it("returns 404 for another company's item and does not look up recipes", async () => {
    const queries = installDeleteDb({ found: false, recipes: ["Soap"] });
    const res = mockRes();
    await deleteItem(deleteReq(99), res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, "Item not found");
    const owned = queries.find((query) => query.sql.includes("FROM items"));
    assert.deepEqual(owned.params, ["10", 99]);
    assert.equal(
      queries.some((query) => query.sql.includes("FROM bom_items")),
      false
    );
    assert.equal(
      queries.some((query) => query.sql.includes("DELETE FROM items")),
      false
    );
  });

  it("deletes an item that is not used in another recipe or an active batch", async () => {
    const queries = installDeleteDb();
    const res = mockRes();
    await deleteItem(deleteReq(), res);

    assert.equal(res.statusCode, 204);
    assert.equal(res.ended, true);
    assert.ok(queries.some((query) => query.sql.includes("DELETE FROM items")));
    const commitAt = queries.findIndex((query) => query.sql === "COMMIT");
    const deleteAt = queries.findIndex((query) =>
      query.sql.includes("DELETE FROM items")
    );
    assert.ok(deleteAt > -1 && deleteAt < commitAt);
  });
});
