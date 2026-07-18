import { pool } from "../lib/db.js";
import { expandProductionTree, isMakeItem } from "../lib/productionTree.js";

const batchesSelect = `
  SELECT b.*,
    i.name AS item_name,
    i.unit_of_measure AS item_unit_of_measure,
    COALESCE(b.sku, (SELECT s.sku FROM item_skus s WHERE s.batch_id = b.id LIMIT 1)) AS sku,
    COALESCE(
      (SELECT json_agg(json_build_object(
        'id', p.id,
        'sequence', p.sequence,
        'name', p.name,
        'description', p.description,
        'source_phase_id', p.source_phase_id,
        'source_item_id', p.source_item_id,
        'source_item_name', p.source_item_name,
        'source_item_qty', p.source_item_qty,
        'group_order', p.group_order,
        'status', p.status,
        'started_at', p.started_at,
        'completed_at', p.completed_at)
        ORDER BY COALESCE(p.group_order, 0), p.sequence)
       FROM batch_phases p WHERE p.batch_id = b.id),
      '[]'::json
    ) AS phases,
    COALESCE(
      (SELECT json_agg(json_build_object(
        'id', bc.id,
        'item_id', bc.item_id,
        'quantity_allocated', bc.quantity_allocated,
        'name', ci.name,
        'make_or_buy', ci.make_or_buy,
        'unit_of_measure', ci.unit_of_measure)
        ORDER BY ci.name)
       FROM batch_components bc
       JOIN items ci ON ci.id = bc.item_id
       WHERE bc.batch_id = b.id),
      '[]'::json
    ) AS components
  FROM batches b
  JOIN items i ON i.id = b.item_id
`;

const VALID_PHASE_STATUSES = ["pending", "in_progress", "complete", "skipped"];

async function syncBatchStatus(dbClient, batchId) {
  const { rows: batchRows } = await dbClient.query(
    `SELECT status FROM batches WHERE id = $1`,
    [batchId]
  );
  if (batchRows.length === 0) return;
  if (batchRows[0].status === "cancelled") return;

  const { rows } = await dbClient.query(
    `SELECT status FROM batch_phases WHERE batch_id = $1 ORDER BY sequence`,
    [batchId]
  );

  if (rows.length === 0) return;

  const allDone = rows.every(
    (row) => row.status === "complete" || row.status === "skipped"
  );
  const anyStarted = rows.some(
    (row) => row.status === "in_progress" || row.status === "complete"
  );

  let batchStatus = "planned";
  // All phases done still means floor work finished — batch stays open until
  // master Complete posts inventory and locks the batch.
  if (allDone || anyStarted) batchStatus = "in_progress";

  await dbClient.query(
    `UPDATE batches
     SET status = $1,
         start_date = CASE WHEN $1 = 'in_progress' AND start_date IS NULL THEN CURRENT_TIMESTAMP ELSE start_date END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2
       AND status NOT IN ('complete', 'cancelled')`,
    [batchStatus, batchId]
  );
}

async function insertPhaseGroups(dbClient, batchId, phaseGroups) {
  let globalSequence = 0;
  let groupOrder = 0;
  for (const group of phaseGroups) {
    groupOrder += 1;
    for (const phase of group.phases) {
      globalSequence += 1;
      await dbClient.query(
        `INSERT INTO batch_phases
           (batch_id, sequence, name, description, source_phase_id, status,
            source_item_id, source_item_name, source_item_qty, group_order)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9)`,
        [
          batchId,
          globalSequence,
          phase.name,
          phase.description,
          phase.id,
          group.item_id,
          group.name,
          group.quantity,
          groupOrder,
        ]
      );
    }
  }
}

/**
 * Older batches only snapshotted the root router. When still fully pending,
 * rebuild phases from the current nested make BOM so children appear.
 */
