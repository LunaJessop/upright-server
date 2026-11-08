import { pool } from "./db.js";

export const ACTIVITY_TYPES = Object.freeze([
  "login",
  "login_failed",
  "password_reset_requested",
  "password_reset",
  "rate_limited",
  "error",
  "email",
]);

const ACTIVITY_TYPE_SET = new Set(ACTIVITY_TYPES);
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

let loggedMissingActivity = false;

export function isMissingRelation(err) {
  if (err?.code === "42P01" || err?.code === "42703") return true;
  const message = String(err?.message ?? "");
  return /does not exist/i.test(message) && /(admin_activity|email_log)/i.test(message);
}

function clip(value, max) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

function safeMessage(value) {
  const text = clip(value, 300);
  if (!text) return null;
  return text.replace(
    /(password|token|authorization|secret)\s*[:=]\s*\S+/gi,
    "$1=[redacted]"
  );
}

function cleanDetail(detail) {
  const out = {};
  for (const [key, value] of Object.entries(detail ?? {})) {
    if (/password|token|secret|authorization|html|body/i.test(key)) continue;
    if (value == null) {
      out[key] = null;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (typeof value === "string") out[key] = value.slice(0, 200);
  }
  return out;
}

/**
 * Write one auth or error event. Never throws.
 * If admin_activity does not exist yet, the event is skipped and a warning
 * is logged once per process.
 */
export async function recordActivity(event = {}) {
  const eventType = String(event.type ?? "").trim();
  if (!ACTIVITY_TYPE_SET.has(eventType) || eventType === "email") return;

  try {
    await pool.query(
      `INSERT INTO admin_activity
         (event_type, client_id, user_id, email, message, detail)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        eventType,
        positiveInt(event.clientId),
        positiveInt(event.userId),
        clip(event.email, 320),
        safeMessage(event.message),
        JSON.stringify(cleanDetail(event.detail)),
      ]
    );
  } catch (err) {
    if (isMissingRelation(err)) {
      if (!loggedMissingActivity) {
        loggedMissingActivity = true;
        console.error(
          "admin_activity is missing, so this event was not saved. Run scripts/sql/admin-activity.sql."
        );
      }
      return;
    }
    console.error("activity log failed:", err?.message ?? err);
  }
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function parseActivityQuery(query = {}) {
  const limitRaw = Number(query.limit);
  const offsetRaw = Number(query.offset);
  const limit =
    Number.isInteger(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, MAX_LIMIT)
      : DEFAULT_LIMIT;
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
  const requested = String(query.type ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const unknown = requested.filter((type) => !ACTIVITY_TYPE_SET.has(type));
  const userId = query.userId == null || query.userId === "" ? null : Number(query.userId);
  const email = clip(query.email, 320);
  return {
    limit,
    offset,
    types: requested,
    unknown,
    userId,
    email,
  };
}

function activityWhere() {
  return `(
    $1::int IS NULL
    OR a.client_id = $1
    OR lower(a.email) IN (
      SELECT lower(u.email) FROM users u WHERE u.client_id = $1
    )
  )`;
}

const ACTIVITY_SELECT = `
  SELECT a.id::text AS id,
         a.created_at,
         a.event_type AS type,
         a.client_id,
         a.user_id,
         a.email,
         a.message,
         a.detail,
         'activity' AS source
  FROM admin_activity a
  WHERE ${activityWhere()}
    AND ($2::int IS NULL OR a.user_id = $2)
    AND ($3::text IS NULL OR lower(a.email) = lower($3))
    AND ($4::text[] IS NULL OR a.event_type = ANY($4::text[]))
`;

const EMAIL_SELECT = `
  SELECT e.id::text AS id,
         e.created_at,
         'email' AS type,
         e.client_id,
         e.user_id,
         e.to_address AS email,
         e.error AS message,
         jsonb_build_object('template', e.template, 'status', e.status) AS detail,
         'email' AS source
  FROM email_log e
  WHERE ($1::int IS NULL OR e.client_id = $1)
    AND ($2::int IS NULL OR e.user_id = $2)
    AND ($3::text IS NULL OR lower(e.to_address) = lower($3))
`;

function eventPayload(row) {
  const detail = row.detail && typeof row.detail === "object" ? row.detail : {};
  const payload = {
    id: `${row.source}:${row.id}`,
    source: row.source,
    type: row.type,
    created_at: row.created_at,
    client_id: row.client_id ?? null,
    user_id: row.user_id ?? null,
    email: row.email ?? null,
    message: row.message ?? null,
  };
  if (row.type === "email") {
    payload.template = detail.template ?? null;
    payload.email_status = detail.status ?? null;
  } else if (detail.action) {
    payload.action = detail.action;
  } else if (detail.path) {
    payload.method = detail.method ?? null;
    payload.path = detail.path ?? null;
    payload.status = detail.status ?? null;
  }
  return payload;
}

async function runSource(sql, params) {
  try {
    const result = await pool.query(sql, params);
    return { status: "ok", rows: result.rows };
  } catch (err) {
    if (isMissingRelation(err)) return { status: "unavailable", rows: [] };
    throw err;
  }
}

export async function loadActivity({ clientId = null, userId = null, email = null, types = [], limit, offset }) {
  const activityTypes = types.filter((type) => type !== "email");
  const includeActivity = types.length === 0 || activityTypes.length > 0;
  const includeEmail = types.length === 0 || types.includes("email");
  const params = [
    clientId,
    userId,
    email,
    activityTypes.length > 0 ? activityTypes : null,
  ];

  const parts = [];
  if (includeActivity) parts.push({ name: "admin_activity", sql: ACTIVITY_SELECT });
  if (includeEmail) parts.push({ name: "email_log", sql: EMAIL_SELECT });

  const sources = { admin_activity: "skipped", email_log: "skipped" };
  const available = [];
  for (const part of parts) {
    const probe = await runSource(
      `SELECT * FROM (${part.sql}) probe LIMIT 0`,
      params
    );
    sources[part.name] = probe.status === "ok" ? "ok" : "unavailable";
    if (probe.status === "ok") available.push(part.sql);
  }

  if (available.length === 0) {
    return { events: [], total: 0, sources };
  }

  const union = available.join("\nUNION ALL\n");
  const listParams = [...params, limit, offset];
  const [listResult, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM (${union}) events
       ORDER BY created_at DESC NULLS LAST, id DESC
       LIMIT $5 OFFSET $6`,
      listParams
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM (${union}) events`, params),
  ]);

  return {
    events: listResult.rows.map(eventPayload),
    total: countResult.rows[0]?.total ?? 0,
    sources,
  };
}

/** Records HTTP 500 responses. Does not read the request body. */
export function captureServerErrors(req, res, next) {
  let statusCode = res.statusCode || 200;
  let noted = false;
  let message = "Server error";
  const origStatus = res.status.bind(res);
  const origJson = res.json.bind(res);
  const origSend = res.send.bind(res);

  res.status = (code) => {
    statusCode = code;
    return origStatus(code);
  };

  const note = () => {
    const code = statusCode || res.statusCode;
    if (noted || code < 500) return;
    noted = true;
    void recordActivity({
      type: "error",
      clientId: req.auth?.clientId ?? null,
      userId: req.auth?.userId ?? null,
      email: req.auth?.email ?? null,
      message,
      detail: {
        method: req.method,
        path: String(req.originalUrl || req.path || "").split("?")[0].slice(0, 200),
        status: code,
      },
    });
  };

  res.json = (body) => {
    if (body && typeof body === "object" && typeof body.error === "string") {
      message = safeMessage(body.error) || "Server error";
    }
    note();
    return origJson(body);
  };
  res.send = (body) => {
    note();
    return origSend(body);
  };
  next();
}
