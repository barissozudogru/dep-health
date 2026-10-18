import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLatestVersionForTest } from "../dist/index.js";

/**
 * The registry serves some fully unpublished and security-held packages as a
 * 200 packument whose dist-tags carry no latest entry. The version picker used
 * to fall back to "0.0.0", which matched no published version, so deprecation
 * and freshness were read from an empty object and the worst possible packages
 * scored perfectly on both signals.
 */

test("a present latest dist-tag decides the version to compare against", () => {
  const registry = {
    name: "example",
    "dist-tags": { latest: "1.4.2", next: "2.0.0-rc.1" },
    time: {},
    versions: { "1.4.2": {}, "2.0.0-rc.1": {} },
  };
  assert.equal(resolveLatestVersionForTest(registry), "1.4.2");
});

test("an invalid latest dist-tag falls back to an available published version", () => {
  const registry = {
    name: "example",
    "dist-tags": { latest: "9.9.9" },
    time: {},
    versions: { "1.2.3": {} },
  };
  // A stale tag must not make the dependency disappear from the analysis.
  assert.equal(resolveLatestVersionForTest(registry), "1.2.3");
});

test("an existing but malformed latest dist-tag falls back to a valid version", () => {
  const registry = {
    name: "example",
    "dist-tags": { latest: "not-a-version" },
    time: {},
    versions: { "1.2.3": {}, "not-a-version": {} },
  };
  // A malformed tag must not make a valid published version disappear from scoring.
  assert.equal(resolveLatestVersionForTest(registry), "1.2.3");
});

test("an empty dist-tags object falls back to the highest published version", () => {
  const registry = {
    name: "example-unpublished",
    "dist-tags": {},
    time: {
      created: "2020-01-10T10:00:00.000Z",
      modified: "2024-03-01T10:00:00.000Z",
      "1.4.2": "2020-01-10T10:00:00.000Z",
      "3.1.0": "2024-03-01T10:00:00.000Z",
    },
    versions: {
      "1.4.2": {},
      "3.1.0": { deprecated: "This package is no longer supported." },
    },
  };
  // Before the fix this packument produced latestVersion "0.0.0", no
  // deprecation, and a zero version delta.
  const latest = resolveLatestVersionForTest(registry);
  assert.equal(latest, "3.1.0");
  assert.equal(registry.versions[latest].deprecated, "This package is no longer supported.");
});

test("a packument with no dist-tags key also falls back to the highest version", () => {
  const registry = {
    name: "example-unpublished",
    time: {},
    versions: { "0.9.1": {}, "1.2.3": {}, "1.2.10": {} },
  };
  assert.equal(resolveLatestVersionForTest(registry), "1.2.10");
});

test("a release outranks a prerelease of the same version", () => {
  // semver counts 2.0.0-rc.1 as lower than 2.0.0, and so does a real
  // latest tag, so the release must win when both are published.
  const registry = {
    name: "example",
    "dist-tags": {},
    time: {},
    versions: { "2.0.0-rc.1": {}, "2.0.0": {} },
  };
  assert.equal(resolveLatestVersionForTest(registry), "2.0.0");
});

test("the highest prerelease wins regardless of identifier shape or insertion order", () => {
  const cases = [
    ["2.0.0-rc.2", "2.0.0-rc.10", "2.0.0-rc.10"],
    ["2.0.0-1", "2.0.0-alpha", "2.0.0-alpha"],
    ["2.0.0-alpha.1.2", "2.0.0-alpha.1", "2.0.0-alpha.1.2"],
    ["2.0.0-alpha", "2.0.0-beta", "2.0.0-beta"],
  ];

  for (const [first, second, expected] of cases) {
    for (const versions of [
      { [first]: {}, [second]: {} },
      { [second]: {}, [first]: {} },
    ]) {
      const registry = {
        name: "example",
        "dist-tags": {},
        time: {},
        versions,
      };
      assert.equal(resolveLatestVersionForTest(registry), expected);
    }
  }
});

test("a higher version wins even when only a prerelease of it exists", () => {
  const registry = {
    name: "example",
    "dist-tags": {},
    time: {},
    versions: { "2.0.0": {}, "2.1.0-rc.1": {} },
  };
  assert.equal(resolveLatestVersionForTest(registry), "2.1.0-rc.1");
});

test("an invalid numeric prerelease is ignored during fallback selection", () => {
  const registry = {
    name: "example",
    "dist-tags": {},
    time: {},
    versions: { "1.0.0": {}, "2.0.0-01": {} },
  };
  // Numeric prerelease identifiers cannot contain leading zeroes.
  assert.equal(resolveLatestVersionForTest(registry), "1.0.0");
});

test("malformed build metadata is ignored during fallback selection", () => {
  const registry = {
    name: "example",
    "dist-tags": {},
    time: {},
    versions: { "2.0.0+": {}, "1.0.0": {} },
  };
  // A trailing plus is not valid semver. It must not win merely because it
  // appears first in the registry response.
  assert.equal(resolveLatestVersionForTest(registry), "1.0.0");
});

test("a packument with no dist-tag and no versions resolves to nothing", () => {
  // Nothing here can be scored honestly; the caller stops the run instead.
  assert.equal(resolveLatestVersionForTest({ name: "example", "dist-tags": {}, time: {} }), null);
  assert.equal(resolveLatestVersionForTest({ name: "example", time: {} }), null);
});