async function maybeRebuildNestedPhases(dbClient, clientId, batch) {
  if (batch.status === "cancelled" || batch.status === "complete") return false;
  const phases = Array.isArray(batch.phases) ? batch.phases : [];
  if (phases.length === 0) return false;
  if (phases.some((phase) => phase.status !== "pending")) return false;

  const sourceIds = new Set(
    phases
      .map((phase) => phase.source_item_id)
      .filter((id) => id != null)
      .map(String)
  );

  const { phaseGroups } = await expandProductionTree(
    dbClient,
    clientId,
    batch.item_id,
    Number(batch.quantity)
  );

  if (phaseGroups.length <= 1) return false;

  const treeIds = new Set(phaseGroups.map((group) => String(group.item_id)));
  const missingChildren = [...treeIds].some((id) => !sourceIds.has(id));
  if (!missingChildren && sourceIds.size >= treeIds.size) return false;

  await dbClient.query("DELETE FROM batch_phases WHERE batch_id = $1", [
    batch.id,
  ]);
  await insertPhaseGroups(dbClient, batch.id, phaseGroups);
  return true;
}

export async function getBatches(req, res) {
  const { clientId } = req.auth;
  try {
    const { rows } = await pool.query(
      `${batchesSelect} WHERE b.client_id = $1 ORDER BY b.created_at DESC`,
      [clientId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch batches" });
  }
}

export async function getBatchById(req, res) {
  const { id } = req.params;
  const { clientId } = req.auth;

  try {
    let { rows } = await pool.query(
      `${batchesSelect} WHERE b.id = $1 AND b.client_id = $2`,
      [id, clientId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Batch not found" });
    }

    const dbClient = await pool.connect();
    try {
      await dbClient.query("BEGIN");
      const rebuilt = await maybeRebuildNestedPhases(
        dbClient,
        clientId,
        rows[0]
      );
      if (rebuilt) {
        await dbClient.query("COMMIT");
        ({ rows } = await pool.query(
          `${batchesSelect} WHERE b.id = $1 AND b.client_id = $2`,
          [id, clientId]
        ));
      } else {
        await dbClient.query("ROLLBACK");
      }
    } catch (err) {
      await dbClient.query("ROLLBACK");
      throw err;
    } finally {
      dbClient.release();
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch batch" });
  }
}

export async function createBatch(req, res) {
  const { item_id, quantity, sku } = req.body;
  const { clientId, userId } = req.auth;

  const itemId = Number(item_id);
  const qty = Number(quantity);
  const lotSku = sku == null ? "" : String(sku).trim();

  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: "item_id is required" });
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: "quantity must be greater than zero" });
  }
  if (!lotSku) {
    return res.status(400).json({ error: "SKU is required" });
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

    const { rows: itemRows } = await dbClient.query(
      "SELECT id, make_or_buy FROM items WHERE id = $1 AND client_id = $2",
      [itemId, clientId]
    );

    if (itemRows.length === 0) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Item not found" });
    }

    if (!isMakeItem(itemRows[0].make_or_buy)) {
      await dbClient.query("ROLLBACK");
      return res.status(400).json({ error: "Batches can only be created for make items" });
    }

    const { rows: batchRows } = await dbClient.query(
      `INSERT INTO batches (client_id, item_id, quantity, sku, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'planned', $5, $5)
       RETURNING *`,
      [clientId, itemId, qty, lotSku, userId]
    );
    const batch = batchRows[0];

    const { needs, phaseGroups } = await expandProductionTree(
      dbClient,
      clientId,
      itemId,
      qty
    );

    await insertPhaseGroups(dbClient, batch.id, phaseGroups);

    for (const need of needs) {
      await dbClient.query(
        `INSERT INTO batch_components (batch_id, item_id, quantity_allocated)
         VALUES ($1, $2, $3)`,
        [batch.id, need.item_id, need.quantity]
      );
    }

    await dbClient.query(
      `INSERT INTO item_skus (client_id, item_id, sku, batch_id, source)
       VALUES ($1, $2, $3, $4, 'production')`,
      [clientId, itemId, lotSku, batch.id]
    );

    await dbClient.query("COMMIT");

    const { rows } = await pool.query(
      `${batchesSelect} WHERE b.id = $1`,
      [batch.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    await dbClient.query("ROLLBACK");
    console.error(err);
    if (err.status === 404) {
      return res.status(404).json({ error: err.message });
    }
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === "23505") {
      return res.status(409).json({ error: "That SKU is already in use" });
    }
    res.status(500).json({ error: "Failed to create batch" });
  } finally {
    dbClient.release();
  }
}

