import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import * as depHealth from "../dist/index.js";

const {
  computeScoreForTest,
  scorePopularityForTest,
  isNotFoundForTest,
  isRetryableStatusForTest,
  fetchJsonWithRetryForTest,
} = depHealth;

// Keep the baseline runnable when the candidate's test export is absent. The
// fallback preserves the old parsing behavior so the regression fails there.
const parsePublishedDateForTest =
  depHealth.parsePublishedDateForTest ??
  ((value) => (value ? new Date(value) : null));
const scoreRecencyForTest =
  depHealth.scoreRecencyForTest ??
  ((lastPublished) => {
    if (!lastPublished) return 1;
    const months =
      (Date.now() - lastPublished.getTime()) / (1000 * 60 * 60 * 24 * 30);
    if (months < 6) return 10;
    if (months < 12) return 7;
    if (months < 24) return 4;
    return 1;
  });

/**
 * The npm downloads API rate-limits after a handful of rapid requests. A failed
 * lookup used to be scored as zero popularity, so the same project produced
 * different scores on consecutive runs and a --min-score gate flaked in CI.
 */

test("an unknown download count is not scored as zero", () => {
  assert.equal(scorePopularityForTest(false, null), null);
  assert.equal(scorePopularityForTest(true, null), null);
  assert.equal(scorePopularityForTest(false, -1), null);
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

test("an invalid publish timestamp becomes unknown instead of poisoning the score", () => {
  assert.equal(parsePublishedDateForTest("not-a-date"), null);
  assert.equal(parsePublishedDateForTest("2026-02-30T00:00:00.000Z"), null);
  assert.equal(parsePublishedDateForTest("2026-02-30 00:00:00Z"), null);
  assert.equal(parsePublishedDateForTest("2026-02-30t00:00:00.000Z"), null);
  assert.equal(parsePublishedDateForTest("2026-02-30Z"), null);
  assert.equal(parsePublishedDateForTest("2026/02/30"), null);
  assert.equal(parsePublishedDateForTest(123), null);
  assert.equal(
    parsePublishedDateForTest("2026-09-11T00:00:00.000Z")?.toISOString(),
    "2026-09-11T00:00:00.000Z"
  );
});

test("a future publish timestamp does not receive the freshest recency score", () => {
  const future = parsePublishedDateForTest("2099-01-01T00:00:00.000Z");
  assert.ok(future);
  assert.equal(scoreRecencyForTest(future), 1);
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

test("fetchJsonWithRetry retries on 429 and succeeds on the next attempt", async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(429);
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const start = Date.now();

  try {
    const data = await fetchJsonWithRetryForTest(`http://127.0.0.1:${port}/test`);
    const elapsed = Date.now() - start;
    assert.deepEqual(data, { ok: true });
    assert.equal(calls, 2);
    assert.ok(elapsed >= 350, "backoff must pause before retry");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchJsonWithRetry retries on timeout and succeeds on the next attempt", async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    if (calls === 1) {
      // Unresponsive on first attempt to trigger request timeout.
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const start = Date.now();

  try {
    const data = await fetchJsonWithRetryForTest(`http://127.0.0.1:${port}/test`);
    const elapsed = Date.now() - start;
    assert.deepEqual(data, { ok: true });
    assert.equal(calls, 2);
    assert.ok(elapsed >= 15000, "must wait for timeout before retrying");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("follows all standard HTTP redirects", async () => {
  const originalGet = http.get;
  let calls = 0;
  http.get = (url, options, callback) => {
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = new EventEmitter();
      if (calls++ % 2 === 0) {
        const status = Number(new URL(url).searchParams.get("status"));
        response.statusCode = status;
        response.headers = { location: "http://redirect.test/payload" };
        response.resume = () => {};
      } else {
        response.statusCode = 200;
        response.headers = {};
        response.resume = () => {};
        queueMicrotask(() => {
          response.emit("data", Buffer.from(JSON.stringify({ ok: true })));
          response.emit("end");
        });
      }
      callback(response);
    });
    return request;
  };

  try {
    for (const status of [301, 302, 303, 307, 308]) {
      const data = await fetchJsonWithRetryForTest(
        `http://redirect.test/redirect?status=${status}`
      );
      assert.deepEqual(data, { ok: true }, String(status));
    }
  } finally {
    http.get = originalGet;
  }
});

test("resolves relative HTTP redirects against the current URL", async () => {
  const originalGet = http.get;
  const baseUrl = "http://redirect.test/redirect";
  const expectedPayloadUrl = "http://redirect.test/payload";
  const requestedUrls = [];
  http.get = (url, options, callback) => {
    requestedUrls.push(String(url));
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.resume = () => {};
      if (String(url) === baseUrl) {
        response.statusCode = 302;
        response.headers = { location: "/payload" };
      } else if (String(url) === expectedPayloadUrl) {
        response.statusCode = 200;
        response.headers = {};
        queueMicrotask(() => {
          response.emit("data", Buffer.from(JSON.stringify({ ok: true })));
          response.emit("end");
        });
      } else {
        response.statusCode = 400;
        response.headers = {};
      }
      callback(response);
    });
    return request;
  };

  try {
    const data = await fetchJsonWithRetryForTest(baseUrl);
    assert.deepEqual(data, { ok: true });
    assert.deepEqual(requestedUrls, [baseUrl, expectedPayloadUrl]);
  } finally {
    http.get = originalGet;
  }
});

