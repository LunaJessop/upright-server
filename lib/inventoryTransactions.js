import { spokenUnit } from "./crossKindUnit.js";

/**
 * Per-item stock ledger.
 *
 * The table is optional until the SQL in scripts/sql/inventory-transactions.sql
 * is applied. A missing table is not an error for stock updates that already
 * existed: those updates still save, and no history row is written. The manual
 * transaction API refuses instead, because its only job is to write a row.
 * Nothing is backfilled. History starts with the first row after the table exists.
 *
 * A unit change rewrites earlier rows into the new unit. It adds one
 * unit_change row only when there was history to explain. That row does not
 * move stock again (quantity_change is 0). The positive quantity is the
 * on-hand amount after the change, which keeps the database rule that every
 * row has a quantity above zero.
 */

export const MANUAL_IN_REASONS = Object.freeze([
  "returned",
  "found",
  "stock_check",
  "other",
]);

export const MANUAL_OUT_REASONS = Object.freeze([
  "sold",
  "gifted",
  "donated",
  "lost",
  "damaged",
  "stock_check",
  "other",
]);

const MANUAL_IN = new Set(MANUAL_IN_REASONS);
const MANUAL_OUT = new Set(MANUAL_OUT_REASONS);
const SYSTEM_REASONS = new Set([
  "production",
  "materials_used",
  "received",
  "adjustment",
  "unit_change",
]);

export const HISTORY_UNAVAILABLE = "Stock history isn't available yet.";
export const BELOW_ZERO = "That would take stock below zero.";
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;
export const NOTE_MAX = 500;

let transactionsReady = null;

export function resetInventoryTransactionsForTests() {
  transactionsReady = null;
}

export async function inventoryTransactionsReady(db) {
  if (transactionsReady === true) return true;
  try {
    const { rows } = await db.query(
      `SELECT to_regclass('public.inventory_transactions') AS regclass`
    );
    const name = rows[0]?.regclass;
    const ready = typeof name === "string" && name.length > 0;
    if (ready) transactionsReady = true;
    return ready;
  } catch (err) {
    console.error("inventory transaction table check failed");
    return false;
  }
}

function unavailable() {
  const err = new Error(HISTORY_UNAVAILABLE);
  err.status = 503;
  return err;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function numericIsNegative(text) {
  const value = Number(text);
  return Number.isFinite(value) && value < 0;
}

function numericIsZero(text) {
  return Number(text) === 0;
}

export function parsePositiveInt(raw) {
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw <= 0) return null;
    return raw;
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

export function parsePageLimit(raw) {
  if (raw == null || raw === "") return { value: DEFAULT_PAGE_LIMIT };
  const value = parsePositiveInt(typeof raw === "number" ? String(raw) : raw);
  if (value == null || value > MAX_PAGE_LIMIT) {
    return { error: `limit must be a whole number from 1 to ${MAX_PAGE_LIMIT}` };
  }
  return { value };
}

export function parseCursor(raw) {
  if (raw == null || raw === "") return { value: null };
  const value = parsePositiveInt(typeof raw === "number" ? String(raw) : raw);
  if (value == null) return { error: "before must be a history row id" };
  return { value };
}

function parseQuantity(raw) {
  if (typeof raw === "boolean" || raw == null) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function parseUnitPrice(raw) {
  if (raw == null || raw === "") return { value: null };
  if (typeof raw === "boolean") return { error: "Price must be zero or more." };
  if (typeof raw !== "number" && typeof raw !== "string") {
    return { error: "Price must be zero or more." };
  }
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value) || value < 0) {
    return { error: "Price must be zero or more." };
  }
  return { value };
}

function parseNote(raw) {
  if (raw == null || raw === "") return { value: null };
  if (typeof raw !== "string") return { error: "Note must be text." };
  const text = raw.trim();
  if (!text) return { value: null };
  if (text.length > NOTE_MAX) {
    return { error: `Note must be ${NOTE_MAX} characters or fewer.` };
  }
  return { value: text };
}

export function parseOccurredOn(raw) {
  if (raw == null || raw === "") return { value: null };
  if (typeof raw !== "string") return { error: "Date must be YYYY-MM-DD." };
  const text = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return { error: "Date must be YYYY-MM-DD." };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { error: "Date must be YYYY-MM-DD." };
  }
  return { value: text };
}

