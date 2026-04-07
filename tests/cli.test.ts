import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { parseArgs, runCommand } from "../src/cli.js";

async function writeRunnableSpec(projectRoot: string, relativePath: string, title: string): Promise<void> {
  const absolute = path.join(projectRoot, "specs", relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(
    absolute,
    `# ${title}

Repo: demo-repo
Workdir: demo-repo

## Branch Instructions
- Source branch: \`dev\`
- Create branch: \`feature/${path.basename(relativePath, ".md")}\`
- PR target: \`dev\`

## Goal
Stream progress output.

## Verification (Fast-First)
\`\`\`bash
git status --short
\`\`\`
`,
    "utf8",
  );
}

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
  assert.equal(flagOnly.model, undefined);
});

test("parseArgs leaves model unset when --model is omitted so smart role policy can decide", () => {
  const parsed = parseArgs(["run", "1001-demo"]);
  assert.equal(parsed.model, undefined);
});

test("parseArgs rejects --model when the explicit value is missing", () => {
  assert.equal(parseArgs(["run", "--model"]).parseError, "Missing --model value");
  assert.equal(parseArgs(["run", "--model", "--dry-run"]).parseError, "Missing --model value");
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

test("runCommand streams spec-indexed progress lines and log paths during run", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-cli-run-"));
  await fs.mkdir(path.join(tempRoot, "specs"), { recursive: true });
  await writeRunnableSpec(tempRoot, "1001-one.md", "1001 - One");
  await writeRunnableSpec(tempRoot, "1002-two.md", "1002 - Two");

  let logOutput = "";
  const originalLog = console.log;
  const previousCwd = process.cwd();
  console.log = (message?: unknown) => {
    logOutput += `${String(message)}\n`;
  };
  process.chdir(tempRoot);
  try {
    const exitCode = await runCommand(
      {
        command: "run",
        specFilters: [],
        workspaceRoot: tempRoot,
        model: "gpt-5.3-codex",
        maxIterations: 3,
        dryRun: false,
        inspectTarget: undefined,
        createSpecTarget: undefined,
      },
      {
        executeSpec: async (_paths, _options, spec, deps) => {
          const runId = `${spec.specId}-run`;
          await deps?.onProgress?.({
            timestamp: new Date("2026-04-07T09:00:00.000Z").toISOString(),
            runId,
            specId: spec.specId,
            specTitle: spec.title,
            phase: "setup",
            summary: `worktree ready at /tmp/${spec.specId}`,
          });
          await deps?.onProgress?.({
            timestamp: new Date("2026-04-07T09:00:01.000Z").toISOString(),
            runId,
            specId: spec.specId,
            specTitle: spec.title,
            phase: "implementing",
            iteration: 1,
            summary: "candidate commit validated",
            candidateCommit: "1234567890abcdef1234567890abcdef12345678",
          });
          return {
            status: "done",
            summary: `Completed ${spec.specId}.`,
            candidateCommit: "1234567890abcdef1234567890abcdef12345678",
            nextAction: "none",
          };
        },
      },
    );
    assert.equal(exitCode, 0);
  } finally {
    process.chdir(previousCwd);
    console.log = originalLog;
  }

  assert.match(logOutput, /Running 2 spec\(s\) with model override=gpt-5\.3-codex maxIterations=3/);
  assert.match(logOutput, /\[1\/2\] 1001-one :: 1001 - One/);
  assert.match(logOutput, /\[1\/2\] logs\s+\.ralph\/runs\/1001-one\/1001-one-run\/events\.log/);
  assert.match(logOutput, /\[1\/2\] setup\s+worktree ready at \/tmp\/1001-one/);
  assert.match(logOutput, /\[1\/2\] implementing\s+iter 1\/3\s+candidate commit validated \[1234567890ab\]/);
  assert.match(logOutput, /\[2\/2\] 1002-two :: 1002 - Two/);
  assert.match(logOutput, /DONE: Completed 1002-two\./);
});

test("runCommand logs the smart role policy banner when model is omitted", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-cli-run-smart-"));
  await fs.mkdir(path.join(tempRoot, "specs"), { recursive: true });
  await writeRunnableSpec(tempRoot, "1001-one.md", "1001 - One");

  let logOutput = "";
  const originalLog = console.log;
  const previousCwd = process.cwd();
  console.log = (message?: unknown) => {
    logOutput += `${String(message)}\n`;
  };
  process.chdir(tempRoot);
  try {
    const exitCode = await runCommand(
      {
        command: "run",
        specFilters: [],
        workspaceRoot: tempRoot,
        model: undefined,
        maxIterations: 3,
        dryRun: false,
        inspectTarget: undefined,
        createSpecTarget: undefined,
      },
      {
        executeSpec: async () => ({
          status: "done",
          summary: "Completed 1001-one.",
          candidateCommit: "1234567890abcdef1234567890abcdef12345678",
          nextAction: "none",
        }),
      },
    );
    assert.equal(exitCode, 0);
  } finally {
    process.chdir(previousCwd);
    console.log = originalLog;
  }

  assert.match(logOutput, /Running 1 spec\(s\) with smart role policy maxIterations=3/);
});
