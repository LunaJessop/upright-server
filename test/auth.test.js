import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-jwt-secret-for-auth-tests";
process.env.DATABASE_URL ||= "postgres://127.0.0.1:5432/upright_auth_test";
process.env.PLATFORM_ADMIN_EMAILS = "platform-admin@example.com";

const {
  REVOKE_USER_TOKENS_SQL,
  USER_SESSION_LOOKUP_SQL,
  createRequireAuth,
  requirePlatformAdmin,
  signAuthToken,
} = await import("../lib/auth.js");
const { createLogoutHandler } = await import("../api-functions/auth.js");
const { requireFounder } = await import("../lib/billing.js");

const SECRET = process.env.JWT_SECRET;

function user(overrides = {}) {
  return {
    id: 1,
    client_id: 5,
    email: "worker@example.com",
    role: "user",
    active: true,
    token_version: 3,
    ...overrides,
  };
}

function memoryStore(rows) {
  const users = new Map(rows.map((row) => [row.id, { ...row }]));
  return {
    calls: 0,
    async load(id) {
      this.calls += 1;
      const row = users.get(id);
      return row ? { ...row } : null;
    },
    async revoke(id) {
      const row = users.get(id);
      if (!row) return null;
      row.token_version += 1;
      return { id: row.id, token_version: row.token_version };
    },
    get(id) {
      return users.get(id);
    },
  };
}

function buildApp(store) {
  const app = express();
  app.use(express.json());
  const requireAuth = createRequireAuth((id) => store.load(id));
  app.get("/api/whoami", requireAuth, (req, res) => {
    res.json({ auth: req.auth });
  });
  app.get("/api/admin/clients", requireAuth, requirePlatformAdmin, (req, res) => {
    res.json({ ok: true, email: req.auth.email });
  });
  app.get("/api/founder", requireAuth, requireFounder, (req, res) => {
    res.json({ ok: true, role: req.auth.role });
  });
  app.post("/api/auth/logout", requireAuth, createLogoutHandler((id) => store.revoke(id)));
  return app;
}

async function withApp(app, fn) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function send(base, path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  if (text) {
    json = JSON.parse(text);
  }
  return { status: response.status, json };
}

describe("session tokens", () => {
  it("signs only user id and token version, with a 7-day expiry", () => {
    const token = signAuthToken({ userId: 4, tokenVersion: 0 });
    const decoded = jwt.decode(token);
    assert.equal(decoded.userId, 4);
    assert.equal(decoded.tv, 0);
    assert.equal(decoded.clientId, undefined);
    assert.equal(decoded.role, undefined);
    assert.equal(decoded.email, undefined);
    assert.equal(decoded.exp - decoded.iat, 7 * 24 * 60 * 60);
  });

  it("refuses to sign a token that cannot be checked or revoked", () => {
    assert.throws(
      () => signAuthToken({ userId: 1 }),
      /token version/
    );
    assert.throws(
      () => signAuthToken({ userId: 1, tokenVersion: 1.5 }),
      /token version/
    );
    assert.throws(
      () => signAuthToken({ tokenVersion: 0 }),
      /user id/
    );
  });
});

