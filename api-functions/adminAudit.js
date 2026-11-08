import { loadAdminAudit, parseAuditQuery } from "../lib/adminAudit.js";

function invalidId(value, label) {
  return value != null && (!Number.isInteger(value) || value <= 0)
    ? `${label} is invalid`
    : null;
}

export async function listAdminAudit(req, res) {
  const parsed = parseAuditQuery(req.query);
  const problem =
    invalidId(parsed.clientId, "Customer id") ||
    invalidId(parsed.userId, "User id") ||
    invalidId(parsed.adminUserId, "Admin user id");
  if (problem) return res.status(400).json({ error: problem });

  try {
    const loaded = await loadAdminAudit(parsed);
    res.json({
      events: loaded.events,
      page: { limit: parsed.limit, offset: parsed.offset, total: loaded.total },
      sources: { admin_activity: loaded.source },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load audit log" });
  }
}
