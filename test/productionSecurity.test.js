import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

const PROD = "https://uprightmrp.netlify.app";
const LOCAL = "http://localhost:3000";

process.env.VERCEL = "1";
process.env.NODE_ENV = "production";
process.env.DATABASE_URL ??= "postgres://localhost:5432/upright_production_security_test";
process.env.FRONTEND_URL = PROD;
delete process.env.CORS_EXTRA_ORIGINS;
delete process.env.CORS_ALLOW_NETLIFY_PREVIEWS;
process.env.JWT_SECRET ??= "test-jwt-secret-not-for-production";

const { default: app, pool } = await import("../index.js");

function listen(application) {
  return new Promise((resolve) => {
    const server = http.createServer(application);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function request(server, { method = "GET", path = "/", headers = {} }) {
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
    req.end();
  });
}

test("production API rejects localhost, keeps the Netlify app, and sends security headers", async () => {
  const server = await listen(app);
  try {
    const local = await request(server, {
      path: "/api/items",
      headers: { Origin: LOCAL },
    });
    assert.equal(local.status, 401);
    assert.equal(local.headers["access-control-allow-origin"], undefined);
    assert.match(local.body, /Authentication required/);

    const prod = await request(server, {
      path: "/api/items",
      headers: { Origin: PROD },
    });
    assert.equal(prod.status, 401);
    assert.equal(prod.headers["access-control-allow-origin"], PROD);
    assert.equal(prod.headers["x-content-type-options"], "nosniff");
    assert.equal(prod.headers["x-frame-options"], "SAMEORIGIN");
    assert.equal(prod.headers["cross-origin-resource-policy"], "cross-origin");
    assert.equal(prod.headers["x-powered-by"], undefined);
    assert.match(prod.headers["strict-transport-security"], /max-age=15552000/);
    assert.match(prod.headers["strict-transport-security"], /includeSubDomains/);

    const preflight = await request(server, {
      method: "OPTIONS",
      path: "/api/items",
      headers: {
        Origin: PROD,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], PROD);
    assert.match(preflight.headers["access-control-allow-headers"], /authorization/i);
    assert.equal(preflight.headers["cross-origin-resource-policy"], "cross-origin");

    const localPreflight = await request(server, {
      method: "OPTIONS",
      path: "/api/items",
      headers: {
        Origin: LOCAL,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    assert.equal(localPreflight.headers["access-control-allow-origin"], undefined);
  } finally {
    await close(server);
    await pool.end();
  }
});
