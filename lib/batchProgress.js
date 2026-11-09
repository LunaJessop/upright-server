/**
 * Entered quantity for a batch ingredient, separate from the allocation.
 * quantity_allocated is the required total and is never changed here.
 * batch_phase_id is the batch step row, or null for the unassigned list.
 * Writes do not look up a phase by name.
 *
 * The table check is remembered in memory and starts empty on each process.
 */

let progressTableReady = null;

export function resetBatchProgressForTests() {
  progressTableReady = null;
}

export function parseEnteredQuantity(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    value = String(value);
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
  if (text.length > 24) return null;
  return text;
}

export async function batchProgressTableReady(db) {
  if (progressTableReady != null) return progressTableReady;
  try {
    const { rows } = await db.query(
      `SELECT to_regclass('public.batch_component_progress') AS regclass`
    );
    const name = rows[0]?.regclass;
    progressTableReady = typeof name === "string" && name.length > 0;
    return progressTableReady;
  } catch (err) {
    console.error("batch progress table check failed");
    return false;
  }
}

export async function attachComponentProgress(db, clientId, batches) {
  const rows = (batches ?? []).filter(Boolean);
  for (const batch of rows) {
    if (!Array.isArray(batch.components)) continue;
    for (const component of batch.components) component.progress = [];
  }
  if (!(await batchProgressTableReady(db))) return batches;

  const batchIds = rows
    .map((batch) => Number(batch.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (batchIds.length === 0) return batches;

  let progressRows = [];
  try {
    const result = await db.query(
      `SELECT p.batch_component_id, p.batch_phase_id, p.quantity_entered::text AS quantity_entered
       FROM batch_component_progress p
       JOIN batch_components bc ON bc.id = p.batch_component_id
       JOIN batches b ON b.id = bc.batch_id AND b.client_id = $1
       WHERE bc.batch_id = ANY($2::int[])
       ORDER BY p.batch_component_id, p.batch_phase_id NULLS FIRST`,
      [clientId, batchIds]
    );
    progressRows = result.rows;
  } catch (err) {
    if (err?.code === "42P01") {
      progressTableReady = false;
      return batches;
    }
    throw err;
  }

  const byComponent = new Map();
  for (const row of progressRows) {
    const id = Number(row.batch_component_id);
    const list = byComponent.get(id) ?? [];
    list.push({
      batch_phase_id: row.batch_phase_id == null ? null : Number(row.batch_phase_id),
      quantity_entered: row.quantity_entered,
    });
    byComponent.set(id, list);
  }
  for (const batch of rows) {
    if (!Array.isArray(batch.components)) continue;
    for (const component of batch.components) {
      component.progress = byComponent.get(Number(component.id)) ?? [];
    }
  }
  return batches;
}
