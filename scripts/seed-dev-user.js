/**
 * Creates a local-dev client and founder user.
 *
 * Usage:
 *   node scripts/seed-dev-user.js
 *
 * Credentials (never hardcoded):
 *   SEED_DEV_EMAIL     optional, default dev-founder@localhost
 *   SEED_DEV_PASSWORD  optional. If unset, a random password is generated
 *                      and printed once after a successful seed. If set, it
 *                      must match the app password policy in lib/billing.js:
 *                      8+ characters, one uppercase letter, one symbol.
 *
 * The user is attached only to the client named "Upright Local Dev"
 * (slug upright-local-dev). An existing company is never reused, and a user
 * that already belongs to a different client is left unchanged.
 *
 * Refuses to run when NODE_ENV=production, when VERCEL is set, or when
 * DATABASE_URL is not a local database (localhost, 127.0.0.0/8, ::1, or a
 * Unix socket). To override that refusal:
 *   ALLOW_PRODUCTION_DEV_SEED=I_UNDERSTAND_THIS_CREATES_A_REAL_LOGIN
 */
import "dotenv/config";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import pg from "pg";

const { Pool } = pg;

export const DEV_CLIENT_NAME = "Upright Local Dev";
export const DEV_CLIENT_SLUG = "upright-local-dev";
export const DEV_USER_NAME = "Local Dev Founder";
export const DEFAULT_SEED_EMAIL = "dev-founder@localhost";

export const PRODUCTION_SEED_OVERRIDE_ENV = "ALLOW_PRODUCTION_DEV_SEED";
export const PRODUCTION_SEED_OVERRIDE_VALUE =
  "I_UNDERSTAND_THIS_CREATES_A_REAL_LOGIN";

/** Same rules as passwordMeetsPolicy in lib/billing.js. */
export function passwordMeetsPolicy(password) {
  if (typeof password !== "string" || password.length < 8) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[^A-Za-z0-9]/.test(password)) return false;
  return true;
}

function isLoopbackHost(host) {
  const normalized = String(host ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!octets) return false;
  return octets.slice(1).every((part) => Number(part) <= 255);
}

function readLibpqValues(connectionString, key) {
  const pattern = new RegExp(
    `(?:^|\\s)${key}=('(?:[^']|'')*'|"(?:[^"]|"")*"|\\S+)`,
    "gi"
  );
  const values = [];
  for (const match of connectionString.matchAll(pattern)) {
    let value = match[1];
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1).replace(/''/g, "'").replace(/""/g, '"');
    }
    values.push(value);
  }
  return values;
}

function hostsFromUri(connectionString) {
  const queryIndex = connectionString.indexOf("?");
  const withoutQuery =
    queryIndex === -1
      ? connectionString
      : connectionString.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : connectionString.slice(queryIndex + 1);
  const hosts = [];
  let localSocket = false;
  let params;

  try {
    const url = new URL(connectionString);
    params = url.searchParams;
    const hostname = url.hostname;
    if (!hostname) localSocket = true;
    else hosts.push(hostname);
  } catch {
    // libpq allows `postgresql://user:pass@/dbname` (empty host = socket).
    // WHATWG URL rejects an empty host when userinfo is present.
    const socketUri =
      /^postgres(?:ql)?:\/\/(?:[^@/?\s]+@)?\/[^?\s]*$/i.test(withoutQuery);
    if (!socketUri) {
      return { ok: false };
    }
    localSocket = true;
    params = new URLSearchParams(query);
  }

  for (const key of ["host", "hostaddr"]) {
    const value = params.get(key);
    if (value == null || value === "") continue;
    if (value.startsWith("/")) localSocket = true;
    else hosts.push(value);
  }

  return { ok: true, hosts, localSocket };
}

