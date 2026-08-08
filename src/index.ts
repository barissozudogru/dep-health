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
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
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

function scorePopularity(hasTypes: boolean, weeklyDownloads: number): number {
  // 20% weight — raw score 0-10
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

function computeScore(breakdown: Omit<ScoreBreakdown, "total">): ScoreBreakdown {
  const total =
    breakdown.freshness * 0.3 +
    breakdown.recency * 0.3 +
    breakdown.deprecation * 0.2 +
    breakdown.popularity * 0.2;
  return { ...breakdown, total: Math.round(total * 10) / 10 };
}

async function fetchWeeklyDownloads(name: string): Promise<number> {
  try {
    // The npm downloads API accepts scoped packages as @scope/pkg without encoding the slash.
    // Encoding the slash breaks the endpoint for scoped packages.
    const data = await fetchJson<DownloadsResponse>(
      `${DOWNLOADS_BASE}/${name}`
    );
    return data.downloads ?? 0;
  } catch {
    return 0;
  }
}

function stripVersionRange(version: string): string {
  return version.replace(/^[\^~>=<*]+/, "").split(" ")[0];
}

async function analyzePackage(
  name: string,
  installedRange: string,
  isDev: boolean
): Promise<DependencyHealth | null> {
  let registry: RegistryPackage;
  try {
    const encoded = name.startsWith("@")
      ? "@" + encodeURIComponent(name.slice(1))
      : encodeURIComponent(name);
    registry = await fetchJson<RegistryPackage>(`${REGISTRY_BASE}/${encoded}`);
  } catch (err) {
    // Package not on registry (local path, git dep, etc.) — skip silently
    return null;
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

  const weeklyDownloads = await fetchWeeklyDownloads(name);
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

  const tasks = deps.map(
    ([name, version, isDev]) =>
      () =>
        analyzePackage(name, version, isDev)
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
