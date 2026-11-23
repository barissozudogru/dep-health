import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { analyze } from "../dist/index.js";

test("an empty deprecation message still marks the package deprecated", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-health-deprecation-"));
  const originalGet = https.get;

  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: { demo: "1.0.0" } })
  );

  https.get = (url, options, callback) => {
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      response.resume = () => {};
      callback(response);

      const body = String(url).includes("downloads")
        ? { downloads: 1000, start: "2026-01-01", end: "2026-01-07", package: "demo" }
        : {
            "dist-tags": { latest: "1.0.0" },
            versions: { "1.0.0": { deprecated: "" } },
            time: { "1.0.0": "2026-01-01T00:00:00.000Z" },
          };
      queueMicrotask(() => {
        response.emit("data", Buffer.from(JSON.stringify(body)));
        response.emit("end");
      });
    });
    return request;
  };

  try {
    const result = await analyze(dir);
    assert.equal(result.dependencies[0].deprecated, true);
    assert.equal(result.dependencies[0].breakdown.deprecation, 0);
  } finally {
    https.get = originalGet;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a false deprecation marker does not mark the package deprecated", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-health-deprecation-"));
  const originalGet = https.get;

  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: { demo: "1.0.0" } })
  );

  https.get = (url, options, callback) => {
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      response.resume = () => {};
      callback(response);

      const body = String(url).includes("downloads")
        ? { downloads: 1000, start: "2026-01-01", end: "2026-01-07", package: "demo" }
        : {
            "dist-tags": { latest: "1.0.0" },
            versions: { "1.0.0": { deprecated: false } },
            time: { "1.0.0": "2026-01-01T00:00:00.000Z" },
          };
      queueMicrotask(() => {
        response.emit("data", Buffer.from(JSON.stringify(body)));
        response.emit("end");
      });
    });
    return request;
  };

  try {
    const result = await analyze(dir);
    assert.equal(result.dependencies[0].deprecated, false);
    assert.equal(result.dependencies[0].breakdown.deprecation, 10);
  } finally {
    https.get = originalGet;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
