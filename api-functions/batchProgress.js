import { pool } from "../lib/db.js";
import { batchProgressTableReady, parseEnteredQuantity } from "../lib/batchProgress.js";

function unavailable(res) {
  return res.status(503).json({
    error: "Ingredient progress is not set up yet.",
    code: "PROGRESS_UNAVAILABLE",
  });
}

export async function saveBatchComponentProgress(req, res) {
  const batchId = Number(req.params.id);
  const componentId = Number(req.params.componentId);
  if (!Number.isInteger(batchId) || batchId <= 0 || !Number.isInteger(componentId) || componentId <= 0) {
    return res.status(400).json({ error: "Invalid batch or ingredient id" });
  }

  const quantity = parseEnteredQuantity(req.body?.quantity_entered);
  if (quantity == null) {
    return res.status(400).json({
      error: "Enter a quantity that is zero or more, with up to 6 decimal places.",
      code: "QUANTITY_INVALID",
    });
  }

  const phaseRaw = req.body?.batch_phase_id;
  let phaseId = null;
  if (phaseRaw != null) {
    phaseId = Number(phaseRaw);
    if (!Number.isInteger(phaseId) || phaseId <= 0) {
      return res.status(400).json({
        error: "That step is not on this batch.",
        code: "PHASE_NOT_ON_BATCH",
      });
    }
  }

  const { clientId, userId } = req.auth;
  const db = await pool.connect();
  try {
    if (!(await batchProgressTableReady(db))) return unavailable(res);
    await db.query("BEGIN");

    const { rows: components } = await db.query(
      `SELECT bc.id, bc.batch_id, bc.quantity_allocated::text AS quantity_allocated,
              bc.unit_of_measure, b.status
       FROM batch_components bc
       JOIN batches b ON b.id = bc.batch_id AND b.client_id = $1
       WHERE bc.id = $2 AND bc.batch_id = $3
       FOR UPDATE OF bc`,
      [clientId, componentId, batchId]
    );
    const component = components[0];
    if (!component) {
      await db.query("ROLLBACK");
      return res.status(404).json({ error: "Ingredient not found" });
    }
    if (component.status === "complete" || component.status === "cancelled") {
      await db.query("ROLLBACK");
      return res.status(400).json({
        error: "Cannot change ingredient progress on a completed or cancelled batch.",
      });
    }
    if (component.quantity_allocated == null) {
      await db.query("ROLLBACK");
      return res.status(400).json({
        error: "This ingredient has no allocated quantity.",
        code: "QUANTITY_UNALLOCATED",
      });
    }

    if (phaseId != null) {
      const { rows: phases } = await db.query(
        `SELECT id FROM batch_phases WHERE id = $1 AND batch_id = $2`,
        [phaseId, batchId]
      );
      if (phases.length === 0) {
        await db.query("ROLLBACK");
        return res.status(400).json({
          error: "That step is not on this batch.",
          code: "PHASE_NOT_ON_BATCH",
        });
      }
    }

    const { rows: within } = await db.query(
      `SELECT ($1::numeric <= $2::numeric) AS ok`,
      [quantity, component.quantity_allocated]
    );
    if (!within[0]?.ok) {
      await db.query("ROLLBACK");
      return res.status(400).json({
        error: "Entered quantity cannot be more than the allocated amount.",
        code: "QUANTITY_OVER_ALLOCATED",
      });
    }

    const updated = await db.query(
      `UPDATE batch_component_progress
       SET quantity_entered = $1::numeric,
           updated_at = CURRENT_TIMESTAMP,
           updated_by = $2
       WHERE batch_component_id = $3
         AND batch_phase_id IS NOT DISTINCT FROM $4::int
       RETURNING quantity_entered::text AS quantity_entered`,
      [quantity, userId, componentId, phaseId]
    );

    let entered = updated.rows[0]?.quantity_entered;
    if (!entered) {
      try {
        const inserted = await db.query(
          `INSERT INTO batch_component_progress
             (batch_component_id, batch_phase_id, quantity_entered, updated_by)
           VALUES ($1, $2, $3::numeric, $4)
           RETURNING quantity_entered::text AS quantity_entered`,
          [componentId, phaseId, quantity, userId]
        );
        entered = inserted.rows[0]?.quantity_entered;
      } catch (err) {
        if (err?.code !== "23505") throw err;
        const raced = await db.query(
          `UPDATE batch_component_progress
           SET quantity_entered = $1::numeric,
               updated_at = CURRENT_TIMESTAMP,
               updated_by = $2
           WHERE batch_component_id = $3
             AND batch_phase_id IS NOT DISTINCT FROM $4::int
           RETURNING quantity_entered::text AS quantity_entered`,
          [quantity, userId, componentId, phaseId]
        );
        entered = raced.rows[0]?.quantity_entered;
      }
    }

    if (!entered) {
      await db.query("ROLLBACK");
      return res.status(500).json({ error: "Failed to save ingredient progress" });
    }

    await db.query("COMMIT");
    res.json({
      batch_component_id: componentId,
      batch_phase_id: phaseId,
      quantity_entered: entered,
      quantity_allocated: component.quantity_allocated,
      unit_of_measure: component.unit_of_measure ?? null,
    });
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch {
      console.error("ingredient progress rollback failed");
    }
    console.error("ingredient progress save failed");
    res.status(500).json({ error: "Failed to save ingredient progress" });
  } finally {
    db.release();
  }
}
