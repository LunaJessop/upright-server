import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import cors from "cors";
import express from "express";
import { allowedOrigins, createCorsOptions } from "./cors.js";

const PROD = "https://uprightmrp.netlify.app";
const LOCAL = "http://localhost:3000";
const PREVIEW = "https://deploy-preview-42--uprightmrp.netlify.app";

function env(overrides = {}) {
  return {
    FRONTEND_URL: PROD,
    CORS_EXTRA_ORIGINS: "",
    CORS_ALLOW_NETLIFY_PREVIEWS: "",
    ...overrides,
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function request(server, { method = "GET", path = "/", headers = {}, body }) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("allowlist is the production origin, localhost, and optional extras", () => {
  assert.deepEqual(allowedOrigins(env()), [PROD, LOCAL]);
  assert.deepEqual(
    allowedOrigins(env({ CORS_EXTRA_ORIGINS: " https://staging.example.com/, http://127.0.0.1:3000 " })),
    [PROD, LOCAL, "https://staging.example.com", "http://127.0.0.1:3000"]
  );
});

test("FRONTEND_URL trailing slash is normalized and * is never allowed", () => {
  assert.deepEqual(allowedOrigins(env({ FRONTEND_URL: `${PROD}/` })), [PROD, LOCAL]);
  assert.deepEqual(allowedOrigins(env({ FRONTEND_URL: "*", CORS_EXTRA_ORIGINS: "*" })), [LOCAL]);
});

test("Netlify deploy previews are denied unless opted in for this site", () => {
  const off = allowedOrigins(env());
  assert.equal(off.some((item) => item instanceof RegExp), false);

  const on = allowedOrigins(env({ CORS_ALLOW_NETLIFY_PREVIEWS: "true" }));
  const pattern = on.find((item) => item instanceof RegExp);
  assert.ok(pattern);
  assert.equal(pattern.test(PREVIEW), true);
  assert.equal(pattern.test("https://deploy-preview-1--uprightmrp.netlify.app"), true);
  assert.equal(pattern.test("https://evil.netlify.app"), false);
  assert.equal(pattern.test("https://deploy-preview-1--evil.netlify.app"), false);
  assert.equal(pattern.test("https://feature--uprightmrp.netlify.app"), false);
  assert.equal(pattern.test("http://deploy-preview-1--uprightmrp.netlify.app"), false);
  assert.equal(pattern.test("https://deploy-preview-x--uprightmrp.netlify.app"), false);
  assert.equal(
    pattern.test("https://deploy-preview-1--uprightmrp.netlify.app.evil.com"),
    false
  );

  const customDomain = allowedOrigins(
    env({
      FRONTEND_URL: "https://app.example.com",
      CORS_ALLOW_NETLIFY_PREVIEWS: "yes",
    })
  );
  assert.equal(customDomain.some((item) => item instanceof RegExp), false);
});

test("browser CORS reflects allowed origins and omits the header for others", async () => {
  const app = express();
  app.use(cors(createCorsOptions(env({ CORS_EXTRA_ORIGINS: "https://staging.example.com" }))));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  const server = await listen(app);
  try {
    const allowed = await request(server, { path: "/api/health", headers: { Origin: PROD } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers["access-control-allow-origin"], PROD);
    assert.equal(allowed.headers["access-control-allow-origin"].includes("*"), false);

    const local = await request(server, { path: "/api/health", headers: { Origin: LOCAL } });
    assert.equal(local.headers["access-control-allow-origin"], LOCAL);

    const extra = await request(server, {
      path: "/api/health",
      headers: { Origin: "https://staging.example.com" },
    });
    assert.equal(extra.headers["access-control-allow-origin"], "https://staging.example.com");

    const denied = await request(server, {
      path: "/api/health",
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(denied.status, 200);
    assert.equal(denied.headers["access-control-allow-origin"], undefined);

    const nullOrigin = await request(server, {
      path: "/api/health",
      headers: { Origin: "null" },
    });
    assert.equal(nullOrigin.headers["access-control-allow-origin"], undefined);

    const preview = await request(server, { path: "/api/health", headers: { Origin: PREVIEW } });
    assert.equal(preview.headers["access-control-allow-origin"], undefined);

    const missing = await request(server, { path: "/api/health" });
    assert.equal(missing.status, 200);
    assert.equal(missing.headers["access-control-allow-origin"], undefined);
    assert.equal(missing.body, '{"ok":true}');
  } finally {
    await close(server);
  }
});

test("opt-in deploy preview is reflected and other Netlify sites are not", async () => {
  const app = express();
  app.use(cors(createCorsOptions(env({ CORS_ALLOW_NETLIFY_PREVIEWS: "true" }))));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  const server = await listen(app);
  try {
    const preview = await request(server, { path: "/api/health", headers: { Origin: PREVIEW } });
    assert.equal(preview.headers["access-control-allow-origin"], PREVIEW);

    const other = await request(server, {
      path: "/api/health",
      headers: { Origin: "https://evil.netlify.app" },
    });
    assert.equal(other.headers["access-control-allow-origin"], undefined);

    const preflight = await request(server, {
      method: "OPTIONS",
      path: "/api/health",
      headers: {
        Origin: PREVIEW,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], PREVIEW);
    assert.match(preflight.headers["access-control-allow-headers"], /authorization/i);
  } finally {
    await close(server);
  }
});

test("Stripe webhook route still runs with no Origin and with a foreign Origin", async () => {
  process.env.VERCEL = "1";
  process.env.DATABASE_URL ??= "postgres://localhost:5432/upright_cors_test";
  process.env.FRONTEND_URL = PROD;
  delete process.env.CORS_EXTRA_ORIGINS;
  delete process.env.CORS_ALLOW_NETLIFY_PREVIEWS;
  delete process.env.STRIPE_WEBHOOK_SECRET;

  const { default: app, pool } = await import("../index.js");
  const server = await listen(app);
  try {
    const noOrigin = await request(server, {
      method: "POST",
      path: "/api/stripe/webhook",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(noOrigin.status, 503);
    assert.equal(noOrigin.headers["access-control-allow-origin"], undefined);
    assert.match(noOrigin.body, /Webhook not configured/);

    const foreign = await request(server, {
      method: "POST",
      path: "/api/stripe/webhook",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: "{}",
    });
    assert.equal(foreign.status, 503);
    assert.equal(foreign.headers["access-control-allow-origin"], undefined);

    const allowed = await request(server, {
      method: "POST",
      path: "/api/stripe/webhook",
      headers: {
        "Content-Type": "application/json",
        Origin: PROD,
      },
      body: "{}",
    });
    assert.equal(allowed.status, 503);
    assert.equal(allowed.headers["access-control-allow-origin"], PROD);
    assert.equal(String(allowed.headers["access-control-allow-origin"]).includes("*"), false);

    const local = await request(server, {
      method: "POST",
      path: "/api/stripe/webhook",
      headers: {
        "Content-Type": "application/json",
        Origin: LOCAL,
      },
      body: "{}",
    });
    assert.equal(local.headers["access-control-allow-origin"], LOCAL);
  } finally {
    await close(server);
    await pool.end();
  }
});
