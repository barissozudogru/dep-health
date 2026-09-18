#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { analyze } from "./index.js";
import { DependencyHealth, AnalysisResult, HealthCategory } from "./types.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

// ── ANSI colors ──────────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY === true;
const c = {
  reset: isTTY ? "\x1b[0m" : "",
  bold: isTTY ? "\x1b[1m" : "",
  dim: isTTY ? "\x1b[2m" : "",
  red: isTTY ? "\x1b[31m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  green: isTTY ? "\x1b[32m" : "",
  cyan: isTTY ? "\x1b[36m" : "",
  white: isTTY ? "\x1b[37m" : "",
  bgRed: isTTY ? "\x1b[41m" : "",
  bgYellow: isTTY ? "\x1b[43m" : "",
  bgGreen: isTTY ? "\x1b[42m" : "",
};

// ── Package version (read from package.json at runtime) ──────────────────────
function getPackageVersion(): string {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const content = fs.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(content) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── Argument parsing (no external deps) ─────────────────────────────────────
interface CliArgs {
  targetDir: string;
  jsonMode: boolean;
  minScore: number | null;
  help: boolean;
  version: boolean;
  prodOnly: boolean;
  devOnly: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let targetDir = process.cwd();
  let jsonMode = false;
  let minScore: number | null = null;
  let help = false;
  let version = false;
  let prodOnly = false;
  let devOnly = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg === "--json") {
      jsonMode = true;
    } else if (arg === "--prod-only") {
      prodOnly = true;
    } else if (arg === "--dev-only") {
      devOnly = true;
    } else if (arg === "--path" || arg === "-p") {
      const next = args[++i];
      if (!next) {
        console.error("--path requires a directory argument");
        process.exit(1);
      }
      targetDir = path.resolve(next);
    } else if (arg === "--min-score") {
      const next = args[++i];
      const val = parseFloat(next ?? "");
      if (isNaN(val)) {
        console.error("--min-score requires a numeric argument");
        process.exit(1);
      }
      minScore = val;
    } else if (arg.startsWith("--path=")) {
      targetDir = path.resolve(arg.slice("--path=".length));
    } else if (arg.startsWith("--min-score=")) {
      const val = parseFloat(arg.slice("--min-score=".length));
      if (isNaN(val)) {
        console.error("--min-score requires a numeric argument");
        process.exit(1);
      }
      minScore = val;
    } else {
      // A mistyped flag used to fall through silently, which disabled
      // whatever it was meant to configure: "--min-scor 4" ran with no
      // gate and exited 0, so a CI pipeline went green without the
      // check ever happening. Reject instead, before anything runs.
      console.error(`Unknown argument: ${arg}`);
      console.error("Run dep-health --help to see the supported options.");
      process.exit(1);
    }
  }

  if (prodOnly && devOnly) {
    console.error("--prod-only and --dev-only cannot be used together");
    process.exit(1);
  }

  return { targetDir, jsonMode, minScore, help, version, prodOnly, devOnly };
}

function printHelp(): void {
  console.log(`
dep-health - npm dependency health scorer

USAGE
  dep-health [options]

OPTIONS
  --path <dir>       Directory containing package.json  (default: cwd)
  --json             Output results as JSON for CI pipelines
  --min-score <n>    Exit with code 1 if any dependency scores below <n>
  --prod-only        Analyze only production dependencies
  --dev-only         Analyze only dev dependencies
  -v, --version      Print version and exit
  -h, --help         Show this help message

SCORING (0-10, higher is better)
  Freshness     30%   Major versions behind penalized (-3 each), minor (-1), patch (-0.5)
  Recency       30%   Last publish date: <6 months=10, <1 year=7, <2 years=4, older=1
  Deprecation   20%   Deprecated packages score 0
  Popularity    20%   Has TypeScript types +2, weekly downloads tiered score

CATEGORIES
  CRITICAL    0-3   Immediate attention required
  WARNING     4-6   Should be updated soon
  HEALTHY     7-10  Looks good

EXAMPLES
  dep-health
  dep-health --path ./my-project
  dep-health --json > report.json
  dep-health --min-score 5       # CI gate: fail if any dep scores below 5
  dep-health --prod-only         # skip devDependencies
  dep-health --dev-only          # skip dependencies

SOURCE AND DOCUMENTATION
  https://github.com/barissozudogru/dep-health
`);
}

