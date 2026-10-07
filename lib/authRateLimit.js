/**
 * Fixed-window auth rate limits stored in Postgres.
 *
 * In-memory counters reset on every Vercel serverless instance, so a
 * password spray would skip them. `auth_rate_limits` keeps one row per
 * action + scope + subject and resets `attempts` when the window rolls.
 * Create the table with scripts/setup-auth-rate-limits.js.
 *
 * If the table is missing or the database errors, checks fail open so a
 * migration lag cannot lock everyone out of login. The failure is logged
 * once per process.
 */

export const AUTH_RATE_LIMITS = {
  login: {
    // Failed passwords only. Five tries, then a 15-minute wait on that email.
    email: { limit: 5, windowMs: 15 * 60 * 1000 },
    // Shared NAT / office. Stops one address spraying many accounts.
    ip: { limit: 20, windowMs: 15 * 60 * 1000 },
  },
  register: {
    email: { limit: 5, windowMs: 60 * 60 * 1000 },
    ip: { limit: 10, windowMs: 60 * 60 * 1000 },
  },
  // Same window as login. Every request counts, including an unknown email.
  forgot_password: {
    email: { limit: 5, windowMs: 15 * 60 * 1000 },
    ip: { limit: 20, windowMs: 15 * 60 * 1000 },
  },
};

export const PEEK_SQL = `
SELECT attempts, window_start
FROM auth_rate_limits
WHERE action = $1 AND scope = $2 AND subject = $3
`;

export const CONSUME_SQL = `
INSERT INTO auth_rate_limits (action, scope, subject, window_start, attempts)
VALUES ($1, $2, $3, $4, 1)
ON CONFLICT (action, scope, subject)
DO UPDATE SET
  attempts = CASE
    WHEN auth_rate_limits.window_start = EXCLUDED.window_start
      THEN auth_rate_limits.attempts + 1
    ELSE 1
  END,
  window_start = EXCLUDED.window_start,
  updated_at = CURRENT_TIMESTAMP
RETURNING attempts
`;

const MAX_EMAIL_LENGTH = 320;
const MAX_IP_LENGTH = 64;

let loggedRateLimitFailure = false;

export function rateLimitErrorMessage(retryAfterSeconds) {
  const minutes = Math.max(1, Math.ceil(Number(retryAfterSeconds) / 60));
  const unit = minutes === 1 ? "minute" : "minutes";
  return `Too many attempts. Please try again in ${minutes} ${unit}.`;
}

export function normalizeRateLimitEmail(email) {
  return String(email ?? "")
    .trim()
    .toLowerCase()
    .slice(0, MAX_EMAIL_LENGTH);
}

export function normalizeRateLimitIp(ip) {
  const value = String(ip ?? "")
    .trim()
    .slice(0, MAX_IP_LENGTH);
  return value || "unknown";
}

function headerValue(req, name) {
  const headers = req?.headers;
  if (!headers) return "";
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return String(raw[0] ?? "");
  if (typeof raw === "string") return raw;
  return "";
}

function firstForwardedAddress(value) {
  return value.split(",")[0].trim();
}

/**
 * Client IP on Vercel. `x-vercel-forwarded-for` is set by the platform and
 * is not replaced by a proxy in front of it. `x-forwarded-for` is overwritten
 * by Vercel to block spoofing when there is no trusted proxy.
 */
export function clientIp(req) {
  const vercelForwarded = headerValue(req, "x-vercel-forwarded-for");
  if (vercelForwarded.trim()) {
    return normalizeRateLimitIp(firstForwardedAddress(vercelForwarded));
  }

  const forwarded = headerValue(req, "x-forwarded-for");
  if (forwarded.trim()) {
    return normalizeRateLimitIp(firstForwardedAddress(forwarded));
  }

  const realIp = headerValue(req, "x-real-ip");
  if (realIp.trim()) return normalizeRateLimitIp(realIp);

  return normalizeRateLimitIp(req?.ip || req?.socket?.remoteAddress || "");
}

