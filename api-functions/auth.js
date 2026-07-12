import bcrypt from "bcryptjs";
import { pool } from "../index.js";
import { signAuthToken, userResponse } from "../lib/auth.js";

export async function login(req, res) {
  const { email, password } = req.body ?? {};

  if (!email?.trim() || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.client_id, u.name, u.email, u.password_hash, u.role, u.active,
              c.name AS client_name
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

export async function getMe(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.client_id, u.name, u.email, u.role, u.active,
              c.name AS client_name
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
