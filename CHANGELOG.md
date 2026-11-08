# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed

- Recency scores now use exact calendar-month boundaries, including end-of-month dates.

## [0.5.1] - 2026-08-26

### Fixed

- The GitHub Action now installs and invokes the pinned CLI binary explicitly.

### Added

- Command help now links directly to the source repository.

## [0.5.0] - 2026-08-26

### Added

- Reusable GitHub Action that writes the full score evidence to the workflow summary and enforces a minimum score.
- Continuous integration, Petri Labs discovery metadata, download badges, and a repository social preview.

### Changed

- Documentation now separates maintenance signals from vulnerability analysis more explicitly.
- The package homepage now points to the focused Petri Labs tool page while source and issues remain on GitHub.

## [0.4.0] - 2026-08-19

### Fixed
- Download counts are fetched in one batched request per 100 packages, keeping a run under the registry rate limit.
- An unavailable download count is recorded as unknown rather than zero, and its weight is renormalised out of the score.
- Registry failures other than 404 stop the run instead of silently dropping the dependency.

### Added
- Retry with backoff for 429 and 5xx responses.
- Test suite.

## [0.3.0] - 2025-03-12

### Added
- `--prod-only` flag to analyze only `dependencies` and skip `devDependencies`.
- `--dev-only` flag to analyze only `devDependencies` and skip `dependencies`.
- Live progress indicator written to `stderr` during analysis.
- `-v` / `--version` flag to print the current version and exit.

### Fixed
- Scoped package URLs (e.g. `@types/node`) now encode correctly against the npm registry.
- TTY detection is now performed independently for `stdout` and `stderr` so color and progress output work correctly when stdout is redirected.

---

## [0.2.0] - 2025-02-20

### Added
- `--min-score <n>` flag for use as a CI gate; exits with code `1` when any dependency scores below the threshold.
- `--json` flag to emit the full analysis as machine-readable JSON.
- Score breakdown per dependency (`freshness`, `recency`, `deprecation`, `popularity`).
- CRITICAL / WARNING / HEALTHY grouping in terminal output.
- Color-coded progress bar rendered inline with each dependency row.

---

## [0.1.0] - 2025-01-15

### Added
- Initial release.
- Fetches registry metadata for every `dependencies` and `devDependencies` entry.
- Scores each dependency 0 - 10 using freshness, recency, deprecation, and popularity signals.
- `--path <dir>` flag to target a project outside the current directory.
- Concurrent registry requests with a configurable concurrency ceiling.
- Zero runtime dependencies; uses Node's built-in `https` module.
