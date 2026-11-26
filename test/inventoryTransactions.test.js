import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { after, beforeEach, describe, it } from "node:test";
import express from "express";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_inventory_transactions_test";
process.env.JWT_SECRET ??= "inventory-txn-test-secret";
process.env.PLATFORM_ADMIN_EMAILS ??= "platform-admin@example.com";

const { pool } = await import("../lib/db.js");
const { createRequireAuth, signImpersonationToken } = await import("../lib/auth.js");
const { completeBatch } = await import("../api-functions/batches.js");
const { updateItemInventory } = await import("../api-functions/inventory.js");
const { changeItemUnit } = await import("../api-functions/items.js");
const {
  createPurchaseLot,
  deletePurchaseLot,
} = await import("../api-functions/purchaseLots.js");
const {
  createInventoryTransaction,
  listInventoryTransactions,
} = await import("../api-functions/inventoryTransactions.js");
const {
  HISTORY_UNAVAILABLE,
  resetInventoryTransactionsForTests,
} = await import("../lib/inventoryTransactions.js");
const { resetBomPhaseColumnCacheForTests } = await import("../lib/bomPhase.js");
const { resetBatchProgressForTests } = await import("../lib/batchProgress.js");

pool.options.connectionTimeoutMillis = 500;

const CLIENT = 4;
const USER = 9;
const ITEM = 10;
const TODAY = "2026-11-26";

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

function authReq(extra = {}) {
  return {
    auth: { clientId: CLIENT, userId: USER, role: "founder" },
    params: { id: String(ITEM) },
    query: {},
    body: {},
    ...extra,
  };
}

/**
 * In-memory stock and ledger. Numeric math is done the same way the SQL
 * fragments ask for it, so a test can assert the stored balance.
 */
