import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_tags_test";

const { pool } = await import("../lib/db.js");
const { updateTag, deleteTag } = await import("../api-functions/tags.js");

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
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

function authReq(body, id = "3") {
  return {
    auth: { clientId: 4, userId: 9 },
    body,
    params: { id },
  };
}

after(async () => {
  await pool.end();
});

describe("rename tag", { concurrency: 1 }, () => {
  it("trims the name and returns the updated tag", async () => {
    const queries = [];
    pool.query = async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text.includes("SELECT id FROM tags")) {
        return { rows: [{ id: 3 }] };
      }
      if (text.includes("id <>")) return { rows: [] };
      if (text.includes("UPDATE tags")) {
        return {
          rows: [
            {
              id: 3,
              name: params[0],
              created_at: "2026-09-27T00:00:00.000Z",
            },
          ],
        };
      }
      throw new Error(`unexpected sql: ${text}`);
    };

    const res = mockRes();
    await updateTag(authReq({ name: "  Retail  " }, "3"), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      id: 3,
      name: "Retail",
      created_at: "2026-09-27T00:00:00.000Z",
    });
    const update = queries.find((query) => query.sql.includes("UPDATE tags"));
    assert.deepEqual(update.params, ["Retail", 3, 4]);
  });

  it("allows a case-only change of the same tag", async () => {
    const queries = [];
    pool.query = async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text.includes("SELECT id FROM tags")) return { rows: [{ id: 3 }] };
      if (text.includes("id <>")) return { rows: [] };
      if (text.includes("UPDATE tags")) {
        return { rows: [{ id: 3, name: params[0], created_at: "t" }] };
      }
      throw new Error(`unexpected sql: ${text}`);
    };

    const res = mockRes();
    await updateTag(authReq({ name: "Retail" }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.name, "Retail");
    const conflict = queries.find((query) => query.sql.includes("id <>"));
    assert.deepEqual(conflict.params, [4, "Retail", 3]);
    assert.equal(
      queries.some((query) => query.sql.includes("UPDATE tags")),
      true
    );
  });

  it("returns 404 when the tag belongs to another client or does not exist", async () => {
    pool.query = async (sql) => {
      const text = String(sql);
      if (text.includes("SELECT id FROM tags")) return { rows: [] };
      throw new Error(`should not continue: ${text}`);
    };

    const res = mockRes();
    await updateTag(authReq({ name: "Retail" }, "99"), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: "Tag not found" });

    let queried = false;
    pool.query = async () => {
      queried = true;
      return { rows: [] };
    };
    const badId = mockRes();
    await updateTag(authReq({ name: "Retail" }, "nope"), badId);
    assert.equal(badId.statusCode, 404);
    assert.equal(queried, false);
  });

  it("returns 409 when another tag already uses that name, ignoring case", async () => {
    pool.query = async (sql) => {
      const text = String(sql);
      if (text.includes("SELECT id FROM tags")) return { rows: [{ id: 3 }] };
      if (text.includes("id <>")) return { rows: [{ id: 8, name: "Summer" }] };
      throw new Error(`should not update: ${text}`);
    };

    const res = mockRes();
    await updateTag(authReq({ name: " summer " }), res);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, {
      error: "You already have a tag called Summer.",
    });
  });

  it("rejects a blank name", async () => {
    pool.query = async () => {
      throw new Error("should not query");
    };

    for (const name of ["", "   ", undefined]) {
      const res = mockRes();
      await updateTag(authReq({ name }), res);
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { error: "Tag name is required" });
    }
  });
});

describe("delete tag", { concurrency: 1 }, () => {
  it("removes item links and then the tag in one transaction", async () => {
    const queries = [];
    pool.connect = async () => ({
      async query(sql, params = []) {
        const text = String(sql);
        queries.push({ sql: text, params });
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
          return { rows: [] };
        }
        if (text.includes("SELECT id FROM tags")) return { rows: [{ id: 3 }] };
        if (text.includes("DELETE FROM item_tags")) return { rows: [], rowCount: 2 };
        if (text.includes("DELETE FROM tags")) return { rows: [{ id: 3 }] };
        throw new Error(`unexpected sql: ${text}`);
      },
      release() {},
    });

    const res = mockRes();
    await deleteTag(authReq(undefined, "3"), res);

    assert.equal(res.statusCode, 204);
    assert.equal(res.body, undefined);
    assert.deepEqual(
      queries.map((query) => query.sql.split("\n")[0]),
      [
        "BEGIN",
        "SELECT id FROM tags WHERE id = $1 AND client_id = $2",
        "DELETE FROM item_tags WHERE tag_id = $1",
        "DELETE FROM tags",
        "COMMIT",
      ]
    );
    const linkDelete = queries.find((query) =>
      query.sql.includes("DELETE FROM item_tags")
    );
    const tagDelete = queries.find((query) =>
      query.sql.includes("DELETE FROM tags")
    );
    assert.deepEqual(linkDelete.params, [3]);
    assert.deepEqual(tagDelete.params, [3, 4]);
    assert.ok(
      queries.findIndex((query) => query.sql.includes("DELETE FROM item_tags")) <
        queries.findIndex((query) => query.sql.includes("DELETE FROM tags"))
    );
  });

  it("returns 404 for another client's tag and does not delete links", async () => {
    const queries = [];
    pool.connect = async () => ({
      async query(sql, params = []) {
        const text = String(sql);
        queries.push({ sql: text, params });
        if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("SELECT id FROM tags")) return { rows: [] };
        throw new Error(`should not continue: ${text}`);
      },
      release() {},
    });

    const res = mockRes();
    await deleteTag(authReq(undefined, "99"), res);

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: "Tag not found" });
    assert.equal(
      queries.some((query) => query.sql.includes("DELETE")),
      false
    );
    assert.equal(
      queries.some((query) => query.sql === "ROLLBACK"),
      true
    );
    assert.deepEqual(queries[1].params, [99, 4]);
  });
});
