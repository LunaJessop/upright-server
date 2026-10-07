import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  AUTH_RATE_LIMITS,
  CONSUME_SQL,
  PEEK_SQL,
  clientIp,
  consumeAuthRateLimit,
  inspectAuthRateLimit,
  rateLimitErrorMessage,
} from "../lib/authRateLimit.js";

function createMemoryQuery() {
  const rows = new Map();
  return {
    rows,
    async query(sql, params) {
      if (sql.includes("INSERT INTO auth_rate_limits")) {
        const [action, scope, subject, windowStart] = params;
        const windowIso = new Date(windowStart).toISOString();
        const key = `${action}\0${scope}\0${subject}`;
        const existing = rows.get(key);
        const attempts =
          existing && existing.windowStart === windowIso ? existing.attempts + 1 : 1;
        rows.set(key, { windowStart: windowIso, attempts });
        return { rows: [{ attempts }] };
      }
      if (sql.includes("FROM auth_rate_limits")) {
        const [action, scope, subject] = params;
        const existing = rows.get(`${action}\0${scope}\0${subject}`);
        if (!existing) return { rows: [] };
        return {
          rows: [
            {
              attempts: existing.attempts,
              window_start: new Date(existing.windowStart),
            },
          ],
        };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

describe("auth rate limit policy", () => {
  it("allows a handful of failed logins per email per 15 minutes", () => {
    assert.equal(AUTH_RATE_LIMITS.login.email.limit, 5);
    assert.equal(AUTH_RATE_LIMITS.login.email.windowMs, 15 * 60 * 1000);
    assert.equal(AUTH_RATE_LIMITS.login.ip.limit, 20);
    assert.equal(AUTH_RATE_LIMITS.login.ip.windowMs, 15 * 60 * 1000);
    assert.equal(AUTH_RATE_LIMITS.register.email.limit, 5);
    assert.equal(AUTH_RATE_LIMITS.register.email.windowMs, 60 * 60 * 1000);
    assert.equal(AUTH_RATE_LIMITS.register.ip.limit, 10);
    assert.equal(AUTH_RATE_LIMITS.register.ip.windowMs, 60 * 60 * 1000);
    assert.equal(
      AUTH_RATE_LIMITS.forgot_password.email.limit,
      AUTH_RATE_LIMITS.login.email.limit
    );
    assert.equal(
      AUTH_RATE_LIMITS.forgot_password.email.windowMs,
      AUTH_RATE_LIMITS.login.email.windowMs
    );
    assert.equal(
      AUTH_RATE_LIMITS.forgot_password.ip.limit,
      AUTH_RATE_LIMITS.login.ip.limit
    );
    assert.equal(
      AUTH_RATE_LIMITS.forgot_password.ip.windowMs,
      AUTH_RATE_LIMITS.login.ip.windowMs
    );
  });

  it("describes the wait in minutes for the response body", () => {
    assert.equal(
      rateLimitErrorMessage(1),
      "Too many attempts. Please try again in 1 minute."
    );
    assert.equal(
      rateLimitErrorMessage(15 * 60),
      "Too many attempts. Please try again in 15 minutes."
    );
    assert.equal(
      rateLimitErrorMessage(60 * 60),
      "Too many attempts. Please try again in 60 minutes."
    );
  });

  it("keeps the counter query atomic and parameterized", () => {
    assert.match(PEEK_SQL, /WHERE action = \$1 AND scope = \$2 AND subject = \$3/);
    assert.match(CONSUME_SQL, /INSERT INTO auth_rate_limits/);
    assert.match(CONSUME_SQL, /ON CONFLICT \(action, scope, subject\)/);
    assert.match(CONSUME_SQL, /WHEN auth_rate_limits\.window_start = EXCLUDED\.window_start/);
    assert.match(CONSUME_SQL, /RETURNING attempts/);
    assert.doesNotMatch(CONSUME_SQL, /\$\{/);
  });

  it("setup script creates the primary key the upsert conflicts on", () => {
    const source = readFileSync(
      new URL("../scripts/setup-auth-rate-limits.js", import.meta.url),
      "utf8"
    );
    assert.match(source, /CREATE TABLE auth_rate_limits/);
    assert.match(source, /PRIMARY KEY \(action, scope, subject\)/);
    assert.match(source, /window_start TIMESTAMPTZ NOT NULL/);
    assert.match(source, /attempts INTEGER NOT NULL/);
  });
});

describe("auth rate limit counters", { concurrency: 1 }, () => {
  it("blocks the next login for that email after five failures and resets the window", async () => {
    const db = createMemoryQuery();
    const start = new Date("2026-01-01T00:00:00.000Z");
    const input = {
      action: "login",
      ip: "203.0.113.10",
      email: "User@Example.com",
      now: start,
    };

    for (let n = 0; n < 5; n += 1) {
      const gate = await inspectAuthRateLimit(db.query.bind(db), input);
      assert.equal(gate.limited, false);
      await consumeAuthRateLimit(db.query.bind(db), input);
    }

    const blocked = await inspectAuthRateLimit(db.query.bind(db), {
      ...input,
      now: new Date("2026-01-01T00:14:59.000Z"),
      ip: "203.0.113.99",
    });
    assert.equal(blocked.limited, true);
    assert.equal(blocked.retryAfterSeconds, 1);

    const freshWindow = await inspectAuthRateLimit(db.query.bind(db), {
      ...input,
      now: new Date("2026-01-01T00:15:00.000Z"),
    });
    assert.equal(freshWindow.limited, false);
  });

  it("limits an IP spraying many emails without blocking a different address early", async () => {
    const db = createMemoryQuery();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const query = db.query.bind(db);

    for (let n = 0; n < 5; n += 1) {
      await consumeAuthRateLimit(query, {
        action: "login",
        ip: "203.0.113.10",
        email: `person-${n}@example.com`,
        now,
      });
    }

    const sameIpNewEmail = await inspectAuthRateLimit(query, {
      action: "login",
      ip: "203.0.113.10",
      email: "someone-else@example.com",
      now,
    });
    assert.equal(sameIpNewEmail.limited, false);

    for (let n = 5; n < 20; n += 1) {
      await consumeAuthRateLimit(query, {
        action: "login",
        ip: "203.0.113.10",
        email: `person-${n}@example.com`,
        now,
      });
    }

    const ipBlocked = await inspectAuthRateLimit(query, {
      action: "login",
      ip: "203.0.113.10",
      email: "new-person@example.com",
      now,
    });
    assert.equal(ipBlocked.limited, true);

    const otherIp = await inspectAuthRateLimit(query, {
      action: "login",
      ip: "203.0.113.11",
      email: "new-person@example.com",
      now,
    });
    assert.equal(otherIp.limited, false);
  });

  it("caps registration per IP per hour and folds email case into one bucket", async () => {
    const db = createMemoryQuery();
    const query = db.query.bind(db);
    const start = new Date("2026-01-01T00:00:00.000Z");

    for (let n = 0; n < 5; n += 1) {
      await consumeAuthRateLimit(query, {
        action: "register",
        ip: "203.0.113.20",
        email: n % 2 === 0 ? "Owner@Company.com" : "owner@company.com",
        now: start,
      });
    }

    const sameEmail = await inspectAuthRateLimit(query, {
      action: "register",
      ip: "198.51.100.8",
      email: "OWNER@company.com",
      now: new Date("2026-01-01T00:30:00.000Z"),
    });
    assert.equal(sameEmail.limited, true);
    assert.equal(sameEmail.retryAfterSeconds, 30 * 60);

    const later = await inspectAuthRateLimit(query, {
      action: "register",
      ip: "198.51.100.8",
      email: "owner@company.com",
      now: new Date("2026-01-01T01:00:00.000Z"),
    });
    assert.equal(later.limited, false);

    for (let n = 0; n < 10; n += 1) {
      await consumeAuthRateLimit(query, {
        action: "register",
        ip: "203.0.113.77",
        email: `signup-${n}@example.com`,
        now: start,
      });
    }
    const ipBlocked = await inspectAuthRateLimit(query, {
      action: "register",
      ip: "203.0.113.77",
      email: "signup-new@example.com",
      now: start,
    });
    assert.equal(ipBlocked.limited, true);
  });

  it("fails open when the rate limit table is missing", async () => {
    const err = new Error('relation "auth_rate_limits" does not exist');
    err.code = "42P01";
    const query = async () => {
      throw err;
    };
    const original = console.error;
    const logged = [];
    console.error = (...args) => {
      logged.push(args.map((part) => String(part)).join(" "));
    };
    try {
      const result = await inspectAuthRateLimit(query, {
        action: "login",
        ip: "203.0.113.5",
        email: "a@example.com",
      });
      assert.deepEqual(result, { limited: false, retryAfterSeconds: 0 });
      assert.match(logged.join("\n"), /setup-auth-rate-limits\.js/);
    } finally {
      console.error = original;
    }
  });

  it("still blocks when one bucket is already over the limit and the other query fails", async () => {
    const windowMs = AUTH_RATE_LIMITS.login.ip.windowMs;
    const now = new Date("2026-01-01T00:07:00.000Z");
    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const query = async (_sql, params) => {
      if (params[1] === "email") throw new Error("connection reset");
      return { rows: [{ attempts: 20, window_start: windowStart }] };
    };
    const result = await inspectAuthRateLimit(query, {
      action: "login",
      ip: "203.0.113.5",
      email: "a@example.com",
      now,
    });
    assert.equal(result.limited, true);
  });
});

describe("client IP", () => {
  it("prefers the Vercel header over a spoofed forwarded-for list", () => {
    const ip = clientIp({
      headers: {
        "x-vercel-forwarded-for": " 203.0.113.5, 10.0.0.8 ",
        "x-forwarded-for": "198.51.100.20",
        "x-real-ip": "192.0.2.9",
      },
      ip: "10.0.0.1",
    });
    assert.equal(ip, "203.0.113.5");
  });

  it("uses the first x-forwarded-for address when Vercel did not set one", () => {
    const ip = clientIp({
      headers: { "x-forwarded-for": ["198.51.100.20, 10.1.1.1"] },
      ip: "10.0.0.1",
    });
    assert.equal(ip, "198.51.100.20");
  });

  it("falls back to the socket address for local requests", () => {
    assert.equal(clientIp({ headers: {}, ip: "::1" }), "::1");
    assert.equal(clientIp({ headers: {} }), "unknown");
  });
});
