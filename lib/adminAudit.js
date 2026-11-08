import { pool } from "./db.js";
import { isPlatformAdminEmail } from "./auth.js";
import { isMissingRelation, recordActivity } from "./activityLog.js";

const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function pathOnly(req) {
  return String(req.originalUrl || req.path || "").split("?")[0];
}

function recordFromPath(path) {
  const rules = [
    [/^\/api\/items\/(\d+)/, "item"],
    [/^\/api\/vendors\/(\d+)/, "vendor"],
    [/^\/api\/tags\/(\d+)/, "tag"],
    [/^\/api\/batches\/(\d+)/, "batch"],
    [/^\/api\/router-phase-templates\/(\d+)/, "phase"],
    [/^\/api\/client\/users\/(\d+)/, "user"],
    [/^\/api\/items$/, "item"],
    [/^\/api\/vendors$/, "vendor"],
    [/^\/api\/tags$/, "tag"],
    [/^\/api\/batches$/, "batch"],
    [/^\/api\/client\/users$/, "user"],
  ];
  for (const [pattern, recordType] of rules) {
    const match = path.match(pattern);
    if (match) return { recordType, recordId: match[1] ?? null };
  }
  return { recordType: null, recordId: null };
}

function summarize(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return null;
  return body;
}

/**
 * What to write for this platform-admin request.
 * List pages and the audit feed itself are not recorded.
 * Returns null when the request should not be audited.
 */
export function describeAdminRequest(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const path = pathOnly(req);
  const supplied = res?.locals?.adminAudit ?? {};

  const customer = path.match(/^\/api\/admin\/customers\/(\d+)$/);
  if (method === "GET" && customer) {
    return {
      action: "view_customer",
      clientId: Number(customer[1]),
      userId: null,
      recordType: "customer",
      recordId: customer[1],
      message: "Viewed customer",
      before: null,
      after: null,
    };
  }

  const customerActivity = path.match(/^\/api\/admin\/customers\/(\d+)\/activity$/);
  if (method === "GET" && customerActivity) {
    return {
      action: "view_customer_activity",
      clientId: Number(customerActivity[1]),
      userId: null,
      recordType: "customer",
      recordId: customerActivity[1],
      message: "Viewed customer activity",
      before: null,
      after: null,
    };
  }

  if (method === "GET" && path === "/api/admin/activity") {
    const clientId = Number(req.query?.clientId);
    if (!Number.isInteger(clientId) || clientId <= 0) return null;
    return {
      action: "view_customer_activity",
      clientId,
      userId: null,
      recordType: "customer",
      recordId: String(clientId),
      message: "Viewed customer activity",
      before: null,
      after: null,
    };
  }

  if (!MUTATIONS.has(method)) return null;
  if (path === "/api/stripe/webhook") return null;

  const fromPath = recordFromPath(path);
  return {
    action: supplied.action || `${method.toLowerCase()}_${fromPath.recordType || "request"}`,
    clientId: supplied.clientId ?? req.auth?.clientId ?? null,
    userId: supplied.userId ?? null,
    recordType: supplied.recordType || fromPath.recordType,
    recordId: supplied.recordId ?? fromPath.recordId,
    message: supplied.message || `${method} ${path}`,
    before: supplied.before ?? null,
    after: supplied.after === undefined ? summarize(req.body) : supplied.after,
  };
}

export function auditAdminRequests(req, res, next) {
  res.on("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    if (!isPlatformAdminEmail(req.auth?.email)) return;
    const spec = describeAdminRequest(req, res);
    if (!spec) return;
    void recordActivity({
      type: "admin_action",
      clientId: spec.clientId,
      userId: spec.userId,
      email: spec.email ?? null,
      message: spec.message,
      detail: {
        adminUserId: req.auth?.userId ?? null,
        adminEmail: req.auth?.email ?? null,
        action: spec.action,
        recordType: spec.recordType,
        recordId: spec.recordId,
        before: spec.before,
        after: spec.after,
      },
    });
  });
  next();
}

function auditEvent(row) {
  const detail = row.detail && typeof row.detail === "object" ? row.detail : {};
  return {
    id: `activity:${row.id}`,
    type: "admin_action",
    created_at: row.created_at,
    admin_user_id: detail.adminUserId ?? null,
    admin_email: detail.adminEmail ?? null,
    action: detail.action ?? null,
    client_id: row.client_id ?? null,
    user_id: row.user_id ?? null,
    email: row.email ?? null,
    record_type: detail.recordType ?? null,
    record_id: detail.recordId ?? null,
    message: row.message ?? null,
    before: detail.before ?? null,
    after: detail.after ?? null,
  };
}

export function parseAuditQuery(query = {}) {
  const limitRaw = Number(query.limit);
  const offsetRaw = Number(query.offset);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 25;
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
  const clientId = query.clientId == null || query.clientId === "" ? null : Number(query.clientId);
  const userId = query.userId == null || query.userId === "" ? null : Number(query.userId);
  const adminUserId =
    query.adminUserId == null || query.adminUserId === "" ? null : Number(query.adminUserId);
  const action = String(query.action ?? "").trim().slice(0, 80) || null;
  return { limit, offset, clientId, userId, adminUserId, action };
}

export async function loadAdminAudit({ clientId, userId, adminUserId, action, limit, offset }) {
  const params = [
    clientId,
    userId,
    adminUserId == null ? null : String(adminUserId),
    action,
    limit,
    offset,
  ];
  const where = `
    WHERE event_type = 'admin_action'
      AND ($1::int IS NULL OR client_id = $1)
      AND ($2::int IS NULL OR user_id = $2)
      AND ($3::text IS NULL OR detail->>'adminUserId' = $3)
      AND ($4::text IS NULL OR detail->>'action' = $4)
  `;
  try {
    const [listResult, countResult] = await Promise.all([
      pool.query(
        `SELECT id::text AS id, created_at, client_id, user_id, email, message, detail
         FROM admin_activity
         ${where}
         ORDER BY created_at DESC NULLS LAST, id DESC
         LIMIT $5 OFFSET $6`,
        params
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM admin_activity ${where}`, params.slice(0, 4)),
    ]);
    return {
      events: listResult.rows.map(auditEvent),
      total: countResult.rows[0]?.total ?? 0,
      source: "ok",
    };
  } catch (err) {
    if (isMissingRelation(err)) {
      return { events: [], total: 0, source: "unavailable" };
    }
    throw err;
  }
}
