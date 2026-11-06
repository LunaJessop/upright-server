import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const PUBLIC_ROUTES = new Set([
  "POST /api/auth/login",
  "POST /api/auth/register",
  "POST /api/auth/forgot-password",
  "POST /api/auth/reset-password",
  "POST /api/stripe/webhook",
  "GET /api/health",
]);

function extractRouteCalls(source) {
  const calls = [];
  const re = /app\.(get|post|put|patch|delete)\(/g;
  let match;
  while ((match = re.exec(source))) {
    let depth = 0;
    for (let i = match.index + match[0].length - 1; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          calls.push(source.slice(match.index, i + 1));
          break;
        }
      }
    }
  }
  return calls;
}

function routeKey(call) {
  const method = call.match(/^app\.(\w+)/)[1].toUpperCase();
  const path = call.match(/["'](\/[^"']+)["']/)[1];
  return `${method} ${path}`;
}

describe("route authentication", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const calls = extractRouteCalls(source);
  const keys = calls.map(routeKey);

  it("requires a session on every route except the public allowlist", () => {
    assert.ok(calls.length >= 40);
    const seen = new Set();
    for (const call of calls) {
      const key = routeKey(call);
      assert.equal(seen.has(key), false, `duplicate route ${key}`);
      seen.add(key);
      if (PUBLIC_ROUTES.has(key)) {
        assert.equal(call.includes("requireAuth"), false, key);
      } else {
        assert.equal(call.includes("requireAuth"), true, `${key} is missing requireAuth`);
      }
    }
    for (const key of PUBLIC_ROUTES) {
      assert.equal(seen.has(key), true, `public route ${key} is no longer registered`);
    }
  });

  it("keeps the client list behind a platform admin", () => {
    const admin = calls.find((call) => routeKey(call) === "GET /api/admin/clients");
    assert.ok(admin);
    assert.match(admin, /requirePlatformAdmin/);
  });

  it("registers each public route once", () => {
    assert.deepEqual(
      keys.filter((key) => PUBLIC_ROUTES.has(key)).sort(),
      [...PUBLIC_ROUTES].sort()
    );
  });
});
