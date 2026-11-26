import { pool } from "../lib/db.js";
import { upsertClientPhaseTemplates } from "./routerPhases.js";
import {
  ROUTERS_UNAVAILABLE,
  clientRoutersReady,
  isMissingRouterSchema,
  parseRouterPayload,
  resetClientRoutersForTests,
} from "../lib/clientRouters.js";

/**
 * A company router is a saved phase list. Saving it copies each phase
 * (name, description, minutes) and makes sure that name exists in the
 * company phase library, so a recipe line can still point at the phase.
 * Nothing here writes an item, a recipe, or an item's own phase list.
 */

const PHASES_JSON = `
  COALESCE(
    (SELECT json_agg(json_build_object(
      'id', p.id,
      'sequence', p.sequence,
      'name', p.name,
      'description', p.description,
      'estimated_minutes', p.estimated_minutes,
      'phase_template_id', p.phase_template_id
    ) ORDER BY p.sequence)
     FROM client_router_phases p
     WHERE p.router_id = r.id),
    '[]'::json
  )`;

const ROUTER_FROM = `
  SELECT r.id, r.name, r.description, r.created_at, r.updated_at,
    ${PHASES_JSON} AS phases
  FROM client_routers r
`;

function parseRouterId(raw) {
  const text = typeof raw === "number" ? String(raw) : String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}

function phaseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return [];
    }
  }
  return [];
}

function presentRouter(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    phases: phaseList(row.phases),
  };
}

function sendRouterError(res, err, fallback) {
  if (err?.status === 400 || err?.status === 404) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err?.code === "23505") {
    res.status(409).json({ error: "A router with that name already exists" });
    return;
  }
  if (isMissingRouterSchema(err)) {
    resetClientRoutersForTests();
    res.status(503).json({ error: ROUTERS_UNAVAILABLE });
    return;
  }
  console.error(err);
  res.status(500).json({ error: fallback });
}

async function requireRouters(res) {
  if (await clientRoutersReady(pool)) return true;
  res.status(503).json({ error: ROUTERS_UNAVAILABLE });
  return false;
}

async function templateIdsForPhases(db, clientId, phases) {
  const explicit = [
    ...new Set(
      phases
        .map((phase) => phase.phaseTemplateId)
        .filter((id) => id != null)
    ),
  ];
  if (explicit.length > 0) {
    const { rows } = await db.query(
      `SELECT id
       FROM client_router_phase_templates
       WHERE client_id = $1 AND id = ANY($2::int[])`,
      [clientId, explicit]
    );
    if (rows.length !== explicit.length) {
      throw Object.assign(new Error("Phase must belong to your company"), {
        status: 400,
      });
    }
  }

  const byName = new Map();
  if (phases.length === 0) return byName;

  await upsertClientPhaseTemplates(
    db,
    clientId,
    phases.map((phase) => ({
      name: phase.name,
      description: phase.description,
      estimated_minutes: phase.minutes,
    }))
  );

  const names = [...new Set(phases.map((phase) => phase.name))];
  const { rows } = await db.query(
    `SELECT id, name
     FROM client_router_phase_templates
     WHERE client_id = $1 AND name = ANY($2::text[])`,
    [clientId, names]
  );
  for (const row of rows) byName.set(row.name, Number(row.id));
  return byName;
}

async function replaceRouterPhaseRows(db, clientId, routerId, phases) {
  const byName = await templateIdsForPhases(db, clientId, phases);
  await db.query(`DELETE FROM client_router_phases WHERE router_id = $1`, [
    routerId,
  ]);
  const inserted = [];
  for (const phase of phases) {
    const templateId = phase.phaseTemplateId ?? byName.get(phase.name) ?? null;
    const { rows } = await db.query(
      `INSERT INTO client_router_phases
         (router_id, sequence, name, description, estimated_minutes, phase_template_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, sequence, name, description, estimated_minutes, phase_template_id`,
      [
        routerId,
        phase.sequence,
        phase.name,
        phase.description,
        phase.minutes,
        templateId,
      ]
    );
    inserted.push(rows[0]);
  }
  return inserted;
}

export async function listRouters(req, res) {
  const { clientId } = req.auth;
  try {
    if (!(await requireRouters(res))) return;
    const { rows } = await pool.query(
      `${ROUTER_FROM}
       WHERE r.client_id = $1
       ORDER BY lower(r.name), r.id`,
      [clientId]
    );
    res.json(rows.map(presentRouter));
  } catch (err) {
    sendRouterError(res, err, "Failed to fetch routers");
  }
}

export async function getRouter(req, res) {
  const { clientId } = req.auth;
  try {
    if (!(await requireRouters(res))) return;
    const id = parseRouterId(req.params.id);
    if (!id) return res.status(404).json({ error: "Router not found" });
    const { rows } = await pool.query(
      `${ROUTER_FROM}
       WHERE r.client_id = $1 AND r.id = $2`,
      [clientId, id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Router not found" });
    res.json(presentRouter(rows[0]));
  } catch (err) {
    sendRouterError(res, err, "Failed to fetch router");
  }
}

export async function createRouter(req, res) {
  const { clientId } = req.auth;
  const parsed = parseRouterPayload(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    if (!(await requireRouters(res))) return;
  } catch (err) {
    sendRouterError(res, err, "Failed to create router");
    return;
  }

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query(
      `INSERT INTO client_routers (client_id, name, description)
       VALUES ($1, $2, $3)
       RETURNING id, name, description, created_at, updated_at`,
      [clientId, parsed.value.name, parsed.value.description]
    );
    const phases = await replaceRouterPhaseRows(
      db,
      clientId,
      rows[0].id,
      parsed.value.phases
    );
    await db.query("COMMIT");
    res.status(201).json(presentRouter({ ...rows[0], phases }));
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error(rollbackErr);
    }
    sendRouterError(res, err, "Failed to create router");
  } finally {
    db.release();
  }
}

export async function updateRouter(req, res) {
  const { clientId } = req.auth;
  const parsed = parseRouterPayload(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const id = parseRouterId(req.params.id);
  if (!id) return res.status(404).json({ error: "Router not found" });
  try {
    if (!(await requireRouters(res))) return;
  } catch (err) {
    sendRouterError(res, err, "Failed to update router");
    return;
  }

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query(
      `UPDATE client_routers
       SET name = $1,
           description = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND client_id = $4
       RETURNING id, name, description, created_at, updated_at`,
      [parsed.value.name, parsed.value.description, id, clientId]
    );
    if (!rows[0]) {
      throw Object.assign(new Error("Router not found"), { status: 404 });
    }
    const phases = await replaceRouterPhaseRows(
      db,
      clientId,
      rows[0].id,
      parsed.value.phases
    );
    await db.query("COMMIT");
    res.json(presentRouter({ ...rows[0], phases }));
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error(rollbackErr);
    }
    sendRouterError(res, err, "Failed to update router");
  } finally {
    db.release();
  }
}

export async function deleteRouter(req, res) {
  const { clientId } = req.auth;
  const id = parseRouterId(req.params.id);
  if (!id) return res.status(404).json({ error: "Router not found" });
  try {
    if (!(await requireRouters(res))) return;
    const { rows } = await pool.query(
      `DELETE FROM client_routers
       WHERE id = $1 AND client_id = $2
       RETURNING id`,
      [id, clientId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Router not found" });
    res.status(204).send();
  } catch (err) {
    sendRouterError(res, err, "Failed to delete router");
  }
}