function installStockDb(state = {}) {
  const queries = [];
  const stock = new Map(
    Object.entries(state.stock ?? {}).map(([id, qty]) => [Number(id), String(qty)])
  );
  const transactions = (state.transactions ?? []).map((row) => ({ ...row }));
  let nextId = state.nextId ?? 100;
  const table = state.table !== false;
  const item = state.item ?? {
    id: ITEM,
    make_or_buy: "buy",
    unit_of_measure: "oz",
  };

  async function query(sql, params = []) {
    const text = String(sql);
    queries.push({ sql: text, params: [...params] });
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      return { rows: [] };
    }
    if (text.includes("to_regclass")) {
      if (text.includes("inventory_transactions")) {
        return { rows: [{ regclass: table ? "inventory_transactions" : null }] };
      }
      return { rows: [{ regclass: null }] };
    }
    if (text.includes("information_schema")) return { rows: [] };
    if (text.includes("SELECT CURRENT_DATE")) {
      return { rows: [{ today: state.today ?? TODAY }] };
    }
    if (text.includes("make_or_buy") && text.includes("FROM items")) {
      const itemId = Number(params[0]);
      const clientId = Number(params[1]);
      if (itemId === ITEM && clientId === CLIENT) return { rows: [item] };
      return { rows: [] };
    }
    if (text.includes("SELECT unit_of_measure") && text.includes("FROM items")) {
      return { rows: [{ unit_of_measure: state.units?.[params[0]] ?? "oz" }] };
    }
    if (text.includes("SELECT name") && text.includes("FROM users")) {
      if (Number(params[0]) === USER && Number(params[1]) === CLIENT) {
        return { rows: [{ name: "Ada" }] };
      }
      return { rows: [] };
    }
    if (text.includes("INSERT INTO inventory_transactions")) {
      const row = {
        id: nextId++,
        client_id: params[0],
        item_id: params[1],
        direction: params[2],
        reason: params[3],
        quantity: String(params[4]),
        quantity_change: String(params[5]),
        balance_after: String(params[6]),
        unit_price: params[7] == null ? null : String(params[7]),
        unit_of_measure: params[8],
        note: params[9],
        occurred_on: params[10] ?? state.today ?? TODAY,
        source: params[11],
        batch_id: params[12],
        purchase_lot_id: params[13],
        created_by: params[14],
        created_by_name: Number(params[14]) === USER ? "Ada" : null,
        created_at: "2026-11-26T12:00:00.000Z",
      };
      transactions.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (text.includes("INSERT INTO inventory")) {
      const itemId = Number(params[1]);
      if (!stock.has(itemId)) stock.set(itemId, "0");
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("INSERT INTO purchase_lots")) {
      return {
        rows: [
          {
            id: 70,
            client_id: params[0],
            item_id: params[1],
            lot_number: params[2],
            quantity: params[3],
            total_cost: params[4],
            unit_cost: params[5],
            arrival_date: params[6],
            received_at: TODAY,
            created_by: params[7],
            created_at: TODAY,
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("FOR UPDATE") && text.includes("FROM inventory")) {
      return { rows: [{ quantity: stock.get(Number(params[1])) ?? "0" }] };
    }
    if (text.includes("GREATEST(0::numeric, quantity")) {
      const itemId = Number(params[1]);
      const before = Number(stock.get(itemId) ?? "0");
      const after = Math.max(0, before + Number(params[2]));
      stock.set(itemId, String(after));
      return { rows: [{ quantity: String(after) }], rowCount: 1 };
    }
    if (text.includes("SET quantity = $3::numeric")) {
      const itemId = Number(params[1]);
      stock.set(itemId, String(params[2]));
      return { rows: [{ quantity: String(params[2]) }], rowCount: 1 };
    }
    if (text.includes("SELECT ($1::numeric - $2::numeric)")) {
      const applied = Number(params[0]) - Number(params[1]);
      return {
        rows: [{ applied: String(applied), magnitude: String(Math.abs(applied)) }],
      };
    }
    if (text.includes("SELECT ($1::numeric + $2::numeric)")) {
      return { rows: [{ after: String(Number(params[0]) + Number(params[1])) }] };
    }
    if (/SUM\(/i.test(text)) return { rows: [{ total: 0 }] };
    if (text.includes("FROM item_inventory_goals")) return { rows: [] };
    if (text.includes("inventory_posted")) {
      return { rows: state.batch ? [state.batch] : [] };
    }
    if (text.includes("FROM batch_phases")) return { rows: [] };
    if (text.includes("FROM batch_components")) return { rows: state.components ?? [] };
    if (text.includes("UPDATE batches")) return { rows: [], rowCount: 1 };
    if (text.includes("json_agg")) return { rows: [{ id: state.batch?.id ?? 5, components: [] }] };
    if (text.includes("FROM purchase_lots") && text.includes("FOR UPDATE")) {
      return { rows: state.lot ? [state.lot] : [] };
    }
    if (text.includes("DELETE FROM purchase_lots")) return { rows: [], rowCount: 1 };
    if (text.includes("FROM purchase_lots")) return { rows: [] };
    if (text.includes("UPDATE items")) return { rows: [], rowCount: 1 };
    if (text.includes("SELECT quantity") && text.includes("FROM inventory\n")) {
      const qty = stock.get(Number(params[1]));
      return { rows: qty == null ? [] : [{ quantity: qty }] };
    }
    if (
      text.includes("FROM inventory_transactions") &&
      text.includes("WHERE id = $1")
    ) {
      const found = transactions.find(
        (row) =>
          Number(row.id) === Number(params[0]) &&
          Number(row.client_id) === Number(params[1]) &&
          Number(row.item_id) === Number(params[2])
      );
      return { rows: found ? [{ ok: 1 }] : [] };
    }
    if (text.includes("FROM inventory_transactions t")) {
      const beforeId = params.length >= 4 ? Number(params[2]) : null;
      const limit = Number(params[params.length - 1]);
      const cursor = transactions.find((row) => Number(row.id) === beforeId);
      const page = transactions
        .filter(
          (row) =>
            Number(row.client_id) === Number(params[0]) &&
            Number(row.item_id) === Number(params[1])
        )
        .filter((row) => (cursor ? isOlder(row, cursor) : true))
        .sort(newestFirst)
        .slice(0, limit);
      return { rows: page };
    }
    if (text.includes("UPDATE inventory_transactions")) {
      return { rows: [], rowCount: state.historyRows ?? 0 };
    }
    return { rows: [] };
  }

  pool.query = query;
  pool.connect = async () => ({ query, release() {} });
  return { queries, stock, transactions };
}

function newestFirst(a, b) {
  if (a.occurred_on !== b.occurred_on) return a.occurred_on < b.occurred_on ? 1 : -1;
  return Number(b.id) - Number(a.id);
}

function isOlder(row, cursor) {
  if (row.occurred_on < cursor.occurred_on) return true;
  if (row.occurred_on === cursor.occurred_on && Number(row.id) < Number(cursor.id)) {
    return true;
  }
  return false;
}

function ledgerInserts(queries) {
  return queries.filter((query) => query.sql.includes("INSERT INTO inventory_transactions"));
}

beforeEach(() => {
  resetInventoryTransactionsForTests();
  resetBomPhaseColumnCacheForTests();
  resetBatchProgressForTests();
});

after(async () => {
  resetInventoryTransactionsForTests();
  await pool.end();
});

describe("inventory transaction sql", () => {
  it("is safe to run more than once and keeps history with the item", () => {
    const sql = readFileSync(
      new URL("../scripts/sql/inventory-transactions.sql", import.meta.url),
      "utf8"
    );
    assert.match(sql, /Do not run until Luna approves/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS inventory_transactions/);
    assert.match(sql, /CHECK \(direction IN \('in','out'\)\)/);
    assert.match(sql, /CHECK \(quantity > 0\)/);
    assert.match(sql, /CHECK \(balance_after >= 0\)/);
    assert.match(sql, /item_id INTEGER NOT NULL REFERENCES items\(id\) ON DELETE CASCADE/);
    assert.match(sql, /batch_id INTEGER REFERENCES batches\(id\) ON DELETE SET NULL/);
    assert.match(sql, /purchase_lot_id INTEGER REFERENCES purchase_lots\(id\) ON DELETE SET NULL/);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS inventory_transactions_item_idx/);
    assert.equal(sql.includes("CHECK (reason"), false);
  });
});

describe("POST /api/items/:id/inventory/transactions", { concurrency: 1 }, () => {
  it("adds stock and returns the new on-hand amount plus the row", async () => {
    const db = installStockDb({ stock: { [ITEM]: 5 } });
    const res = mockRes();
    await createInventoryTransaction(
      authReq({
        body: {
          direction: "in",
          reason: "returned",
          quantity: 2,
          note: "  Customer brought it back  ",
          occurred_on: "2026-11-20",
        },
      }),
      res
    );

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.inventory.quantity, 7);
    assert.equal(res.body.inventory.unit_of_measure, "oz");
    assert.equal(res.body.transaction.direction, "in");
    assert.equal(res.body.transaction.reason, "returned");
    assert.equal(res.body.transaction.quantity, 2);
    assert.equal(res.body.transaction.quantity_change, 2);
    assert.equal(res.body.transaction.balance_after, 7);
    assert.equal(res.body.transaction.note, "Customer brought it back");
    assert.equal(res.body.transaction.occurred_on, "2026-11-20");
    assert.equal(res.body.transaction.source, "manual");
    assert.equal(res.body.transaction.created_by, USER);
    assert.equal(res.body.transaction.created_by_name, "Ada");
    assert.equal(res.body.transaction.email, undefined);
    assert.equal(db.stock.get(ITEM), "7");
    const insert = ledgerInserts(db.queries)[0];
    assert.equal(insert.params[0], CLIENT);
    assert.equal(insert.params[1], ITEM);
    const commitAt = db.queries.findIndex((query) => query.sql === "COMMIT");
    const insertAt = db.queries.indexOf(insert);
    assert.ok(insertAt > -1 && insertAt < commitAt);
  });

  it("stores a sell price per stock unit and does not treat it as revenue", async () => {
    const db = installStockDb({ stock: { [ITEM]: 4 } });
    const res = mockRes();
    await createInventoryTransaction(
      authReq({
        body: { direction: "out", reason: "sold", quantity: 1, unit_price: 12.5 },
      }),
      res
    );

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.inventory.quantity, 3);
    assert.equal(res.body.transaction.reason, "sold");
    assert.equal(res.body.transaction.unit_price, 12.5);
    assert.equal(res.body.transaction.quantity_change, -1);
    assert.equal(res.body.transaction.balance_after, 3);
    assert.equal(
      db.queries.some((query) => /insert into sales/i.test(query.sql)),
      false
    );
  });

  it("rejects an out that would take stock below zero and does not change it", async () => {
    const db = installStockDb({ stock: { [ITEM]: 2 } });
    const res = mockRes();
    await createInventoryTransaction(
      authReq({ body: { direction: "out", reason: "sold", quantity: 5 } }),
      res
    );

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "That would take stock below zero.");
    assert.equal(ledgerInserts(db.queries).length, 0);
    assert.equal(
      db.queries.some((query) => query.sql.includes("SET quantity = $3::numeric")),
      false
    );
    assert.ok(db.queries.some((query) => query.sql === "ROLLBACK"));
    assert.equal(db.queries.some((query) => query.sql === "COMMIT"), false);
    assert.equal(db.stock.get(ITEM), "2");
  });

  it("allows an out that lands on zero", async () => {
    const db = installStockDb({ stock: { [ITEM]: 2 } });
    const res = mockRes();
    await createInventoryTransaction(
      authReq({ body: { direction: "out", reason: "damaged", quantity: 2 } }),
      res
    );
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.inventory.quantity, 0);
    assert.equal(res.body.transaction.balance_after, 0);
    assert.equal(res.body.transaction.quantity_change, -2);
    assert.equal(db.stock.get(ITEM), "0");
  });

  it("rejects a reason that does not belong to the direction", async () => {
    const db = installStockDb({ stock: { [ITEM]: 5 } });
    const cases = [
      { direction: "in", reason: "sold" },
      { direction: "out", reason: "returned" },
      { direction: "in", reason: "production" },
      { direction: "out", reason: "adjustment" },
      { direction: "up", reason: "other" },
    ];
    for (const body of cases) {
      const res = mockRes();
      await createInventoryTransaction(
        authReq({ body: { ...body, quantity: 1 } }),
        res
      );
      assert.equal(res.statusCode, 400, body.reason);
    }
    assert.equal(ledgerInserts(db.queries).length, 0);
  });

  it("rejects a future date, a bad date, and a note that is too long", async () => {
    installStockDb({ stock: { [ITEM]: 5 }, today: TODAY });
    const future = mockRes();
    await createInventoryTransaction(
      authReq({
        body: { direction: "in", reason: "found", quantity: 1, occurred_on: "2026-11-27" },
      }),
      future
    );
    assert.equal(future.statusCode, 400);
    assert.match(future.body.error, /future/);

    const badDay = mockRes();
    await createInventoryTransaction(
      authReq({
        body: { direction: "in", reason: "found", quantity: 1, occurred_on: "2026-02-31" },
      }),
      badDay
    );
    assert.equal(badDay.statusCode, 400);
    assert.match(badDay.body.error, /YYYY-MM-DD/);

    const longNote = mockRes();
    await createInventoryTransaction(
      authReq({
        body: { direction: "in", reason: "found", quantity: 1, note: "x".repeat(501) },
      }),
      longNote
    );
    assert.equal(longNote.statusCode, 400);
    assert.match(longNote.body.error, /500/);
  });

  it("returns 404 for another company's item and does not write", async () => {
    const db = installStockDb({ stock: { [ITEM]: 5 } });
    const res = mockRes();
    await createInventoryTransaction(
      authReq({
        auth: { clientId: 99, userId: USER },
        body: { direction: "in", reason: "found", quantity: 1 },
      }),
      res
    );

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, "Item not found");
    assert.equal(ledgerInserts(db.queries).length, 0);
    const lookup = db.queries.find(
      (query) => query.sql.includes("FROM items") && query.sql.includes("make_or_buy")
    );
    assert.deepEqual(lookup.params, [ITEM, 99]);
  });

  it("refuses the manual change when the history table is not there yet", async () => {
    const db = installStockDb({ stock: { [ITEM]: 5 }, table: false });
    const res = mockRes();
    await createInventoryTransaction(
      authReq({ body: { direction: "in", reason: "found", quantity: 1 } }),
      res
    );

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, HISTORY_UNAVAILABLE);
    assert.equal(db.queries.some((query) => query.sql === "BEGIN"), false);
    assert.equal(db.stock.get(ITEM), "5");
  });
});

