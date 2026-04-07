import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { parseArgs, runCommand } from "../src/cli.js";

test("parseArgs keeps the first positional token as a run filter when the subcommand is omitted", () => {
  const parsed = parseArgs(["1001-demo", "--dry-run", "--max-iterations", "5"]);

  assert.equal(parsed.command, "run");
  assert.equal(parsed.parseError, undefined);
  assert.deepEqual(parsed.specFilters, ["1001-demo"]);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.maxIterations, 5);
});

test("parseArgs marks unknown first commands as parse errors", async () => {
  const parsed = parseArgs(["rn", "1001-demo"]);
  assert.equal(parsed.parseError, "Unknown command: rn");

  let errorOutput = "";
  const originalError = console.error;
  console.error = (message?: unknown) => {
    errorOutput += `${String(message)}\n`;
  };
  try {
    const exitCode = await runCommand(parsed);
    assert.equal(exitCode, 1);
  } finally {
    console.error = originalError;
  }

  assert.match(errorOutput, /Unknown command: rn/);
});

test("parseArgs rejects invalid --max-iterations values", async () => {
  const parsed = parseArgs(["run", "--max-iterations", "nope"]);
  assert.equal(parsed.parseError, "Invalid --max-iterations value: nope");
  assert.equal(parsed.maxIterations, 3);

  let errorOutput = "";
  const originalError = console.error;
  console.error = (message?: unknown) => {
    errorOutput += `${String(message)}\n`;
  };
  try {
    const exitCode = await runCommand(parsed);
    assert.equal(exitCode, 1);
  } finally {
    console.error = originalError;
  }

  assert.match(errorOutput, /Invalid --max-iterations value: nope/);
});

test("parseArgs accepts spec-like shorthand filters and flag-only run invocations", () => {
  const nestedSpec = parseArgs(["area/1234-demo.md"]);
  assert.equal(nestedSpec.parseError, undefined);
  assert.deepEqual(nestedSpec.specFilters, ["area/1234-demo.md"]);

  const flagOnly = parseArgs(["--dry-run"]);
  assert.equal(flagOnly.parseError, undefined);
  assert.equal(flagOnly.command, "run");
  assert.equal(flagOnly.dryRun, true);
});

test("create-spec scaffolds a spec with required and recommended sections", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-cli-"));
  await fs.mkdir(path.join(tempRoot, "specs"), { recursive: true });
  const specTarget = path.join("area", "1234-sample-feature.md");
  const previousCwd = process.cwd();

  process.chdir(tempRoot);
  try {
    const exitCode = await runCommand({
      command: "create-spec",
      specFilters: [],
      workspaceRoot: undefined,
      model: "gpt-5.3-codex",
      maxIterations: 3,
      dryRun: false,
      inspectTarget: undefined,
      createSpecTarget: specTarget,
    });
    assert.equal(exitCode, 0);
  } finally {
    process.chdir(previousCwd);
  }

  const created = await fs.readFile(path.join(tempRoot, "specs", specTarget), "utf8");
  assert.match(created, /^# 1234 - Sample Feature$/m);
  assert.match(created, /^Repo:\s*$/m);
  assert.match(created, /^Workdir:\s*$/m);
  assert.match(created, /^## Branch Instructions$/m);
  assert.match(created, /^## Goal$/m);
  assert.match(created, /^## Constraints$/m);
  assert.match(created, /^## Dependencies$/m);
  assert.match(created, /^## Required Reading$/m);
  assert.match(created, /^## Acceptance Criteria$/m);
  assert.match(created, /^## Verification \(Fast-First\)$/m);
  assert.match(created, /^## Big Picture$/m);
  assert.match(created, /^## Scope \(In\)$/m);
  assert.match(created, /^## Boundaries \(Out, No Overlap\)$/m);
  assert.match(created, /^## Commit Requirements$/m);
});
