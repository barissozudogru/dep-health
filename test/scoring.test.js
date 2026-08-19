import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeScoreForTest,
  scorePopularityForTest,
  isNotFoundForTest,
  isRetryableStatusForTest,
} from "../dist/index.js";

/**
 * The npm downloads API rate-limits after a handful of rapid requests. A failed
 * lookup used to be scored as zero popularity, so the same project produced
 * different scores on consecutive runs and a --min-score gate flaked in CI.
 */

test("an unknown download count is not scored as zero", () => {
  assert.equal(scorePopularityForTest(false, null), null);
  assert.equal(scorePopularityForTest(true, null), null);
  // Zero is still a real, meaningful value when the registry actually says so.
  assert.equal(scorePopularityForTest(false, 0), 0);
});

test("unknown popularity drops out of the average instead of dragging it down", () => {
  const known = computeScoreForTest({
    freshness: 10, recency: 10, deprecation: 10, popularity: 10,
  });
  const unknown = computeScoreForTest({
    freshness: 10, recency: 10, deprecation: 10, popularity: null,
  });
  // A perfect package whose download lookup failed is still perfect.
  assert.equal(known.total, 10);
  assert.equal(unknown.total, 10);
});

test("renormalisation keeps the remaining weights proportional", () => {
  // freshness .3, recency .3, deprecation .2 -> total weight .8 when popularity drops.
  const s = computeScoreForTest({
    freshness: 0, recency: 10, deprecation: 10, popularity: null,
  });
  // (0*.3 + 10*.3 + 10*.2) / .8 = 5/.8 -> 6.25
  assert.equal(s.total, 6.3);
});

test("a zero download count still lowers the score", () => {
  const s = computeScoreForTest({
    freshness: 10, recency: 10, deprecation: 10, popularity: 0,
  });
  // (10*.3 + 10*.3 + 10*.2 + 0*.2) / 1.0 = 8
  assert.equal(s.total, 8);
});

test("the old behaviour would have scored an unknown lookup lower", () => {
  // Before: unknown became 0 and kept its 0.2 weight.
  const oldTotal = 10 * 0.3 + 10 * 0.3 + 10 * 0.2 + 0 * 0.2;
  const now = computeScoreForTest({
    freshness: 10, recency: 10, deprecation: 10, popularity: null,
  }).total;
  assert.equal(oldTotal, 8);
  assert.equal(now, 10);
  assert.ok(now > oldTotal, "unknown must no longer be penalised as zero");
});

test("popularity tiers are unchanged for known counts", () => {
  assert.equal(scorePopularityForTest(false, 2_000_000), 8);
  assert.equal(scorePopularityForTest(true, 2_000_000), 10);
  assert.equal(scorePopularityForTest(false, 500), 1);
  assert.equal(scorePopularityForTest(false, 50), 0);
});

test("only 404 is treated as a package that is not on the registry", () => {
  // A 404 means a local path, git dependency or private package, which is
  // expected and skipped. Any other failure means the analysis would silently
  // cover fewer packages than reported, so it must stop the run instead.
  assert.equal(isNotFoundForTest("NOT_FOUND:https://registry.npmjs.org/x"), true);
  assert.equal(isNotFoundForTest("HTTP_503:https://registry.npmjs.org/x"), false);
  assert.equal(isNotFoundForTest("HTTP_429:https://registry.npmjs.org/x"), false);
  assert.equal(isNotFoundForTest("TIMEOUT:https://registry.npmjs.org/x"), false);
  assert.equal(isNotFoundForTest("PARSE_ERROR:https://registry.npmjs.org/x"), false);
});

test("a 5xx is retryable so a transient blip does not abort the run", () => {
  assert.equal(isRetryableStatusForTest(503), true);
  assert.equal(isRetryableStatusForTest(500), true);
  assert.equal(isRetryableStatusForTest(429), true);
  assert.equal(isRetryableStatusForTest(404), false);
  assert.equal(isRetryableStatusForTest(200), false);
});