function category(score: number): HealthCategory {
  if (score <= 3) return "CRITICAL";
  if (score <= 6) return "WARNING";
  return "HEALTHY";
}

function categoryColor(cat: HealthCategory): string {
  if (cat === "CRITICAL") return c.red;
  if (cat === "WARNING") return c.yellow;
  return c.green;
}

function scoreBar(score: number): string {
  if (!isTTY) return `${score.toFixed(1)}/10`;
  const filled = Math.round(score);
  const empty = 10 - filled;
  const cat = category(score);
  const col = categoryColor(cat);
  return `${col}${"█".repeat(filled)}${c.dim}${"░".repeat(empty)}${c.reset} ${c.bold}${score.toFixed(1)}${c.reset}`;
}

function formatAge(date: Date | null): string {
  if (!date) return "unknown";
  const ms = Date.now() - date.getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function formatDownloads(n: number | null): string {
  // An unknown count is reported as unknown rather than as zero, so a rate
  // limit is never mistaken for an unpopular package.
  if (n === null) return "downloads unavailable";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M/wk`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k/wk`;
  return `${n}/wk`;
}

function formatVersionDelta(dep: DependencyHealth): string {
  const { major, minor, patch } = dep.versionsBehind;
  if (major === 0 && minor === 0 && patch === 0) return "up to date";
  const parts: string[] = [];
  if (major > 0) parts.push(`${major} major`);
  if (minor > 0) parts.push(`${minor} minor`);
  if (patch > 0) parts.push(`${patch} patch`);
  return `${parts.join(", ")} behind`;
}

/**
 * True when package.json declared dependencies but none resolved on the public
 * registry, so every lookup took the 404 skip path. The scores in such a
 * report cover zero packages: this happens behind a private registry mirror or
 * a proxy that answers 404 for registry.npmjs.org.
 */
function nothingScored(result: AnalysisResult): boolean {
  return result.dependencies.length === 0 && result.skippedDependencies.length > 0;
}

function printPretty(result: AnalysisResult, minScore: number | null): void {
  const { packageName, packageVersion, dependencies, overallScore, summary, analyzedAt } =
    result;
  const skipped = result.skippedDependencies;

  console.log();
  console.log(
    `${c.bold}${c.cyan}dep-health${c.reset}  ${c.dim}v${packageVersion} of ${packageName}${c.reset}  ${c.dim}${analyzedAt.toISOString()}${c.reset}`
  );
  console.log(
    `${c.dim}${"─".repeat(72)}${c.reset}`
  );

  const groups: Record<HealthCategory, DependencyHealth[]> = {
    CRITICAL: dependencies.filter((d) => d.score <= 3),
    WARNING: dependencies.filter((d) => d.score > 3 && d.score <= 6),
    HEALTHY: dependencies.filter((d) => d.score > 6),
  };

  const headerColors: Record<HealthCategory, string> = {
    CRITICAL: c.red,
    WARNING: c.yellow,
    HEALTHY: c.green,
  };

  for (const cat of ["CRITICAL", "WARNING", "HEALTHY"] as HealthCategory[]) {
    const list = groups[cat];
    if (list.length === 0) continue;
    console.log();
    console.log(
      `${headerColors[cat]}${c.bold}  ${cat} (${list.length})${c.reset}`
    );
    console.log();

    for (const dep of list) {
      const tag = dep.isDev ? `${c.dim}[dev]${c.reset} ` : "";
      const typesTag = dep.hasTypes ? `${c.cyan}[TS]${c.reset} ` : "";
      const deprecTag = dep.deprecated ? `${c.red}[DEPRECATED]${c.reset} ` : "";

      console.log(
        `    ${c.bold}${dep.name}${c.reset}  ${tag}${typesTag}${deprecTag}`
      );
      console.log(
        `    ${scoreBar(dep.score)}   ${c.dim}${dep.installedVersion} -> ${dep.latestVersion}${c.reset}`
      );
      console.log(
        `    ${c.dim}${formatVersionDelta(dep)}  |  last publish: ${formatAge(dep.lastPublished)}  |  ${formatDownloads(dep.weeklyDownloads)}${c.reset}`
      );

      const breakdown = dep.breakdown;
      console.log(
        `    ${c.dim}freshness:${breakdown.freshness.toFixed(1)}  recency:${breakdown.recency.toFixed(1)}  deprecation:${breakdown.deprecation.toFixed(1)}  popularity:${breakdown.popularity === null ? "n/a" : breakdown.popularity.toFixed(1)}${c.reset}`
      );

      if (dep.deprecated && dep.deprecationMessage) {
        console.log(`    ${c.yellow}note: ${dep.deprecationMessage}${c.reset}`);
      }
      console.log();
    }
  }

  console.log(`${c.dim}${"─".repeat(72)}${c.reset}`);

  if (nothingScored(result)) {
    console.log();
    console.log(
      `${c.red}${c.bold}  WARNING: none of the ${skipped.length} declared dependencies is on the public registry,${c.reset}`
    );
    console.log(
      `${c.red}  so no dependency was scored and this report contains no health evidence:${c.reset}`
    );
    for (const name of skipped) {
      console.log(`    - ${name}`);
    }
    console.log(
      `  Overall project score:  ${c.bold}n/a${c.reset}  (no dependency could be scored)`
    );
  } else {
    const overallCat = category(overallScore);
    const overallCol = categoryColor(overallCat);
    console.log(
      `  Overall project score:  ${overallCol}${c.bold}${overallScore.toFixed(1)} / 10${c.reset}  (${overallCat})`
    );
  }
  console.log(
    `  ${c.dim}${summary.total} packages analyzed  |  ${c.red}${summary.critical} critical${c.reset}  ${c.dim}|  ${c.yellow}${summary.warning} warning${c.reset}  ${c.dim}|  ${c.green}${summary.healthy} healthy${c.reset}`
  );
  if (skipped.length > 0 && !nothingScored(result)) {
    console.log(
      `  ${c.dim}Skipped, not on the public registry: ${skipped.join(", ")}${c.reset}`
    );
  }
  console.log();

  if (minScore !== null) {
    const failing = dependencies.filter((d) => d.score < minScore);
    if (failing.length > 0) {
      console.log(
        `${c.red}${c.bold}  CI gate failed: ${failing.length} package(s) scored below ${minScore}${c.reset}`
      );
      for (const d of failing) {
        console.log(
          `    - ${d.name}  (${d.score.toFixed(1)})`
        );
      }
      console.log();
      process.exit(1);
    } else if (nothingScored(result)) {
      // Passing here would rest on zero scored dependencies, which is how a
      // private registry project sailed through the gate with a perfect 10.
      console.log(
        `${c.red}${c.bold}  CI gate failed: none of the ${skipped.length} declared dependencies could be scored${c.reset}`
      );
      console.log();
      process.exit(1);
    } else {
      console.log(
        `${c.green}  CI gate passed: all packages scored >= ${minScore}${c.reset}`
      );
      console.log();
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.version) {
    console.log(getPackageVersion());
    process.exit(0);
  }

  if (!args.jsonMode) {
    console.log(
      `${isTTY ? "\x1b[36m" : ""}Analyzing dependencies in ${args.targetDir}...${isTTY ? "\x1b[0m" : ""}`
    );
  }

  let result: AnalysisResult;
  try {
    result = await analyze(args.targetDir, {
      prodOnly: args.prodOnly,
      devOnly: args.devOnly,
      onProgress: (completed, total) => {
        const isStderrTTY = process.stderr.isTTY === true;
        if (isStderrTTY) {
          process.stderr.write(
            `\rAnalyzing ${completed}/${total} dependencies...`
          );
          if (completed === total) {
            process.stderr.write("\n");
          }
        } else {
          if (completed === total) {
            process.stderr.write(`Analyzed ${total} dependencies.\n`);
          }
        }
      },
    });
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  if (args.jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    if (args.minScore !== null) {
      const failing = result.dependencies.filter(
        (d) => d.score < args.minScore!
      );
      if (failing.length > 0 || nothingScored(result)) {
        // The report on stdout carries the evidence; stderr carries the reason
        // a pipeline sees a nonzero exit next to an empty dependencies array.
        if (nothingScored(result)) {
          console.error(
            `CI gate failed: none of the ${result.skippedDependencies.length} declared dependencies could be scored`
          );
        }
        process.exit(1);
      }
    }
    return;
  }

  printPretty(result, args.minScore);
}

main().catch((err) => {
  console.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
