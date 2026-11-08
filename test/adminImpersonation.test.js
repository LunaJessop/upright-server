import assert from "node:assert/strict";
import { once } from "node:events";
import { after, describe, it } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-jwt-secret-for-auth-tests";
process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_admin_impersonation_test";
process.env.PLATFORM_ADMIN_EMAILS = "platform-admin@example.com";

const { pool } = await import("../lib/db.js");
const {
  IMPERSONATION_TTL_SECONDS,
  createRequireAuth,
  signAuthToken,
  signImpersonationToken,
} = await import("../lib/auth.js");
const { createLogoutHandler, getMe } = await import("../api-functions/auth.js");
const {
  endImpersonation,
  startImpersonation,
} = await import("../api-functions/adminImpersonation.js");

const SECRET = process.env.JWT_SECRET;
pool.options.connectionTimeoutMillis = 500;

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    locals: {},
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

function memoryStore(rows) {
  const users = new Map(rows.map((row) => [row.id, { ...row }]));
  return {
    async load(id) {
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

function installPool(store, ended) {
  pool.query = async (sql, params = []) => {
    const text = String(sql);
    if (text.includes("detail->>'jti'")) {
      return { rows: ended.has(params[0]) ? [{ ended: true }] : [] };
    }
    if (text.includes("INSERT INTO admin_activity")) {
      const detail = JSON.parse(params[5]);
      if (detail.action === "impersonation_end" && detail.jti) ended.add(detail.jti);
      return { rows: [] };
    }
    if (text.includes("FROM users")) {
      const row = store.get(params[0]);
      if (!row) return { rows: [] };
      return {
        rows: [
          {
            client_name: "Soap Co",
            client_slug: "soap-co",
            client_email: "billing@soap.test",
            subscription_status: "active",
            past_due_started_at: null,
            stripe_price_id: null,
            ...row,
          },
        ],
      };
    }
    throw new Error(text);
  };
}

function buildApp(store) {
  const app = express();
  app.use(express.json());
  const requireAuth = createRequireAuth((id) => store.load(id));
  app.get("/api/items", requireAuth, (req, res) => {
    res.json({
      clientId: req.auth.clientId,
      userId: req.auth.userId,
      email: req.auth.email,
    });
  });
  app.post("/api/items", requireAuth, (req, res) => {
    res.status(201).json({ wrote: true });
  });
  app.post("/api/auth/logout", requireAuth, createLogoutHandler((id) => store.revoke(id)));
  app.post("/api/admin/impersonation/end", requireAuth, endImpersonation);
  app.get("/api/auth/me", requireAuth, getMe);
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
  return {
    status: response.status,
    json: text ? JSON.parse(text) : null,
  };
}

function people() {
  return [
    {
      id: 1,
      client_id: 1,
      name: "Luna",
      email: "platform-admin@example.com",
      role: "founder",
      active: true,
      token_version: 4,
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: 8,
      client_id: 4,
      name: "Ada",
      email: "ada@soap.test",
      role: "founder",
      active: true,
      token_version: 2,
      created_at: "2026-02-01T00:00:00.000Z",
      password_hash: "do-not-leak",
    },
  ];
}

after(async () => {
  await pool.end();
});

describe("impersonation token", () => {
  it("expires in 30 minutes and does not carry the user's login claims", () => {
    const token = signImpersonationToken({
      userId: 8,
      adminUserId: 1,
      adminTokenVersion: 4,
    });
    const decoded = jwt.decode(token);
    assert.equal(decoded.imp, true);
    assert.equal(decoded.userId, 8);
    assert.equal(decoded.aid, 1);
    assert.equal(decoded.atv, 4);
    assert.equal(typeof decoded.jti, "string");
    assert.equal(decoded.exp - decoded.iat, IMPERSONATION_TTL_SECONDS);
    assert.equal(decoded.tv, undefined);
    assert.equal(decoded.email, undefined);
    assert.equal(decoded.password, undefined);
    assert.equal(decoded.password_hash, undefined);
  });
});

describe("view as user", { concurrency: 1 }, () => {
  it("requires confirm and a reason before it looks anyone up", async () => {
    let queried = false;
    pool.query = async () => {
      queried = true;
      return { rows: [] };
    };
    const missing = mockRes();
    await startImpersonation(
      { params: { id: "4", userId: "8" }, body: { reason: "support" }, auth: { userId: 1 } },
      missing
    );
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.body.code, "CONFIRMATION_REQUIRED");
    const noReason = mockRes();
    await startImpersonation(
      { params: { id: "4", userId: "8" }, body: { confirm: true, reason: "  " }, auth: { userId: 1 } },
      noReason
    );
    assert.equal(noReason.statusCode, 400);
    assert.equal(queried, false);
  });

  it("refuses another platform admin and a user from a different company", async () => {
    const queries = [];
    pool.query = async (sql, params = []) => {
      queries.push(String(sql));
      if (String(sql).includes("client_id")) {
        return {
          rows: [
            {
              id: 2,
              client_id: 4,
              name: "Other Admin",
              email: "platform-admin@example.com",
              role: "founder",
              active: true,
            },
          ],
        };
      }
      return { rows: [] };
    };
    const forbidden = mockRes();
    await startImpersonation(
      {
        params: { id: "4", userId: "2" },
        body: { confirm: true, reason: "checking a ticket" },
        auth: { userId: 1 },
      },
      forbidden
    );
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.body.code, "IMPERSONATION_FORBIDDEN");
    assert.equal(forbidden.body.token, undefined);

    pool.query = async (sql) => {
      queries.push(String(sql));
      return { rows: [] };
    };
    const missing = mockRes();
    await startImpersonation(
      {
        params: { id: "4", userId: "8" },
        body: { confirm: true, reason: "checking a ticket" },
        auth: { userId: 1 },
      },
      missing
    );
    assert.equal(missing.statusCode, 404);
    assert.equal(queries.some((sql) => sql.includes("password_hash")), false);
  });

  it("issues a read-only session for that member and records the admin", async () => {
    const store = memoryStore(people());
    const ended = new Set();
    installPool(store, ended);
    const res = mockRes();
    await startImpersonation(
      {
        params: { id: "4", userId: "8" },
        body: { confirm: true, reason: "Customer asked for help" },
        auth: { userId: 1, email: "platform-admin@example.com" },
      },
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.user.email, "ada@soap.test");
    assert.equal(res.body.user.password_hash, undefined);
    assert.equal(res.body.impersonating.admin_email, "platform-admin@example.com");
    assert.equal(res.locals.adminAudit.action, "impersonation_start");
    assert.equal(res.locals.adminAudit.userId, 1);
    assert.equal(res.locals.adminAudit.after.reason, "Customer asked for help");
    assert.equal(JSON.stringify(res.locals.adminAudit).includes(res.body.token), false);

    const token = res.body.token;
    const decoded = jwt.decode(token);
    assert.equal(decoded.imp, true);
    assert.equal(decoded.aid, 1);
    assert.equal(decoded.userId, 8);
    assert.equal(decoded.password_hash, undefined);

    await withApp(buildApp(store), async (base) => {
      const items = await send(base, "/api/items", { token });
      assert.equal(items.status, 200);
      assert.equal(items.json.clientId, 4);
      assert.equal(items.json.userId, 8);
      assert.equal(items.json.email, "ada@soap.test");

      const write = await send(base, "/api/items", {
        method: "POST",
        token,
        body: { name: "Oil" },
      });
      assert.equal(write.status, 403);
      assert.equal(write.json.code, "IMPERSONATION_READ_ONLY");

      const logout = await send(base, "/api/auth/logout", { method: "POST", token });
      assert.equal(logout.status, 403);
      assert.equal(store.get(8).token_version, 2);
      assert.equal(store.get(1).token_version, 4);

      const me = await send(base, "/api/auth/me", { token });
      assert.equal(me.status, 200);
      assert.equal(me.json.user.email, "ada@soap.test");
      assert.equal(me.json.user.password_hash, undefined);
      assert.equal(me.json.impersonating.admin_email, "platform-admin@example.com");
      assert.equal(me.json.impersonating.expires_at, res.body.expires_at);
      assert.equal(me.json.impersonating.jti, undefined);
      assert.equal(me.json.impersonating.admin_user_id, undefined);

      const endedSession = await send(base, "/api/admin/impersonation/end", {
        method: "POST",
        token,
      });
      assert.equal(endedSession.status, 200);
      assert.equal(endedSession.json.impersonating, null);
      assert.equal(endedSession.json.user.email, "platform-admin@example.com");
      assert.equal(endedSession.json.user.password_hash, undefined);
      const restored = jwt.decode(endedSession.json.token);
      assert.equal(restored.userId, 1);
      assert.equal(restored.tv, 4);
      assert.equal(restored.imp, undefined);
      assert.equal(endedSession.json.token.includes("do-not-leak"), false);

      const again = await send(base, "/api/items", { token });
      assert.equal(again.status, 401);

      const adminAgain = await send(base, "/api/items", {
        method: "POST",
        token: endedSession.json.token,
        body: { name: "Oil" },
      });
      assert.equal(adminAgain.status, 201);
    });
  });

  it("ends the session when the admin token version changes", async () => {
    const store = memoryStore(people());
    installPool(store, new Set());
    const token = signImpersonationToken({
      userId: 8,
      adminUserId: 1,
      adminTokenVersion: 4,
    });
    store.get(1).token_version = 5;
    await withApp(buildApp(store), async (base) => {
      const res = await send(base, "/api/items", { token });
      assert.equal(res.status, 401);
    });
  });

  it("rejects a long-lived impersonation token", async () => {
    const store = memoryStore(people());
    installPool(store, new Set());
    const token = jwt.sign(
      { imp: true, userId: 8, aid: 1, atv: 4, jti: "too-long" },
      SECRET,
      { expiresIn: "7d" }
    );
    await withApp(buildApp(store), async (base) => {
      const res = await send(base, "/api/items", { token });
      assert.equal(res.status, 401);
    });
  });

  it("shows impersonating on /api/auth/me and omits it for a normal session", async () => {
    const row = {
      id: 8,
      client_id: 4,
      name: "Ada",
      email: "ada@soap.test",
      role: "user",
      active: false,
      created_at: "2026-02-01T00:00:00.000Z",
      client_name: "Soap Co",
      subscription_status: "active",
      past_due_started_at: null,
      stripe_price_id: null,
      password_hash: "do-not-leak",
    };
    pool.query = async () => ({ rows: [row] });
    const viewing = mockRes();
    await getMe(
      {
        auth: {
          userId: 8,
          impersonating: {
            admin_user_id: 1,
            admin_email: "platform-admin@example.com",
            expires_at: "2026-04-01T00:30:00.000Z",
            read_only: true,
            jti: "secret-jti",
          },
        },
      },
      viewing
    );
    assert.equal(viewing.statusCode, 200);
    assert.deepEqual(viewing.body.impersonating, {
      admin_email: "platform-admin@example.com",
      expires_at: "2026-04-01T00:30:00.000Z",
    });
    assert.equal(viewing.body.user.password_hash, undefined);

    const normal = mockRes();
    await getMe({ auth: { userId: 8 } }, normal);
    assert.equal(normal.statusCode, 401);

    const active = mockRes();
    pool.query = async () => ({ rows: [{ ...row, active: true }] });
    const token = signAuthToken({ userId: 8, tokenVersion: 2 });
    await getMe({ auth: { userId: 8 } }, active);
    assert.equal(active.statusCode, 200);
    assert.equal(active.body.impersonating, null);
    assert.equal(JSON.stringify(active.body).includes(token), false);
  });
});
