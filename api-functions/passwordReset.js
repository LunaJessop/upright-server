import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { pool } from "../lib/db.js";
import { getFrontendUrl, passwordMeetsPolicy } from "../lib/billing.js";
import {
  clientIp,
  consumeAuthRateLimit,
  inspectAuthRateLimit,
  rateLimitErrorMessage,
} from "../lib/authRateLimit.js";
import { sendEmail } from "../lib/email/index.js";

const RESET_TTL_MS = 60 * 60 * 1000;

export const FORGOT_PASSWORD_MESSAGE =
  "If an account exists for that email, we sent a reset link.";

export const RESET_PASSWORD_INVALID_MESSAGE =
  "This reset link is invalid or has expired. Request a new one.";

export const RESET_PASSWORD_SUCCESS_MESSAGE =
  "Your password has been updated. Log in with the new password.";

const PASSWORD_POLICY_MESSAGE =
  "Password must be at least 8 characters and include an uppercase letter and a non-alphanumeric character";

function dbQuery(sql, params) {
  return pool.query(sql, params);
}

function sendRateLimited(res, retryAfterSeconds) {
  const seconds = Math.max(1, Number(retryAfterSeconds) || 1);
  res.setHeader("Retry-After", String(seconds));
  return res.status(429).json({ error: rateLimitErrorMessage(seconds) });
}

export function hashResetToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function createResetToken() {
  return randomBytes(32).toString("base64url");
}

function resetUrl(token) {
  return `${getFrontendUrl()}/reset-password?token=${encodeURIComponent(token)}`;
}

async function issueResetToken(email) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query(
      `SELECT id, client_id, name, email, active
       FROM users
       WHERE LOWER(email) = LOWER($1)
       LIMIT 1`,
      [email]
    );
    const user = rows[0];
    if (!user || user.active !== true) {
      await db.query("COMMIT");
      return null;
    }

    const token = createResetToken();
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);

    await db.query(
      `UPDATE password_reset_tokens
       SET used_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND used_at IS NULL`,
      [user.id]
    );
    await db.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt]
    );
    await db.query("COMMIT");
    return { user, token, expiresAt };
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error(rollbackErr);
    }
    throw err;
  } finally {
    db.release();
  }
}

export async function forgotPassword(req, res) {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  const rateLimit = {
    action: "forgot_password",
    ip: clientIp(req),
    email,
  };
  const gate = await inspectAuthRateLimit(dbQuery, rateLimit);
  if (gate.limited) {
    return sendRateLimited(res, gate.retryAfterSeconds);
  }
  await consumeAuthRateLimit(dbQuery, rateLimit);

  try {
    const issued = await issueResetToken(email);
    if (issued) {
      await sendEmail({
        to: issued.user.email,
        template: "password_reset",
        data: {
          name: issued.user.name,
          resetUrl: resetUrl(issued.token),
        },
        clientId: issued.user.client_id,
        userId: issued.user.id,
      });
    }
  } catch (err) {
    console.error(err);
  }

  return res.json({ ok: true, message: FORGOT_PASSWORD_MESSAGE });
}

export async function resetPassword(req, res) {
  const token = String(req.body?.token ?? "").trim();
  const password = req.body?.password;

  if (!token || !password) {
    return res.status(400).json({ error: "Token and password are required" });
  }
  if (!passwordMeetsPolicy(password)) {
    return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
  }
  if (token.length < 20 || token.length > 200) {
    return res.status(400).json({ error: RESET_PASSWORD_INVALID_MESSAGE });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query(
      `SELECT t.id, t.user_id, t.expires_at, t.used_at, u.active
       FROM password_reset_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = $1
       FOR UPDATE OF t`,
      [hashResetToken(token)]
    );
    const row = rows[0];
    const expiresAt = row ? new Date(row.expires_at).getTime() : 0;
    const usable =
      row &&
      row.used_at == null &&
      row.active === true &&
      Number.isFinite(expiresAt) &&
      expiresAt > Date.now();

    if (!usable) {
      await db.query("ROLLBACK");
      return res.status(400).json({ error: RESET_PASSWORD_INVALID_MESSAGE });
    }

    await db.query(
      `UPDATE users
       SET password_hash = $1,
           token_version = token_version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [passwordHash, row.user_id]
    );
    await db.query(
      `UPDATE password_reset_tokens
       SET used_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND used_at IS NULL`,
      [row.user_id]
    );
    await db.query("COMMIT");
    return res.json({ ok: true, message: RESET_PASSWORD_SUCCESS_MESSAGE });
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error(rollbackErr);
    }
    console.error(err);
    return res.status(500).json({ error: "Could not reset password" });
  } finally {
    db.release();
  }
}
