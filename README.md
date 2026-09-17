<p align="center">
  <img src="./assets/social-preview.svg" alt="dep-health" width="900" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@barissozudogru/dep-health"><img alt="npm version" src="https://img.shields.io/npm/v/@barissozudogru/dep-health?style=flat-square&color=8D88E8"></a>
  <a href="https://www.npmjs.com/package/@barissozudogru/dep-health"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@barissozudogru/dep-health?style=flat-square&color=8D88E8"></a>
  <a href="https://github.com/barissozudogru/dep-health/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/barissozudogru/dep-health/actions/workflows/ci.yml/badge.svg"></a>
  <a href="./LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/License-MIT-8D88E8?style=flat-square"></a>
</p>

# dep-health

Health score for every npm dependency in a project. Queries the npm registry for each dependency in `package.json` and calculates a score from 0 to 10 based on version freshness, publish recency, deprecation status, and popularity. Zero runtime dependencies.

This is a maintenance review aid, not a vulnerability or CVE scanner. A low score is a prompt to investigate, not an automatic removal decision.

[Tool page](https://petri-labs.org/tools/dep-health/) · [npm](https://www.npmjs.com/package/@barissozudogru/dep-health) · [Source](https://github.com/barissozudogru/dep-health)

```bash
npx @barissozudogru/dep-health
```

## Usage

```bash
# Analyze current directory
dep-health

# Analyze a specific project
dep-health --path ./my-project

# Filter by dependency type
dep-health --prod-only
dep-health --dev-only

# JSON output
dep-health --json > report.json

# Fail CI if any dependency scores below threshold
dep-health --min-score 5
```

## Options

| Flag | Description | Default |
|---|---|---|
| `--path <dir>` | Directory containing `package.json` | Current working directory |
| `--json` | Output results as JSON instead of formatted text | Off |
| `--min-score <n>` | Exit with code `1` if any dependency scores below `n` | Off |
| `--prod-only` | Analyze only `dependencies` (skip `devDependencies`) | Off |
| `--dev-only` | Analyze only `devDependencies` (skip `dependencies`) | Off |
| `-v, --version` | Print version and exit | - |
| `-h, --help` | Show help message | - |

`--prod-only` and `--dev-only` are mutually exclusive.

## Scoring Breakdown

Each dependency receives a weighted score out of 10:

| Signal | Weight | Detail |
|---|---|---|
| Freshness | 30% | Major versions behind: -3 each. Minor: -1 each. Patch: -0.5 each. |
| Recency | 30% | Last publish < 6 months: 10. < 1 year: 7. < 2 years: 4. Older: 1. |
| Deprecation | 20% | Deprecated: 0. Not deprecated: 10. |
| Popularity | 20% | TypeScript types present: +2. Weekly downloads: tiered 0 to 8. When the download count is unavailable this signal is dropped and the remaining weights are renormalised, rather than scored as zero. |

Download tiers (popularity sub-score):

| Weekly downloads | Score contribution |
|---|---|
| >= 1,000,000 | +8 |
| >= 100,000 | +7 |
| >= 10,000 | +5 |
| >= 1,000 | +3 |
| >= 100 | +1 |
| < 100 | 0 |

## Verified output

The current release was run against this repository's real `package.json` on 2026-08-26:

```text
HEALTHY (2)

  @types/node  [dev] [TS]
  7.0/10
  freshness:0.0  recency:10.0  deprecation:10.0  popularity:10.0

  typescript  [dev]
  7.8/10
  freshness:4.0  recency:10.0  deprecation:10.0  popularity:n/a

Overall project score: 7.4 / 10 (HEALTHY)
2 packages analyzed
```

Registry data changes over time, so repeated runs can legitimately differ. Unknown download data is excluded from the weighted score instead of being treated as zero.

Dependencies that are not on the public registry (git, file, and private packages) cannot be scored. They are named in the report and listed in the JSON output as `skippedDependencies`. When none of the declared dependencies can be resolved, the report says so instead of printing a score, and a `--min-score` gate fails rather than passing on zero evidence.

If this saves you time, consider [starring the repository](https://github.com/barissozudogru/dep-health). It helps other developers find it.

## CI Integration

Use the reusable action to write the evidence to the workflow summary and enforce a threshold:

```yaml
name: Dependency health

on: [pull_request]

jobs:
  dep-health:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: barissozudogru/dep-health@v0.5.1
        with:
          path: .
          min-score: "4"
```

Add a step to your CI pipeline to enforce a minimum health score:

```yaml
- name: Check dependency health
  run: npx @barissozudogru/dep-health --min-score 4
```

With JSON output for artifact upload:

```yaml
- name: Dependency health report
  run: npx @barissozudogru/dep-health --json > dep-health-report.json

- name: Enforce health gate
  run: npx @barissozudogru/dep-health --min-score 4
```

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Analysis complete. All dependencies at or above `--min-score` (or no gate set). |
| `1` | One or more dependencies scored below `--min-score`, or, with `--min-score` set, no declared dependency could be resolved on the public registry, or a fatal error occurred. |

## Requirements

- Node.js >= 18.0.0

## License

[MIT](LICENSE)
