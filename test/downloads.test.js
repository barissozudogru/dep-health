import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDownloadsBatchForTest } from "../dist/index.js";

/**
 * A batch of one unscoped name resolves to the single-package downloads
 * endpoint, which answers with a bare downloads object. The bulk endpoint for
 * several names answers with a map keyed by package name. The batch parser
 * read every response as the keyed shape, so the lone-name count came out as
 * unknown and the popularity signal was silently dropped. The payloads below
 * are the live responses of the two endpoint shapes.
 */

test("a batch of one reads the bare single-package response", () => {
  const single = {
    downloads: 394117801,
    start: "2026-09-05",
    end: "2026-09-11",
    package: "ms",
  };
  const counts = parseDownloadsBatchForTest(single, ["ms"]);
  assert.equal(counts.get("ms"), 394117801);
});

test("a multi-name batch reads the keyed response", () => {
  const keyed = {
    ms: { downloads: 394117801, start: "2026-09-05", end: "2026-09-11", package: "ms" },
    typescript: { downloads: 203362610, start: "2026-09-05", end: "2026-09-11", package: "typescript" },
  };
  const counts = parseDownloadsBatchForTest(keyed, ["ms", "typescript"]);
  assert.equal(counts.get("ms"), 394117801);
  assert.equal(counts.get("typescript"), 203362610);
});

test("the same count comes out regardless of which shape carries it", () => {
  // Before the fix, ms alone scored 6.6 because its count read as unknown,
  // and 6.9 once a sibling put it on the keyed bulk endpoint.
  const single = { downloads: 394117801, start: "2026-09-05", end: "2026-09-11", package: "ms" };
  const keyed = { ms: single };
  assert.equal(
    parseDownloadsBatchForTest(single, ["ms"]).get("ms"),
    parseDownloadsBatchForTest(keyed, ["ms"]).get("ms")
  );
});

test("a null entry in a keyed response stays unknown rather than zero", () => {
  // The bulk endpoint maps unknown packages to null, which must remain
  // distinct from a real zero count.
  const keyed = { "does-not-exist": null };
  const counts = parseDownloadsBatchForTest(keyed, ["does-not-exist"]);
  assert.equal(counts.get("does-not-exist"), null);
});

test("a non-numeric keyed download count stays unknown", () => {
  const keyed = { ms: { downloads: "394117801" } };
  const counts = parseDownloadsBatchForTest(keyed, ["ms"]);
  assert.equal(counts.get("ms"), null);
});

test("a fractional download count stays unknown", () => {
  const keyed = { ms: { downloads: 100.5 } };
  const counts = parseDownloadsBatchForTest(keyed, ["ms"]);
  assert.equal(counts.get("ms"), null);
});

test("an unsafe integer download count stays unknown", () => {
  const keyed = { ms: { downloads: Number.MAX_SAFE_INTEGER + 1 } };
  const counts = parseDownloadsBatchForTest(keyed, ["ms"]);
  assert.equal(counts.get("ms"), null);
});

test("a malformed scoped download count stays unknown", () => {
  const scoped = { downloads: "394117801" };
  assert.equal(parseDownloadsBatchForTest(scoped, ["@scope/pkg"]).get("@scope/pkg"), null);
  assert.equal(parseDownloadsBatchForTest({ downloads: -1 }, ["@scope/pkg"]).get("@scope/pkg"), null);
  assert.equal(parseDownloadsBatchForTest({ downloads: Infinity }, ["@scope/pkg"]).get("@scope/pkg"), null);
  assert.equal(parseDownloadsBatchForTest({ downloads: 394117801 }, ["@scope/pkg"]).get("@scope/pkg"), 394117801);
});

test("a non-object download response stays unknown", () => {
  assert.deepEqual(
    [...parseDownloadsBatchForTest(null, ["pkg"]).entries()],
    [["pkg", null]]
  );
});

test("a bare response cannot assign one package count to a multi-name batch", () => {
  const single = {
    downloads: 394117801,
    start: "2026-09-05",
    end: "2026-09-11",
    package: "ms",
  };
  const counts = parseDownloadsBatchForTest(single, ["ms", "typescript"]);
  assert.equal(counts.get("ms"), null);
  assert.equal(counts.get("typescript"), null);
});
