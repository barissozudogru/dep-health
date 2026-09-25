import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripVersionRangeForTest,
  computeVersionDeltaForTest,
} from "../dist/index.js";

/**
 * Version range specifiers like ">= 3.0.0" include a space after the comparison
 * operator. When stripVersionRange removed the leading operator characters but
 * did not trim whitespace before splitting on spaces, the first split token
 * was an empty string. The empty string failed version parsing, causing
 * computeVersionDelta to fall back to zero versions behind and falsely giving
 * outdated dependencies a perfect freshness score.
 */

test("strips comparison operators with spaces without producing an empty version string", () => {
  assert.equal(stripVersionRangeForTest(">= 3.0.0"), "3.0.0");
  assert.equal(stripVersionRangeForTest(">=3.0.0"), "3.0.0");
  assert.equal(stripVersionRangeForTest("^1.2.3"), "1.2.3");
  assert.equal(stripVersionRangeForTest("~0.1.0"), "0.1.0");
  assert.equal(stripVersionRangeForTest("= 2.0.0"), "2.0.0");
  assert.equal(stripVersionRangeForTest("<= 4.5.6"), "4.5.6");
  assert.equal(stripVersionRangeForTest("< 2.0.0"), "2.0.0");
  assert.equal(stripVersionRangeForTest("> 1.0.0"), "1.0.0");
});

test("handles space-separated range bounds by selecting the first version", () => {
  assert.equal(stripVersionRangeForTest(">= 1.2.3 < 2.0.0"), "1.2.3");
  assert.equal(stripVersionRangeForTest(">=1.2.3 <2.0.0"), "1.2.3");
});

test("returns null delta when version strings cannot be parsed into semver triples", () => {
  assert.equal(computeVersionDeltaForTest("github:expressjs/express", "4.18.2"), null);
  assert.equal(computeVersionDeltaForTest("workspace:*", "1.0.0"), null);
  assert.equal(computeVersionDeltaForTest("*", "2.0.0"), null);
  assert.equal(computeVersionDeltaForTest("", "1.0.0"), null);
  assert.equal(computeVersionDeltaForTest("1.0.0", "invalid"), null);
});

test("computes version delta for valid semver versions", () => {
  assert.deepEqual(computeVersionDeltaForTest("1.0.0", "2.0.0"), { major: 1, minor: 0, patch: 0 });
  assert.deepEqual(computeVersionDeltaForTest("1.1.0", "1.3.0"), { major: 0, minor: 2, patch: 0 });
  assert.deepEqual(computeVersionDeltaForTest("1.1.1", "1.1.5"), { major: 0, minor: 0, patch: 4 });
  assert.deepEqual(computeVersionDeltaForTest("2.0.0", "1.0.0"), { major: 0, minor: 0, patch: 0 });
});
