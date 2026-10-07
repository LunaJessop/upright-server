import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_password_reset_test";
process.env.FRONTEND_URL = "https://app.example.com";
process.env.JWT_SECRET ??= "test-jwt-secret-not-for-production";
delete process.env.RESEND_API_KEY;

const { pool } = await import("../lib/db.js");
const { AUTH_RATE_LIMITS } = await import("../lib/authRateLimit.js");
const { resetEmailForTests, setResendForTests } = await import("../lib/email/index.js");
const {
  FORGOT_PASSWORD_MESSAGE,
  RESET_PASSWORD_INVALID_MESSAGE,
  RESET_PASSWORD_SUCCESS_MESSAGE,
  forgotPassword,
  resetPassword,
} = await import("../api-functions/passwordReset.js");

pool.options.connectionTimeoutMillis = 500;

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function mockReq(body) {
  return {
    body,
    headers: { "x-vercel-forwarded-for": "203.0.113.5" },
    ip: "10.0.0.1",
    socket: { remoteAddress: "10.0.0.1" },
  };
}

function windowStart(scope) {
  const windowMs = AUTH_RATE_LIMITS.forgot_password[scope].windowMs;
  return new Date(Math.floor(Date.now() / windowMs) * windowMs);
}

function installForgot({ user = null, limited = false } = {}) {
  const queries = [];
  const sent = [];
  setResendForTests({
    emails: {
      async send(payload) {
        sent.push(payload);
        return { data: { id: "msg_reset" }, error: null };
      },
    },
  });

  pool.query = async (sql, params = []) => {
    const text = String(sql);
    queries.push({ sql: text, params });
    if (text.includes("FROM auth_rate_limits")) {
      if (!limited) return { rows: [] };
      const scope = params[1];
      return {
        rows: [
          {
            attempts: AUTH_RATE_LIMITS.forgot_password[scope].limit,
            window_start: windowStart(scope),
          },
        ],
      };
    }
    if (text.includes("INSERT INTO auth_rate_limits")) {
      return { rows: [{ attempts: 1 }] };
    }
    if (text.includes("INSERT INTO email_log")) return { rows: [{ id: 1 }] };
    return { rows: [] };
  };

  pool.connect = async () => ({
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [] };
      }
      if (text.includes("FROM users")) {
        return { rows: user ? [user] : [] };
      }
      return { rows: [] };
    },
    release() {},
  });

  return { queries, sent };
}

function installReset(tokenRow) {
  const queries = [];
  const state = {
    token: tokenRow ? { ...tokenRow } : null,
    passwordHash: "old-hash",
    tokenVersion: 2,
  };

  pool.connect = async () => ({
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [] };
      }
      if (text.includes("FROM password_reset_tokens")) {
        if (!state.token || state.token.token_hash !== params[0]) return { rows: [] };
        return { rows: [{ ...state.token }] };
      }
      if (text.includes("UPDATE users")) {
        state.passwordHash = params[0];
        state.tokenVersion += 1;
        return { rows: [{ id: params[1], token_version: state.tokenVersion }] };
      }
      if (text.includes("UPDATE password_reset_tokens")) {
        if (state.token && state.token.user_id === params[0] && state.token.used_at == null) {
          state.token.used_at = new Date();
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  });

  return { queries, state };
}

after(async () => {
  resetEmailForTests();
  await pool.end();
});

