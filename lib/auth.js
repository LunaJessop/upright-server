import jwt from "jsonwebtoken";

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
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    client_id: row.client_id,
    client_name: row.client_name ?? null,
  };
}
