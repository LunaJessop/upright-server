import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_client_routers_test";

const { pool } = await import("../lib/db.js");
const { ESTIMATED_MINUTES_ERROR } = await import("../lib/estimatedMinutes.js");
const { resetBomPhaseColumnCacheForTests } = await import("../lib/bomPhase.js");
const {
  MAX_ROUTER_PHASES,
  ROUTERS_UNAVAILABLE,
  resetClientRoutersForTests,
} = await import("../lib/clientRouters.js");
const {
  createRouter,
  deleteRouter,
  getRouter,
  listRouters,
  updateRouter,
} = await import("../api-functions/clientRouters.js");
const { createItem, updateItem } = await import("../api-functions/items.js");

pool.options.connectionTimeoutMillis = 500;

const CLIENT = 4;
const OTHER = 5;

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
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function authReq(body, extra = {}) {
  return {
    auth: { clientId: CLIENT, userId: 9 },
    body,
    params: {},
    query: {},
    ...extra,
  };
}

function createWorld(options = {}) {
  const state = {
    tables: options.tables !== false,
    sourceColumn: options.sourceColumn !== false,
    routers: [],
    phases: [],
    templates: [...(options.templates ?? [])],
    items: [
      {
        id: 2,
        client_id: CLIENT,
        name: "Oil",
        make_or_buy: "buy",
        unit_of_measure: "fl_oz",
      },
    ],
    bom: [],
    itemRouters: [],
    itemPhases: [],
    nextId: 10,
  };
  const queries = [];
  let checkpoint = null;

  function alloc() {
    const id = state.nextId;
    state.nextId += 1;
    return id;
  }

  function snapshot() {
    return {
      routers: structuredClone(state.routers),
      phases: structuredClone(state.phases),
      templates: structuredClone(state.templates),
      items: structuredClone(state.items),
      bom: structuredClone(state.bom),
      itemRouters: structuredClone(state.itemRouters),
      itemPhases: structuredClone(state.itemPhases),
      nextId: state.nextId,
    };
  }

  function restore(saved) {
    state.routers = saved.routers;
    state.phases = saved.phases;
    state.templates = saved.templates;
    state.items = saved.items;
    state.bom = saved.bom;
    state.itemRouters = saved.itemRouters;
    state.itemPhases = saved.itemPhases;
    state.nextId = saved.nextId;
  }

  function routerRow(router) {
    return {
      id: router.id,
      name: router.name,
      description: router.description,
      created_at: router.created_at,
      updated_at: router.updated_at,
      phases: state.phases
        .filter((phase) => phase.router_id === router.id)
        .sort((a, b) => a.sequence - b.sequence)
        .map((phase) => ({ ...phase, router_id: undefined })),
    };
  }

  async function query(sql, params = []) {
    const text = String(sql);
    queries.push({ sql: text, params: [...params] });

    if (text === "BEGIN") {
      checkpoint = snapshot();
      return { rows: [] };
    }
    if (text === "COMMIT") {
      checkpoint = null;
      return { rows: [] };
    }
    if (text === "ROLLBACK") {
      if (checkpoint) restore(checkpoint);
      checkpoint = null;
      return { rows: [] };
    }
    if (text.includes("to_regclass")) {
      return {
        rows: [
          {
            routers: state.tables ? "client_routers" : null,
            phases: state.tables ? "client_router_phases" : null,
          },
        ],
      };
    }
    if (text.includes("information_schema")) {
      if (text.includes("phase_id")) return { rows: [] };
      if (text.includes("source_router_id")) {
        return { rows: state.sourceColumn ? [{ column_name: "source_router_id" }] : [] };
      }
      return { rows: [] };
    }
    if (text.includes("AS router_phases")) {
      const id = Number(params[0]);
      const clientId = Number(params[1]);
      const item = state.items.find(
        (row) => row.id === id && row.client_id === clientId
      );
      if (!item) return { rows: [] };
      const itemRouter = state.itemRouters.find((row) => row.item_id === item.id);
      return {
        rows: [
          {
            ...item,
            bom_items: state.bom
              .filter((line) => line.parent_item_id === item.id)
              .map((line) => ({ ...line })),
            router_phases: state.itemPhases
              .filter((phase) => phase.router_id === itemRouter?.id)
              .sort((a, b) => a.sequence - b.sequence),
            source_router_id: state.sourceColumn
              ? itemRouter?.source_router_id ?? null
              : null,
            tags: [],
            item_skus: [],
            used_in: [],
          },
        ],
      };
    }
    if (text.includes("INSERT INTO items")) {
      const item = {
        id: alloc(),
        client_id: params[0],
        name: params[1],
        sku: params[2],
        description: params[3],
        make_or_buy: params[4],
        unit_of_measure: params[5],
      };
      state.items.push(item);
      return { rows: [{ ...item }] };
    }
    if (text.includes("UPDATE items")) {
      const item = state.items.find(
        (row) => row.id === Number(params[11]) && row.client_id === Number(params[12])
      );
      if (!item) return { rows: [] };
      item.name = params[0];
      item.make_or_buy = params[3];
      item.unit_of_measure = params[4];
      return { rows: [{ ...item }] };
    }
    if (text.includes("id = ANY") && text.includes("FROM items")) {
      const ids = new Set((params[1] ?? []).map(Number));
      return {
        rows: state.items
          .filter((row) => row.client_id === params[0] && ids.has(row.id))
          .map((row) => ({ id: row.id, unit_of_measure: row.unit_of_measure })),
      };
    }
    if (text.includes("FROM items")) {
      const item = state.items.find(
        (row) => row.id === Number(params[0]) && row.client_id === Number(params[1])
      );
      return { rows: item ? [{ unit_of_measure: item.unit_of_measure }] : [] };
    }
    if (text.includes("DELETE FROM bom_items")) {
      state.bom = state.bom.filter((line) => line.parent_item_id !== Number(params[0]));
      return { rows: [] };
    }
    if (text.includes("INSERT INTO bom_items")) {
      state.bom.push({
        parent_item_id: Number(params[0]),
        component_item_id: Number(params[1]),
        quantity: params[2],
        unit_of_measure: params[3],
      });
      return { rows: [] };
    }
    if (text.includes("FROM bom_items")) {
      return {
        rows: state.bom
          .filter((line) => line.parent_item_id === Number(params[0]))
          .map((line) => ({
            component_item_id: line.component_item_id,
            unit_of_measure: line.unit_of_measure,
          })),
      };
    }
    if (text.includes("batch_phases")) return { rows: [] };
    if (text.includes("INSERT INTO item_router_phases")) {
      const row = {
        id: alloc(),
        router_id: params[0],
        sequence: params[1],
        name: params[2],
        description: params[3],
        estimated_minutes: params[4],
      };
      state.itemPhases.push(row);
      return { rows: [{ ...row }] };
    }
    if (text.includes("DELETE FROM item_router_phases")) {
      state.itemPhases = state.itemPhases.filter(
        (phase) => phase.router_id !== params[0]
      );
      return { rows: [] };
    }
    if (text.includes("UPDATE item_routers")) {
      const row = state.itemRouters.find(
        (router) => router.id === params[1] && router.client_id === params[2]
      );
      if (row) row.source_router_id = params[0];
      return { rows: [] };
    }
    if (text.includes("INSERT INTO item_routers")) {
      const row = {
        id: alloc(),
        client_id: params[0],
        item_id: params[1],
        source_router_id: text.includes("source_router_id") ? params[2] : null,
      };
      state.itemRouters.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (text.includes("DELETE FROM item_routers")) {
      const itemId = Number(params[0]);
      const removed = state.itemRouters.filter((row) => row.item_id === itemId);
      state.itemRouters = state.itemRouters.filter((row) => row.item_id !== itemId);
      const removedIds = new Set(removed.map((row) => row.id));
      state.itemPhases = state.itemPhases.filter(
        (phase) => !removedIds.has(phase.router_id)
      );
      return { rows: [] };
    }
    if (text.includes("FROM item_routers")) {
      const row = state.itemRouters.find((router) => router.item_id === Number(params[0]));
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (text.includes("client_router_phase_templates")) {
      if (text.includes("INSERT INTO")) {
        const existing = state.templates.find(
          (row) => row.client_id === params[0] && row.name === params[1]
        );
        if (existing) {
          existing.description = params[2];
          existing.estimated_minutes = params[3];
          return { rows: [] };
        }
        state.templates.push({
          id: alloc(),
          client_id: params[0],
          name: params[1],
          description: params[2],
          estimated_minutes: params[3],
        });
        return { rows: [] };
      }
      if (text.includes("id = ANY")) {
        const ids = new Set((params[1] ?? []).map(Number));
        return {
          rows: state.templates
            .filter((row) => row.client_id === params[0] && ids.has(row.id))
            .map((row) => ({ id: row.id })),
        };
      }
      const names = new Set(params[1] ?? []);
      return {
        rows: state.templates
          .filter((row) => row.client_id === params[0] && names.has(row.name))
          .map((row) => ({ id: row.id, name: row.name })),
      };
    }
    if (text.includes("DELETE FROM client_router_phases")) {
      state.phases = state.phases.filter((phase) => phase.router_id !== params[0]);
      return { rows: [] };
    }
    if (text.includes("INSERT INTO client_router_phases")) {
      const row = {
        id: alloc(),
        router_id: params[0],
        sequence: params[1],
        name: params[2],
        description: params[3],
        estimated_minutes: params[4],
        phase_template_id: params[5],
      };
      state.phases.push(row);
      return {
        rows: [
          {
            id: row.id,
            sequence: row.sequence,
            name: row.name,
            description: row.description,
            estimated_minutes: row.estimated_minutes,
            phase_template_id: row.phase_template_id,
          },
        ],
      };
    }
    if (text.includes("INSERT INTO client_routers")) {
      if (
        state.routers.some(
          (row) => row.client_id === params[0] && row.name === params[1]
        )
      ) {
        const err = new Error("duplicate router name");
        err.code = "23505";
        throw err;
      }
      const row = {
        id: alloc(),
        client_id: params[0],
        name: params[1],
        description: params[2],
        created_at: "2026-11-26T12:00:00.000Z",
        updated_at: "2026-11-26T12:00:00.000Z",
      };
      state.routers.push(row);
      return { rows: [{ ...row }] };
    }
    if (text.includes("UPDATE client_routers")) {
      const router = state.routers.find(
        (row) => row.id === params[2] && row.client_id === params[3]
      );
      if (!router) return { rows: [] };
      if (
        state.routers.some(
          (row) =>
            row.client_id === params[3] &&
            row.name === params[0] &&
            row.id !== router.id
        )
      ) {
        const err = new Error("duplicate router name");
        err.code = "23505";
        throw err;
      }
      router.name = params[0];
      router.description = params[1];
      router.updated_at = "2026-11-26T13:00:00.000Z";
      return { rows: [{ ...router }] };
    }
    if (text.includes("DELETE FROM client_routers")) {
      const router = state.routers.find(
        (row) => row.id === params[0] && row.client_id === params[1]
      );
      if (!router) return { rows: [] };
      state.routers = state.routers.filter((row) => row.id !== router.id);
      state.phases = state.phases.filter((phase) => phase.router_id !== router.id);
      return { rows: [{ id: router.id }] };
    }
    if (text.includes("SELECT id FROM client_routers")) {
      const router = state.routers.find(
        (row) => row.id === params[0] && row.client_id === params[1]
      );
      return { rows: router ? [{ id: router.id }] : [] };
    }
    if (text.includes("FROM client_routers")) {
      const clientId = params[0];
      const id = params.length > 1 ? params[1] : null;
      const rows = state.routers
        .filter((row) => row.client_id === clientId && (id == null || row.id === id))
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id)
        .map(routerRow);
      return { rows };
    }
    if (text.includes("item_tags") || text.includes("FROM tags")) return { rows: [] };
    throw new Error(`unexpected sql: ${text}`);
  }

  function install() {
    pool.query = query;
    pool.connect = async () => ({
      query,
      release() {},
    });
  }

  return { state, queries, install };
}

function phaseNames(rows) {
  return [...rows]
    .sort((a, b) => a.sequence - b.sequence)
    .map((phase) => ({
      sequence: phase.sequence,
      name: phase.name,
      estimated_minutes: phase.estimated_minutes,
    }));
}

beforeEach(() => {
  resetClientRoutersForTests();
  resetBomPhaseColumnCacheForTests();
});

after(async () => {
  await pool.end();
});

describe("client router sql", () => {
  it("can be applied more than once and does not rewrite items", () => {
    const sql = readFileSync(
      new URL("../scripts/sql/client-routers.sql", import.meta.url),
      "utf8"
    );
    assert.match(sql, /CREATE TABLE IF NOT EXISTS client_routers/);
    assert.match(sql, /UNIQUE \(client_id, name\)/);
    assert.match(sql, /REFERENCES clients\(id\) ON DELETE CASCADE/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS client_router_phases/);
    assert.match(
      sql,
      /phase_template_id INTEGER REFERENCES client_router_phase_templates\(id\) ON DELETE SET NULL/
    );
    assert.match(sql, /UNIQUE \(router_id, sequence\)/);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS client_router_phases_router_idx/);
    assert.match(
      sql,
      /ADD COLUMN IF NOT EXISTS source_router_id INTEGER REFERENCES client_routers\(id\) ON DELETE SET NULL/
    );
    assert.doesNotMatch(sql, /DROP /i);
    assert.doesNotMatch(sql, /DELETE FROM/i);
    assert.doesNotMatch(sql, /item_router_phases/);
    assert.doesNotMatch(sql, /bom_items/);
  });
});

