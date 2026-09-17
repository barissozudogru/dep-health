import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * When every declared dependency 404s on the public registry, which happens
 * behind a private registry mirror, behind a proxy that blocks
 * registry.npmjs.org, or in a project of only git and file dependencies, the
 * analysis ended with zero results. The overall score defaulted to a perfect
 * 10, the report said HEALTHY, and a --min-score gate exited 0: a project with
 * no measurable dependency reported perfect health over zero evidence.
 * Skipped names were invisible either way, so even a partial skip narrowed a
 * report without a trace. These tests run the built CLI against names that do
 * not exist on the registry, which is the same 404 path private packages take.
 */

const MISSING_A = "dep-health-test-package-does-not-exist-a";
const MISSING_B = "dep-health-test-package-does-not-exist-b";

function makeProject(dependencies) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-health-skipped-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      { name: "skipped-fixture", version: "1.0.0", dependencies },
      null,
      2
    )
  );
  return dir;
}

function runCli(args) {
  return spawnSync(process.execPath, ["dist/cli.js", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function withProject(dependencies, fn) {
  const dir = makeProject(dependencies);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a project whose dependencies all 404 fails the gate instead of passing", () => {
  withProject({ [MISSING_A]: "^1.0.0", [MISSING_B]: "^2.0.0" }, (dir) => {
    const result = runCli(["--path", dir, "--min-score", "4"]);
    // Before the fix this exited 0 with "CI gate passed" over zero evidence.
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /CI gate failed/);
    assert.doesNotMatch(result.stdout, /Overall project score:\s+10\.0/);
  });
});

test("the report names the dependencies that were skipped", () => {
  withProject({ [MISSING_A]: "^1.0.0", [MISSING_B]: "^2.0.0" }, (dir) => {
    const result = runCli(["--path", dir]);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, new RegExp(MISSING_A));
    assert.match(result.stdout, new RegExp(MISSING_B));
  });
});

test("json output carries the skipped names and the gate still fails", () => {
  withProject({ [MISSING_A]: "^1.0.0", [MISSING_B]: "^2.0.0" }, (dir) => {
    const result = runCli(["--path", dir, "--json", "--min-score", "4"]);
    assert.equal(result.status, 1, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      [...report.skippedDependencies].sort(),
      [MISSING_A, MISSING_B].sort()
    );
    assert.equal(report.dependencies.length, 0);
  });
});

test("a partial skip is visible in the report", () => {
  withProject({ typescript: "^5.0.0", [MISSING_A]: "^1.0.0" }, (dir) => {
    const result = runCli(["--path", dir]);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /typescript/);
    assert.match(
      result.stdout,
      new RegExp(`not on the public registry.*${MISSING_A}`)
    );
  });
});