function hostsFromKeywordString(connectionString) {
  const hostValues = readLibpqValues(connectionString, "host");
  const hostaddrValues = readLibpqValues(connectionString, "hostaddr");
  const hosts = [];
  let localSocket = false;

  if (hostValues.length === 0 && hostaddrValues.length === 0) {
    localSocket = true;
  } else {
    for (const host of hostValues) {
      if (host.startsWith("/")) localSocket = true;
      else if (host !== "") hosts.push(host);
    }
    for (const hostaddr of hostaddrValues) {
      if (hostaddr !== "") hosts.push(hostaddr);
    }
  }

  return { ok: true, hosts, localSocket };
}

/**
 * @returns {string | null} a reason DATABASE_URL is not a local database, or null if it is local.
 * Missing URL is not itself a production signal.
 */
export function nonLocalDatabaseReason(connectionString) {
  const raw = String(connectionString ?? "").trim();
  if (!raw) return null;

  const parsed = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? hostsFromUri(raw)
    : raw.includes("=")
      ? hostsFromKeywordString(raw)
      : { ok: false };

  if (!parsed.ok) {
    return "DATABASE_URL could not be parsed; refusing to treat it as local";
  }

  const remote = parsed.hosts.filter((host) => !isLoopbackHost(host));
  if (remote.length > 0) {
    return `DATABASE_URL host "${remote[0]}" is not local`;
  }
  if (parsed.hosts.length === 0 && !parsed.localSocket) {
    return "DATABASE_URL host could not be determined; refusing to treat it as local";
  }
  return null;
}

/** @returns {string[]} human-readable reasons this process looks like production. */
export function productionSeedBlockers(env) {
  const reasons = [];
  if (String(env.NODE_ENV ?? "").trim() === "production") {
    reasons.push("NODE_ENV=production");
  }
  if (String(env.VERCEL ?? "").trim() !== "") {
    reasons.push("VERCEL is set");
  }
  const databaseReason = nonLocalDatabaseReason(env.DATABASE_URL);
  if (databaseReason) reasons.push(databaseReason);
  return reasons;
}

export function overrideAllowsProductionSeed(env) {
  return (
    String(env[PRODUCTION_SEED_OVERRIDE_ENV] ?? "").trim() ===
    PRODUCTION_SEED_OVERRIDE_VALUE
  );
}

export function formatProductionRefusal(reasons) {
  return [
    "Refusing to seed a dev login. This environment looks like production:",
    ...reasons.map((reason) => `  - ${reason}`),
    "",
    "This script creates a login and sets that client's subscription_status to active.",
    "Running it against a real database can expose that company to anyone who knows the password.",
    "",
    "It will not run unless you set:",
    `  ${PRODUCTION_SEED_OVERRIDE_ENV}=${PRODUCTION_SEED_OVERRIDE_VALUE}`,
  ].join("\n");
}

function generatePassword(randomBytes) {
  const body = randomBytes(18).toString("base64url");
  const password = `A!${body}`;
  if (!passwordMeetsPolicy(password)) {
    throw new Error("Generated password did not meet policy");
  }
  return password;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ randomBytes?: (size: number) => Buffer }} [deps]
 */
export function resolveSeedCredentials(env, deps = {}) {
  const email = String(env.SEED_DEV_EMAIL ?? DEFAULT_SEED_EMAIL)
    .trim()
    .toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    return {
      error:
        "SEED_DEV_EMAIL must be an email address (default is dev-founder@localhost).",
    };
  }

  const provided = env.SEED_DEV_PASSWORD;
  if (provided != null && String(provided).length > 0) {
    const password = String(provided);
    if (!passwordMeetsPolicy(password)) {
      return {
        error:
          "SEED_DEV_PASSWORD does not meet the password policy: at least 8 characters, an uppercase letter, and a non-alphanumeric character.",
      };
    }
    return { email, password, generated: false };
  }

  const randomBytes = deps.randomBytes ?? crypto.randomBytes;
  return { email, password: generatePassword(randomBytes), generated: true };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