describe("router validation", () => {
  it("rejects a bad router before querying", async () => {
    let queried = false;
    pool.query = async () => {
      queried = true;
      throw new Error("should not query");
    };
    pool.connect = async () => {
      queried = true;
      throw new Error("should not connect");
    };

    const cases = [
      [{ phases: [] }, "Router name is required"],
      [{ name: "   ", phases: [] }, "Router name is required"],
      [{ name: "Soap day" }, "Phases must be a list"],
      [{ name: "Soap day", phases: "Mix" }, "Phases must be a list"],
      [
        {
          name: "Soap day",
          phases: Array.from({ length: MAX_ROUTER_PHASES + 1 }, (_, index) => ({
            name: `Step ${index + 1}`,
          })),
        },
        `A router can have at most ${MAX_ROUTER_PHASES} phases`,
      ],
      [{ name: "Soap day", phases: [{}] }, "Phase 1 requires a name"],
      [
        { name: "Soap day", phases: [{ name: "Mix", sequence: 2 }] },
        "Phase sequence must be 1, 2, 3… with no gaps",
      ],
      [
        { name: "Soap day", phases: [{ name: "Mix", estimated_minutes: 7.5 }] },
        ESTIMATED_MINUTES_ERROR,
      ],
      [
        { name: "Soap day", phases: [{ name: "Mix", phase_template_id: "nope" }] },
        "Phase must belong to your company",
      ],
      [{ name: "Soap day", description: 4, phases: [] }, "Description must be text"],
    ];

    for (const [body, error] of cases) {
      const res = mockRes();
      await createRouter(authReq(body), res);
      assert.equal(res.statusCode, 400, error);
      assert.equal(res.body.error, error);
    }
    assert.equal(queried, false);
  });
});

