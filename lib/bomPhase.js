import { pool } from "./db.js";

let phaseColumnExists = null;

/** Tests only. Production detects the column once per process. */
export function resetBomPhaseColumnCacheForTests() {
  phaseColumnExists = null;
}

/**
 * True when bom_items.phase_id is present.
 * A failed check is not cached, so a later request can try again.
 */
export async function hasBomPhaseColumn(db = pool) {
  if (phaseColumnExists != null) return phaseColumnExists;
  try {
    const { rows } = await db.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'bom_items'
         AND column_name = 'phase_id'`
    );
    phaseColumnExists = rows.length > 0;
    return phaseColumnExists;
  } catch (err) {
    console.error(err);
    return false;
  }
}

export function parsePhaseId(value) {
  if (value == null || value === "") return { ok: true, phaseId: null };
  const phaseId = Number(value);
  if (!Number.isInteger(phaseId) || phaseId <= 0) {
    return { ok: false, error: "phase_id must be a company phase" };
  }
  return { ok: true, phaseId };
}

export async function phaseNamesById(db, clientId, phaseIds) {
  const ids = [...new Set(phaseIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT id, name
     FROM client_router_phase_templates
     WHERE client_id = $1 AND id = ANY($2::int[])`,
    [clientId, ids]
  );
  if (rows.length !== ids.length) {
    throw Object.assign(new Error("Phase must belong to your company"), { status: 400 });
  }
  return new Map(rows.map((row) => [Number(row.id), row.name]));
}

function componentArray(batch) {
  const value = batch?.components;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        batch.components = parsed;
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

const BATCH_COMPONENT_PHASES_SQL = `
  WITH RECURSIVE walk AS (
    SELECT b.id AS batch_id,
           b.item_id AS parent_id,
           ARRAY[b.item_id] AS path
    FROM batches b
    WHERE b.client_id = $1 AND b.id = ANY($2::int[])
    UNION ALL
    SELECT w.batch_id,
           bom.component_item_id,
           w.path || bom.component_item_id
    FROM walk w
    JOIN bom_items bom ON bom.parent_item_id = w.parent_id
    JOIN items child
      ON child.id = bom.component_item_id
     AND child.client_id = $1
     AND child.make_or_buy = 'make'
    WHERE NOT bom.component_item_id = ANY (w.path)
  )
  SELECT w.batch_id,
         bom.component_item_id,
         bom.phase_id,
         t.name AS phase_name
  FROM walk w
  JOIN bom_items bom ON bom.parent_item_id = w.parent_id
  JOIN items comp ON comp.id = bom.component_item_id AND comp.client_id = $1
  LEFT JOIN client_router_phase_templates t
    ON t.id = bom.phase_id AND t.client_id = $1
`;

function applyPhase(component, links) {
  const ids = new Set(
    links.map((row) => (row.phase_id == null ? null : Number(row.phase_id)))
  );
  if (ids.size !== 1) {
    component.phase_id = null;
    component.phase_name = null;
    return;
  }
  const phaseId = [...ids][0];
  const named = links.find((row) => row.phase_name);
  component.phase_id = phaseId;
  component.phase_name = phaseId == null ? null : named?.phase_name ?? null;
}

/**
 * Add phase_id and phase_name to each batch component from the current recipe.
 * When the column is missing, both fields are null.
 */
export async function attachBatchMaterialPhases(db, clientId, batches) {
  const rows = (batches ?? []).filter(Boolean);
  const lists = rows.map((batch) => ({ batch, components: componentArray(batch) }));
  const withColumn = await hasBomPhaseColumn(db);
  if (!withColumn) {
    for (const { components } of lists) {
      if (!components) continue;
      for (const component of components) {
        component.phase_id = null;
        component.phase_name = null;
      }
    }
    return batches;
  }

  const batchIds = rows
    .map((batch) => Number(batch.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (batchIds.length === 0) return batches;

  const { rows: links } = await db.query(BATCH_COMPONENT_PHASES_SQL, [clientId, batchIds]);
  const byKey = new Map();
  for (const link of links) {
    const key = `${Number(link.batch_id)}:${Number(link.component_item_id)}`;
    const group = byKey.get(key) ?? [];
    group.push(link);
    byKey.set(key, group);
  }

  for (const { batch, components } of lists) {
    if (!components) continue;
    for (const component of components) {
      const key = `${Number(batch.id)}:${Number(component.item_id)}`;
      applyPhase(component, byKey.get(key) ?? []);
    }
  }
  return batches;
}
