import { pool } from "../lib/db.js";
import { recordActivity } from "../lib/activityLog.js";
import {
  isPlatformAdminEmail,
  signAuthToken,
  signImpersonationToken,
  userResponse,
} from "../lib/auth.js";

function confirmationError(body) {
  if (body?.confirm === true) return null;
  return {
    status: 400,
    body: {
      error: "Confirm this action with confirm: true",
      code: "CONFIRMATION_REQUIRED",
    },
  };
}

function reasonFrom(body) {
  if (typeof body?.reason !== "string") return null;
  const reason = body.reason.trim();
  if (!reason || reason.length > 500) return null;
  return reason;
}

function ids(customerIdRaw, userIdRaw) {
  const customerId = Number(customerIdRaw);
  const userId = Number(userIdRaw);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return { error: { status: 400, body: { error: "Invalid customer id" } } };
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    return { error: { status: 400, body: { error: "Invalid user id" } } };
  }
  return { customerId, userId };
}

export async function startImpersonation(req, res) {
  const blocked = confirmationError(req.body);
  if (blocked) return res.status(blocked.status).json(blocked.body);
  const reason = reasonFrom(req.body);
  if (!reason) {
    return res.status(400).json({ error: "A reason is required" });
  }
  const parsed = ids(req.params.id, req.params.userId);
  if (parsed.error) return res.status(parsed.error.status).json(parsed.error.body);
  if (parsed.userId === req.auth?.userId) {
    return res.status(403).json({
      error: "Cannot impersonate a platform admin",
      code: "IMPERSONATION_FORBIDDEN",
    });
  }

  try {
    const targetResult = await pool.query(
      `SELECT id, client_id, name, email, role, active
       FROM users
       WHERE id = $1 AND client_id = $2`,
      [parsed.userId, parsed.customerId]
    );
    const target = targetResult.rows[0];
    if (!target) return res.status(404).json({ error: "User not found" });
    if (isPlatformAdminEmail(target.email)) {
      return res.status(403).json({
        error: "Cannot impersonate a platform admin",
        code: "IMPERSONATION_FORBIDDEN",
      });
    }

    const adminResult = await pool.query(
      `SELECT id, email, active, token_version
       FROM users
       WHERE id = $1`,
      [req.auth.userId]
    );
    const admin = adminResult.rows[0];
    const adminVersion = Number(admin?.token_version);
    if (
      !admin ||
      admin.active !== true ||
      !isPlatformAdminEmail(admin.email) ||
      !Number.isInteger(adminVersion) ||
      adminVersion < 0
    ) {
      return res.status(403).json({ error: "Platform admin required" });
    }

    const token = signImpersonationToken({
      userId: target.id,
      adminUserId: admin.id,
      adminTokenVersion: adminVersion,
    });
    const decoded = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    );
    const expiresAt = new Date(decoded.exp * 1000).toISOString();

    res.locals = res.locals ?? {};
    res.locals.adminAudit = {
      action: "impersonation_start",
      clientId: parsed.customerId,
      userId: admin.id,
      recordType: "user",
      recordId: String(target.id),
      message: "Started view-as-user",
      before: null,
      after: {
        target_user_id: target.id,
        target_email: target.email,
        reason,
        read_only: true,
        expires_at: expiresAt,
        jti: decoded.jti,
      },
    };

    res.json({
      token,
      expires_at: expiresAt,
      impersonating: {
        admin_email: admin.email,
        expires_at: expiresAt,
      },
      user: {
        id: target.id,
        client_id: target.client_id,
        name: target.name,
        email: target.email,
        role: target.role,
        active: target.active ?? true,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to start view-as-user" });
  }
}

export async function endImpersonation(req, res) {
  const session = req.auth?.impersonating;
  if (!session?.admin_user_id || !session.jti) {
    return res.status(400).json({ error: "Not impersonating" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.client_id, u.name, u.email, u.role, u.active, u.token_version, u.created_at,
              c.name AS client_name,
              c.slug AS client_slug,
              c.email AS client_email,
              c.subscription_status, c.past_due_started_at, c.stripe_price_id
       FROM users u
       JOIN clients c ON c.id = u.client_id
       WHERE u.id = $1`,
      [session.admin_user_id]
    );
    const admin = rows[0];
    const adminVersion = Number(admin?.token_version);
    if (
      !admin ||
      admin.active !== true ||
      !isPlatformAdminEmail(admin.email) ||
      !Number.isInteger(adminVersion) ||
      adminVersion < 0
    ) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const token = signAuthToken({
      userId: admin.id,
      tokenVersion: adminVersion,
    });
    await recordActivity({
      type: "admin_action",
      clientId: req.auth.clientId,
      userId: admin.id,
      email: admin.email,
      message: "Ended view-as-user",
      detail: {
        adminUserId: admin.id,
        adminEmail: admin.email,
        action: "impersonation_end",
        recordType: "user",
        recordId: String(req.auth.userId),
        targetUserId: req.auth.userId,
        jti: session.jti,
      },
    });
    res.json({
      token,
      impersonating: null,
      user: userResponse(admin),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to end view-as-user" });
  }
}
