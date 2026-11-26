import { pool } from "../lib/db.js";
import { isMakeItem } from "../lib/productionTree.js";
import { recordStockDelta } from "../lib/inventoryTransactions.js";

const lotSelect = `
  SELECT
    pl.id,
    pl.client_id,
    pl.item_id,
    pl.lot_number,
    pl.quantity,
    pl.total_cost,
    pl.unit_cost,
    pl.arrival_date,
    pl.received_at,
    pl.created_by,
    pl.created_at
  FROM purchase_lots pl
`;

function parseArrivalDate(raw) {
  if (raw == null || raw === "") return null;
  const text = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return text;
}

async function loadBuyItem(db, itemId, clientId) {
  const { rows } = await db.query(
    `SELECT id, make_or_buy, unit_of_measure, unit_cost, default_unit_price
     FROM items
     WHERE id = $1 AND client_id = $2`,
    [itemId, clientId]
  );
  const item = rows[0] ?? null;
  if (!item) return null;
  if (isMakeItem(item.make_or_buy)) {
    throw Object.assign(new Error("Purchase lots are only for buy items"), {
      status: 400,
    });
  }
  return item;
}

async function syncItemUnitCostFromLots(dbClient, clientId, itemId) {
  const { rows } = await dbClient.query(
    `SELECT unit_cost
     FROM purchase_lots
     WHERE client_id = $1 AND item_id = $2
     ORDER BY arrival_date DESC, id DESC
     LIMIT 1`,
    [clientId, itemId]
  );
  if (rows.length === 0) return null;

  const unitCost = Number(rows[0].unit_cost);
  await dbClient.query(
    `UPDATE items
     SET unit_cost = $1,
         default_unit_price = $1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND client_id = $3`,
    [unitCost, itemId, clientId]
  );
  return unitCost;
}

export async function getPurchaseLotsForItem(req, res) {
  const { id } = req.params;
  const { clientId } = req.auth;
  const itemId = Number(id);

  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: "Invalid item id" });
  }

  try {
    const item = await loadBuyItem(pool, itemId, clientId);
    if (!item) {
      return res.status(404).json({ error: "Item not found" });
    }

    const { rows } = await pool.query(
      `${lotSelect}
       WHERE pl.client_id = $1 AND pl.item_id = $2
       ORDER BY pl.arrival_date DESC, pl.id DESC`,
      [clientId, itemId]
    );
    res.json(rows);
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to fetch purchase lots" });
  }
}

export async function createPurchaseLot(req, res) {
  const { id } = req.params;
  const { clientId, userId } = req.auth;
  const itemId = Number(id);
  const lotNumber =
    req.body?.lot_number == null ? "" : String(req.body.lot_number).trim();
  const quantity = Number(req.body?.quantity);
  // Prefer total_cost (amount paid for the receive). Fall back to legacy unit_cost.
  const hasTotal =
    req.body?.total_cost !== undefined && req.body?.total_cost !== null;
  const totalCost = hasTotal
    ? Number(req.body.total_cost)
    : Number(req.body?.unit_cost) * quantity;
  const arrivalDate =
    parseArrivalDate(req.body?.arrival_date) ??
    new Date().toISOString().slice(0, 10);

  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: "Invalid item id" });
  }
  if (!lotNumber) {
    return res.status(400).json({ error: "Vendor lot # is required" });
  }
  if (req.body?.arrival_date != null && req.body.arrival_date !== "") {
    if (!parseArrivalDate(req.body.arrival_date)) {
      return res
        .status(400)
        .json({ error: "arrival_date must be YYYY-MM-DD" });
    }
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ error: "quantity must be a positive number" });
  }
  if (!Number.isFinite(totalCost) || totalCost < 0) {
    return res
      .status(400)
      .json({ error: "total_cost must be a non-negative number" });
  }

  const unitCost = totalCost / quantity;

  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

    const item = await loadBuyItem(dbClient, itemId, clientId);
    if (!item) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Item not found" });
    }

    const { rows } = await dbClient.query(
      `INSERT INTO purchase_lots
         (client_id, item_id, lot_number, quantity, total_cost, unit_cost,
          arrival_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8)
       RETURNING id, client_id, item_id, lot_number, quantity, total_cost, unit_cost,
                 arrival_date, received_at, created_by, created_at`,
      [
        clientId,
        itemId,
        lotNumber,
        quantity,
        totalCost,
        unitCost,
        arrivalDate,
        userId,
      ]
    );

    await recordStockDelta(dbClient, {
      clientId,
      itemId,
      delta: quantity,
      reason: "received",
      source: "purchase_lot",
      purchaseLotId: rows[0].id,
      userId,
      unitOfMeasure: item.unit_of_measure ?? null,
      occurredOn: arrivalDate,
      note: `Received vendor lot ${lotNumber}`,
    });
    await dbClient.query(
      `UPDATE items
       SET unit_cost = $1,
           default_unit_price = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND client_id = $3`,
      [unitCost, itemId, clientId]
    );

    await dbClient.query("COMMIT");
    res.status(201).json(rows[0]);
  } catch (err) {
    await dbClient.query("ROLLBACK");
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to receive purchase lot" });
  } finally {
    dbClient.release();
  }
}

export async function deletePurchaseLot(req, res) {
  const { id, lotId } = req.params;
  const { clientId } = req.auth;
  const itemId = Number(id);
  const purchaseLotId = Number(lotId);

  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: "Invalid item id" });
  }
  if (!Number.isInteger(purchaseLotId) || purchaseLotId <= 0) {
    return res.status(400).json({ error: "Invalid lot id" });
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

    const item = await loadBuyItem(dbClient, itemId, clientId);
    if (!item) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Item not found" });
    }

    const { rows: owned } = await dbClient.query(
      `SELECT id, quantity, lot_number
       FROM purchase_lots
       WHERE id = $1 AND item_id = $2 AND client_id = $3
       FOR UPDATE`,
      [purchaseLotId, itemId, clientId]
    );
    if (owned.length === 0) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Purchase lot not found" });
    }

    const qty = Number(owned[0].quantity);
    const lotNumber = owned[0].lot_number ? String(owned[0].lot_number) : "";
    // Write the row before the lot is deleted. The foreign key then clears
    // purchase_lot_id, and the note keeps the vendor lot number.
    await recordStockDelta(dbClient, {
      clientId,
      itemId,
      delta: -qty,
      reason: "adjustment",
      source: "purchase_lot",
      purchaseLotId,
      userId: req.auth.userId,
      unitOfMeasure: item.unit_of_measure ?? null,
      note: lotNumber ? `Removed vendor lot ${lotNumber}` : "Removed a vendor lot",
    });
    await dbClient.query(
      `DELETE FROM purchase_lots WHERE id = $1 AND client_id = $2`,
      [purchaseLotId, clientId]
    );
    await syncItemUnitCostFromLots(dbClient, clientId, itemId);

    await dbClient.query("COMMIT");
    res.status(204).end();
  } catch (err) {
    await dbClient.query("ROLLBACK");
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to delete purchase lot" });
  } finally {
    dbClient.release();
  }
}