describe("router crud", { concurrency: 1 }, () => {
  it("saves a copy of each phase and adds the name to the phase library", async () => {
    const world = createWorld({
      templates: [
        {
          id: 7,
          client_id: CLIENT,
          name: "Mix",
          description: "Old",
          estimated_minutes: 40,
        },
      ],
    });
    world.install();

    const res = mockRes();
    await createRouter(
      authReq({
        name: "  Soap day  ",
        description: "  Cold process  ",
        ingredients: [{ name: "Oil", quantity: 9 }],
        phases: [
          {
            name: " Mix ",
            description: " Blend ",
            estimated_minutes: "20",
            quantity: 9,
            phase_template_id: 7,
          },
          { name: "Cure", estimated_minutes: "", sequence: 2 },
        ],
      }),
      res
    );

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.name, "Soap day");
    assert.equal(res.body.description, "Cold process");
    assert.equal(res.body.ingredients, undefined);
    assert.deepEqual(
      res.body.phases.map((phase) => ({
        sequence: phase.sequence,
        name: phase.name,
        description: phase.description,
        estimated_minutes: phase.estimated_minutes,
        phase_template_id: phase.phase_template_id,
      })),
      [
        {
          sequence: 1,
          name: "Mix",
          description: "Blend",
          estimated_minutes: 20,
          phase_template_id: 7,
        },
        {
          sequence: 2,
          name: "Cure",
          description: null,
          estimated_minutes: null,
          phase_template_id: world.state.templates.find((row) => row.name === "Cure").id,
        },
      ]
    );
    assert.equal(
      world.state.templates.find((row) => row.name === "Mix").estimated_minutes,
      20
    );
    const phaseInsert = world.queries.find((query) =>
      query.sql.includes("INSERT INTO client_router_phases")
    );
    assert.equal(phaseInsert.sql.includes("quantity"), false);
    assert.equal(phaseInsert.params.includes(9), false);
    assert.equal(
      world.queries.some((query) => query.sql.includes("bom_items")),
      false
    );

    const listed = mockRes();
    await listRouters(authReq(), listed);
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].phases[1].name, "Cure");

    const fetched = mockRes();
    await getRouter(authReq(undefined, { params: { id: String(res.body.id) } }), fetched);
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.body.id, res.body.id);
  });

  it("keeps each company's routers separate", async () => {
    const world = createWorld();
    world.install();
    const created = mockRes();
    await createRouter(
      authReq({ name: "Soap day", phases: [{ name: "Mix" }] }),
      created
    );
    assert.equal(created.statusCode, 201);

    const other = mockRes();
    await createRouter(
      {
        auth: { clientId: OTHER, userId: 3 },
        body: { name: "Soap day", phases: [{ name: "Pour" }] },
        params: {},
      },
      other
    );
    assert.equal(other.statusCode, 201);

    const ours = mockRes();
    await listRouters(authReq(), ours);
    assert.equal(ours.body.length, 1);
    assert.equal(ours.body[0].phases[0].name, "Mix");

    const hidden = mockRes();
    await getRouter(
      authReq(undefined, { params: { id: String(other.body.id) } }),
      hidden
    );
    assert.equal(hidden.statusCode, 404);

    const beforeSteal = world.queries.length;
    const stolen = mockRes();
    await updateRouter(
      authReq(
        { name: "Stolen", phases: [{ name: "Cut" }] },
        { params: { id: String(other.body.id) } }
      ),
      stolen
    );
    assert.equal(stolen.statusCode, 404);
    assert.equal(
      world.queries.slice(beforeSteal).some((query) => query.sql === "COMMIT"),
      false
    );
    assert.equal(
      world.state.routers.find((row) => row.id === other.body.id).name,
      "Soap day"
    );

    const removed = mockRes();
    await deleteRouter(
      authReq(undefined, { params: { id: String(other.body.id) } }),
      removed
    );
    assert.equal(removed.statusCode, 404);
    assert.equal(
      world.state.routers.some((row) => row.id === other.body.id),
      true
    );
  });

  it("rejects a phase from another company and a duplicate name", async () => {
    const world = createWorld({
      templates: [{ id: 8, client_id: OTHER, name: "Mix", description: null, estimated_minutes: 5 }],
    });
    world.install();

    const foreign = mockRes();
    await createRouter(
      authReq({
        name: "Soap day",
        phases: [{ name: "Mix", phase_template_id: 8 }],
      }),
      foreign
    );
    assert.equal(foreign.statusCode, 400);
    assert.equal(foreign.body.error, "Phase must belong to your company");
    assert.equal(world.state.routers.length, 0);
    assert.equal(
      world.queries.some((query) =>
        query.sql.includes("INSERT INTO client_router_phase_templates")
      ),
      false
    );

    const first = mockRes();
    await createRouter(authReq({ name: "Soap day", phases: [] }), first);
    assert.equal(first.statusCode, 201);
    const again = mockRes();
    await createRouter(authReq({ name: "Soap day", phases: [] }), again);
    assert.equal(again.statusCode, 409);
    assert.equal(again.body.error, "A router with that name already exists");
    assert.equal(world.state.routers.length, 1);
  });

  it("replaces the phase list in one transaction", async () => {
    const world = createWorld();
    world.install();
    const created = mockRes();
    await createRouter(
      authReq({
        name: "Soap day",
        phases: [
          { name: "Mix", estimated_minutes: 20 },
          { name: "Cure", estimated_minutes: 30 },
        ],
      }),
      created
    );
    world.queries.length = 0;

    const updated = mockRes();
    await updateRouter(
      authReq(
        {
          name: "Soap day",
          phases: [{ name: "Pour", estimated_minutes: 5, sequence: 1 }],
        },
        { params: { id: String(created.body.id) } }
      ),
      updated
    );

    assert.equal(updated.statusCode, 200);
    assert.deepEqual(
      updated.body.phases.map((phase) => phase.name),
      ["Pour"]
    );
    const begin = world.queries.findIndex((query) => query.sql === "BEGIN");
    const commit = world.queries.findIndex((query) => query.sql === "COMMIT");
    const removed = world.queries.findIndex((query) =>
      query.sql.includes("DELETE FROM client_router_phases")
    );
    const inserted = world.queries.findIndex((query) =>
      query.sql.includes("INSERT INTO client_router_phases")
    );
    assert.ok(begin !== -1 && begin < removed && removed < inserted && inserted < commit);
    assert.equal(world.queries.filter((query) => query.sql === "COMMIT").length, 1);
    assert.equal(
      world.queries.some((query) => /item_router|bom_items|UPDATE items/.test(query.sql)),
      false
    );
  });

  it("says routers are unavailable until the tables exist", async () => {
    const world = createWorld({ tables: false });
    world.install();
    let connected = false;
    const original = pool.connect;
    pool.connect = async () => {
      connected = true;
      return original();
    };
    const res = mockRes();
    await listRouters(authReq(), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, ROUTERS_UNAVAILABLE);
    assert.equal(connected, false);

    const created = mockRes();
    await createRouter(
      authReq({ name: "Soap day", phases: [{ name: "Mix" }] }),
      created
    );
    assert.equal(created.statusCode, 503);
    assert.equal(world.state.routers.length, 0);
  });
});

