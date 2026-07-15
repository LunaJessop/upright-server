import jwt from "jsonwebtoken";
import { billingFieldsFromClient } from "./billing.js";

const JWT_SECRET = process.env.JWT_SECRET?.trim();

if (!JWT_SECRET && !process.env.VERCEL) {
  console.warn(
    "JWT_SECRET is not set — auth tokens will fail. Add JWT_SECRET to upright-server/.env"
  );
}

export function signAuthToken(payload) {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured");
  }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyAuthToken(token) {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured");
  }
  return jwt.verify(token, JWT_SECRET);
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }
  try {
    const payload = verifyAuthToken(header.slice(7));
    req.auth = {
      userId: payload.userId,
      clientId: payload.clientId,
      role: payload.role,
      email: payload.email,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
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
  };
}
