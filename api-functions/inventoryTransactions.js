import { pool } from "../lib/db.js";
import { loadInventoryItem, loadInventoryView } from "./inventory.js";
import {
  HISTORY_UNAVAILABLE,
  applyManualTransaction,
  inventoryTransactionsReady,
  parseCursor,
  parseManualTransaction,
  parsePageLimit,
  parsePositiveInt,
  presentTransaction,
  resetInventoryTransactionsForTests,
} from "../lib/inventoryTransactions.js";

function emptyPage() {
  return { transactions: [], has_more: false, next_before: null };
}

export async function listInventoryTransactions(req, res) {
  const itemId = parsePositiveInt(req.params?.id);
  if (!itemId) return res.status(400).json({ error: "Invalid item id" });

  const limit = parsePageLimit(req.query?.limit);
  if (limit.error) return res.status(400).json({ error: limit.error });
  const before = parseCursor(req.query?.before);
  if (before.error) return res.status(400).json({ error: before.error });

  const { clientId } = req.auth;
  try {
    const item = await loadInventoryItem(pool, itemId, clientId);
    if (!item) return res.status(404).json({ error: "Item not found" });

    if (!(await inventoryTransactionsReady(pool))) return res.json(emptyPage());

    if (before.value != null) {
      const cursor = await pool.query(
        `SELECT 1
         FROM inventory_transactions
         WHERE id = $1 AND client_id = $2 AND item_id = $3`,
        [before.value, clientId, itemId]
      );
      if (cursor.rows.length === 0) {
        return res.status(400).json({
          error: "That page marker is not in this item's history.",
        });
      }
    }

    const params = [clientId, itemId];
    let cursorSql = "";
    if (before.value != null) {
      params.push(before.value);
      cursorSql = `AND (t.occurred_on, t.id) < (
           SELECT c.occurred_on, c.id
           FROM inventory_transactions c
           WHERE c.id = $${params.length}
             AND c.client_id = $1
             AND c.item_id = $2
         )`;
    }
    params.push(limit.value + 1);
    const { rows } = await pool.query(
      `SELECT t.id,
              t.direction,
              t.reason,
              t.quantity::text AS quantity,
              t.quantity_change::text AS quantity_change,
              t.balance_after::text AS balance_after,
              t.unit_price::text AS unit_price,
              t.unit_of_measure,
              t.note,
              t.occurred_on::text AS occurred_on,
              t.source,
              t.batch_id,
              t.purchase_lot_id,
              t.created_by,
              t.created_at,
              u.name AS created_by_name
       FROM inventory_transactions t
       LEFT JOIN users u
         ON u.id = t.created_by
        AND u.client_id = t.client_id
       WHERE t.client_id = $1
         AND t.item_id = $2
         ${cursorSql}
       ORDER BY t.occurred_on DESC, t.id DESC
       LIMIT $${params.length}`,
      params
    );

    const hasMore = rows.length > limit.value;
    const page = hasMore ? rows.slice(0, limit.value) : rows;
    const transactions = page.map((row) => presentTransaction(row));
    res.json({
      transactions,
      has_more: hasMore,
      next_before: hasMore ? transactions[transactions.length - 1].id : null,
    });
  } catch (err) {
    if (err?.code === "42P01") {
      resetInventoryTransactionsForTests();
      return res.json(emptyPage());
    }
    console.error(err);
    res.status(500).json({ error: "Failed to fetch stock history" });
  }
}

export async function createInventoryTransaction(req, res) {
  const itemId = parsePositiveInt(req.params?.id);
  if (!itemId) return res.status(400).json({ error: "Invalid item id" });

  const parsed = parseManualTransaction(req.body ?? {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  if (!(await inventoryTransactionsReady(pool))) {
    return res.status(503).json({ error: HISTORY_UNAVAILABLE });
  }

  const { clientId, userId } = req.auth;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const item = await loadInventoryItem(db, itemId, clientId);
    if (!item) {
      await db.query("ROLLBACK");
      return res.status(404).json({ error: "Item not found" });
    }

    const applied = await applyManualTransaction(db, {
      clientId,
      itemId,
      userId,
      unitOfMeasure: item.unit_of_measure ?? null,
      ...parsed.value,
    });
    const inventory = await loadInventoryView(db, clientId, itemId);
    await db.query("COMMIT");
    res.status(201).json({
      inventory,
      transaction: presentTransaction(applied.transaction),
    });
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch {
      // The change was already committed, or the connection dropped.
    }
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Failed to record the stock change" });
  } finally {
    db.release();
  }
}
