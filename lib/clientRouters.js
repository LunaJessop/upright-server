import { parseEstimatedMinutes } from "./estimatedMinutes.js";

/**
 * Company routers (client_routers) are reusable phase lists.
 * An item's own phase list (item_routers) is a separate copy.
 *
 * scripts/sql/client-routers.sql is optional until Luna applies it.
 * A missing table or column is not cached, so a later request can try again.
 * A found table or column is cached for this process.
 * The check starts empty in each process.
 */

export const MAX_ROUTER_PHASES = 100;
export const ROUTERS_UNAVAILABLE = "Routers aren't available yet.";

let routersReady = null;
let sourceColumnReady = null;

export function resetClientRoutersForTests() {
  routersReady = null;
  sourceColumnReady = null;
}

export async function clientRoutersReady(db) {
  if (routersReady === true) return true;
  try {
    const { rows } = await db.query(
      `SELECT to_regclass('public.client_routers') AS routers,
              to_regclass('public.client_router_phases') AS phases`
    );
    const routers = rows[0]?.routers;
    const phases = rows[0]?.phases;
    const ready =
      typeof routers === "string" &&
      routers.length > 0 &&
      typeof phases === "string" &&
      phases.length > 0;
    if (ready) routersReady = true;
    return ready;
  } catch {
    console.error("client router table check failed");
    return false;
  }
}

export async function sourceRouterColumnReady(db) {
  if (sourceColumnReady === true) return true;
  try {
    const { rows } = await db.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'item_routers'
         AND column_name = 'source_router_id'`
    );
    const ready = rows.length > 0;
    if (ready) sourceColumnReady = true;
    return ready;
  } catch {
    console.error("source router column check failed");
    return false;
  }
}

export function isMissingRouterSchema(err) {
  return err?.code === "42P01" || err?.code === "42703";
}

function optionalText(value, label) {
  if (value == null) return { value: null };
  if (typeof value !== "string") return { error: `${label} must be text` };
  const trimmed = value.trim();
  return { value: trimmed === "" ? null : trimmed };
}

/**
 * @param {unknown} body
 * @returns {{ error: string } | { value: { name: string, description: string | null, phases: object[] } }}
 */
export function parseRouterPayload(body) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "Router name is required" };

  const description = optionalText(body?.description, "Description");
  if (description.error) return { error: description.error };

  if (!Array.isArray(body?.phases)) return { error: "Phases must be a list" };
  if (body.phases.length > MAX_ROUTER_PHASES) {
    return { error: `A router can have at most ${MAX_ROUTER_PHASES} phases` };
  }

  const phases = [];
  for (let i = 0; i < body.phases.length; i += 1) {
    const phase = body.phases[i];
    const phaseName = typeof phase?.name === "string" ? phase.name.trim() : "";
    if (!phaseName) return { error: `Phase ${i + 1} requires a name` };

    const sequence = phase?.sequence == null || phase.sequence === ""
      ? i + 1
      : Number(phase.sequence);
    if (sequence !== i + 1) {
      return { error: "Phase sequence must be 1, 2, 3… with no gaps" };
    }

    const minutes = parseEstimatedMinutes(phase?.estimated_minutes);
    if (!minutes.ok) return { error: minutes.error };

    const phaseDescription = optionalText(phase?.description, "Description");
    if (phaseDescription.error) return { error: phaseDescription.error };

    let phaseTemplateId = null;
    const rawTemplate = phase?.phase_template_id;
    if (rawTemplate != null && rawTemplate !== "") {
      const text = typeof rawTemplate === "number"
        ? String(rawTemplate)
        : typeof rawTemplate === "string"
          ? rawTemplate.trim()
          : "";
      if (!/^\d+$/.test(text)) {
        return { error: "Phase must belong to your company" };
      }
      phaseTemplateId = Number(text);
      if (!Number.isSafeInteger(phaseTemplateId) || phaseTemplateId <= 0) {
        return { error: "Phase must belong to your company" };
      }
    }

    phases.push({
      sequence: i + 1,
      name: phaseName,
      description: phaseDescription.value,
      minutes: minutes.minutes,
      phaseTemplateId,
    });
  }

  return {
    value: {
      name,
      description: description.value,
      phases,
    },
  };
}

/**
 * source_router_id is optional. Absent means leave the item's label alone.
 * Present null clears it. A positive id must belong to this company.
 */
export function readSourceRouterInput(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { present: false, value: null };
  }
  if (!Object.prototype.hasOwnProperty.call(body, "source_router_id")) {
    return { present: false, value: null };
  }
  const raw = body.source_router_id;
  if (raw == null || raw === "") return { present: true, value: null };
  const text = typeof raw === "number"
    ? String(raw)
    : typeof raw === "string"
      ? raw.trim()
      : "";
  if (!/^\d+$/.test(text)) {
    return { present: true, error: "Router must belong to your company" };
  }
  const id = Number(text);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { present: true, error: "Router must belong to your company" };
  }
  return { present: true, value: id };
}

/**
 * @returns {Promise<{ mode: "keep" } | { mode: "set", id: number | null }>}
 */
export async function resolveSourceRouter(db, clientId, source) {
  if (!source?.present) return { mode: "keep" };
  if (source.value == null) return { mode: "set", id: null };
  if (!(await clientRoutersReady(db))) return { mode: "keep" };
  const { rows } = await db.query(
    `SELECT id FROM client_routers WHERE id = $1 AND client_id = $2`,
    [source.value, clientId]
  );
  if (!rows[0]) {
    throw Object.assign(new Error("Router must belong to your company"), {
      status: 400,
    });
  }
  return { mode: "set", id: Number(rows[0].id) };
}
