import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8"
);

function childBlock(parentLine) {
  const lines = source.split("\n");
  const start = lines.indexOf(parentLine);
  assert.notEqual(start, -1, `missing ${parentLine}`);
  const indent = parentLine.match(/^ */)[0].length;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      body.push(line);
      continue;
    }
    if (line.match(/^ */)[0].length <= indent) break;
    body.push(line);
  }
  return body.join("\n");
}

describe("GitHub Actions CI workflow", () => {
  it("runs on pull requests to develop and main, and on pushes to develop", () => {
    const pullRequest = childBlock("  pull_request:");
    const push = childBlock("  push:");
    assert.match(pullRequest, /- develop(?:\n|$)/);
    assert.match(pullRequest, /- main(?:\n|$)/);
    assert.match(push, /- develop(?:\n|$)/);
    assert.doesNotMatch(push, /- main(?:\n|$)/);
  });

  it("installs with npm ci and runs npm test on the current Node LTS", () => {
    assert.match(source, /node-version:\s*lts\/\*/);
    assert.match(source, /check-latest:\s*true/);
    assert.match(source, /^\s+- name: Install dependencies\n\s+run: npm ci\n/m);
    assert.match(source, /^\s+- name: Run tests\n\s+run: npm test\n/m);
    assert.match(source, /name: npm test/);
  });

  it("does not reference repository secrets and does not use a real database", () => {
    assert.doesNotMatch(source, /secrets\./);
    assert.doesNotMatch(source, /\$\{\{/);
    assert.match(source, /DATABASE_URL:\s*postgres:\/\/ci:ci@127\.0\.0\.1:5432\/upright_ci/);
    assert.doesNotMatch(source, /neon\.tech/i);
  });
});
