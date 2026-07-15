import { pool } from "../lib/db.js";

export async function getRouterPhaseTemplates(req, res) {
  const { clientId } = req.auth;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, description, estimated_minutes, created_at, updated_at
       FROM client_router_phase_templates
       WHERE client_id = $1
       ORDER BY name ASC`,
      [clientId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch router phase templates" });
  }
}

export async function createRouterPhaseTemplate(req, res) {
  const { clientId } = req.auth;
  const { name, description, estimated_minutes } = req.body ?? {};
  const trimmedName = name?.trim();

  if (!trimmedName) {
    return res.status(400).json({ error: "Phase name is required" });
  }

  const minutes =
    estimated_minutes == null || estimated_minutes === ""
      ? null
      : Number(estimated_minutes);
  if (minutes != null && (!Number.isFinite(minutes) || minutes < 0)) {
    return res.status(400).json({ error: "Estimated minutes must be a non-negative number" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO client_router_phase_templates
         (client_id, name, description, estimated_minutes)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, description, estimated_minutes, created_at, updated_at`,
      [clientId, trimmedName, description?.trim() || null, minutes]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      return res.status(409).json({ error: "A phase with that name already exists" });
    }
    res.status(500).json({ error: "Failed to create phase" });
  }
}

export async function updateRouterPhaseTemplate(req, res) {
  const { clientId } = req.auth;
  const { id } = req.params;
  const { name, description, estimated_minutes } = req.body ?? {};
  const trimmedName = name?.trim();

  if (!trimmedName) {
    return res.status(400).json({ error: "Phase name is required" });
  }

  const minutes =
    estimated_minutes == null || estimated_minutes === ""
      ? null
      : Number(estimated_minutes);
  if (minutes != null && (!Number.isFinite(minutes) || minutes < 0)) {
    return res.status(400).json({ error: "Estimated minutes must be a non-negative number" });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE client_router_phase_templates
       SET name = $1,
           description = $2,
           estimated_minutes = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND client_id = $5
       RETURNING id, name, description, estimated_minutes, created_at, updated_at`,
      [trimmedName, description?.trim() || null, minutes, id, clientId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Phase not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      return res.status(409).json({ error: "A phase with that name already exists" });
    }
    res.status(500).json({ error: "Failed to update phase" });
  }
}

export async function deleteRouterPhaseTemplate(req, res) {
  const { clientId } = req.auth;
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `DELETE FROM client_router_phase_templates
       WHERE id = $1 AND client_id = $2
       RETURNING id`,
      [id, clientId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Phase not found" });
    }

    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete phase" });
  }
}

/** @deprecated Prefer managing phases on the Settings → Phases page. */
export async function upsertClientPhaseTemplates(dbClient, clientId, routerPhases) {
  if (!Array.isArray(routerPhases) || routerPhases.length === 0) return;

  for (const phase of routerPhases) {
    const name = phase.name?.trim();
    if (!name) continue;

    await dbClient.query(
      `INSERT INTO client_router_phase_templates
         (client_id, name, description, estimated_minutes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (client_id, name) DO UPDATE SET
         description = EXCLUDED.description,
         estimated_minutes = EXCLUDED.estimated_minutes,
         updated_at = CURRENT_TIMESTAMP`,
      [
        clientId,
        name,
        phase.description?.trim() || null,
        phase.estimated_minutes == null || phase.estimated_minutes === ""
          ? null
          : Number(phase.estimated_minutes),
      ]
    );
  }
}