describe("applying a router copies phases", { concurrency: 1 }, () => {
  it("keeps the item copy when the router or the item changes", async () => {
    const world = createWorld();
    world.install();

    const created = mockRes();
    await createRouter(
      authReq({
        name: "Soap day",
        phases: [
          { name: "Mix", description: "Blend", estimated_minutes: 20 },
          { name: "Cure", estimated_minutes: 30 },
        ],
      }),
      created
    );
    assert.equal(created.statusCode, 201);
    world.queries.length = 0;

    const item = mockRes();
    await createItem(
      authReq({
        name: "Soap",
        make_or_buy: "make",
        unit_of_measure: "ea",
        source_router_id: created.body.id,
        router_phases: created.body.phases.map((phase) => ({
          sequence: phase.sequence,
          name: phase.name,
          description: phase.description,
          estimated_minutes: phase.estimated_minutes,
        })),
        bom_items: [
          { component_item_id: 2, quantity: 1, unit_of_measure: "fl_oz" },
        ],
      }),
      item
    );
    assert.equal(item.statusCode, 201);
    assert.equal(item.body.source_router_id, created.body.id);
    assert.deepEqual(phaseNames(item.body.router_phases), [
      { sequence: 1, name: "Mix", estimated_minutes: 20 },
      { sequence: 2, name: "Cure", estimated_minutes: 30 },
    ]);
    assert.equal(
      world.queries.some((query) => query.sql.includes("client_router_phases")),
      false
    );
    const sourceInsert = world.queries.find((query) =>
      query.sql.includes("INSERT INTO item_routers")
    );
    assert.match(sourceInsert.sql, /source_router_id/);
    assert.equal(sourceInsert.params[2], created.body.id);

    const copied = phaseNames(world.state.itemPhases);
    world.queries.length = 0;
    const editedRouter = mockRes();
    await updateRouter(
      authReq(
        {
          name: "Soap day",
          phases: [
            { name: "Pour", estimated_minutes: 5 },
            { name: "Cut", estimated_minutes: 6 },
          ],
        },
        { params: { id: String(created.body.id) } }
      ),
      editedRouter
    );
    assert.equal(editedRouter.statusCode, 200);
    assert.deepEqual(
      editedRouter.body.phases.map((phase) => phase.name),
      ["Pour", "Cut"]
    );
    assert.deepEqual(phaseNames(world.state.itemPhases), copied);
    assert.equal(world.state.bom[0].quantity, 1);
    assert.equal(
      world.queries.some((query) =>
        /item_router_phases|item_routers|bom_items|UPDATE items|INSERT INTO items/.test(
          query.sql
        )
      ),
      false
    );

    world.queries.length = 0;
    const editedItem = mockRes();
    await updateItem(
      authReq(
        {
          name: "Soap",
          make_or_buy: "make",
          unit_of_measure: "ea",
          router_phases: [{ sequence: 1, name: "Wrap", estimated_minutes: 12 }],
          bom_items: [
            { component_item_id: 2, quantity: 3, unit_of_measure: "fl_oz" },
          ],
        },
        { params: { id: String(item.body.id) } }
      ),
      editedItem
    );
    assert.equal(editedItem.statusCode, 200);
    assert.equal(editedItem.body.source_router_id, created.body.id);
    assert.deepEqual(phaseNames(editedItem.body.router_phases), [
      { sequence: 1, name: "Wrap", estimated_minutes: 12 },
    ]);
    assert.equal(editedItem.body.bom_items[0].quantity, 3);
    assert.deepEqual(
      phaseNames(world.state.phases.filter((phase) => phase.router_id === created.body.id)),
      [
        { sequence: 1, name: "Pour", estimated_minutes: 5 },
        { sequence: 2, name: "Cut", estimated_minutes: 6 },
      ]
    );
    assert.equal(
      world.queries.some((query) =>
        /client_router_phases|UPDATE client_routers|DELETE FROM client_routers/.test(
          query.sql
        )
      ),
      false
    );

    const itemPhases = phaseNames(world.state.itemPhases);
    const recipe = world.state.bom.map((line) => ({ ...line }));
    world.queries.length = 0;
    const removed = mockRes();
    await deleteRouter(
      authReq(undefined, { params: { id: String(created.body.id) } }),
      removed
    );
    assert.equal(removed.statusCode, 204);
    assert.deepEqual(phaseNames(world.state.itemPhases), itemPhases);
    assert.deepEqual(world.state.bom, recipe);
    assert.equal(world.state.routers.length, 0);
    assert.deepEqual(
      world.queries.map((query) => query.sql.trim().split(/\s+/)[0]),
      ["DELETE"]
    );
    assert.equal(
      world.queries.some((query) =>
        /item_router|bom_items|\bitems\b/.test(query.sql)
      ),
      false
    );
  });

  it("rejects another company's router and still saves when the label cannot be stored", async () => {
    const ready = createWorld();
    ready.install();
    const router = mockRes();
    await createRouter(
      {
        auth: { clientId: OTHER, userId: 3 },
        body: { name: "Theirs", phases: [{ name: "Mix" }] },
        params: {},
      },
      router
    );

    const foreign = mockRes();
    await createItem(
      authReq({
        name: "Soap",
        make_or_buy: "make",
        unit_of_measure: "ea",
        source_router_id: router.body.id,
        router_phases: [{ sequence: 1, name: "Mix", estimated_minutes: 10 }],
      }),
      foreign
    );
    assert.equal(foreign.statusCode, 400);
    assert.equal(foreign.body.error, "Router must belong to your company");
    assert.equal(
      ready.state.items.some((row) => row.name === "Soap"),
      false
    );
    assert.equal(ready.state.itemPhases.length, 0);

    const missingColumn = createWorld({ sourceColumn: false });
    missingColumn.install();
    resetClientRoutersForTests();
    resetBomPhaseColumnCacheForTests();
    const own = mockRes();
    await createRouter(
      authReq({ name: "Soap day", phases: [{ name: "Mix", estimated_minutes: 10 }] }),
      own
    );
    missingColumn.queries.length = 0;
    const saved = mockRes();
    await createItem(
      authReq({
        name: "Soap",
        make_or_buy: "make",
        unit_of_measure: "ea",
        source_router_id: own.body.id,
        router_phases: [{ sequence: 1, name: "Mix", estimated_minutes: 10 }],
      }),
      saved
    );
    assert.equal(saved.statusCode, 201);
    assert.equal(saved.body.source_router_id, null);
    assert.equal(saved.body.router_phases[0].name, "Mix");
    const insert = missingColumn.queries.find((query) =>
      query.sql.includes("INSERT INTO item_routers")
    );
    assert.match(insert.sql, /INSERT INTO item_routers \(client_id, item_id\)/);
    assert.equal(insert.sql.includes("source_router_id"), false);

    const missingTables = createWorld({ tables: false, sourceColumn: false });
    missingTables.install();
    resetClientRoutersForTests();
    resetBomPhaseColumnCacheForTests();
    const anyway = mockRes();
    await createItem(
      authReq({
        name: "Soap",
        make_or_buy: "make",
        unit_of_measure: "ea",
        source_router_id: 99,
        router_phases: [{ sequence: 1, name: "Mix", estimated_minutes: 4 }],
      }),
      anyway
    );
    assert.equal(anyway.statusCode, 201);
    assert.equal(anyway.body.router_phases[0].name, "Mix");
    assert.equal(anyway.body.source_router_id, null);
    assert.equal(missingTables.state.itemPhases[0].estimated_minutes, 4);
  });

  it("rejects a source router that is not an id before saving", async () => {
    let connected = false;
    pool.connect = async () => {
      connected = true;
      throw new Error("should not connect");
    };
    const res = mockRes();
    await createItem(
      authReq({
        name: "Soap",
        make_or_buy: "make",
        unit_of_measure: "ea",
        source_router_id: "nope",
        router_phases: [{ sequence: 1, name: "Mix" }],
      }),
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "Router must belong to your company");
    assert.equal(connected, false);
  });
});

describe("router routes", () => {
  it("requires a session, and a subscription to change a router", () => {
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    assert.match(
      source,
      /app\.get\(\s*"\/api\/routers",\s*requireAuth,\s*requireReadableSubscription,\s*listRouters\s*\)/
    );
    assert.match(
      source,
      /app\.post\(\s*"\/api\/routers",\s*requireAuth,\s*requireActiveSubscription,\s*createRouter\s*\)/
    );
    assert.match(
      source,
      /app\.get\(\s*"\/api\/routers\/:id",\s*requireAuth,\s*requireReadableSubscription,\s*getRouter\s*\)/s
    );
    assert.match(
      source,
      /app\.put\(\s*"\/api\/routers\/:id",\s*requireAuth,\s*requireActiveSubscription,\s*updateRouter\s*\)/s
    );
    assert.match(
      source,
      /app\.delete\(\s*"\/api\/routers\/:id",\s*requireAuth,\s*requireActiveSubscription,\s*deleteRouter\s*\)/s
    );
  });
});
