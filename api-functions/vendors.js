import { pool } from "../lib/db.js";

function normalizeOptional(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeSiteLink(value) {
  const trimmed = normalizeOptional(value);
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export async function getVendors(req, res) {
  const { clientId } = req.auth;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, site_link, phone, created_at, updated_at
       FROM vendors
       WHERE client_id = $1
       ORDER BY name ASC`,
      [clientId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch vendors" });
  }
}

export async function createVendor(req, res) {
  const { clientId } = req.auth;
  const { name, email, site_link, phone } = req.body ?? {};
  const trimmedName = normalizeOptional(name);

  if (!trimmedName) {
    return res.status(400).json({ error: "Vendor name is required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO vendors (client_id, name, email, site_link, phone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, site_link, phone, created_at, updated_at`,
      [
        clientId,
        trimmedName,
        normalizeOptional(email),
        normalizeSiteLink(site_link),
        normalizeOptional(phone),
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      return res.status(409).json({ error: "A vendor with that name already exists" });
    }
    res.status(500).json({ error: "Failed to create vendor" });
  }
}

export async function updateVendor(req, res) {
  const { clientId } = req.auth;
  const { id } = req.params;
  const { name, email, site_link, phone } = req.body ?? {};
  const trimmedName = normalizeOptional(name);

  if (!trimmedName) {
    return res.status(400).json({ error: "Vendor name is required" });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE vendors
       SET name = $1,
           email = $2,
           site_link = $3,
           phone = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 AND client_id = $6
       RETURNING id, name, email, site_link, phone, created_at, updated_at`,
      [
        trimmedName,
        normalizeOptional(email),
        normalizeSiteLink(site_link),
        normalizeOptional(phone),
        id,
        clientId,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      return res.status(409).json({ error: "A vendor with that name already exists" });
    }
    res.status(500).json({ error: "Failed to update vendor" });
  }
}

export async function deleteVendor(req, res) {
  const { clientId } = req.auth;
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `DELETE FROM vendors
       WHERE id = $1 AND client_id = $2
       RETURNING id`,
      [id, clientId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete vendor" });
  }
}

/** Ensures vendor_id belongs to this client; returns null for empty. */
export async function resolveVendorId(dbClient, clientId, vendor) {
  if (vendor == null || vendor === "") return null;
  const vendorId = Number(vendor);
  if (!Number.isInteger(vendorId) || vendorId <= 0) {
    throw Object.assign(new Error("Invalid vendor"), { status: 400 });
  }
  const { rows } = await dbClient.query(
    `SELECT id FROM vendors WHERE id = $1 AND client_id = $2`,
    [vendorId, clientId]
  );
  if (rows.length === 0) {
    throw Object.assign(new Error("Vendor not found"), { status: 400 });
  }
  return vendorId;
}
