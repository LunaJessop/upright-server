import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { billingFieldsFromClient } from "./billing.js";
import { pool } from "./db.js";
import { isMissingRelation, recordActivity } from "./activityLog.js";

const JWT_SECRET = process.env.JWT_SECRET?.trim();

if (!JWT_SECRET && !process.env.VERCEL) {
  console.warn(
    "JWT_SECRET is not set — auth tokens will fail. Add JWT_SECRET to upright-server/.env"
  );
}

/**
 * One primary-key lookup per authenticated request.
 * Identity (company, role, email, active) is read here and never from the JWT.
 */
export const USER_SESSION_LOOKUP_SQL = `SELECT u.id, u.client_id, u.email, u.role, u.active, u.token_version,
    c.active AS client_active
  FROM users u
  JOIN clients c ON c.id = u.client_id
  WHERE u.id = $1`;

/** Bumps users.token_version so every previously issued token stops matching. */
export const REVOKE_USER_TOKENS_SQL = `UPDATE users
  SET token_version = token_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = $1
  RETURNING id, token_version`;

export function logMissingTokenVersion(err) {
  if (err?.code === "42703" && String(err.message).includes("token_version")) {
    console.error(
      "users.token_version is missing. Run: node scripts/setup-token-version.js"
    );
    return true;
  }
  return false;
}

function invalidSession() {
  const err = new Error("Invalid or expired session");
  err.status = 401;
  return err;
}

export const IMPERSONATION_TTL_SECONDS = 30 * 60;

export const IMPERSONATION_END_PATH = "/api/admin/impersonation/end";

/**
 * Sign a 7-day session token. Only the user id and token version are stored.
 * Callers must not put clientId, role, or email in the token — requireAuth
 * loads those from the users row on every request.
 */
export function signAuthToken({ userId, tokenVersion }) {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured");
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("Cannot sign a session without a user id");
  }
  if (!Number.isInteger(tokenVersion) || tokenVersion < 0) {
    throw new Error("Cannot sign a session without a token version");
  }
  return jwt.sign({ userId, tv: tokenVersion }, JWT_SECRET, { expiresIn: "7d" });
}

/**
 * Short-lived read-only session. The target user id is who the app is viewing.
 * `aid` / `atv` are the real admin, so logout of that admin ends the session.
 * This is not the user's password and not one of the user's own login tokens.
 */
export function signImpersonationToken({ userId, adminUserId, adminTokenVersion }) {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured");
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("Cannot sign a session without a user id");
  }
  if (!Number.isInteger(adminUserId) || adminUserId <= 0 || adminUserId === userId) {
    throw new Error("Cannot sign an impersonation session without the admin id");
  }
  if (!Number.isInteger(adminTokenVersion) || adminTokenVersion < 0) {
    throw new Error("Cannot sign an impersonation session without the admin token version");
  }
  return jwt.sign(
    {
      imp: true,
      userId,
      aid: adminUserId,
      atv: adminTokenVersion,
      jti: randomBytes(16).toString("base64url"),
    },
    JWT_SECRET,
    { expiresIn: IMPERSONATION_TTL_SECONDS }
  );
}

export function publicImpersonation(auth) {
  if (!auth?.impersonating) return null;
  return {
    admin_email: auth.impersonating.admin_email,
    expires_at: auth.impersonating.expires_at,
  };
}

function requestPath(req) {
  return String(req.originalUrl || req.path || "").split("?")[0];
}

function impersonationWriteBlocked(req) {
  if (!req.auth?.impersonating) return false;
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET") return false;
  return !(method === "POST" && requestPath(req) === IMPERSONATION_END_PATH);
}

function auditImpersonatedRequest(req, res, auth) {
  res.on("finish", () => {
    const method = String(req.method || "GET").toUpperCase();
    const path = requestPath(req);
    void recordActivity({
      type: "admin_action",
      clientId: auth.clientId,
      userId: auth.impersonating.admin_user_id,
      email: auth.impersonating.admin_email,
      message: `${method} ${path}`,
      detail: {
        adminUserId: auth.impersonating.admin_user_id,
        adminEmail: auth.impersonating.admin_email,
        action: "impersonation_request",
        method,
        path,
        targetUserId: auth.userId,
      },
    });
  });
}

async function impersonationWasEnded(jti) {
  if (!jti) return true;
  try {
    const { rows } = await pool.query(
      `SELECT 1
       FROM admin_activity
       WHERE event_type = 'admin_action'
         AND detail->>'action' = 'impersonation_end'
         AND detail->>'jti' = $1
       LIMIT 1`,
      [jti]
    );
    return rows.length > 0;
  } catch (err) {
    if (isMissingRelation(err)) return false;
    console.error(err);
    return true;
  }
}

