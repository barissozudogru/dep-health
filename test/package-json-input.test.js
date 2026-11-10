import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze } from "../dist/index.js";

test("rejects a non-object package.json with a useful validation error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-health-package-json-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "null");

    await assert.rejects(
      analyze(dir),
      (error) =>
        error instanceof Error &&
        error.message ===
          `package.json at ${path.join(dir, "package.json")} must contain a JSON object`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps package metadata strings when package.json has invalid metadata types", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-health-package-json-"));
  try {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: 42, version: 7 })
    );

    const result = await analyze(dir);
    assert.equal(result.packageName, path.basename(dir));
    assert.equal(result.packageVersion, "0.0.0");
    assert.equal(typeof result.packageName, "string");
    assert.equal(typeof result.packageVersion, "string");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects conflicting dependency filters instead of analyzing nothing", async () => {
  await assert.rejects(
    analyze(process.cwd(), { prodOnly: true, devOnly: true }),
    (error) =>
      error instanceof Error &&
      error.message === "prodOnly and devOnly cannot be used together"
  );
});

test("skips non-semver dependency specifiers without network access", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-health-package-json-"));
  const originalGet = https.get;
  let networkCalls = 0;
  try {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { express: "github:expressjs/express" } })
    );
    https.get = (...args) => {
      networkCalls += 1;
      return originalGet(...args);
    };

    const result = await analyze(dir);
    assert.deepEqual(result.skippedDependencies, ["express"]);
    assert.equal(result.dependencies.length, 0);
    assert.equal(networkCalls, 0);
  } finally {
    https.get = originalGet;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