export async function cancelBatch(req, res) {
  const { id: batchId } = req.params;
  const { clientId, userId } = req.auth;

  try {
    const { rows: owned } = await pool.query(
      `SELECT id, status FROM batches WHERE id = $1 AND client_id = $2`,
      [batchId, clientId]
    );
    if (owned.length === 0) {
      return res.status(404).json({ error: "Batch not found" });
    }
    if (owned[0].status === "complete") {
      return res.status(400).json({ error: "Completed batches cannot be cancelled" });
    }
    if (owned[0].status === "cancelled") {
      const { rows } = await pool.query(
        `${batchesSelect} WHERE b.id = $1 AND b.client_id = $2`,
        [batchId, clientId]
      );
      return res.json(rows[0]);
    }

    const { rows: updated } = await pool.query(
      `UPDATE batches
       SET status = 'cancelled',
           end_date = CURRENT_TIMESTAMP,
           updated_by = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND client_id = $3
       RETURNING id`,
      [userId, batchId, clientId]
    );
    if (updated.length === 0) {
      return res.status(404).json({ error: "Batch not found" });
    }

    const { rows } = await pool.query(
      `${batchesSelect} WHERE b.id = $1 AND b.client_id = $2`,
      [batchId, clientId]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to cancel batch" });
  }
}

async function adjustInventoryQuantity(dbClient, clientId, itemId, delta) {
  const amount = Number(delta);
  if (!Number.isFinite(amount) || amount === 0) return;

  await dbClient.query(
    `INSERT INTO inventory (client_id, item_id, quantity, updated_at)
     VALUES ($1, $2, GREATEST(0, $3), CURRENT_TIMESTAMP)
     ON CONFLICT (client_id, item_id)
     DO UPDATE SET quantity = GREATEST(0, inventory.quantity + $3),
                   updated_at = CURRENT_TIMESTAMP`,
    [clientId, itemId, amount]
  );
}

/**
 * Master complete: lock batch, post inventory once.
 * - Credits finished item by batch.quantity
 * - Debits buy component allocations (nested make lines are production steps, not stock pulls)
 */
export async function completeBatch(req, res) {
  const { id: batchId } = req.params;
  const { clientId, userId } = req.auth;
  const id = Number(batchId);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid batch id" });
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

    const { rows: owned } = await dbClient.query(
      `SELECT id, item_id, quantity, status, inventory_posted
       FROM batches
       WHERE id = $1 AND client_id = $2
       FOR UPDATE`,
      [id, clientId]
    );
    if (owned.length === 0) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Batch not found" });
    }

    const batch = owned[0];
    if (batch.status === "cancelled") {
      await dbClient.query("ROLLBACK");
      return res.status(400).json({ error: "Cancelled batches cannot be completed" });
    }
    if (batch.status === "complete" || batch.inventory_posted) {
      await dbClient.query("ROLLBACK");
      const { rows } = await pool.query(
        `${batchesSelect} WHERE b.id = $1 AND b.client_id = $2`,
        [id, clientId]
      );
      return res.json(rows[0]);
    }

    const { rows: phases } = await dbClient.query(
      `SELECT status FROM batch_phases WHERE batch_id = $1`,
      [id]
    );
    if (phases.length > 0) {
      const unfinished = phases.some(
        (phase) => phase.status !== "complete" && phase.status !== "skipped"
      );
      if (unfinished) {
        await dbClient.query("ROLLBACK");
        return res.status(400).json({
          error:
            "Finish or cancel every phase before completing the batch",
        });
      }
    }

    const qty = Number(batch.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      await dbClient.query("ROLLBACK");
      return res.status(400).json({ error: "Batch quantity is invalid" });
    }

    // Credit finished goods
    await adjustInventoryQuantity(dbClient, clientId, batch.item_id, qty);

    // Debit purchased materials allocated to this batch
    const { rows: components } = await dbClient.query(
      `SELECT bc.item_id, bc.quantity_allocated, i.make_or_buy
       FROM batch_components bc
       JOIN items i ON i.id = bc.item_id
       WHERE bc.batch_id = $1`,
      [id]
    );

    for (const component of components) {
      if (isMakeItem(component.make_or_buy)) continue;
      const allocated = Number(component.quantity_allocated);
      if (!Number.isFinite(allocated) || allocated <= 0) continue;
      await adjustInventoryQuantity(
        dbClient,
        clientId,
        component.item_id,
        -allocated
      );
    }

    await dbClient.query(
      `UPDATE batches
       SET status = 'complete',
           inventory_posted = TRUE,
           end_date = CURRENT_TIMESTAMP,
           updated_by = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND client_id = $3`,
      [userId, id, clientId]
    );

    await dbClient.query("COMMIT");

    const { rows } = await pool.query(
      `${batchesSelect} WHERE b.id = $1 AND b.client_id = $2`,
      [id, clientId]
    );
    res.json(rows[0]);
  } catch (err) {
    await dbClient.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to complete batch" });
  } finally {
    dbClient.release();
  }
}

