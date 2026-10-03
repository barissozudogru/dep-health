import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

/**
 * parseArgs matched each argument against the known flags and had no case for
 * anything else, so an unrecognized argument fell through silently. A mistyped
 * gate flag ("dep-health --min-scor 4") ran a full analysis with no gate
 * applied and exited 0, which a CI pipeline reads as a pass while the intended
 * enforcement never happened. The same hole swallowed stray positional
 * arguments, which the CLI has never accepted. These tests pin the rejection,
 * which happens before any analysis or network access starts.
 */

function runCli(args) {
  return spawnSync(process.execPath, ["dist/cli.js", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

test("a mistyped gate flag exits 1 instead of running ungated", () => {
  const result = runCli(["--min-scor", "4"]);
  // Before the fix this printed a normal report and exited 0.
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /--min-scor/);
  assert.doesNotMatch(result.stdout, /packages analyzed/);
});

test("a mistyped flag in the equals form is rejected too", () => {
  const result = runCli(["--min-scor=4"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /--min-scor=4/);
});

test("a positional argument is rejected rather than ignored", () => {
  const result = runCli(["./my-project"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /my-project/);
});

test("a minimum score with trailing text is rejected", () => {
  const result = runCli(["--min-score", "4oops", "--help"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /--min-score requires a numeric argument/);
});

test("a minimum score with trailing text is rejected in equals form", () => {
  const result = runCli(["--min-score=4oops", "--help"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /--min-score requires a numeric argument/);
});

test("a non-finite minimum score is rejected", () => {
  const result = runCli(["--min-score=1e309", "--help"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /--min-score requires a finite numeric argument/);
});

test("a finite scientific-notation minimum score remains accepted", () => {
  const result = runCli(["--min-score=4e2", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dep-health - npm dependency health scorer/);
});
