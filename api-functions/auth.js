import bcrypt from "bcryptjs";
import { pool } from "../lib/db.js";
import { signAuthToken, userResponse } from "../lib/auth.js";
import {
  getStripe,
  passwordMeetsPolicy,
  uniqueSlug,
} from "../lib/billing.js";

export async function login(req, res) {
  const { email, password } = req.body ?? {};

  if (!email?.trim() || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.client_id, u.name, u.email, u.password_hash, u.role, u.active, u.created_at,
              c.name AS client_name,
              c.slug AS client_slug,
              c.email AS client_email,
              c.subscription_status, c.past_due_started_at, c.stripe_price_id
       FROM users u
       JOIN clients c ON c.id = u.client_id
       WHERE LOWER(u.email) = LOWER($1)`,
      [email.trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = rows[0];

    if (!user.active) {
      return res.status(403).json({ error: "This account is inactive" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signAuthToken({
      userId: user.id,
      clientId: user.client_id,
      role: user.role,
      email: user.email,
    });

    res.json({
      token,
      user: userResponse(user),
    });
  } catch (err) {
    console.error(err);
    if (err.message === "JWT_SECRET is not configured") {
      return res.status(503).json({
        error: "Server auth is not configured (JWT_SECRET missing)",
      });
    }
    res.status(500).json({ error: "Login failed" });
  }
}

export async function register(req, res) {
  const { companyName, name, email, password } = req.body ?? {};

  if (!companyName?.trim() || !name?.trim() || !email?.trim() || !password) {
    return res.status(400).json({
      error: "Company name, name, email, and password are required",
    });
  }

  if (!passwordMeetsPolicy(password)) {
    return res.status(400).json({
      error:
        "Password must be at least 8 characters and include an uppercase letter and a non-alphanumeric character",
    });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const trimmedCompany = companyName.trim();
  const trimmedName = name.trim();

  const db = await pool.connect();
  let clientId;
  let userRow;

  try {
    await db.query("BEGIN");

    const existing = await db.query(
      `SELECT 1 FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [normalizedEmail]
    );
    if (existing.rows.length > 0) {
      await db.query("ROLLBACK");
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const slug = await uniqueSlug(db, trimmedCompany);
    const clientInsert = await db.query(
      `INSERT INTO clients (name, slug, email, active, subscription_status)
       VALUES ($1, $2, $3, TRUE, 'incomplete')
       RETURNING id, name, email, subscription_status, past_due_started_at, stripe_price_id`,
      [trimmedCompany, slug, normalizedEmail]
    );
    clientId = clientInsert.rows[0].id;

    const passwordHash = await bcrypt.hash(password, 10);
    const userInsert = await db.query(
      `INSERT INTO users (client_id, name, email, password_hash, role, active)
       VALUES ($1, $2, $3, $4, 'founder', TRUE)
       RETURNING id, client_id, name, email, role, active`,
      [clientId, trimmedName, normalizedEmail, passwordHash]
    );

    userRow = {
      ...userInsert.rows[0],
      client_name: clientInsert.rows[0].name,
      subscription_status: clientInsert.rows[0].subscription_status,
      past_due_started_at: clientInsert.rows[0].past_due_started_at,
      stripe_price_id: clientInsert.rows[0].stripe_price_id,
    };

    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    console.error(err);
    if (err.code === "23505") {
      return res.status(409).json({ error: "An account with this email already exists" });
    }
    return res.status(500).json({ error: "Registration failed" });
  } finally {
    db.release();
  }

  // Optionally create Stripe customer now; plan + Checkout happen on /register/plan.
  try {
    const stripe = getStripe();
    const customer = await stripe.customers.create({
      email: normalizedEmail,
      name: trimmedCompany,
      metadata: { client_id: String(clientId) },
    });

    await pool.query(
      `UPDATE clients
       SET stripe_customer_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [customer.id, clientId]
    );
  } catch (err) {
    console.error("Stripe customer create after register failed:", err);
    // Account exists; checkout can create the customer later.
  }

  try {
    const token = signAuthToken({
      userId: userRow.id,
      clientId: userRow.client_id,
      role: userRow.role,
      email: userRow.email,
    });

    res.status(201).json({
      token,
      user: userResponse(userRow),
    });
  } catch (err) {
    console.error(err);
    if (err.message === "JWT_SECRET is not configured") {
      return res.status(503).json({
        error: "Server auth is not configured (JWT_SECRET missing)",
      });
    }
    res.status(500).json({ error: "Registration succeeded but session failed" });
  }
}

export async function getMe(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.client_id, u.name, u.email, u.role, u.active, u.created_at,
              c.name AS client_name,
              c.slug AS client_slug,
              c.email AS client_email,
              c.subscription_status, c.past_due_started_at, c.stripe_price_id
       FROM users u
       JOIN clients c ON c.id = u.client_id
       WHERE u.id = $1`,
      [req.auth.userId]
    );

    if (rows.length === 0 || !rows[0].active) {
      return res.status(401).json({ error: "User not found or inactive" });
    }

    res.json({ user: userResponse(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load session" });
  }
}