export function parseManualTransaction(body) {
  const direction = body?.direction;
  if (direction !== "in" && direction !== "out") {
    return { error: "Direction must be in or out." };
  }
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  const allowed = direction === "in" ? MANUAL_IN : MANUAL_OUT;
  if (!allowed.has(reason)) {
    return { error: "That reason doesn't match this stock change." };
  }
  const quantity = parseQuantity(body?.quantity);
  if (quantity == null) {
    return { error: "Quantity must be greater than zero." };
  }
  const price = parseUnitPrice(body?.unit_price);
  if (price.error) return price;
  const note = parseNote(body?.note);
  if (note.error) return note;
  const occurred = parseOccurredOn(body?.occurred_on);
  if (occurred.error) return occurred;
  return {
    value: {
      direction,
      reason,
      quantity,
      unitPrice: price.value,
      note: note.value,
      occurredOn: occurred.value,
    },
  };
}

export function presentTransaction(row) {
  if (!row) return null;
  const price = row.unit_price == null || row.unit_price === "" ? null : Number(row.unit_price);
  return {
    id: Number(row.id),
    direction: row.direction,
    reason: row.reason,
    quantity: Number(row.quantity),
    quantity_change: Number(row.quantity_change),
    balance_after: Number(row.balance_after),
    unit_price: price,
    unit_of_measure: row.unit_of_measure ?? null,
    note: row.note ?? null,
    occurred_on: dateText(row.occurred_on),
    source: row.source,
    batch_id: row.batch_id == null ? null : Number(row.batch_id),
    purchase_lot_id: row.purchase_lot_id == null ? null : Number(row.purchase_lot_id),
    created_by: row.created_by == null ? null : Number(row.created_by),
    created_by_name: row.created_by_name ?? null,
    created_at: row.created_at ?? null,
  };
}

function dateText(value) {
  if (value == null) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return match ? match[1] : String(value);
}

/**
 * Insert a zero row when this item has no inventory yet, then lock it.
 * Returns the locked quantity as text so later math stays in the database.
 */
export async function lockInventory(db, clientId, itemId) {
  await db.query(
    `INSERT INTO inventory (client_id, item_id, quantity, updated_at)
     VALUES ($1, $2, 0, CURRENT_TIMESTAMP)
     ON CONFLICT (client_id, item_id) DO NOTHING`,
    [clientId, itemId]
  );
  const { rows } = await db.query(
    `SELECT quantity::text AS quantity
     FROM inventory
     WHERE client_id = $1 AND item_id = $2
     FOR UPDATE`,
    [clientId, itemId]
  );
  return rows[0]?.quantity ?? "0";
}

async function signedDelta(db, afterText, beforeText) {
  const { rows } = await db.query(
    `SELECT ($1::numeric - $2::numeric)::text AS applied,
            abs($1::numeric - $2::numeric)::text AS magnitude`,
    [afterText, beforeText]
  );
  return rows[0];
}

async function itemUnit(db, clientId, itemId) {
  const { rows } = await db.query(
    `SELECT unit_of_measure
     FROM items
     WHERE id = $1 AND client_id = $2`,
    [itemId, clientId]
  );
  return rows[0]?.unit_of_measure ?? null;
}

