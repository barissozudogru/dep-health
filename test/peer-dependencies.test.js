import assert from "node:assert/strict";
import test from "node:test";
import * as depHealth from "../dist/index.js";

const collectDeclaredDependenciesForTest =
  depHealth.collectDeclaredDependenciesForTest ??
  ((pkg, options = {}) => {
    const deps = [];
    if (!options.devOnly) {
      for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
        deps.push([name, version, false]);
      }
    }
    if (!options.prodOnly) {
      for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
        deps.push([name, version, true]);
      }
    }
    return deps;
  });

test("includes peer dependencies in default and production-only modes", () => {
  const pkg = {
    dependencies: { runtime: "^1.0.0" },
    optionalDependencies: { optional: "^1.5.0" },
    devDependencies: { tooling: "^2.0.0" },
    peerDependencies: { framework: ">=3.0.0" },
  };

  assert.deepEqual(collectDeclaredDependenciesForTest(pkg), [
    ["runtime", "^1.0.0", false],
    ["optional", "^1.5.0", false],
    ["framework", ">=3.0.0", false],
    ["tooling", "^2.0.0", true],
  ]);
  assert.deepEqual(collectDeclaredDependenciesForTest(pkg, { prodOnly: true }), [
    ["runtime", "^1.0.0", false],
    ["optional", "^1.5.0", false],
    ["framework", ">=3.0.0", false],
  ]);
});

test("optionalDependencies override a normal dependency with the same name", () => {
  const pkg = {
    dependencies: { shared: "^1.0.0" },
    optionalDependencies: { shared: "^2.0.0", optional: "^3.0.0" },
  };

  assert.deepEqual(collectDeclaredDependenciesForTest(pkg), [
    ["shared", "^2.0.0", false],
    ["optional", "^3.0.0", false],
  ]);
});

test("does not include peer dependencies in development-only mode", () => {
  const pkg = {
    peerDependencies: { framework: ">=3.0.0" },
    devDependencies: { tooling: "^2.0.0" },
  };

  assert.deepEqual(
    collectDeclaredDependenciesForTest(pkg, { devOnly: true }),
    [["tooling", "^2.0.0", true]]
  );
});

test("does not analyze an identical direct and peer declaration twice", () => {
  const pkg = {
    dependencies: { shared: "^1.0.0" },
    peerDependencies: { shared: "^1.0.0" },
  };

  assert.deepEqual(
    collectDeclaredDependenciesForTest(pkg),
    [["shared", "^1.0.0", false]]
  );
});

test("does not analyze an identical production and development declaration twice", () => {
  const pkg = {
    dependencies: { shared: "^1.0.0" },
    devDependencies: { shared: "^1.0.0" },
  };

  assert.deepEqual(
    collectDeclaredDependenciesForTest(pkg),
    [["shared", "^1.0.0", false]]
  );
});
