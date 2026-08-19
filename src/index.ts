import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  PackageJson,
  RegistryPackage,
  VersionData,
  DependencyHealth,
  ScoreBreakdown,
  VersionDelta,
  AnalysisResult,
  DownloadsResponse,
} from "./types.js";

const REGISTRY_BASE = "https://registry.npmjs.org";
const DOWNLOADS_BASE = "https://api.npmjs.org/downloads/point/last-week";
const CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 15_000;

function fetchJson<T>(url: string, redirectCount = 0): Promise<T> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error(`TOO_MANY_REDIRECTS:${url}`));
      return;
    }
    const mod = url.startsWith("https://") ? https : http;
    const req = mod.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        res.resume();
        if (!location) {
          reject(new Error(`REDIRECT_NO_LOCATION:${url}`));
          return;
        }
        resolve(fetchJson<T>(location, redirectCount + 1));
        return;
      }
      if (res.statusCode === 404) {
        reject(new Error(`NOT_FOUND:${url}`));
        res.resume();
        return;
      }
      if (res.statusCode === 429 || (res.statusCode ?? 0) >= 500) {
        const retryAfter = Number(res.headers["retry-after"]);
        res.resume();
        reject(
          Object.assign(new Error(`HTTP_${res.statusCode}:${url}`), {
            retryable: true,
            retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : null,
          })
        );
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP_${res.statusCode}:${url}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
        } catch (e) {
          reject(new Error(`PARSE_ERROR:${url}`));
        }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => {
      req.destroy(new Error(`TIMEOUT:${url}`));
    });
    req.on("error", reject);
  });
}

function parseVersion(version: string): [number, number, number] | null {
  const cleaned = version.replace(/^[^0-9]*/, "");
  const match = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [
    parseInt(match[1], 10),
    parseInt(match[2] ?? "0", 10),
    parseInt(match[3] ?? "0", 10),
  ];
}

function computeVersionDelta(installed: string, latest: string): VersionDelta {
  const iv = parseVersion(installed);
  const lv = parseVersion(latest);
  if (!iv || !lv) return { major: 0, minor: 0, patch: 0 };

  const [iMaj, iMin, iPat] = iv;
  const [lMaj, lMin, lPat] = lv;

  if (lMaj > iMaj) return { major: lMaj - iMaj, minor: 0, patch: 0 };
  if (lMaj === iMaj && lMin > iMin) return { major: 0, minor: lMin - iMin, patch: 0 };
  if (lMaj === iMaj && lMin === iMin && lPat > iPat) return { major: 0, minor: 0, patch: lPat - iPat };
  return { major: 0, minor: 0, patch: 0 };
}

function scoreFreshness(delta: VersionDelta): number {
  // 30% weight — raw score 0-10
  const raw = 10 - delta.major * 3 - delta.minor * 1 - delta.patch * 0.5;
  return Math.max(0, Math.min(10, raw));
}

function scoreRecency(lastPublished: Date | null): number {
  // 30% weight — raw score 0-10
  if (!lastPublished) return 1;
  const ageMs = Date.now() - lastPublished.getTime();
  const months = ageMs / (1000 * 60 * 60 * 24 * 30);
  if (months < 6) return 10;
  if (months < 12) return 7;
  if (months < 24) return 4;
  return 1;
}

function scoreDeprecation(deprecated: boolean): number {
  // 20% weight — 0 or 10
  return deprecated ? 0 : 10;
}

function scorePopularity(
  hasTypes: boolean,
  weeklyDownloads: number | null
): number | null {
  // 20% weight — raw score 0-10, or null when the download count is unknown.
  // Scoring an unknown count as zero would mark popular packages unpopular.
  if (weeklyDownloads === null) return null;
  let score = 0;
  if (hasTypes) score += 2;
  // Tiered download score
  if (weeklyDownloads >= 1_000_000) score += 8;
  else if (weeklyDownloads >= 100_000) score += 7;
  else if (weeklyDownloads >= 10_000) score += 5;
  else if (weeklyDownloads >= 1_000) score += 3;
  else if (weeklyDownloads >= 100) score += 1;
  return Math.min(10, score);
}

/**
 * Weighted average over the signals that are actually available.
 *
 * When popularity is unknown its weight is dropped and the remaining weights
 * are renormalised, so a failed lookup lowers confidence rather than the score.
 */
