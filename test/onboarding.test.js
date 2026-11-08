import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_onboarding_test";

const { pool } = await import("../lib/db.js");
const { CANONICAL_UNITS } = await import("../lib/units.js");
const { ONBOARDING_TEMPLATES } = await import("../lib/onboardingTemplates.js");
const {
  applyOnboardingTemplate,
  getOnboardingStatus,
  getOnboardingTemplates,
} = await import("../api-functions/onboarding.js");

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

after(async () => {
  await pool.end();
});

describe("onboarding templates", () => {
  it("offers a starter pack for each shop type with real units and minutes", () => {
    const keys = ONBOARDING_TEMPLATES.map((template) => template.key);
    assert.deepEqual(keys, ["soap", "candles", "baked", "jewelry", "textiles", "generic"]);
    for (const template of ONBOARDING_TEMPLATES) {
      assert.ok(template.phases.length >= 3);
      assert.ok(template.items.length >= 3);
      for (const phase of template.phases) {
        assert.equal(Number.isInteger(phase.estimated_minutes), true);
        assert.ok(phase.estimated_minutes > 0);
        assert.ok(phase.name.trim());
      }
      for (const item of template.items) {
        assert.ok(CANONICAL_UNITS.includes(item.unit_of_measure), item.unit_of_measure);
        assert.equal(item.make_or_buy, undefined);
      }
    }
  });

  it("returns the catalog without a database", async () => {
    let queried = false;
    pool.query = async () => {
      queried = true;
      return { rows: [] };
    };
    const res = mockRes();
    await getOnboardingTemplates({ auth: { clientId: 4 } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.templates.length, 6);
    assert.equal(res.body.templates[0].key, "soap");
    assert.equal(res.body.templates[0].items[0].unit_of_measure, "fl_oz");
    assert.equal(queried, false);
  });
});

describe("apply onboarding template", { concurrency: 1 }, () => {
  it("creates the chosen phases and buy items and skips names the shop already has", async () => {
    const queries = [];
    const phases = ["pour"];
    const items = ["coconut oil"];
    let phaseId = 10;
    let itemId = 20;
    pool.connect = async () => ({
      async query(sql, params = []) {
        const text = String(sql);
        queries.push({ sql: text, params });
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("FROM client_router_phase_templates")) {
          assert.equal(params[0], 4);
          return { rows: phases.map((name) => ({ name })) };
        }
        if (text.includes("FROM items")) {
          assert.equal(params[0], 4);
          return { rows: items.map((name) => ({ name })) };
        }
        if (text.includes("INSERT INTO client_router_phase_templates")) {
          assert.equal(params[0], 4);
          phaseId += 1;
          return {
            rows: [
              {
                id: phaseId,
                name: params[1],
                description: params[2],
                estimated_minutes: params[3],
              },
            ],
          };
        }
        if (text.includes("INSERT INTO items")) {
          assert.equal(params[0], 4);
          assert.match(text, /'buy'/);
          assert.equal(params[4], 9);
          itemId += 1;
          return {
            rows: [
              {
                id: itemId,
                name: params[1],
                unit_of_measure: params[3],
                make_or_buy: "buy",
              },
            ],
          };
        }
        throw new Error(text);
      },
      release() {},
    });

    const res = mockRes();
    await applyOnboardingTemplate(
      {
        auth: { clientId: 4, userId: 9, role: "founder" },
        body: { templateKey: "soap", include: { phases: true, items: true } },
      },
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.template.key, "soap");
    assert.deepEqual(res.body.phases.skipped, ["Pour"]);
    assert.equal(
      res.body.phases.created.some((phase) => phase.name === "Pour"),
      false
    );
    assert.ok(res.body.phases.created.some((phase) => phase.name === "Melt oils"));
    assert.deepEqual(res.body.items.skipped, ["Coconut oil"]);
    assert.equal(
      res.body.items.created.some((item) => item.name === "Coconut oil"),
      false
    );
    assert.ok(res.body.items.created.every((item) => item.make_or_buy === "buy"));
    assert.equal(queries[0].sql, "BEGIN");
    assert.equal(queries.at(-1).sql, "COMMIT");
    assert.equal(
      queries.some((query) => query.sql === "ROLLBACK"),
      false
    );
  });

  it("can add phases without items, and rejects an unknown pack", async () => {
    const queries = [];
    pool.connect = async () => ({
      async query(sql, params = []) {
        const text = String(sql);
        queries.push(text);
        if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
        if (text.includes("FROM client_router_phase_templates")) return { rows: [] };
        if (text.includes("INSERT INTO client_router_phase_templates")) {
          return {
            rows: [{ id: 1, name: params[1], description: params[2], estimated_minutes: params[3] }],
          };
        }
        throw new Error(text);
      },
      release() {},
    });

    const res = mockRes();
    await applyOnboardingTemplate(
      {
        auth: { clientId: 4, userId: 9, role: "founder" },
        body: { templateKey: "CANDLES", include: { phases: true, items: false } },
      },
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.template.key, "candles");
    assert.equal(res.body.phases.created.length > 0, true);
    assert.deepEqual(res.body.items, { created: [], skipped: [] });
    assert.equal(queries.some((sql) => sql.includes("INSERT INTO items")), false);

    const unknown = mockRes();
    await applyOnboardingTemplate(
      { auth: { clientId: 4, userId: 9 }, body: { templateKey: "pottery" } },
      unknown
    );
    assert.equal(unknown.statusCode, 400);
  });

  it("rolls back when a later insert fails", async () => {
    const queries = [];
    pool.connect = async () => ({
      async query(sql) {
        const text = String(sql);
        queries.push(text);
        if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("FROM client_router_phase_templates")) return { rows: [] };
        if (text.includes("INSERT INTO client_router_phase_templates")) {
          return { rows: [{ id: 1, name: "Prep", estimated_minutes: 15 }] };
        }
        if (text.includes("FROM items")) return { rows: [] };
        if (text.includes("INSERT INTO items")) throw new Error("items down");
        throw new Error(text);
      },
      release() {},
    });
    const res = mockRes();
    await applyOnboardingTemplate(
      {
        auth: { clientId: 4, userId: 9 },
        body: { templateKey: "generic" },
      },
      res
    );
    assert.equal(res.statusCode, 500);
    assert.equal(queries.at(-1), "ROLLBACK");
    assert.equal(queries.includes("COMMIT"), false);
  });
});

describe("onboarding status", { concurrency: 1 }, () => {
  it("counts the shop and marks the checklist from those counts", async () => {
    const queries = [];
    pool.query = async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      return {
        rows: [
          {
            phases: 2,
            vendors: 0,
            buy_items: 4,
            make_items: 1,
            batches: 0,
          },
        ],
      };
    };
    const res = mockRes();
    await getOnboardingStatus({ auth: { clientId: 4 } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.counts, {
      phases: 2,
      vendors: 0,
      buy_items: 4,
      make_items: 1,
      batches: 0,
    });
    const byKey = Object.fromEntries(res.body.checklist.map((step) => [step.key, step]));
    assert.equal(byKey.phases.done, true);
    assert.equal(byKey.buy_items.done, true);
    assert.equal(byKey.make_items.count, 1);
    assert.equal(byKey.vendors.done, false);
    assert.equal(byKey.batches.done, false);
    assert.equal(queries[0].params[0], 4);
    assert.match(queries[0].sql, /client_id = \$1/g);
    assert.equal(queries[0].sql.match(/client_id = \$1/g).length, 5);
  });
});