export async function updateBatchPhase(req, res) {
  const { id: batchId, phaseId } = req.params;
  const { status } = req.body;
  const { clientId, userId } = req.auth;

  if (!VALID_PHASE_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `status must be one of: ${VALID_PHASE_STATUSES.join(", ")}`,
    });
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

    const owned = await dbClient.query(
      "SELECT id, status FROM batches WHERE id = $1 AND client_id = $2",
      [batchId, clientId]
    );
    if (owned.rows.length === 0) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Batch not found" });
    }
    if (
      owned.rows[0].status === "cancelled" ||
      owned.rows[0].status === "complete"
    ) {
      await dbClient.query("ROLLBACK");
      return res.status(400).json({
        error: "Cannot update phases on a cancelled or completed batch",
      });
    }

    const completedBy =
      status === "complete" || status === "skipped" ? userId : null;

    const { rows } = await dbClient.query(
      `UPDATE batch_phases
       SET status = $1,
           started_at = CASE
             WHEN $1 = 'in_progress' THEN COALESCE(started_at, CURRENT_TIMESTAMP)
             WHEN $1 = 'pending' THEN NULL
             ELSE started_at
           END,
           completed_at = CASE
             WHEN $1 IN ('complete', 'skipped') THEN COALESCE(completed_at, CURRENT_TIMESTAMP)
             WHEN $1 IN ('pending', 'in_progress') THEN NULL
             ELSE completed_at
           END,
           completed_by = CASE
             WHEN $1 IN ('complete', 'skipped') THEN $2::integer
             ELSE NULL::integer
           END
       WHERE id = $3 AND batch_id = $4
       RETURNING *`,
      [status, completedBy, phaseId, batchId]
    );

    if (rows.length === 0) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Phase not found" });
    }

    await syncBatchStatus(dbClient, batchId);
    await dbClient.query("COMMIT");

    const { rows: batchRows } = await pool.query(
      `${batchesSelect} WHERE b.id = $1`,
      [batchId]
    );
    res.json(batchRows[0]);
  } catch (err) {
    await dbClient.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to update phase" });
  } finally {
    dbClient.release();
  }
}
