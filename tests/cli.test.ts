import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { runCommand } from "../src/cli.js";

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
