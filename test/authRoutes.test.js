import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import bcrypt from "bcryptjs";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_auth_test";
process.env.JWT_SECRET ??= "test-jwt-secret-not-for-production";
delete process.env.STRIPE_SECRET_KEY;

const { pool } = await import("../lib/db.js");
const { AUTH_RATE_LIMITS } = await import("../lib/authRateLimit.js");
const { login, register } = await import("../api-functions/auth.js");

pool.options.connectionTimeoutMillis = 500;

const ACCOUNT_NOT_CREATED_MESSAGE =
  "We couldn't create an account with those details. If you already have an account, log in.";

let passwordHash;

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

function mockReq(body, headers = {}) {
  return {
    body,
    headers: {
      "x-vercel-forwarded-for": "203.0.113.5",
      ...headers,
    },
    ip: "10.0.0.1",
    socket: { remoteAddress: "10.0.0.1" },
  };
}

function windowStart(action, scope) {
  const windowMs = AUTH_RATE_LIMITS[action][scope].windowMs;
  return new Date(Math.floor(Date.now() / windowMs) * windowMs);
}

function installPool({ limited = false, userRows = [] } = {}) {
  const queries = [];
  pool.query = async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes("INSERT INTO auth_rate_limits")) {
      return { rows: [{ attempts: 1 }] };
    }
    if (sql.includes("FROM auth_rate_limits")) {
      if (!limited) return { rows: [] };
      const [action, scope] = params;
      return {
        rows: [
          {
            attempts: AUTH_RATE_LIMITS[action][scope].limit,
            window_start: windowStart(action, scope),
          },
        ],
      };
    }
    if (sql.includes("FROM users")) return { rows: userRows };
    throw new Error(`unexpected pool query: ${sql}`);
  };
  return queries;
}

describe("login route", { concurrency: 1 }, () => {
  before(async () => {
    passwordHash = await bcrypt.hash("Password1!", 4);
  });

  it("rejects a missing password before touching the database", async () => {
    const queries = installPool();
    const res = mockRes();
    await login(mockReq({ email: "a@example.com" }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "Email and password are required");
    assert.equal(queries.length, 0);
  });

  it("returns 429 with a message the login page can show", async () => {
    const queries = installPool({ limited: true });
    const res = mockRes();
    await login(
      mockReq(
        { email: "a@example.com", password: "Password1!" },
        {
          "x-vercel-forwarded-for": "203.0.113.8, 10.0.0.2",
          "x-forwarded-for": "198.51.100.9",
        }
      ),
      res
    );
    assert.equal(res.statusCode, 429);
    assert.match(res.body.error, /^Too many attempts\. Please try again in \d+ minutes?\.$/);
    assert.match(res.headers["Retry-After"], /^[1-9][0-9]*$/);
    assert.equal(
      queries.some((query) => query.sql.includes("FROM users")),
      false
    );
    const ipPeek = queries.find(
      (query) =>
        query.sql.includes("FROM auth_rate_limits") && query.params[1] === "ip"
    );
    assert.equal(ipPeek.params[2], "203.0.113.8");
  });

  it("counts an unknown email as a failed login and keeps the same 401", async () => {
    const queries = installPool({ userRows: [] });
    const res = mockRes();
    await login(
      mockReq({ email: "missing@example.com", password: "Password1!" }),
      res
    );
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, "Invalid email or password");
    const consumes = queries.filter((query) =>
      query.sql.includes("INSERT INTO auth_rate_limits")
    );
    assert.equal(consumes.length, 2);
    assert.deepEqual(
      consumes.map((query) => query.params[1]).sort(),
      ["email", "ip"]
    );
  });

  it("counts a wrong password and does not count a successful login", async () => {
    const user = {
      id: 7,
      client_id: 3,
      name: "Ada",
      email: "ada@example.com",
      password_hash: passwordHash,
      role: "founder",
      active: true,
      client_name: "Acme",
      client_slug: "acme",
      client_email: "ada@example.com",
      subscription_status: "active",
      past_due_started_at: null,
      stripe_price_id: null,
      token_version: 0,
    };

    const wrongQueries = installPool({ userRows: [{ ...user }] });
    const wrong = mockRes();
    await login(mockReq({ email: "Ada@Example.com", password: "nope-nope" }), wrong);
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.body.error, "Invalid email or password");
    const wrongConsumes = wrongQueries.filter((query) =>
      query.sql.includes("INSERT INTO auth_rate_limits")
    );
    assert.equal(wrongConsumes.length, 2);
    assert.equal(
      wrongConsumes.find((query) => query.params[1] === "email").params[2],
      "ada@example.com"
    );

    const okQueries = installPool({ userRows: [{ ...user }] });
    const ok = mockRes();
    await login(mockReq({ email: "ada@example.com", password: "Password1!" }), ok);
    assert.equal(ok.statusCode, 200);
    assert.equal(typeof ok.body.token, "string");
    assert.equal(ok.body.user.email, "ada@example.com");
    assert.equal(
      okQueries.some((query) => query.sql.includes("INSERT INTO auth_rate_limits")),
      false
    );
  });

  it("counts an inactive account without treating it as a server error", async () => {
    const queries = installPool({
      userRows: [
        {
          id: 1,
          client_id: 1,
          name: "Ada",
          email: "ada@example.com",
          password_hash: passwordHash,
          role: "user",
          active: false,
          subscription_status: "active",
        },
      ],
    });
    const res = mockRes();
    await login(mockReq({ email: "ada@example.com", password: "Password1!" }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "This account is inactive");
    assert.equal(
      queries.filter((query) => query.sql.includes("INSERT INTO auth_rate_limits")).length,
      2
    );
  });
});

