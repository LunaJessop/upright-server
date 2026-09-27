import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_minutes_test";

const { pool } = await import("../lib/db.js");
const { ESTIMATED_MINUTES_ERROR } = await import("../lib/estimatedMinutes.js");
const {
  createRouterPhaseTemplate,
  updateRouterPhaseTemplate,
  upsertClientPhaseTemplates,
} = await import("../api-functions/routerPhases.js");
const { createItem, updateItem } = await import("../api-functions/items.js");

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

function authReq(body, params = {}) {
  return {
    auth: { clientId: 4, userId: 9 },
    body,
    params,
  };
}

function savedTemplate(minutes) {
  return {
    id: 11,
    name: "Mix",
    description: null,
    estimated_minutes: minutes,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

after(async () => {
  await pool.end();
});

describe("router phase template estimated_minutes", { concurrency: 1 }, () => {
  it("rejects fractional, negative, and non-numeric minutes before insert", async () => {
    for (const estimated_minutes of [7.5, "7.5", -1, "nope", true, Number.NaN]) {
      let queried = false;
      pool.query = async () => {
        queried = true;
        throw new Error("database should not be queried");
      };
      const res = mockRes();
      await createRouterPhaseTemplate(
        authReq({ name: "Mix", estimated_minutes }),
        res
      );
      assert.equal(res.statusCode, 400, `value ${estimated_minutes}`);
      assert.equal(res.body.error, ESTIMATED_MINUTES_ERROR);
      assert.equal(queried, false);
    }
  });

  it("stores null when minutes are omitted, null, or blank", async () => {
    for (const body of [
      { name: "Mix" },
      { name: "Mix", estimated_minutes: null },
      { name: "Mix", estimated_minutes: "" },
      { name: "Mix", estimated_minutes: "   " },
    ]) {
      const queries = [];
      pool.query = async (sql, params) => {
        queries.push({ sql, params });
        return { rows: [savedTemplate(params[3])] };
      };
      const res = mockRes();
      await createRouterPhaseTemplate(authReq(body), res);
      assert.equal(res.statusCode, 201);
      assert.equal(queries.length, 1);
      assert.match(queries[0].sql, /INSERT INTO client_router_phase_templates/);
      assert.equal(queries[0].params[3], null);
      assert.equal(res.body.estimated_minutes, null);
    }
  });

  it("stores a non-negative whole number, including numeric strings", async () => {
    for (const [input, stored] of [
      [0, 0],
      [12, 12],
      ["15", 15],
      [8.0, 8],
    ]) {
      const queries = [];
      pool.query = async (sql, params) => {
        queries.push({ sql, params });
        return { rows: [savedTemplate(params[3])] };
      };
      const res = mockRes();
      await createRouterPhaseTemplate(
        authReq({ name: "Mix", description: " Blend ", estimated_minutes: input }),
        res
      );
      assert.equal(res.statusCode, 201, `input ${input}`);
      assert.equal(queries[0].params[0], 4);
      assert.equal(queries[0].params[1], "Mix");
      assert.equal(queries[0].params[2], "Blend");
      assert.equal(queries[0].params[3], stored);
      assert.equal(Number.isInteger(queries[0].params[3]), true);
    }
  });

  it("still requires a phase name before checking minutes", async () => {
    let queried = false;
    pool.query = async () => {
      queried = true;
      throw new Error("database should not be queried");
    };
    const res = mockRes();
    await createRouterPhaseTemplate(authReq({ estimated_minutes: 5 }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "Phase name is required");
    assert.equal(queried, false);
  });

  it("rejects fractional minutes on update before writing", async () => {
    let queried = false;
    pool.query = async () => {
      queried = true;
      throw new Error("database should not be queried");
    };
    const res = mockRes();
    await updateRouterPhaseTemplate(
      authReq({ name: "Mix", estimated_minutes: 7.5 }, { id: "11" }),
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, ESTIMATED_MINUTES_ERROR);
    assert.equal(queried, false);
  });

  it("updates with a whole number or null", async () => {
    for (const [input, stored] of [
      [30, 30],
      [null, null],
      ["0", 0],
    ]) {
      const queries = [];
      pool.query = async (sql, params) => {
        queries.push({ sql, params });
        return { rows: [savedTemplate(params[2])] };
      };
      const res = mockRes();
      await updateRouterPhaseTemplate(
        authReq({ name: " Mix ", estimated_minutes: input }, { id: "11" }),
        res
      );
      assert.equal(res.statusCode, 200, `input ${input}`);
      assert.match(queries[0].sql, /UPDATE client_router_phase_templates/);
      assert.deepEqual(queries[0].params, ["Mix", null, stored, "11", 4]);
    }
  });

  it("does not write template rows when upsert minutes are fractional", async () => {
    const queries = [];
    const dbClient = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [] };
      },
    };

    await assert.rejects(
      () =>
        upsertClientPhaseTemplates(dbClient, 4, [
          { name: "Mix", estimated_minutes: 10 },
          { name: "Cure", estimated_minutes: 7.5 },
        ]),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.message, ESTIMATED_MINUTES_ERROR);
        return true;
      }
    );
    assert.equal(queries.length, 0);
  });

  it("upserts whole-number minutes and null", async () => {
    const queries = [];
    const dbClient = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [] };
      },
    };

    await upsertClientPhaseTemplates(dbClient, 4, [
      { name: " Mix ", description: " Blend ", estimated_minutes: "20" },
      { name: "Cure", estimated_minutes: null },
      { name: "   " },
    ]);

    assert.equal(queries.length, 2);
    assert.deepEqual(queries[0].params, [4, "Mix", "Blend", 20]);
    assert.deepEqual(queries[1].params, [4, "Cure", null, null]);
  });
});