export async function insertInventoryTransaction(db, input) {
  const ready = await inventoryTransactionsReady(db);
  if (!ready) {
    if (input.required) throw unavailable();
    return null;
  }

  const direction = input.direction;
  const reason = input.reason;
  if (input.source === "manual") {
    const allowed = direction === "in" ? MANUAL_IN : MANUAL_OUT;
    if (!allowed.has(reason)) {
      throw badRequest("That reason doesn't match this stock change.");
    }
  } else if (!SYSTEM_REASONS.has(reason)) {
    throw new Error(`Unknown inventory reason: ${reason}`);
  }

  const quantityChange = input.quantityChange;
  if (reason === "unit_change") {
    if (!numericIsZero(quantityChange)) {
      throw new Error("unit_change must not move stock");
    }
  } else if (direction === "out" && !numericIsNegative(quantityChange)) {
    throw new Error("out movement must decrease stock");
  } else if (direction === "in" && (numericIsNegative(quantityChange) || numericIsZero(quantityChange))) {
    throw new Error("in movement must increase stock");
  }

  if (numericIsNegative(input.balanceAfter)) {
    throw badRequest(BELOW_ZERO);
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO inventory_transactions
         (client_id, item_id, direction, reason, quantity, quantity_change,
          balance_after, unit_price, unit_of_measure, note, occurred_on,
          source, batch_id, purchase_lot_id, created_by)
       VALUES
         ($1, $2, $3, $4, $5::numeric, $6::numeric,
          $7::numeric, $8::numeric, $9, $10, COALESCE($11::date, CURRENT_DATE),
          $12, $13, $14, $15)
       RETURNING id, direction, reason,
                 quantity::text AS quantity,
                 quantity_change::text AS quantity_change,
                 balance_after::text AS balance_after,
                 unit_price::text AS unit_price,
                 unit_of_measure, note, occurred_on::text AS occurred_on,
                 source, batch_id, purchase_lot_id, created_by, created_at`,
      [
        input.clientId,
        input.itemId,
        direction,
        reason,
        input.quantity,
        quantityChange,
        input.balanceAfter,
        input.unitPrice ?? null,
        input.unitOfMeasure ?? null,
        input.note ?? null,
        input.occurredOn ?? null,
        input.source,
        input.batchId ?? null,
        input.purchaseLotId ?? null,
        input.userId ?? null,
      ]
    );
    return rows[0];
  } catch (err) {
    if (err?.code === "42P01") {
      transactionsReady = null;
      if (input.required) throw unavailable();
      return null;
    }
    throw err;
  }
}

/**
 * Add a signed delta and clamp at zero. Returns null when nothing changed.
 * The logged amount is the change that was stored, which can be smaller
 * than delta when stock would have gone below zero.
 */
export async function recordStockDelta(db, input) {
  const amount = Number(input.delta);
  if (!Number.isFinite(amount) || amount === 0) return null;

  const beforeText = await lockInventory(db, input.clientId, input.itemId);
  const { rows } = await db.query(
    `UPDATE inventory
     SET quantity = GREATEST(0::numeric, quantity + $3::numeric),
         updated_at = CURRENT_TIMESTAMP
     WHERE client_id = $1 AND item_id = $2
     RETURNING quantity::text AS quantity`,
    [input.clientId, input.itemId, amount]
  );
  const balanceText = rows[0]?.quantity ?? "0";
  const diff = await signedDelta(db, balanceText, beforeText);
  if (numericIsZero(diff.applied)) return null;

  const direction = numericIsNegative(diff.applied) ? "out" : "in";
  const unit =
    input.unitOfMeasure === undefined
      ? await itemUnit(db, input.clientId, input.itemId)
      : input.unitOfMeasure;

  return insertInventoryTransaction(db, {
    clientId: input.clientId,
    itemId: input.itemId,
    direction,
    reason: input.reason,
    quantity: diff.magnitude,
    quantityChange: diff.applied,
    balanceAfter: balanceText,
    unitPrice: input.unitPrice ?? null,
    unitOfMeasure: unit,
    note: input.note ?? null,
    occurredOn: input.occurredOn ?? null,
    source: input.source,
    batchId: input.batchId ?? null,
    purchaseLotId: input.purchaseLotId ?? null,
    userId: input.userId ?? null,
    required: false,
  });
}

/**
 * Replace on-hand quantity. A zero change updates the timestamp and writes
 * no history row.
 */
export async function recordAbsoluteQuantity(db, input) {
  const beforeText = await lockInventory(db, input.clientId, input.itemId);
  const { rows } = await db.query(
    `UPDATE inventory
     SET quantity = $3::numeric,
         updated_at = CURRENT_TIMESTAMP
     WHERE client_id = $1 AND item_id = $2
     RETURNING quantity::text AS quantity`,
    [input.clientId, input.itemId, input.quantity]
  );
  const balanceText = rows[0]?.quantity ?? "0";
  const diff = await signedDelta(db, balanceText, beforeText);
  if (numericIsZero(diff.applied)) {
    return { balanceText, transaction: null };
  }
  const direction = numericIsNegative(diff.applied) ? "out" : "in";
  const transaction = await insertInventoryTransaction(db, {
    clientId: input.clientId,
    itemId: input.itemId,
    direction,
    reason: "adjustment",
    quantity: diff.magnitude,
    quantityChange: diff.applied,
    balanceAfter: balanceText,
    unitOfMeasure: input.unitOfMeasure ?? null,
    source: "edit",
    userId: input.userId ?? null,
    required: false,
  });
  return { balanceText, transaction };
}

/**
 * Manual add or remove. Rejects an out that would pass below zero.
 * Caller holds the transaction open and has already confirmed the table exists.
 */
export async function applyManualTransaction(db, input) {
  const beforeText = await lockInventory(db, input.clientId, input.itemId);
  const signed = input.direction === "in" ? input.quantity : -input.quantity;
  const { rows: math } = await db.query(
    `SELECT ($1::numeric + $2::numeric)::text AS after`,
    [beforeText, signed]
  );
  const afterText = math[0]?.after ?? beforeText;
  if (numericIsNegative(afterText)) {
    throw badRequest(BELOW_ZERO);
  }
  if (input.occurredOn) {
    const { rows: todayRows } = await db.query(
      `SELECT CURRENT_DATE::text AS today`
    );
    const today = todayRows[0]?.today;
    if (typeof today === "string" && input.occurredOn > today) {
      throw badRequest("Date can't be in the future.");
    }
  }
  await db.query(
    `UPDATE inventory
     SET quantity = $3::numeric,
         updated_at = CURRENT_TIMESTAMP
     WHERE client_id = $1 AND item_id = $2`,
    [input.clientId, input.itemId, afterText]
  );
  const diff = await signedDelta(db, afterText, beforeText);
  const row = await insertInventoryTransaction(db, {
    clientId: input.clientId,
    itemId: input.itemId,
    direction: input.direction,
    reason: input.reason,
    quantity: diff.magnitude,
    quantityChange: diff.applied,
    balanceAfter: afterText,
    unitPrice: input.unitPrice,
    unitOfMeasure: input.unitOfMeasure ?? null,
    note: input.note,
    occurredOn: input.occurredOn,
    source: "manual",
    userId: input.userId,
    required: true,
  });
  const { rows: names } = await db.query(
    `SELECT name
     FROM users
     WHERE id = $1 AND client_id = $2`,
    [input.userId, input.clientId]
  );
  return {
    balanceText: afterText,
    transaction: { ...row, created_by_name: names[0]?.name ?? null },
  };
}

const MULTIPLY_SQL = `
  UPDATE inventory_transactions
  SET quantity = quantity * $1::numeric,
      quantity_change = quantity_change * $1::numeric,
      balance_after = balance_after * $1::numeric,
      unit_price = CASE
        WHEN unit_price IS NULL THEN NULL
        ELSE unit_price / $1::numeric
      END,
      unit_of_measure = $2
  WHERE client_id = $3 AND item_id = $4`;

const DIVIDE_SQL = `
  UPDATE inventory_transactions
  SET quantity = quantity / $1::numeric,
      quantity_change = quantity_change / $1::numeric,
      balance_after = balance_after / $1::numeric,
      unit_price = CASE
        WHEN unit_price IS NULL THEN NULL
        ELSE unit_price * $1::numeric
      END,
      unit_of_measure = $2
  WHERE client_id = $3 AND item_id = $4`;

/**
 * Restate existing history into the new stock unit.
 * Same-kind changes multiply quantities (and divide a per-unit price).
 * Cross-kind changes divide quantities by the caller's factor.
 * A unit_change note is written only when at least one earlier row was restated.
 */
export async function restateInventoryHistory(db, input) {
  if (!(await inventoryTransactionsReady(db))) return { restated: 0 };
  const sql = input.mode === "divide" ? DIVIDE_SQL : MULTIPLY_SQL;
  const updated = await db.query(sql, [
    input.factor,
    input.nextUnit,
    input.clientId,
    input.itemId,
  ]);
  if (!updated.rowCount) return { restated: 0 };

  const { rows } = await db.query(
    `SELECT quantity::text AS quantity
     FROM inventory
     WHERE client_id = $1 AND item_id = $2`,
    [input.clientId, input.itemId]
  );
  const balanceText = rows[0]?.quantity ?? "0";
  const quantityText = Number(balanceText) > 0 ? balanceText : "1";
  const fromLabel = spokenUnit(input.fromUnit) || input.fromUnit;
  const toLabel = spokenUnit(input.nextUnit) || input.nextUnit;
  await insertInventoryTransaction(db, {
    clientId: input.clientId,
    itemId: input.itemId,
    direction: "in",
    reason: "unit_change",
    quantity: quantityText,
    quantityChange: "0",
    balanceAfter: balanceText,
    unitOfMeasure: input.nextUnit,
    note: `Unit changed from ${fromLabel} to ${toLabel}. Earlier amounts in this history were restated.`,
    source: "unit_change",
    userId: input.userId ?? null,
    required: false,
  });
  return { restated: updated.rowCount };
}
