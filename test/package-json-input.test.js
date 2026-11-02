import assert from "node:assert/strict";
import fs from "node:fs";
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