async function seedDevClient(db, email, passwordHash) {
  const existingClient = await db.query(
    `SELECT id, name FROM clients WHERE slug = $1`,
    [DEV_CLIENT_SLUG]
  );

  let clientId;
  if (existingClient.rows.length > 0) {
    const row = existingClient.rows[0];
    if (row.name !== DEV_CLIENT_NAME) {
      throw new Error(
        `Client slug "${DEV_CLIENT_SLUG}" is already used by "${row.name}". Refusing to attach a dev login to it.`
      );
    }
    const updated = await db.query(
      `UPDATE clients
       SET subscription_status = 'active',
           active = TRUE
       WHERE id = $1
         AND slug = $2
         AND name = $3
       RETURNING id`,
      [row.id, DEV_CLIENT_SLUG, DEV_CLIENT_NAME]
    );
    if (updated.rows.length === 0) {
      throw new Error(
        `Refusing to update client ${row.id}: it no longer matches the local dev client.`
      );
    }
    clientId = updated.rows[0].id;
  } else {
    const inserted = await db.query(
      `INSERT INTO clients (name, slug, email, active, subscription_status)
       VALUES ($1, $2, $3, TRUE, 'active')
       RETURNING id`,
      [DEV_CLIENT_NAME, DEV_CLIENT_SLUG, email]
    );
    clientId = inserted.rows[0].id;
  }

  const existingUser = await db.query(
    `SELECT id, client_id FROM users WHERE LOWER(email) = LOWER($1)`,
    [email]
  );
  if (existingUser.rows.length > 0) {
    const user = existingUser.rows[0];
    if (String(user.client_id) !== String(clientId)) {
      throw new Error(
        `User ${email} already belongs to client ${user.client_id}, not the local dev client (${clientId}). Refusing to reset that password or move the user. Set SEED_DEV_EMAIL to a different address.`
      );
    }
    await db.query(
      `UPDATE users
       SET password_hash = $1,
           role = 'founder',
           active = TRUE,
           name = $2
       WHERE id = $3
         AND client_id = $4`,
      [passwordHash, DEV_USER_NAME, user.id, clientId]
    );
  } else {
    await db.query(
      `INSERT INTO users (client_id, name, email, password_hash, role, active)
       VALUES ($1, $2, $3, $4, 'founder', TRUE)`,
      [clientId, DEV_USER_NAME, email, passwordHash]
    );
  }

  return clientId;
}

async function main() {
  const blockers = productionSeedBlockers(process.env);
  if (blockers.length > 0 && !overrideAllowsProductionSeed(process.env)) {
    console.error(formatProductionRefusal(blockers));
    process.exit(1);
  }
  if (blockers.length > 0) {
    console.warn(
      [
        "WARNING: production safety checks were overridden.",
        "This still only creates or updates the dedicated local-dev client.",
        `Override: ${PRODUCTION_SEED_OVERRIDE_ENV}`,
      ].join("\n")
    );
  }

  const credentials = resolveSeedCredentials(process.env);
  if (credentials.error) {
    console.error(credentials.error);
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ...(connectionString.includes("neon.tech")
      ? { ssl: { rejectUnauthorized: true } }
      : {}),
  });

  const passwordHash = await bcrypt.hash(credentials.password, 10);
  let db;
  let clientId;
  try {
    db = await pool.connect();
    await db.query("BEGIN");
    clientId = await seedDevClient(db, credentials.email, passwordHash);
    await db.query("COMMIT");
  } catch (err) {
    if (db) {
      try {
        await db.query("ROLLBACK");
      } catch {
        // The connection may already be unusable.
      }
    }
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  } finally {
    db?.release();
    await pool.end();
  }

  console.log("Seed complete.");
  console.log(`  Client:    ${DEV_CLIENT_NAME} (${DEV_CLIENT_SLUG})`);
  console.log(`  Client id: ${clientId}`);
  console.log(`  Email:     ${credentials.email}`);
  if (credentials.generated) {
    console.log(`  Password:  ${credentials.password}`);
    console.log("  (generated password shown once; it is not stored in the repo)");
  } else {
    console.log("  Password:  (from SEED_DEV_PASSWORD)");
  }
  console.log("  Billing:   subscription_status=active on the local dev client only");
}

if (invokedDirectly()) {
  void main();
}