function computeScore(breakdown: Omit<ScoreBreakdown, "total">): ScoreBreakdown {
  const parts: Array<{ value: number; weight: number }> = [
    { value: breakdown.freshness, weight: 0.3 },
    { value: breakdown.recency, weight: 0.3 },
    { value: breakdown.deprecation, weight: 0.2 },
  ];
  if (breakdown.popularity !== null) {
    parts.push({ value: breakdown.popularity, weight: 0.2 });
  }

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const weighted = parts.reduce((sum, p) => sum + p.value * p.weight, 0);
  const total = weighted / totalWeight;

  return { ...breakdown, total: Math.round(total * 10) / 10 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * fetchJson with backoff for rate limits and transient server errors.
 *
 * The downloads API starts returning 429 after a handful of rapid requests.
 * Without this, a rate limit surfaced as a failed lookup, which was then scored
 * as zero popularity, so the same project scored differently on consecutive
 * runs and a --min-score gate in CI failed at random.
 */
async function fetchJsonWithRetry<T>(url: string, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetchJson<T>(url);
    } catch (err) {
      lastErr = err;
      const retryable = (err as { retryable?: boolean }).retryable === true;
      if (!retryable || attempt === attempts - 1) throw err;
      const hinted = (err as { retryAfterMs?: number | null }).retryAfterMs;
      const backoff = hinted ?? Math.min(4000, 400 * 2 ** attempt);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/**
 * Weekly downloads for many packages at once.
 *
 * The npm downloads API accepts a comma-separated list, which turns one request
 * per dependency into one request per batch and keeps the whole lookup under
 * the rate limit. Scoped packages are rejected by bulk lookups, so those are
 * still fetched individually.
 *
 * A null value means the count is unknown, which is different from zero and is
 * scored differently.
 */
const BULK_BATCH_SIZE = 100;

async function fetchWeeklyDownloadsMap(
  names: string[]
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  const scoped = names.filter((n) => n.startsWith("@"));
  const plain = names.filter((n) => !n.startsWith("@"));

  for (let i = 0; i < plain.length; i += BULK_BATCH_SIZE) {
    const batch = plain.slice(i, i + BULK_BATCH_SIZE);
    try {
      const data = await fetchJsonWithRetry<
        Record<string, DownloadsResponse | null>
      >(`${DOWNLOADS_BASE}/${batch.join(",")}`);
      for (const name of batch) {
        const entry = data[name];
        result.set(name, entry ? entry.downloads ?? null : null);
      }
    } catch {
      // Unknown, not zero.
      for (const name of batch) result.set(name, null);
    }
  }

  // Scoped packages one at a time, sequentially, to stay under the rate limit.
  for (const name of scoped) {
    try {
      const data = await fetchJsonWithRetry<DownloadsResponse>(
        `${DOWNLOADS_BASE}/${name}`
      );
      result.set(name, data.downloads ?? null);
    } catch {
      result.set(name, null);
    }
  }

  return result;
}

function stripVersionRange(version: string): string {
  return version.replace(/^[\^~>=<*]+/, "").split(" ")[0];
}

async function analyzePackage(
  name: string,
  installedRange: string,
  isDev: boolean,
  weeklyDownloads: number | null
): Promise<DependencyHealth | null> {
  let registry: RegistryPackage;
  try {
    const encoded = name.startsWith("@")
      ? "@" + encodeURIComponent(name.slice(1))
      : encodeURIComponent(name);
    // Retries transient failures before giving up. Without that, a single 429
    // under concurrency would abort the whole run, and the registry does rate
    // limit once enough dependencies are looked up at once.
    registry = await fetchJsonWithRetry<RegistryPackage>(
      `${REGISTRY_BASE}/${encoded}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // A 404 means the package is not on the public registry: a local path, a
    // git dependency, or a private package. That is expected, so it is skipped.
    if (message.startsWith("NOT_FOUND")) {
      return null;
    }

    // Anything else is a real failure. Skipping it would drop the dependency
    // from the analysis and report a score that silently covers fewer packages
    // than the caller thinks.
    throw new Error(
      `Registry lookup failed for "${name}": ${message}. ` +
        `Scores would cover fewer packages than reported, so the run is stopped.`
    );
  }

  const latestVersion = registry["dist-tags"]?.latest ?? "0.0.0";
  const installedVersion = stripVersionRange(installedRange);

  // Last publish time from the registry time object
  const lastPublishStr =
    registry.time?.[latestVersion] ?? registry.time?.modified ?? null;
  const lastPublished = lastPublishStr ? new Date(lastPublishStr) : null;

  const latestVersionData: VersionData =
    registry.versions?.[latestVersion] ?? {};
  const deprecated = !!latestVersionData.deprecated;
  const deprecationMessage =
    typeof latestVersionData.deprecated === "string"
      ? latestVersionData.deprecated
      : undefined;

  const hasTypes =
    !!latestVersionData.types ||
    !!latestVersionData.typings ||
    name.startsWith("@types/");

  const versionsBehind = computeVersionDelta(installedVersion, latestVersion);

  const rawBreakdown = {
    freshness: scoreFreshness(versionsBehind),
    recency: scoreRecency(lastPublished),
    deprecation: scoreDeprecation(deprecated),
    popularity: scorePopularity(hasTypes, weeklyDownloads),
  };
  const breakdown = computeScore(rawBreakdown);

  return {
    name,
    installedVersion,
    latestVersion,
    score: breakdown.total,
    breakdown,
    deprecated,
    deprecationMessage,
    lastPublished,
    versionsBehind,
    hasTypes,
    weeklyDownloads,
    isDev,
  };
}

async function runConcurrent<T>(
  items: Array<() => Promise<T>>,
  concurrency: number,
  onComplete?: (completed: number, total: number) => void
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;
  let completed = 0;
  const total = items.length;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = index++;
      results[current] = await items[current]();
      completed++;
      onComplete?.(completed, total);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () =>
    worker()
  );
  await Promise.all(workers);
  return results;
}

export interface AnalyzeOptions {
  prodOnly?: boolean;
  devOnly?: boolean;
  onProgress?: (completed: number, total: number) => void;
}

export async function analyze(
  directory: string,
  options: AnalyzeOptions = {}
): Promise<AnalysisResult> {
  const { prodOnly = false, devOnly = false, onProgress } = options;

  const pkgPath = path.join(directory, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`No package.json found at ${pkgPath}`);
  }

  const raw = fs.readFileSync(pkgPath, "utf8");
  const pkg: PackageJson = JSON.parse(raw);

  const deps: Array<[string, string, boolean]> = [];
  if (!devOnly) {
    for (const [n, v] of Object.entries(pkg.dependencies ?? {})) {
      deps.push([n, v, false]);
    }
  }
  if (!prodOnly) {
    for (const [n, v] of Object.entries(pkg.devDependencies ?? {})) {
      deps.push([n, v, true]);
    }
  }

  // One batched request for all download counts instead of one per dependency.
  // This is what keeps the whole run under the rate limit.
  const downloads = await fetchWeeklyDownloadsMap(deps.map(([name]) => name));

  const tasks = deps.map(
    ([name, version, isDev]) =>
      () =>
        analyzePackage(name, version, isDev, downloads.get(name) ?? null)
  );

  const rawResults = await runConcurrent(tasks, CONCURRENCY, onProgress);
  const results = rawResults.filter(
    (r): r is DependencyHealth => r !== null
  );

  // Sort ascending — worst first
  results.sort((a, b) => a.score - b.score);

  const overallScore =
    results.length > 0
      ? Math.round(
          (results.reduce((sum, d) => sum + d.score, 0) / results.length) * 10
        ) / 10
      : 10;

  const summary = {
    critical: results.filter((d) => d.score <= 3).length,
    warning: results.filter((d) => d.score > 3 && d.score <= 6).length,
    healthy: results.filter((d) => d.score > 6).length,
    total: results.length,
  };

  return {
    packageName: pkg.name ?? path.basename(directory),
    packageVersion: pkg.version ?? "0.0.0",
    analyzedAt: new Date(),
    dependencies: results,
    overallScore,
    summary,
  };
}

/** A 404 means the package is not on the public registry, which is expected. */
export function isNotFoundForTest(message: string): boolean {
  return message.startsWith("NOT_FOUND");
}

/** Transient statuses are retried rather than failing the run outright. */
export function isRetryableStatusForTest(status: number): boolean {
  return status === 429 || status >= 500;
}

// Exported for tests: the scoring rules are where the rate-limit bug surfaced.
export const computeScoreForTest = computeScore;
export const scorePopularityForTest = scorePopularity;