describe("requireAuth", () => {
  it("rejects a missing bearer token before looking up a user", async () => {
    const store = memoryStore([user()]);
    await withApp(buildApp(store), async (base) => {
      const res = await send(base, "/api/whoami");
      assert.equal(res.status, 401);
      assert.equal(res.json.error, "Authentication required");
      assert.equal(store.calls, 0);
    });
  });

  it("rejects an invalid signature without a database lookup", async () => {
    const store = memoryStore([user()]);
    const token = jwt.sign({ userId: 1, tv: 3 }, "other-secret");
    await withApp(buildApp(store), async (base) => {
      const res = await send(base, "/api/whoami", { token });
      assert.equal(res.status, 401);
      assert.equal(res.json.error, "Invalid or expired session");
      assert.equal(store.calls, 0);
    });
  });

  it("rejects expired tokens without a database lookup", async () => {
    const store = memoryStore([user()]);
    const token = jwt.sign({ userId: 1, tv: 3 }, SECRET, { expiresIn: -10 });
    await withApp(buildApp(store), async (base) => {
      const res = await send(base, "/api/whoami", { token });
      assert.equal(res.status, 401);
      assert.equal(store.calls, 0);
    });
  });

  it("rejects pre-migration tokens that have no token version", async () => {
    const store = memoryStore([user({ token_version: 0 })]);
    const legacy = jwt.sign(
      {
        userId: 1,
        clientId: 5,
        role: "founder",
        email: "platform-admin@example.com",
      },
      SECRET,
      { expiresIn: "7d" }
    );
    await withApp(buildApp(store), async (base) => {
      const res = await send(base, "/api/whoami", { token: legacy });
      assert.equal(res.status, 401);
      assert.equal(res.json.error, "Invalid or expired session");
      assert.equal(store.calls, 0);
    });
  });

  it("uses company, role, and email from the database, not the token", async () => {
    const store = memoryStore([user()]);
    const token = jwt.sign(
      {
        userId: 1,
        tv: 3,
        clientId: 999,
        role: "founder",
        email: "platform-admin@example.com",
      },
      SECRET,
      { expiresIn: "7d" }
    );

    await withApp(buildApp(store), async (base) => {
      const who = await send(base, "/api/whoami", { token });
      assert.equal(who.status, 200);
      assert.deepEqual(who.json.auth, {
        userId: 1,
        clientId: 5,
        role: "user",
        email: "worker@example.com",
      });
      assert.equal(store.calls, 1);

      const admin = await send(base, "/api/admin/clients", { token });
      assert.equal(admin.status, 403);
      assert.equal(admin.json.error, "Platform admin required");

      const founder = await send(base, "/api/founder", { token });
      assert.equal(founder.status, 403);
      assert.equal(founder.json.error, "Founder role required");
    });
  });

  it("picks up a role, company, or email change on the next request", async () => {
    const store = memoryStore([user({ role: "founder", email: "old@example.com" })]);
    const token = signAuthToken({ userId: 1, tokenVersion: 3 });

    await withApp(buildApp(store), async (base) => {
      const before = await send(base, "/api/founder", { token });
      assert.equal(before.status, 200);

      store.get(1).role = "user";
      store.get(1).client_id = 8;
      store.get(1).email = "Platform-Admin@Example.com";

      const who = await send(base, "/api/whoami", { token });
      assert.equal(who.status, 200);
      assert.equal(who.json.auth.clientId, 8);
      assert.equal(who.json.auth.role, "user");
      assert.equal(who.json.auth.email, "Platform-Admin@Example.com");

      const founder = await send(base, "/api/founder", { token });
      assert.equal(founder.status, 403);

      const admin = await send(base, "/api/admin/clients", { token });
      assert.equal(admin.status, 200);
      assert.equal(admin.json.email, "Platform-Admin@Example.com");
    });
  });

  it("rejects inactive and deleted users even when the token version matches", async () => {
    const inactive = memoryStore([user({ active: false })]);
    const deleted = memoryStore([]);
    const token = signAuthToken({ userId: 1, tokenVersion: 3 });

    await withApp(buildApp(inactive), async (base) => {
      const res = await send(base, "/api/whoami", { token });
      assert.equal(res.status, 401);
      assert.equal(res.json.error, "Invalid or expired session");
    });

    await withApp(buildApp(deleted), async (base) => {
      const res = await send(base, "/api/whoami", { token });
      assert.equal(res.status, 401);
    });
  });

  it("rejects a token whose version does not match the user row", async () => {
    const store = memoryStore([user({ token_version: 4 })]);
    const token = signAuthToken({ userId: 1, tokenVersion: 3 });
    await withApp(buildApp(store), async (base) => {
      const res = await send(base, "/api/whoami", { token });
      assert.equal(res.status, 401);
      assert.equal(store.calls, 1);
    });
  });

  it("returns 503 when users.token_version has not been added yet", async () => {
    const err = new Error('column "token_version" does not exist');
    err.code = "42703";
    const store = {
      async load() {
        throw err;
      },
    };
    const token = signAuthToken({ userId: 1, tokenVersion: 1 });
    const originalError = console.error;
    console.error = () => {};
    try {
      await withApp(buildApp(store), async (base) => {
        const res = await send(base, "/api/whoami", { token });
        assert.equal(res.status, 503);
        assert.equal(res.json.error, "Server auth schema is out of date");
      });
    } finally {
      console.error = originalError;
    }
  });

  it("returns 500 when the user lookup fails", async () => {
    const store = {
      async load() {
        throw new Error("connection reset");
      },
    };
    const token = signAuthToken({ userId: 1, tokenVersion: 1 });
    const originalError = console.error;
    console.error = () => {};
    try {
      await withApp(buildApp(store), async (base) => {
        const res = await send(base, "/api/whoami", { token });
        assert.equal(res.status, 500);
        assert.equal(res.json.error, "Failed to verify session");
      });
    } finally {
      console.error = originalError;
    }
  });

  it("accepts integer columns returned as strings", async () => {
    const row = user();
    const store = {
      async load() {
        return {
          ...row,
          id: String(row.id),
          client_id: String(row.client_id),
          token_version: String(row.token_version),
        };
      },
      async revoke() {
        return null;
      },
    };
    const token = signAuthToken({ userId: 1, tokenVersion: 3 });
    await withApp(buildApp(store), async (base) => {
      const res = await send(base, "/api/whoami", { token });
      assert.equal(res.status, 200);
      assert.equal(res.json.auth.userId, 1);
      assert.equal(res.json.auth.clientId, 5);
    });
  });
});