describe("item router phase estimated_minutes", { concurrency: 1 }, () => {
  function makeItemBody(estimated_minutes) {
    return {
      name: "Soap",
      make_or_buy: "make",
      router_phases: [
        { sequence: 1, name: "Mix", estimated_minutes },
      ],
    };
  }

  it("rejects fractional item phase minutes before opening a transaction", async () => {
    for (const handler of [createItem, updateItem]) {
      let connected = false;
      pool.connect = async () => {
        connected = true;
        throw new Error("should not connect");
      };
      const res = mockRes();
      const req = authReq(makeItemBody(7.5), { id: "10" });
      await handler(req, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, ESTIMATED_MINUTES_ERROR);
      assert.equal(connected, false);
    }
  });

  it("writes whole-number and blank item phase minutes as integers or null", async () => {
    const queries = [];
    pool.connect = async () => ({
      async query(sql, params = []) {
        const text = String(sql);
        queries.push({ sql: text, params });
        if (text.includes("INSERT INTO items")) {
          return { rows: [{ id: 10, name: params[1], client_id: params[0] }] };
        }
        if (text.includes("INSERT INTO item_routers")) {
          return { rows: [{ id: 20 }] };
        }
        if (text.includes("INSERT INTO item_router_phases")) {
          return {
            rows: [
              {
                id: 30,
                sequence: params[1],
                name: params[2],
                description: params[3],
                estimated_minutes: params[4],
              },
            ],
          };
        }
        return { rows: [] };
      },
      release() {},
    });

    const res = mockRes();
    await createItem(
      authReq({
        name: "Soap",
        make_or_buy: "make",
        router_phases: [
          { sequence: 1, name: "Mix", estimated_minutes: 8 },
          { sequence: 2, name: "Cure", estimated_minutes: "" },
          { sequence: 3, name: "Cut", estimated_minutes: "15" },
          { sequence: 4, name: "Pack", estimated_minutes: 0 },
        ],
      }),
      res
    );

    assert.equal(res.statusCode, 201);
    const phaseInserts = queries.filter((query) =>
      query.sql.includes("INSERT INTO item_router_phases")
    );
    assert.deepEqual(
      phaseInserts.map((query) => query.params[4]),
      [8, null, 15, 0]
    );
    for (const minutes of [8, 15, 0]) {
      assert.equal(
        phaseInserts.some(
          (query) =>
            query.params[4] === minutes && Number.isInteger(query.params[4])
        ),
        true
      );
    }
  });
});
