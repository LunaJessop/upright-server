import bcrypt from "bcryptjs";
import { pool } from "../lib/db.js";
import {
  billingFieldsFromClient,
  passwordMeetsPolicy,
} from "../lib/billing.js";

const ALLOWED_ROLES = new Set(["founder", "admin", "user"]);

function clientPayload(row) {
  const billing = billingFieldsFromClient(row);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    email: row.email,
    phone: row.phone,
    active: row.active,
    created_at: row.created_at,
    subscription_status: billing.subscription_status,
    grace_days_remaining: billing.grace_days_remaining,
    has_app_access: billing.has_app_access,
    has_read_access: billing.has_read_access,
    can_write: billing.can_write,
    read_only: billing.read_only,
    plan_price_id: billing.plan_price_id,
  };
}

function teamMemberPayload(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active,
    created_at: row.created_at,
  };
}

export async function getClient(req, res) {
  try {
    const { rows: clientRows } = await pool.query(
      `SELECT id, name, slug, email, phone, active, created_at,
              subscription_status, past_due_started_at, stripe_price_id
       FROM clients
       WHERE id = $1`,
      [req.auth.clientId]
    );

    if (clientRows.length === 0) {
      return res.status(404).json({ error: "Client not found" });
    }

    const { rows: members } = await pool.query(
      `SELECT id, name, email, role, active, created_at
       FROM users
       WHERE client_id = $1
       ORDER BY
         CASE role
           WHEN 'founder' THEN 1
           WHEN 'admin' THEN 2
           ELSE 3
         END,
         name ASC`,
      [req.auth.clientId]
    );

    res.json({
      client: clientPayload(clientRows[0]),
      members: members.map(teamMemberPayload),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load client" });
  }
}

export async function createClientUser(req, res) {
  const { name, email, password, role } = req.body ?? {};

  if (!name?.trim() || !email?.trim() || !password) {
    return res.status(400).json({
      error: "Name, email, and password are required",
    });
  }

  const normalizedRole = String(role ?? "user").toLowerCase();
  if (!ALLOWED_ROLES.has(normalizedRole)) {
    return res.status(400).json({
      error: "Role must be founder, admin, or user",
    });
  }

  if (!passwordMeetsPolicy(password)) {
    return res.status(400).json({
      error:
        "Password must be at least 8 characters and include an uppercase letter and a non-alphanumeric character",
    });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const existing = await pool.query(
      `SELECT 1 FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [normalizedEmail]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (client_id, name, email, password_hash, role, active)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING id, name, email, role, active, created_at`,
      [
        req.auth.clientId,
        name.trim(),
        normalizedEmail,
        passwordHash,
        normalizedRole,
      ]
    );

    res.status(201).json({ user: teamMemberPayload(rows[0]) });
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      return res.status(409).json({ error: "An account with this email already exists" });
    }
    res.status(500).json({ error: "Failed to create user" });
  }
}