describe("logout", () => {
  it("revokes every outstanding token for that user and ignores a body user id", async () => {
    const store = memoryStore([
      user({ id: 1, token_version: 3 }),
      user({ id: 2, token_version: 1, email: "other@example.com" }),
    ]);
    const token = signAuthToken({ userId: 1, tokenVersion: 3 });
    const other = signAuthToken({ userId: 2, tokenVersion: 1 });

    await withApp(buildApp(store), async (base) => {
      const loggedOut = await send(base, "/api/auth/logout", {
        method: "POST",
        token,
        body: { userId: 2 },
      });
      assert.equal(loggedOut.status, 200);
      assert.deepEqual(loggedOut.json, { ok: true });
      assert.equal(store.get(1).token_version, 4);
      assert.equal(store.get(2).token_version, 1);

      const reused = await send(base, "/api/whoami", { token });
      assert.equal(reused.status, 401);

      const stillOther = await send(base, "/api/whoami", { token: other });
      assert.equal(stillOther.status, 200);
      assert.equal(stillOther.json.auth.userId, 2);

      const fresh = signAuthToken({ userId: 1, tokenVersion: 4 });
      const again = await send(base, "/api/whoami", { token: fresh });
      assert.equal(again.status, 200);
      assert.equal(again.json.auth.email, "worker@example.com");
    });
  });

  it("requires a live session", async () => {
    const store = memoryStore([user()]);
    await withApp(buildApp(store), async (base) => {
      const res = await send(base, "/api/auth/logout", { method: "POST" });
      assert.equal(res.status, 401);
      assert.equal(store.get(1).token_version, 3);
    });
  });
});

describe("schema contract", () => {
  it("looks up the session with one primary-key query and revokes by user id", () => {
    assert.match(USER_SESSION_LOOKUP_SQL, /FROM users\s+WHERE id = \$1/);
    assert.match(USER_SESSION_LOOKUP_SQL, /token_version/);
    assert.match(USER_SESSION_LOOKUP_SQL, /client_id/);
    assert.match(USER_SESSION_LOOKUP_SQL, /email/);
    assert.match(USER_SESSION_LOOKUP_SQL, /role/);
    assert.match(USER_SESSION_LOOKUP_SQL, /active/);
    assert.doesNotMatch(USER_SESSION_LOOKUP_SQL, /password_hash/);

    assert.match(REVOKE_USER_TOKENS_SQL, /token_version = token_version \+ 1/);
    assert.match(REVOKE_USER_TOKENS_SQL, /WHERE id = \$1/);
  });

  it("wires POST /api/auth/logout behind requireAuth", () => {
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    assert.match(
      source,
      /app\.post\(\s*"\/api\/auth\/logout",\s*requireAuth,\s*logout\s*\)/
    );
  });

  it("issues login and register tokens from the database token version", () => {
    const source = readFileSync(
      new URL("../api-functions/auth.js", import.meta.url),
      "utf8"
    );
    assert.match(source, /u\.token_version/);
    assert.match(source, /RETURNING id, client_id, name, email, role, active, token_version/);
    assert.match(source, /tokenForUser\(user\)/);
    assert.match(source, /tokenForUser\(userRow\)/);
  });
});
