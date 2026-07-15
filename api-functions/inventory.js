import { pool } from "../lib/db.js";
import { isMakeItem } from "../lib/productionTree.js";

function stockStatus(quantity, goalMin, goalMax) {
  if (goalMin == null || goalMax == null) return null;
  const qty = Number(quantity);
  const min = Number(goalMin);
  const max = Number(goalMax);
  if (!Number.isFinite(qty) || !Number.isFinite(min) || !Number.isFinite(max)) {
    return null;
  }
  if (qty < min) return "below";
  if (qty > max) return "above";
  return "on_track";
}

async function loadItemForClient(db, itemId, clientId) {
  const { rows } = await db.query(
    `SELECT id, make_or_buy, unit_of_measure
     FROM items
     WHERE id = $1 AND client_id = $2`,
    [itemId, clientId]
  );
  return rows[0] ?? null;
}

async function getCurrentQuantity(db, clientId, itemId) {
  const { rows } = await db.query(
    `SELECT quantity FROM inventory
     WHERE client_id = $1 AND item_id = $2`,
    [clientId, itemId]
  );
  return rows.length > 0 ? Number(rows[0].quantity) : 0;
}

async function getOpenBatchDelta(db, clientId, itemId, make) {
  if (make) {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(quantity), 0) AS total
       FROM batches
       WHERE client_id = $1
         AND item_id = $2
         AND status IN ('planned', 'in_progress')`,
      [clientId, itemId]
    );
    return Number(rows[0].total);
  }

  const { rows } = await db.query(
    `SELECT COALESCE(SUM(bc.quantity_allocated), 0) AS total
     FROM batch_components bc
     JOIN batches b ON b.id = bc.batch_id
     WHERE b.client_id = $1
       AND bc.item_id = $2
       AND b.status IN ('planned', 'in_progress')`,
    [clientId, itemId]
  );
  return -Number(rows[0].total);
}

async function getGoals(db, clientId, itemId) {
  const { rows } = await db.query(
    `SELECT goal_min, goal_max
     FROM item_inventory_goals
     WHERE client_id = $1 AND item_id = $2`,
    [clientId, itemId]
  );
  if (rows.length === 0) {
    return { goal_min: null, goal_max: null };
  }
  return {
    goal_min: Number(rows[0].goal_min),
    goal_max: Number(rows[0].goal_max),
  };
}

function buildInventoryPayload(item, quantity, plannedDelta, goals) {
  const plannedQuantity = quantity + plannedDelta;
  return {
    quantity,
    unit_of_measure: item.unit_of_measure ?? null,
    planned_quantity: plannedQuantity,
    planned_delta: plannedDelta,
    goal_min: goals.goal_min,
    goal_max: goals.goal_max,
    status: stockStatus(quantity, goals.goal_min, goals.goal_max),
    planned_status: stockStatus(
      plannedQuantity,
      goals.goal_min,
      goals.goal_max
    ),
  };
}

export async function getInventoryList(req, res) {
  const { clientId } = req.auth;

  try {
    const { rows } = await pool.query(
      `SELECT
         i.id AS item_id,
         i.name AS item_name,
         i.make_or_buy,
         i.unit_of_measure,
         i.active,
         COALESCE(inv.quantity, 0) AS quantity,
         g.goal_min,
         g.goal_max,
         COALESCE(make_delta.total, 0) AS make_open_qty,
         COALESCE(buy_delta.total, 0) AS buy_open_qty
       FROM items i
       LEFT JOIN inventory inv
         ON inv.item_id = i.id AND inv.client_id = i.client_id
       LEFT JOIN item_inventory_goals g
         ON g.item_id = i.id AND g.client_id = i.client_id
       LEFT JOIN (
         SELECT item_id, SUM(quantity) AS total
         FROM batches
         WHERE client_id = $1
           AND status IN ('planned', 'in_progress')
         GROUP BY item_id
       ) make_delta ON make_delta.item_id = i.id
       LEFT JOIN (
         SELECT bc.item_id, SUM(bc.quantity_allocated) AS total
         FROM batch_components bc
         JOIN batches b ON b.id = bc.batch_id
         WHERE b.client_id = $1
           AND b.status IN ('planned', 'in_progress')
         GROUP BY bc.item_id
       ) buy_delta ON buy_delta.item_id = i.id
       WHERE i.client_id = $1
       ORDER BY i.name ASC`,
      [clientId]
    );

    const list = rows.map((row) => {
      const make = isMakeItem(row.make_or_buy);
      const quantity = Number(row.quantity);
      const plannedDelta = make
        ? Number(row.make_open_qty)
        : -Number(row.buy_open_qty);
      const goals = {
        goal_min: row.goal_min == null ? null : Number(row.goal_min),
        goal_max: row.goal_max == null ? null : Number(row.goal_max),
      };
      return {
        item_id: row.item_id,
        item_name: row.item_name,
        make_or_buy: row.make_or_buy,
        active: row.active,
        ...buildInventoryPayload(
          { unit_of_measure: row.unit_of_measure },
          quantity,
          plannedDelta,
          goals
        ),
      };
    });

    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch inventory list" });
  }
}

export async function getItemInventory(req, res) {
  const { id } = req.params;
  const { clientId } = req.auth;
  const itemId = Number(id);

  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: "Invalid item id" });
  }

  try {
    const item = await loadItemForClient(pool, itemId, clientId);
    if (!item) {
      return res.status(404).json({ error: "Item not found" });
    }

    const make = isMakeItem(item.make_or_buy);
    const [quantity, plannedDelta, goals] = await Promise.all([
      getCurrentQuantity(pool, clientId, itemId),
      getOpenBatchDelta(pool, clientId, itemId, make),
      getGoals(pool, clientId, itemId),
    ]);

    res.json(buildInventoryPayload(item, quantity, plannedDelta, goals));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch inventory" });
  }
}

export async function updateItemInventory(req, res) {
  const { id } = req.params;
  const { clientId } = req.auth;
  const itemId = Number(id);
  const quantity = Number(req.body?.quantity);

  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: "Invalid item id" });
  }
  if (!Number.isFinite(quantity) || quantity < 0) {
    return res.status(400).json({ error: "quantity must be a non-negative number" });
  }

  try {
    const item = await loadItemForClient(pool, itemId, clientId);
    if (!item) {
      return res.status(404).json({ error: "Item not found" });
    }

    await pool.query(
      `INSERT INTO inventory (client_id, item_id, quantity, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (client_id, item_id)
       DO UPDATE SET quantity = EXCLUDED.quantity,
                     updated_at = CURRENT_TIMESTAMP`,
      [clientId, itemId, quantity]
    );

    const make = isMakeItem(item.make_or_buy);
    const [plannedDelta, goals] = await Promise.all([
      getOpenBatchDelta(pool, clientId, itemId, make),
      getGoals(pool, clientId, itemId),
    ]);

    res.json(buildInventoryPayload(item, quantity, plannedDelta, goals));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update inventory" });
  }
}

export async function updateItemInventoryGoal(req, res) {
  const { id } = req.params;
  const { clientId, userId } = req.auth;
  const itemId = Number(id);
  const goalMin = Number(req.body?.goal_min);
  const goalMax = Number(req.body?.goal_max);

  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: "Invalid item id" });
  }
  if (!Number.isFinite(goalMin) || goalMin < 0) {
    return res.status(400).json({ error: "goal_min must be a non-negative number" });
  }
  if (!Number.isFinite(goalMax) || goalMax < goalMin) {
    return res
      .status(400)
      .json({ error: "goal_max must be greater than or equal to goal_min" });
  }

  try {
    const item = await loadItemForClient(pool, itemId, clientId);
    if (!item) {
      return res.status(404).json({ error: "Item not found" });
    }

    await pool.query(
      `INSERT INTO item_inventory_goals
         (client_id, item_id, goal_min, goal_max, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (item_id)
       DO UPDATE SET goal_min = EXCLUDED.goal_min,
                     goal_max = EXCLUDED.goal_max,
                     client_id = EXCLUDED.client_id,
                     updated_by = EXCLUDED.updated_by,
                     updated_at = CURRENT_TIMESTAMP`,
      [clientId, itemId, goalMin, goalMax, userId]
    );

    const make = isMakeItem(item.make_or_buy);
    const [quantity, plannedDelta] = await Promise.all([
      getCurrentQuantity(pool, clientId, itemId),
      getOpenBatchDelta(pool, clientId, itemId, make),
    ]);

    res.json(
      buildInventoryPayload(item, quantity, plannedDelta, {
        goal_min: goalMin,
        goal_max: goalMax,
      })
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update inventory goal" });
  }
}
