import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_batch_progress_test";

const { pool } = await import("../lib/db.js");
const { resetBatchProgressForTests } = await import("../lib/batchProgress.js");
const { saveBatchComponentProgress } = await import("../api-functions/batchProgress.js");
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

function req(body, ids = {}) {
  return {
    auth: { clientId: 4, userId: 9 },
    params: { id: "3", componentId: "8", ...ids },
    body,
  };
}

after(async () => {
  resetBatchProgressForTests();
  await pool.end();
});

describe("batch ingredient progress", { concurrency: 1 }, () => {
  it("proposes only the progress table", () => {
    const sql = readFileSync(
      new URL("../scripts/sql/batch-component-progress.sql", import.meta.url),
      "utf8"
    );
    assert.match(sql, /Do not run until Luna approves/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS batch_component_progress/);
    assert.match(sql, /quantity_entered NUMERIC NOT NULL CHECK \(quantity_entered >= 0\)/);
    assert.match(sql, /REFERENCES batch_components\(id\) ON DELETE CASCADE/);
    assert.match(sql, /REFERENCES batch_phases\(id\) ON DELETE CASCADE/);
    assert.match(sql, /COALESCE\(batch_phase_id, 0\)/);
    assert.equal(sql.includes("quantity_allocated"), false);
    assert.equal(sql.includes("inventory"), false);
  });

  it("saves zero and a correction without changing the allocation", async () => {
    resetBatchProgressForTests();
    const queries = [];
    pool.connect = async () => ({
      async query(sql, params = []) {
        const text = String(sql);
        queries.push({ sql: text, params });
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("to_regclass")) {
          return { rows: [{ regclass: "batch_component_progress" }] };
        }
        if (text.includes("FROM batch_components")) {
          assert.equal(params[0], 4);
          assert.deepEqual(params.slice(1), [8, 3]);
          return {
            rows: [
              {
                id: 8,
                batch_id: 3,
                quantity_allocated: "4",
                unit_of_measure: "oz",
                status: "in_progress",
              },
            ],
          };
        }
        if (text.includes("FROM batch_phases")) {
          return params[0] === 15 && params[1] === 3 ? { rows: [{ id: 15 }] } : { rows: [] };
        }
        if (text.includes("<= $2::numeric")) {
          return { rows: [{ ok: Number(params[0]) <= Number(params[1]) }] };
        }
        if (text.includes("UPDATE batch_component_progress")) {
          return { rows: [{ quantity_entered: params[0] }] };
        }
        throw new Error(text);
      },
      release() {},
    });

    const cleared = mockRes();
    await saveBatchComponentProgress(req({ quantity_entered: "0", batch_phase_id: 15 }), cleared);
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.body.quantity_entered, "0");
    assert.equal(cleared.body.quantity_allocated, "4");
    assert.equal(cleared.body.unit_of_measure, "oz");
    assert.equal(cleared.body.batch_phase_id, 15);
    assert.equal(cleared.body.batch_component_id, 8);

    const corrected = mockRes();
    await saveBatchComponentProgress(
      req({ quantity_entered: "1.5", batch_phase_id: null }),
      corrected
    );
    assert.equal(corrected.statusCode, 200);
    assert.equal(corrected.body.quantity_entered, "1.5");
    assert.equal(corrected.body.batch_phase_id, null);
    const writes = queries.filter(
      (query) =>
        query.sql.includes("UPDATE batch_component_progress") ||
        query.sql.includes("INSERT INTO batch_component_progress")
    );
    assert.ok(writes.length >= 1);
    assert.equal(writes.some((query) => /quantity_allocated\s*=/.test(query.sql)), false);
    assert.equal(writes.some((query) => query.sql.includes("inventory")), false);
    assert.equal(writes.some((query) => query.sql.includes("batch_phases")), false);
  });

  it("rejects another company's ingredient, a stale step, and a bad quantity before writing", async () => {
    resetBatchProgressForTests();
    const queries = [];
    pool.connect = async () => ({
      async query(sql, params = []) {
        const text = String(sql);
        queries.push(text);
        if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("to_regclass")) {
          return { rows: [{ regclass: "batch_component_progress" }] };
        }
        if (text.includes("FROM batch_components")) return { rows: [] };
        if (text.includes("FROM batch_phases")) return { rows: [] };
        if (text.includes("UPDATE batch_component_progress") || text.includes("INSERT")) {
          throw new Error("should not write");
        }
        throw new Error(text);
      },
      release() {},
    });

    const missing = mockRes();
    await saveBatchComponentProgress(req({ quantity_entered: "1", batch_phase_id: 15 }), missing);
    assert.equal(missing.statusCode, 404);

    pool.connect = async () => ({
      async query(sql, params = []) {
        const text = String(sql);
        if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("to_regclass")) {
          return { rows: [{ regclass: "batch_component_progress" }] };
        }
        if (text.includes("FROM batch_components")) {
          return {
            rows: [
              {
                id: 8,
                batch_id: 3,
                quantity_allocated: "4",
                unit_of_measure: "oz",
                status: "planned",
              },
            ],
          };
        }
        if (text.includes("FROM batch_phases")) return { rows: [] };
        throw new Error(text);
      },
      release() {},
    });
    const stale = mockRes();
    await saveBatchComponentProgress(req({ quantity_entered: "1", batch_phase_id: 99 }), stale);
    assert.equal(stale.statusCode, 400);
    assert.equal(stale.body.code, "PHASE_NOT_ON_BATCH");

    let connected = false;
    pool.connect = async () => {
      connected = true;
      throw new Error("should not connect");
    };
    const bad = mockRes();
    await saveBatchComponentProgress(req({ quantity_entered: "-1" }), bad);
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.code, "QUANTITY_INVALID");
    assert.equal(connected, false);

    const over = mockRes();
    pool.connect = async () => ({
      async query(sql, params = []) {
        const text = String(sql);
        if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("to_regclass")) {
          return { rows: [{ regclass: "batch_component_progress" }] };
        }
        if (text.includes("FROM batch_components")) {
          return {
            rows: [
              {
                id: 8,
                batch_id: 3,
                quantity_allocated: "4",
                unit_of_measure: "oz",
                status: "planned",
              },
            ],
          };
        }
        if (text.includes("<= $2::numeric")) {
          return { rows: [{ ok: Number(params[0]) <= Number(params[1]) }] };
        }
        throw new Error(text);
      },
      release() {},
    });
    await saveBatchComponentProgress(req({ quantity_entered: "4.0000001" }), over);
    assert.equal(over.statusCode, 400);
    assert.equal(over.body.code, "QUANTITY_INVALID");
    const tooMuch = mockRes();
    await saveBatchComponentProgress(req({ quantity_entered: "4.1" }), tooMuch);
    assert.equal(tooMuch.statusCode, 400);
    assert.equal(tooMuch.body.code, "QUANTITY_OVER_ALLOCATED");
  });

  it("retries the update when two saves insert at the same time", async () => {
    resetBatchProgressForTests();
    let updates = 0;
    pool.connect = async () => ({
      async query(sql, params = []) {
        const text = String(sql);
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("to_regclass")) {
          return { rows: [{ regclass: "batch_component_progress" }] };
        }
        if (text.includes("FROM batch_components")) {
          return {
            rows: [
              {
                id: 8,
                batch_id: 3,
                quantity_allocated: "4",
                unit_of_measure: "oz",
                status: "in_progress",
              },
            ],
          };
        }
        if (text.includes("<= $2::numeric")) return { rows: [{ ok: true }] };
        if (text.includes("UPDATE batch_component_progress")) {
          updates += 1;
          if (updates === 1) return { rows: [] };
          return { rows: [{ quantity_entered: "2" }] };
        }
        if (text.includes("INSERT INTO batch_component_progress")) {
          const err = new Error("duplicate");
          err.code = "23505";
          throw err;
        }
        throw new Error(text);
      },
      release() {},
    });
    const res = mockRes();
    await saveBatchComponentProgress(req({ quantity_entered: "2", batch_phase_id: null }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.quantity_entered, "2");
    assert.equal(updates, 2);
  });

  it("returns saved progress on the batch and does nothing until the table exists", async () => {
    resetBatchProgressForTests();
    pool.query = async (sql) => {
      const text = String(sql);
      if (text.includes("information_schema") || text.includes("WITH RECURSIVE")) {
        return { rows: [] };
      }
      if (text.includes("to_regclass")) return { rows: [{ regclass: null }] };
      if (text.includes("FROM batches")) {
        return {
          rows: [
            {
              id: 3,
              components: [{ id: 8, item_id: 2, quantity_allocated: "4", unit_of_measure: "oz" }],
            },
          ],
        };
      }
      throw new Error(text);
    };
    const before = mockRes();
    await getBatches({ auth: { clientId: 4 } }, before);
    assert.equal(before.statusCode, 200);
    assert.deepEqual(before.body[0].components[0].progress, []);

    const denied = mockRes();
    pool.connect = async () => ({
      async query(sql) {
        if (String(sql).includes("to_regclass")) return { rows: [{ regclass: null }] };
        throw new Error(String(sql));
      },
      release() {},
    });
    await saveBatchComponentProgress(req({ quantity_entered: "1" }), denied);
    assert.equal(denied.statusCode, 503);
    assert.equal(denied.body.code, "PROGRESS_UNAVAILABLE");

    resetBatchProgressForTests();
    pool.query = async (sql, params = []) => {
      const text = String(sql);
      if (text.includes("information_schema") || text.includes("WITH RECURSIVE")) {
        return { rows: [] };
      }
      if (text.includes("to_regclass")) {
        return { rows: [{ regclass: "batch_component_progress" }] };
      }
      if (text.includes("FROM batch_component_progress")) {
        assert.equal(params[0], 4);
        return {
          rows: [
            { batch_component_id: 8, batch_phase_id: 15, quantity_entered: "1.5" },
            { batch_component_id: 8, batch_phase_id: null, quantity_entered: "0" },
          ],
        };
      }
      if (text.includes("FROM batches")) {
        return {
          rows: [
            {
              id: 3,
              components: [{ id: 8, quantity_allocated: "4", unit_of_measure: "oz" }],
            },
          ],
        };
      }
      throw new Error(text);
    };
    const afterSave = mockRes();
    await getBatches({ auth: { clientId: 4 } }, afterSave);
    assert.deepEqual(afterSave.body[0].components[0].progress, [
      { batch_phase_id: 15, quantity_entered: "1.5" },
      { batch_phase_id: null, quantity_entered: "0" },
    ]);
    assert.equal(afterSave.body[0].components[0].quantity_allocated, "4");
  });
});