describe("register route", { concurrency: 1 }, () => {
  function validBody(overrides = {}) {
    return {
      companyName: "Acme",
      name: "Ada",
      email: "ada@example.com",
      password: "Password1!",
      ...overrides,
    };
  }

  it("rejects a weak password before counting the attempt", async () => {
    const queries = installPool();
    let connected = false;
    pool.connect = async () => {
      connected = true;
      throw new Error("should not connect");
    };
    const res = mockRes();
    await register(mockReq(validBody({ password: "password" })), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Password must be at least 8 characters/);
    assert.equal(queries.length, 0);
    assert.equal(connected, false);
  });

  it("returns 429 and does not create a client when registration is limited", async () => {
    installPool({ limited: true });
    let connected = false;
    pool.connect = async () => {
      connected = true;
      throw new Error("should not connect");
    };
    const res = mockRes();
    await register(mockReq(validBody()), res);
    assert.equal(res.statusCode, 429);
    assert.match(res.body.error, /Too many attempts/);
    assert.ok(res.headers["Retry-After"]);
    assert.equal(connected, false);
  });

  it("does not confirm that an email is already registered", async () => {
    const queries = installPool();
    const clientQueries = [];
    let released = false;
    pool.connect = async () => ({
      async query(sql, params) {
        clientQueries.push({ sql, params });
        if (sql.includes("FROM users")) return { rows: [{ "?column?": 1 }] };
        return { rows: [] };
      },
      release() {
        released = true;
      },
    });

    const res = mockRes();
    await register(mockReq(validBody({ email: "Taken@Example.com" })), res);

    assert.equal(res.statusCode, 400);
    assert.notEqual(res.statusCode, 409);
    assert.equal(res.body.error, ACCOUNT_NOT_CREATED_MESSAGE);
    assert.equal(JSON.stringify(res.body).includes("Taken@Example.com"), false);
    assert.equal(JSON.stringify(res.body).toLowerCase().includes("already exists"), false);
    assert.equal(released, true);
    assert.equal(
      queries.some((query) => query.sql.includes("INSERT INTO auth_rate_limits")),
      true
    );
    const lookup = clientQueries.find((query) => query.sql.includes("FROM users"));
    assert.equal(lookup.params[0], "taken@example.com");
  });

  it("uses the same non-confirming message when the email unique index races", async () => {
    installPool();
    pool.connect = async () => ({
      async query(sql) {
        if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT") {
          return { rows: [] };
        }
        if (sql.includes("FROM users")) return { rows: [] };
        if (sql.includes("FROM clients WHERE slug")) return { rows: [] };
        if (sql.includes("INSERT INTO clients")) {
          return {
            rows: [
              {
                id: 4,
                name: "Acme",
                email: "ada@example.com",
                subscription_status: "incomplete",
                past_due_started_at: null,
                stripe_price_id: null,
              },
            ],
          };
        }
        const err = new Error("duplicate key");
        err.code = "23505";
        err.constraint = "users_email_key";
        err.detail = "Key (email)=(ada@example.com) already exists.";
        throw err;
      },
      release() {},
    });

    const res = mockRes();
    const originalError = console.error;
    console.error = () => {};
    try {
      await register(mockReq(validBody()), res);
    } finally {
      console.error = originalError;
    }
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, ACCOUNT_NOT_CREATED_MESSAGE);
  });

  it("still creates a session when Stripe is not configured", async () => {
    installPool();
    pool.connect = async () => ({
      async query(sql, params) {
        if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT") {
          return { rows: [] };
        }
        if (sql.includes("FROM users")) return { rows: [] };
        if (sql.includes("FROM clients WHERE slug")) return { rows: [] };
        if (sql.includes("INSERT INTO clients")) {
          return {
            rows: [
              {
                id: 9,
                name: params[0],
                email: params[2],
                subscription_status: "incomplete",
                past_due_started_at: null,
                stripe_price_id: null,
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO users")) {
          assert.match(params[3], /^\$2[ab]\$/);
          return {
            rows: [
              {
                id: 11,
                client_id: 9,
                name: params[1],
                email: params[2],
                role: "founder",
                active: true,
                token_version: 0,
              },
            ],
          };
        }
        throw new Error(`unexpected client sql: ${sql}`);
      },
      release() {},
    });

    const res = mockRes();
    const originalError = console.error;
    console.error = () => {};
    try {
      await register(mockReq(validBody()), res);
    } finally {
      console.error = originalError;
    }
    assert.equal(res.statusCode, 201);
    assert.equal(typeof res.body.token, "string");
    assert.equal(res.body.user.email, "ada@example.com");
    assert.equal(res.body.user.client_id, 9);
  });
});

after(async () => {
  await pool.end();
});
