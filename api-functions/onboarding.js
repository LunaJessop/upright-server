import { pool } from "../lib/db.js";
import { onboardingTemplate, publicOnboardingTemplates } from "../lib/onboardingTemplates.js";

const CHECKLIST = [
  { key: "phases", label: "Set up production phases", field: "phases" },
  { key: "buy_items", label: "Add materials you buy", field: "buy_items" },
  { key: "vendors", label: "Add a vendor", field: "vendors" },
  { key: "make_items", label: "Add something you make", field: "make_items" },
  { key: "batches", label: "Start a batch", field: "batches" },
];

function nameKey(name) {
  return String(name ?? "").trim().toLowerCase();
}

export async function getOnboardingTemplates(_req, res) {
  res.json({ templates: publicOnboardingTemplates() });
}

export async function getOnboardingStatus(req, res) {
  const { clientId } = req.auth;
  try {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM client_router_phase_templates WHERE client_id = $1) AS phases,
         (SELECT count(*)::int FROM vendors WHERE client_id = $1) AS vendors,
         (SELECT count(*)::int FROM items WHERE client_id = $1 AND make_or_buy = 'buy') AS buy_items,
         (SELECT count(*)::int FROM items WHERE client_id = $1 AND make_or_buy = 'make') AS make_items,
         (SELECT count(*)::int FROM batches WHERE client_id = $1) AS batches`,
      [clientId]
    );
    const counts = {
      phases: rows[0]?.phases ?? 0,
      vendors: rows[0]?.vendors ?? 0,
      buy_items: rows[0]?.buy_items ?? 0,
      make_items: rows[0]?.make_items ?? 0,
      batches: rows[0]?.batches ?? 0,
    };
    res.json({
      counts,
      checklist: CHECKLIST.map((step) => ({
        key: step.key,
        label: step.label,
        count: counts[step.field],
        done: counts[step.field] > 0,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load onboarding status" });
  }
}

function parseInclude(body) {
  if (body?.include == null) return { phases: true, items: true };
  return {
    phases: body.include.phases === true,
    items: body.include.items === true,
  };
}

async function existingNameKeys(db, sql, clientId) {
  const { rows } = await db.query(sql, [clientId]);
  return new Set(rows.map((row) => nameKey(row.name)));
}

export async function applyOnboardingTemplate(req, res) {
  const template = onboardingTemplate(req.body?.templateKey);
  if (!template) {
    return res.status(400).json({ error: "Unknown onboarding template" });
  }
  const include = parseInclude(req.body);
  if (!include.phases && !include.items) {
    return res.status(400).json({ error: "Choose phases, items, or both" });
  }

  const { clientId, userId } = req.auth;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const createdPhases = [];
    const skippedPhases = [];
    const createdItems = [];
    const skippedItems = [];

    if (include.phases) {
      const taken = await existingNameKeys(
        db,
        `SELECT name FROM client_router_phase_templates WHERE client_id = $1`,
        clientId
      );
      for (const phase of template.phases) {
        if (taken.has(nameKey(phase.name))) {
          skippedPhases.push(phase.name);
          continue;
        }
        const { rows } = await db.query(
          `INSERT INTO client_router_phase_templates
             (client_id, name, description, estimated_minutes)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, description, estimated_minutes`,
          [clientId, phase.name, phase.description, phase.estimated_minutes]
        );
        createdPhases.push(rows[0]);
        taken.add(nameKey(phase.name));
      }
    }

    if (include.items) {
      const taken = await existingNameKeys(
        db,
        `SELECT name FROM items WHERE client_id = $1`,
        clientId
      );
      for (const item of template.items) {
        if (taken.has(nameKey(item.name))) {
          skippedItems.push(item.name);
          continue;
        }
        const { rows } = await db.query(
          `INSERT INTO items
             (client_id, name, sku, description, make_or_buy,
              unit_of_measure, active, created_by, updated_by)
           VALUES ($1, $2, NULL, $3, 'buy', $4, TRUE, $5, $5)
           RETURNING id, name, unit_of_measure, make_or_buy`,
          [clientId, item.name, item.description, item.unit_of_measure, userId]
        );
        createdItems.push(rows[0]);
        taken.add(nameKey(item.name));
      }
    }

    await db.query("COMMIT");
    res.json({
      template: { key: template.key, name: template.name },
      phases: { created: createdPhases, skipped: skippedPhases },
      items: { created: createdItems, skipped: skippedItems },
    });
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error(rollbackErr);
    }
    console.error(err);
    res.status(500).json({ error: "Failed to apply onboarding template" });
  } finally {
    db.release();
  }
}