describe("GET /api/items/:id/inventory/transactions", { concurrency: 1 }, () => {
  const history = [
    {
      id: 1,
      client_id: CLIENT,
      item_id: ITEM,
      direction: "in",
      reason: "found",
      quantity: "2",
      quantity_change: "2",
      balance_after: "2",
      unit_price: null,
      unit_of_measure: "oz",
      note: null,
      occurred_on: "2026-11-01",
      source: "manual",
      batch_id: null,
      purchase_lot_id: null,
      created_by: USER,
      created_by_name: "Ada",
      created_at: "2026-11-01T00:00:00.000Z",
      email: "ada@soap.test",
    },
    {
      id: 3,
      client_id: CLIENT,
      item_id: ITEM,
      direction: "out",
      reason: "sold",
      quantity: "1",
      quantity_change: "-1",
      balance_after: "4",
      unit_price: "9",
      unit_of_measure: "oz",
      note: null,
      occurred_on: "2026-11-20",
      source: "manual",
      batch_id: null,
      purchase_lot_id: null,
      created_by: USER,
      created_by_name: "Ada",
      created_at: "2026-11-20T00:00:00.000Z",
    },
    {
      id: 2,
      client_id: CLIENT,
      item_id: ITEM,
      direction: "in",
      reason: "returned",
      quantity: "3",
      quantity_change: "3",
      balance_after: "5",
      unit_price: null,
      unit_of_measure: "oz",
      note: null,
      occurred_on: "2026-11-20",
      source: "manual",
      batch_id: null,
      purchase_lot_id: null,
      created_by: USER,
      created_by_name: "Ada",
      created_at: "2026-11-20T00:00:00.000Z",
    },
    {
      id: 4,
      client_id: CLIENT,
      item_id: ITEM,
      direction: "out",
      reason: "gifted",
      quantity: "1",
      quantity_change: "-1",
      balance_after: "1",
      unit_price: null,
      unit_of_measure: "oz",
      note: "backdated",
      occurred_on: "2026-11-01",
      source: "manual",
      batch_id: null,
      purchase_lot_id: null,
      created_by: 3,
      created_by_name: "Bea",
      created_at: "2026-11-25T00:00:00.000Z",
    },
    {
      id: 9,
      client_id: 99,
      item_id: ITEM,
      direction: "in",
      reason: "found",
      quantity: "50",
      quantity_change: "50",
      balance_after: "50",
      unit_price: null,
      unit_of_measure: "oz",
      note: "other company",
      occurred_on: "2026-11-26",
      source: "manual",
      batch_id: null,
      purchase_lot_id: null,
      created_by: 1,
      created_by_name: "Other",
      created_at: "2026-11-26T00:00:00.000Z",
      email: "secret@other.test",
    },
  ];

  it("lists newest first, names the person, and hides email addresses", async () => {
    const db = installStockDb({ transactions: history });
    const res = mockRes();
    await listInventoryTransactions(authReq(), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.body.transactions.map((row) => row.id),
      [3, 2, 4, 1]
    );
    assert.equal(res.body.has_more, false);
    assert.equal(res.body.next_before, null);
    assert.equal(res.body.transactions[0].created_by_name, "Ada");
    assert.equal(res.body.transactions[0].unit_price, 9);
    assert.equal(JSON.stringify(res.body).includes("ada@soap.test"), false);
    assert.equal(JSON.stringify(res.body).includes("secret@other.test"), false);
    assert.equal(JSON.stringify(res.body).includes("other company"), false);
    const list = db.queries.find((query) => query.sql.includes("FROM inventory_transactions t"));
    assert.match(list.sql, /ORDER BY t\.occurred_on DESC, t\.id DESC/);
    assert.match(list.sql, /u\.client_id = t\.client_id/);
    assert.match(list.sql, /u\.name AS created_by_name/);
    assert.equal(list.sql.toLowerCase().includes("email"), false);
    assert.equal(list.params[0], CLIENT);
    assert.equal(list.params[1], ITEM);
  });

  it("pages with before, including a backdated row with a higher id", async () => {
    installStockDb({ transactions: history });
    const first = mockRes();
    await listInventoryTransactions(authReq({ query: { limit: "2" } }), first);
    assert.deepEqual(
      first.body.transactions.map((row) => row.id),
      [3, 2]
    );
    assert.equal(first.body.has_more, true);
    assert.equal(first.body.next_before, 2);

    const second = mockRes();
    await listInventoryTransactions(
      authReq({ query: { limit: "2", before: String(first.body.next_before) } }),
      second
    );
    assert.deepEqual(
      second.body.transactions.map((row) => row.id),
      [4, 1]
    );
    assert.equal(second.body.has_more, false);

    const missing = mockRes();
    await listInventoryTransactions(authReq({ query: { before: "4242" } }), missing);
    assert.equal(missing.statusCode, 400);
    assert.match(missing.body.error, /page marker/);
  });

  it("returns an empty page when the table is not there yet", async () => {
    installStockDb({ table: false });
    const res = mockRes();
    await listInventoryTransactions(authReq(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { transactions: [], has_more: false, next_before: null });
  });

  it("returns 404 for another company's item", async () => {
    const db = installStockDb({ transactions: history });
    const res = mockRes();
    await listInventoryTransactions(
      authReq({ auth: { clientId: 99, userId: USER } }),
      res
    );
    assert.equal(res.statusCode, 404);
    assert.equal(
      db.queries.some((query) => query.sql.includes("FROM inventory_transactions t")),
      false
    );
  });
});

describe("stock writers record the change that was stored", { concurrency: 1 }, () => {
  it("logs an inventory edit and skips a zero change", async () => {
    const db = installStockDb({ stock: { [ITEM]: 10 } });
    const down = mockRes();
    await updateItemInventory(authReq({ body: { quantity: 4 } }), down);
    assert.equal(down.statusCode, 200);
    assert.equal(down.body.quantity, 4);
    const cut = ledgerInserts(db.queries).at(-1);
    assert.equal(cut.params[2], "out");
    assert.equal(cut.params[3], "adjustment");
    assert.equal(cut.params[4], "6");
    assert.equal(cut.params[5], "-6");
    assert.equal(cut.params[6], "4");
    assert.equal(cut.params[11], "edit");

    const same = mockRes();
    await updateItemInventory(authReq({ body: { quantity: 4 } }), same);
    assert.equal(same.statusCode, 200);
    assert.equal(same.body.quantity, 4);
    assert.equal(ledgerInserts(db.queries).length, 1);

    const up = mockRes();
    await updateItemInventory(authReq({ body: { quantity: 9 } }), up);
    assert.equal(up.body.quantity, 9);
    const added = ledgerInserts(db.queries).at(-1);
    assert.equal(added.params[2], "in");
    assert.equal(added.params[4], "5");
    assert.equal(added.params[5], "5");
    assert.equal(added.params[6], "9");
  });

  it("still saves an inventory edit when history is not available yet", async () => {
    const db = installStockDb({ stock: { [ITEM]: 1 }, table: false });
    const res = mockRes();
    await updateItemInventory(authReq({ body: { quantity: 6 } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.quantity, 6);
    assert.equal(ledgerInserts(db.queries).length, 0);
    assert.equal(db.stock.get(ITEM), "6");
  });

  it("logs batch production and the materials that were actually removed", async () => {
    const db = installStockDb({
      stock: { 10: 1, 2: 3, 3: 20 },
      batch: {
        id: 5,
        item_id: 10,
        quantity: 8,
        sku: "LOT-9",
        status: "in_progress",
        inventory_posted: false,
      },
      components: [
        { item_id: 2, quantity_allocated: 10, make_or_buy: "buy", unit_of_measure: "oz" },
        { item_id: 3, quantity_allocated: 4, make_or_buy: "make", unit_of_measure: "ea" },
      ],
      units: { 10: "ea", 2: "oz" },
    });
    const res = mockRes();
    await completeBatch(authReq({ params: { id: "5" } }), res);

    assert.equal(res.statusCode, 200);
    const rows = ledgerInserts(db.queries);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].params[1], 10);
    assert.equal(rows[0].params[2], "in");
    assert.equal(rows[0].params[3], "production");
    assert.equal(rows[0].params[4], "8");
    assert.equal(rows[0].params[5], "8");
    assert.equal(rows[0].params[6], "9");
    assert.equal(rows[0].params[11], "batch_complete");
    assert.equal(rows[0].params[12], 5);
    assert.match(rows[0].params[9], /LOT-9/);

    assert.equal(rows[1].params[1], 2);
    assert.equal(rows[1].params[2], "out");
    assert.equal(rows[1].params[3], "materials_used");
    assert.equal(rows[1].params[4], "3");
    assert.equal(rows[1].params[5], "-3");
    assert.equal(rows[1].params[6], "0");
    assert.equal(rows[1].params[8], "oz");
    assert.equal(rows[1].params[12], 5);
    assert.equal(db.stock.get(2), "0");
    assert.equal(db.stock.get(3), "20");
    assert.equal(
      rows.some((row) => row.params[1] === 3),
      false
    );
  });

  it("logs a received purchase lot and the stock removed when that lot is deleted", async () => {
    const received = installStockDb({
      stock: { [ITEM]: 2 },
      item: { id: ITEM, make_or_buy: "buy", unit_of_measure: "oz" },
    });
    const created = mockRes();
    await createPurchaseLot(
      authReq({
        body: {
          lot_number: "L-1",
          quantity: 5,
          total_cost: 20,
          arrival_date: "2026-11-02",
        },
      }),
      created
    );
    assert.equal(created.statusCode, 201);
    const got = ledgerInserts(received.queries)[0];
    assert.equal(got.params[2], "in");
    assert.equal(got.params[3], "received");
    assert.equal(got.params[4], "5");
    assert.equal(got.params[6], "7");
    assert.equal(got.params[10], "2026-11-02");
    assert.equal(got.params[11], "purchase_lot");
    assert.equal(got.params[13], 70);
    assert.match(got.params[9], /L-1/);
    assert.equal(received.stock.get(ITEM), "7");

    const removed = installStockDb({
      stock: { [ITEM]: 10 },
      item: { id: ITEM, make_or_buy: "buy", unit_of_measure: "oz" },
      lot: { id: 70, quantity: 4, lot_number: "L-1" },
    });
    const deleted = mockRes();
    await deletePurchaseLot(authReq({ params: { id: String(ITEM), lotId: "70" } }), deleted);
    assert.equal(deleted.statusCode, 204);
    const reversal = ledgerInserts(removed.queries)[0];
    assert.equal(reversal.params[2], "out");
    assert.equal(reversal.params[3], "adjustment");
    assert.equal(reversal.params[4], "4");
    assert.equal(reversal.params[5], "-4");
    assert.equal(reversal.params[6], "6");
    assert.equal(reversal.params[13], 70);
    assert.match(reversal.params[9], /Removed vendor lot L-1/);
    const insertAt = removed.queries.findIndex((query) =>
      query.sql.includes("INSERT INTO inventory_transactions")
    );
    const deleteAt = removed.queries.findIndex((query) =>
      query.sql.includes("DELETE FROM purchase_lots")
    );
    assert.ok(insertAt > -1 && insertAt < deleteAt);
    assert.equal(removed.stock.get(ITEM), "6");

    const clamped = installStockDb({
      stock: { [ITEM]: 1 },
      item: { id: ITEM, make_or_buy: "buy", unit_of_measure: "oz" },
      lot: { id: 70, quantity: 4, lot_number: "L-9" },
    });
    const short = mockRes();
    await deletePurchaseLot(authReq({ params: { id: String(ITEM), lotId: "70" } }), short);
    assert.equal(short.statusCode, 204);
    const partial = ledgerInserts(clamped.queries)[0];
    assert.equal(partial.params[4], "1");
    assert.equal(partial.params[5], "-1");
    assert.equal(partial.params[6], "0");
    assert.equal(clamped.stock.get(ITEM), "0");
  });
});

describe("unit changes restate history", { concurrency: 1 }, () => {
  function installUnitDb({
    storedUnit = "lb",
    table = true,
    historyRows = 1,
    crossKind = false,
  } = {}) {
    const queries = [];
    pool.connect = async () => ({
      async query(sql, params = []) {
        const text = String(sql);
        queries.push({ sql: text, params: [...params] });
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("to_regclass")) {
          return {
            rows: [{ regclass: table ? "inventory_transactions" : null }],
          };
        }
        if (text.includes("UPDATE inventory_transactions")) {
          return { rows: [], rowCount: historyRows };
        }
        if (text.includes("INSERT INTO inventory_transactions")) {
          return {
            rows: [
              {
                id: 1,
                direction: params[2],
                reason: params[3],
                quantity: String(params[4]),
                quantity_change: String(params[5]),
                balance_after: String(params[6]),
                unit_price: null,
                unit_of_measure: params[8],
                note: params[9],
                occurred_on: TODAY,
                source: params[11],
                batch_id: null,
                purchase_lot_id: null,
                created_by: params[14],
                created_at: TODAY,
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes("quantity::text") && text.includes("FROM inventory")) {
          return { rows: [{ quantity: "32" }] };
        }
        if (!crossKind) {
          if (text.includes("FOR UPDATE") && text.includes("FROM items")) {
            return { rows: [{ id: ITEM, unit_of_measure: storedUnit }] };
          }
          if (text.includes("FROM batches")) return { rows: [] };
          if (text.includes("json_agg")) {
            return { rows: [{ id: ITEM, name: "Oil", unit_of_measure: "oz" }] };
          }
          return { rows: [] };
        }
        if (text.includes("unit_sell_price") && text.includes("FROM items")) {
          return {
            rows: [
              {
                id: ITEM,
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
                unit_of_measure: "fl_oz",
              },
            ],
          };
        }
        if (text.includes("component_name")) return { rows: [] };
        if (text.includes("projected_unit_cost")) return { rows: [] };
        if (text.includes("quantity_allocated")) return { rows: [] };
        if (text.includes("json_agg")) {
          return { rows: [{ id: ITEM, name: "Tincture", unit_of_measure: "ea" }] };
        }
        return { rows: [] };
      },
      release() {},
    });
    return queries;
  }

  it("multiplies earlier rows when the unit stays in the same family", async () => {
    const queries = installUnitDb({ storedUnit: "lb", historyRows: 2 });
    const res = mockRes();
    await changeItemUnit(
      {
        auth: { clientId: CLIENT, userId: USER },
        params: { id: String(ITEM) },
        body: { unit_of_measure: "oz" },
      },
      res
    );

    assert.equal(res.statusCode, 200);
    const restated = queries.find((query) => query.sql.includes("UPDATE inventory_transactions"));
    assert.match(restated.sql, /quantity = quantity \* \$1::numeric/);
    assert.match(restated.sql, /quantity_change = quantity_change \* \$1::numeric/);
    assert.match(restated.sql, /balance_after = balance_after \* \$1::numeric/);
    assert.match(restated.sql, /unit_price \/ \$1::numeric/);
    assert.deepEqual(restated.params, [16, "oz", CLIENT, ITEM]);
    const note = ledgerInserts(queries)[0];
    assert.equal(note.params[3], "unit_change");
    assert.equal(note.params[5], "0");
    assert.equal(note.params[11], "unit_change");
    assert.match(note.params[9], /lb to oz/);
    assert.match(note.params[9], /restated/);
    const commitAt = queries.findIndex((query) => query.sql === "COMMIT");
    assert.ok(queries.indexOf(note) < commitAt);
  });

  it("does not add a unit-change row when there is no history to explain", async () => {
    const queries = installUnitDb({ storedUnit: "lb", historyRows: 0 });
    const res = mockRes();
    await changeItemUnit(
      {
        auth: { clientId: CLIENT, userId: USER },
        params: { id: String(ITEM) },
        body: { unit_of_measure: "oz" },
      },
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(ledgerInserts(queries).length, 0);
    assert.ok(queries.some((query) => query.sql.includes("UPDATE inventory_transactions")));
  });

  it("leaves the unit change alone when the history table is absent", async () => {
    const queries = installUnitDb({ storedUnit: "lb", table: false });
    const res = mockRes();
    await changeItemUnit(
      {
        auth: { clientId: CLIENT, userId: USER },
        params: { id: String(ITEM) },
        body: { unit_of_measure: "oz" },
      },
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(
      queries.some((query) => query.sql.includes("UPDATE inventory_transactions")),
      false
    );
    assert.ok(queries.some((query) => query.sql.includes("UPDATE inventory")));
  });

  it("divides earlier rows when the unit changes kind", async () => {
    const queries = installUnitDb({ crossKind: true, historyRows: 1 });
    const res = mockRes();
    await changeItemUnit(
      {
        auth: { clientId: CLIENT, userId: USER },
        params: { id: String(ITEM) },
        body: { unit_of_measure: "ea", factor: 8 },
      },
      res
    );

    assert.equal(res.statusCode, 200);
    const restated = queries.find((query) => query.sql.includes("UPDATE inventory_transactions"));
    assert.match(restated.sql, /quantity = quantity \/ \$1::numeric/);
    assert.match(restated.sql, /quantity_change = quantity_change \/ \$1::numeric/);
    assert.match(restated.sql, /balance_after = balance_after \/ \$1::numeric/);
    assert.match(restated.sql, /unit_price \* \$1::numeric/);
    assert.equal(restated.params[0], 8);
    assert.equal(restated.params[1], "ea");
    assert.equal(restated.params[2], CLIENT);
    const note = ledgerInserts(queries)[0];
    assert.equal(note.params[3], "unit_change");
    assert.equal(note.params[5], "0");
    assert.match(note.params[9], /fl oz to each/);
  });
});

describe("view-as stays read-only", { concurrency: 1 }, () => {
  it("blocks a stock transaction and still allows the history to be read", async () => {
    const users = new Map([
      [
        1,
        {
          id: 1,
          client_id: 1,
          email: "platform-admin@example.com",
          role: "founder",
          active: true,
          token_version: 4,
          client_active: true,
        },
      ],
      [
        8,
        {
          id: 8,
          client_id: CLIENT,
          email: "ada@soap.test",
          role: "founder",
          active: true,
          token_version: 2,
          client_active: true,
        },
      ],
    ]);
    const queries = [];
    pool.query = async (sql, params = []) => {
      const text = String(sql);
      queries.push(text);
      if (text.includes("to_regclass")) {
        return { rows: [{ regclass: "inventory_transactions" }] };
      }
      if (text.includes("FROM items")) {
        return {
          rows: [{ id: ITEM, make_or_buy: "buy", unit_of_measure: "oz" }],
        };
      }
      if (text.includes("COALESCE(SUM") || text.includes("SUM(")) {
        return { rows: [{ total: 0 }] };
      }
      return { rows: [] };
    };
    pool.connect = async () => ({
      query: pool.query,
      release() {},
    });

    const app = express();
    app.use(express.json());
    const requireAuth = createRequireAuth(async (id) => users.get(id) ?? null);
    app.get(
      "/api/items/:id/inventory/transactions",
      requireAuth,
      listInventoryTransactions
    );
    app.post(
      "/api/items/:id/inventory/transactions",
      requireAuth,
      createInventoryTransaction
    );

    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    const token = signImpersonationToken({
      userId: 8,
      adminUserId: 1,
      adminTokenVersion: 4,
    });
    try {
      const read = await fetch(
        `http://127.0.0.1:${port}/api/items/${ITEM}/inventory/transactions`,
        { headers: { authorization: `Bearer ${token}` } }
      );
      assert.equal(read.status, 200);
      const body = await read.json();
      assert.deepEqual(body.transactions, []);

      const write = await fetch(
        `http://127.0.0.1:${port}/api/items/${ITEM}/inventory/transactions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ direction: "out", reason: "sold", quantity: 1 }),
        }
      );
      assert.equal(write.status, 403);
      const denied = await write.json();
      assert.equal(denied.code, "IMPERSONATION_READ_ONLY");
      assert.equal(queries.some((sql) => sql === "BEGIN"), false);
      assert.equal(
        queries.some((sql) => sql.includes("INSERT INTO inventory_transactions")),
        false
      );
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("transaction routes", () => {
  it("registers read and write with the same guards as other inventory routes", () => {
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    assert.match(
      source,
      /app\.get\(\s*"\/api\/items\/:id\/inventory\/transactions"[\s\S]*requireAuth[\s\S]*requireReadableSubscription[\s\S]*listInventoryTransactions/
    );
    assert.match(
      source,
      /app\.post\(\s*"\/api\/items\/:id\/inventory\/transactions"[\s\S]*requireAuth[\s\S]*requireActiveSubscription[\s\S]*createInventoryTransaction/
    );
  });
});