async function resolveImpersonation(payload, loadUser) {
  const userId = payload?.userId;
  const adminId = payload?.aid;
  const adminVersion = payload?.atv;
  if (
    payload?.imp !== true ||
    !Number.isInteger(userId) ||
    userId <= 0 ||
    !Number.isInteger(adminId) ||
    adminId <= 0 ||
    adminId === userId ||
    !Number.isInteger(adminVersion) ||
    adminVersion < 0 ||
    typeof payload?.jti !== "string" ||
    !payload.jti ||
    !Number.isInteger(payload?.iat) ||
    !Number.isInteger(payload?.exp) ||
    payload.exp - payload.iat > IMPERSONATION_TTL_SECONDS
  ) {
    throw invalidSession();
  }

  const [target, admin] = await Promise.all([loadUser(userId), loadUser(adminId)]);
  const targetId = Number(target?.id);
  const adminRowId = Number(admin?.id);
  if (!target || targetId !== userId || !Number.isInteger(Number(target.client_id))) {
    throw invalidSession();
  }
  if (
    !admin ||
    admin.active !== true ||
    admin.client_active === false ||
    adminRowId !== adminId ||
    Number(admin.token_version) !== adminVersion ||
    !isPlatformAdminEmail(admin.email) ||
    isPlatformAdminEmail(target.email)
  ) {
    throw invalidSession();
  }

  const clientId = Number(target.client_id);
  if (!Number.isInteger(clientId) || clientId <= 0) {
    throw invalidSession();
  }
  if (await impersonationWasEnded(payload.jti)) {
    throw invalidSession();
  }

  return {
    userId: targetId,
    clientId,
    role: target.role,
    email: target.email,
    impersonating: {
      admin_user_id: adminRowId,
      admin_email: admin.email,
      expires_at: new Date(payload.exp * 1000).toISOString(),
      read_only: true,
      jti: payload.jti,
    },
  };
}

export function verifyAuthToken(token) {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured");
  }
  return jwt.verify(token, JWT_SECRET);
}

export function isPlatformAdminEmail(email) {
  if (!email) return false;
  const raw = process.env.PLATFORM_ADMIN_EMAILS?.trim() ?? "";
  if (!raw) return false;
  const allowed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(String(email).trim().toLowerCase());
}

export async function findUserForAuth(userId) {
  const { rows } = await pool.query(USER_SESSION_LOOKUP_SQL, [userId]);
  return rows[0] ?? null;
}

/**
 * Invalidate every outstanding token for this user.
 * Logout uses this today. A future password change should call it in the
 * same transaction as the password update (log out everywhere).
 */
export async function revokeUserTokens(userId) {
  const { rows } = await pool.query(REVOKE_USER_TOKENS_SQL, [userId]);
  return rows[0] ?? null;
}

/**
 * Verify the signature, then resolve the caller from the current users row.
 * Tokens minted before token_version existed have no `tv` claim and are rejected.
 */
export async function resolveRequestAuth(token, loadUser = findUserForAuth) {
  let payload;
  try {
    payload = verifyAuthToken(token);
  } catch {
    throw invalidSession();
  }

  if (payload?.imp != null) {
    if (payload.imp !== true) throw invalidSession();
    return resolveImpersonation(payload, loadUser);
  }

  const userId = payload?.userId;
  const tokenVersion = payload?.tv;
  if (
    !Number.isInteger(userId) ||
    userId <= 0 ||
    !Number.isInteger(tokenVersion) ||
    tokenVersion < 0
  ) {
    throw invalidSession();
  }

  const user = await loadUser(userId);
  const rowId = Number(user?.id);
  if (!user || user.active !== true || user.client_active === false || !Number.isInteger(rowId) || rowId !== userId) {
    throw invalidSession();
  }

  const clientId = Number(user.client_id);
  if (!Number.isInteger(clientId) || clientId <= 0) {
    throw invalidSession();
  }

  const currentVersion = Number(user.token_version);
  if (!Number.isInteger(currentVersion) || currentVersion !== tokenVersion) {
    throw invalidSession();
  }

  return {
    userId: rowId,
    clientId,
    role: user.role,
    email: user.email,
  };
}

export function createRequireAuth(loadUser = findUserForAuth) {
  return function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }

    resolveRequestAuth(header.slice(7), loadUser).then(
      (auth) => {
        req.auth = auth;
        if (auth.impersonating) auditImpersonatedRequest(req, res, auth);
        if (impersonationWriteBlocked(req)) {
          return res.status(403).json({
            error: "Impersonation is read-only",
            code: "IMPERSONATION_READ_ONLY",
          });
        }
        next();
      },
      (err) => {
        if (res.headersSent) return;
        if (err.status === 401) {
          return res.status(401).json({ error: "Invalid or expired session" });
        }
        console.error(err);
        if (logMissingTokenVersion(err)) {
          return res.status(503).json({ error: "Server auth schema is out of date" });
        }
        return res.status(500).json({ error: "Failed to verify session" });
      }
    );
  };
}

export const requireAuth = createRequireAuth();

/** After requireAuth — compares PLATFORM_ADMIN_EMAILS to the database email. */
export function requirePlatformAdmin(req, res, next) {
  if (!isPlatformAdminEmail(req.auth?.email)) {
    return res.status(403).json({ error: "Platform admin required" });
  }
  next();
}

export function userResponse(row) {
  const billing = billingFieldsFromClient({
    subscription_status: row.subscription_status,
    past_due_started_at: row.past_due_started_at,
    stripe_price_id: row.stripe_price_id,
  });

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active ?? true,
    created_at: row.created_at ?? null,
    client_id: row.client_id,
    client_name: row.client_name ?? null,
    client_slug: row.client_slug ?? null,
    client_email: row.client_email ?? null,
    subscription_status: billing.subscription_status,
    grace_days_remaining: billing.grace_days_remaining,
    has_app_access: billing.has_app_access,
    has_read_access: billing.has_read_access,
    can_write: billing.can_write,
    read_only: billing.read_only,
    plan_price_id: billing.plan_price_id,
    is_platform_admin: isPlatformAdminEmail(row.email),
  };
}
