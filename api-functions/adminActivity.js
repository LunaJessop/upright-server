import { pool } from "../lib/db.js";
import { loadActivity, parseActivityQuery } from "../lib/activityLog.js";

function badType(res, unknown) {
  return res.status(400).json({
    error: `Unknown activity type: ${unknown.join(", ")}`,
  });
}

function badUser(parsed, res) {
  if (parsed.userId == null) return false;
  if (!Number.isInteger(parsed.userId) || parsed.userId <= 0) {
    res.status(400).json({ error: "Invalid user id" });
    return true;
  }
  return false;
}

export async function listAdminActivity(req, res) {
  const parsed = parseActivityQuery(req.query);
  if (parsed.unknown.length > 0) return badType(res, parsed.unknown);
  if (badUser(parsed, res)) return undefined;

  let clientId = null;
  if (req.query.clientId != null && req.query.clientId !== "") {
    clientId = Number(req.query.clientId);
    if (!Number.isInteger(clientId) || clientId <= 0) {
      return res.status(400).json({ error: "Invalid customer id" });
    }
  }

  try {
    const loaded = await loadActivity({
      clientId,
      userId: parsed.userId,
      email: parsed.email,
      types: parsed.types,
      limit: parsed.limit,
      offset: parsed.offset,
    });
    res.json({
      events: loaded.events,
      page: { limit: parsed.limit, offset: parsed.offset, total: loaded.total },
      sources: loaded.sources,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load activity" });
  }
}

export async function getAdminCustomerActivity(req, res) {
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return res.status(400).json({ error: "Invalid customer id" });
  }

  const parsed = parseActivityQuery(req.query);
  if (parsed.unknown.length > 0) return badType(res, parsed.unknown);
  if (badUser(parsed, res)) return undefined;

  try {
    const found = await pool.query(`SELECT id FROM clients WHERE id = $1`, [customerId]);
    if (!found.rows[0]) {
      return res.status(404).json({ error: "Customer not found" });
    }
    const loaded = await loadActivity({
      clientId: customerId,
      userId: parsed.userId,
      email: parsed.email,
      types: parsed.types,
      limit: parsed.limit,
      offset: parsed.offset,
    });
    res.json({
      events: loaded.events,
      page: { limit: parsed.limit, offset: parsed.offset, total: loaded.total },
      sources: loaded.sources,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load activity" });
  }
}