function windowStartFor(nowMs, windowMs) {
  return new Date(Math.floor(nowMs / windowMs) * windowMs);
}

function sameWindow(stored, expected) {
  if (stored == null) return false;
  const storedMs = stored instanceof Date ? stored.getTime() : new Date(stored).getTime();
  return storedMs === expected.getTime();
}

function buildBuckets({ action, ip, email, now = new Date() }) {
  const rules = AUTH_RATE_LIMITS[action];
  if (!rules) {
    throw new Error(`Unknown auth rate limit action: ${action}`);
  }

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (Number.isNaN(nowMs)) {
    throw new Error("Invalid rate limit timestamp");
  }

  const buckets = [
    makeBucket(action, "ip", normalizeRateLimitIp(ip), rules.ip, nowMs),
  ];
  const normalizedEmail = normalizeRateLimitEmail(email);
  if (normalizedEmail) {
    buckets.push(
      makeBucket(action, "email", normalizedEmail, rules.email, nowMs)
    );
  }
  return buckets;
}

function makeBucket(action, scope, subject, rule, nowMs) {
  const windowStart = windowStartFor(nowMs, rule.windowMs);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowStart.getTime() + rule.windowMs - nowMs) / 1000)
  );
  return {
    action,
    scope,
    subject,
    limit: rule.limit,
    windowStart,
    retryAfterSeconds,
  };
}

function combineLimits(results) {
  let retryAfterSeconds = 0;
  let limited = false;
  for (const result of results) {
    if (!result?.limited) continue;
    limited = true;
    retryAfterSeconds = Math.max(retryAfterSeconds, result.retryAfterSeconds);
  }
  return { limited, retryAfterSeconds };
}

function failOpen(err) {
  if (!loggedRateLimitFailure) {
    loggedRateLimitFailure = true;
    console.error(
      "Auth rate limit check failed open. Run scripts/setup-auth-rate-limits.js if auth_rate_limits is missing:",
      err?.code ?? "",
      err?.message ?? err
    );
  }
  return { limited: false, retryAfterSeconds: 0 };
}

async function runBuckets(buckets, fn) {
  const settled = await Promise.allSettled(buckets.map((bucket) => fn(bucket)));
  const failures = settled.filter((entry) => entry.status === "rejected");
  const fulfilled = settled
    .filter((entry) => entry.status === "fulfilled")
    .map((entry) => entry.value);

  if (failures.length > 0) {
    const limited = combineLimits(fulfilled);
    if (limited.limited) return limited;
    return failOpen(failures[0].reason);
  }
  return combineLimits(fulfilled);
}

async function peekBucket(query, bucket) {
  const { rows } = await query(PEEK_SQL, [
    bucket.action,
    bucket.scope,
    bucket.subject,
  ]);
  const row = rows?.[0];
  if (!row || !sameWindow(row.window_start, bucket.windowStart)) {
    return { limited: false, retryAfterSeconds: 0 };
  }
  const attempts = Number(row.attempts) || 0;
  if (attempts >= bucket.limit) {
    return { limited: true, retryAfterSeconds: bucket.retryAfterSeconds };
  }
  return { limited: false, retryAfterSeconds: 0 };
}

async function consumeBucket(query, bucket) {
  await query(CONSUME_SQL, [
    bucket.action,
    bucket.scope,
    bucket.subject,
    bucket.windowStart,
  ]);
  return { limited: false, retryAfterSeconds: 0 };
}

export async function inspectAuthRateLimit(query, input) {
  const buckets = buildBuckets(input);
  try {
    return await runBuckets(buckets, (bucket) => peekBucket(query, bucket));
  } catch (err) {
    return failOpen(err);
  }
}

/** Counts an attempt. Call only after inspectAuthRateLimit allowed it. */
export async function consumeAuthRateLimit(query, input) {
  const buckets = buildBuckets(input);
  try {
    return await runBuckets(buckets, (bucket) => consumeBucket(query, bucket));
  } catch (err) {
    return failOpen(err);
  }
}