describe("POST /api/auth/forgot-password", { concurrency: 1 }, () => {
  it("is wired without auth", () => {
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    assert.match(source, /app\.post\("\/api\/auth\/forgot-password", forgotPassword\)/);
    assert.match(source, /app\.post\("\/api\/auth\/reset-password", resetPassword\)/);
  });

  it("returns the same success for an unknown email and does not send", async () => {
    const unknown = installForgot();
    const unknownRes = mockRes();
    await forgotPassword(mockReq({ email: "missing@example.com" }), unknownRes);

    const known = installForgot({
      user: {
        id: 8,
        client_id: 4,
        name: "Ada",
        email: "ada@example.com",
        active: true,
      },
    });
    const knownRes = mockRes();
    await forgotPassword(mockReq({ email: "Ada@Example.com" }), knownRes);

    assert.equal(unknownRes.statusCode, 200);
    assert.equal(knownRes.statusCode, 200);
    assert.deepEqual(unknownRes.body, knownRes.body);
    assert.deepEqual(knownRes.body, { ok: true, message: FORGOT_PASSWORD_MESSAGE });
    assert.equal(JSON.stringify(unknownRes.body).includes("missing@example.com"), false);
    assert.equal(unknown.sent.length, 0);
    assert.equal(
      unknown.queries.some((query) => query.sql.includes("INSERT INTO password_reset_tokens")),
      false
    );

    assert.equal(known.sent.length, 1);
    const url = new URL(
      known.sent[0].text.match(/https:\/\/app\.example\.com\/reset-password\?token=(\S+)/)[0]
    );
    const token = url.searchParams.get("token");
    assert.ok(token.length >= 20);
    const insert = known.queries.find((query) =>
      query.sql.includes("INSERT INTO password_reset_tokens")
    );
    assert.equal(insert.params[0], 8);
    assert.equal(insert.params[1], hashToken(token));
    assert.notEqual(insert.params[1], token);
    const ttl = insert.params[2].getTime() - Date.now();
    assert.ok(ttl > 59 * 60 * 1000 && ttl < 61 * 60 * 1000);
    assert.match(known.sent[0].html, /one hour/);
    const log = known.queries.find((query) => query.sql.includes("INSERT INTO email_log"));
    assert.equal(log.params[3], "password_reset");
    assert.equal(log.params[4], "sent");
  });

  it("is rate limited like login", async () => {
    const { queries } = installForgot({
      user: {
        id: 8,
        client_id: 4,
        name: "Ada",
        email: "ada@example.com",
        active: true,
      },
      limited: true,
    });
    const res = mockRes();
    await forgotPassword(mockReq({ email: "ada@example.com" }), res);
    assert.equal(res.statusCode, 429);
    assert.match(res.body.error, /Too many attempts/);
    assert.match(res.headers["Retry-After"], /^[1-9][0-9]*$/);
    assert.equal(
      queries.some((query) => query.sql.includes("FROM users")),
      false
    );
    const peek = queries.find((query) => query.sql.includes("FROM auth_rate_limits"));
    assert.equal(peek.params[0], "forgot_password");
  });
});

describe("POST /api/auth/reset-password", { concurrency: 1 }, () => {
  const token = "a".repeat(32);

  function validToken(overrides = {}) {
    return {
      id: 1,
      user_id: 3,
      token_hash: hashToken(token),
      expires_at: new Date(Date.now() + 30 * 60 * 1000),
      used_at: null,
      active: true,
      ...overrides,
    };
  }

  it("sets a new password, marks the token used, and bumps token_version", async () => {
    const { queries, state } = installReset(validToken());
    const res = mockRes();
    await resetPassword(mockReq({ token, password: "NewPassword1!" }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, message: RESET_PASSWORD_SUCCESS_MESSAGE });
    assert.match(state.passwordHash, /^\$2[ab]\$/);
    assert.notEqual(state.passwordHash, "NewPassword1!");
    assert.equal(state.tokenVersion, 3);
    assert.ok(state.token.used_at instanceof Date);
    const update = queries.find((query) => query.sql.includes("UPDATE users"));
    assert.match(update.sql, /token_version = token_version \+ 1/);
    const lookup = queries.find((query) => query.sql.includes("FROM password_reset_tokens"));
    assert.equal(lookup.params[0], hashToken(token));
  });

  it("rejects an expired token without changing the password", async () => {
    const { queries, state } = installReset(
      validToken({ expires_at: new Date(Date.now() - 1000) })
    );
    const res = mockRes();
    await resetPassword(mockReq({ token, password: "NewPassword1!" }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, RESET_PASSWORD_INVALID_MESSAGE);
    assert.equal(state.passwordHash, "old-hash");
    assert.equal(state.tokenVersion, 2);
    assert.equal(
      queries.some((query) => query.sql.includes("UPDATE users")),
      false
    );
    assert.ok(queries.some((query) => query.sql === "ROLLBACK"));
  });

  it("rejects a token that was already used", async () => {
    const { state } = installReset(validToken());
    const first = mockRes();
    await resetPassword(mockReq({ token, password: "NewPassword1!" }), first);
    assert.equal(first.statusCode, 200);

    const second = mockRes();
    await resetPassword(mockReq({ token, password: "OtherPassword1!" }), second);
    assert.equal(second.statusCode, 400);
    assert.equal(second.body.error, RESET_PASSWORD_INVALID_MESSAGE);
    assert.equal(state.tokenVersion, 3);
  });

  it("rejects an unknown token with the same message", async () => {
    installReset(validToken());
    const res = mockRes();
    await resetPassword(
      mockReq({ token: "b".repeat(32), password: "NewPassword1!" }),
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, RESET_PASSWORD_INVALID_MESSAGE);
  });

  it("rejects a weak password before using the token", async () => {
    let connected = false;
    pool.connect = async () => {
      connected = true;
      throw new Error("should not connect");
    };
    const res = mockRes();
    await resetPassword(mockReq({ token, password: "password" }), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Password must be at least 8 characters/);
    assert.equal(connected, false);
  });
});
