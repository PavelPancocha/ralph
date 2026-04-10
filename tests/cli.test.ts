import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { parseArgs, runCommand } from "../src/cli.js";
import { buildRuntimePaths, ensureRuntimePaths } from "../src/runtime.js";

const execFile = promisify(execFileCb);

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

async function writeDoneState(paths: ReturnType<typeof buildRuntimePaths>, specId: string): Promise<void> {
  await fs.writeFile(
    path.join(paths.stateRoot, `${specId}.json`),
    `${JSON.stringify({
      stateVersion: 2,
      specId,
      specRel: `${specId}.md`,
      status: "done",
      currentIteration: 1,
      updatedAt: new Date("2026-04-09T09:00:00.000Z").toISOString(),
      threads: {},
      threadPolicies: {},
      legacyDoneDetected: false,
    }, null, 2)}\n`,
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
  assert.equal(parsed.maxIterations, 5);

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

test("parseArgs accepts --dryrun as a dry-run alias", () => {
  const parsed = parseArgs(["--dryrun"]);
  assert.equal(parsed.parseError, undefined);
  assert.equal(parsed.command, "run");
  assert.equal(parsed.dryRun, true);
});

test("parseArgs accepts --to for bounded sequential runs", () => {
  const parsed = parseArgs(["run", "--to", "1018", "--dry-run"]);
  assert.equal(parsed.parseError, undefined);
  assert.equal(parsed.toSpec, "1018");
  assert.equal(parsed.dryRun, true);
});

test("parseArgs accepts --resume for checkpointed reruns", () => {
  const parsed = parseArgs(["run", "--resume"]);
  assert.equal(parsed.parseError, undefined);
  assert.equal(parsed.resume, true);
});

test("parseArgs accepts mark-done with an explicit target", () => {
  const parsed = parseArgs(["mark-done", "1001-demo"]);
  assert.equal(parsed.parseError, undefined);
  assert.equal(parsed.command, "mark-done");
  assert.equal(parsed.markDoneTarget, "1001-demo");
});

test("parseArgs leaves model unset when --model is omitted so smart role policy can decide", () => {
  const parsed = parseArgs(["run", "1001-demo"]);
  assert.equal(parsed.model, undefined);
  assert.equal(parsed.maxIterations, 5);
});

test("parseArgs rejects --model when the explicit value is missing", () => {
  assert.equal(parseArgs(["run", "--model"]).parseError, "Missing --model value");
  assert.equal(parseArgs(["run", "--model", "--dry-run"]).parseError, "Missing --model value");
});

test("parseArgs rejects --to when the explicit value is missing", () => {
  assert.equal(parseArgs(["run", "--to"]).parseError, "Missing --to value");
  assert.equal(parseArgs(["run", "--to", "--dry-run"]).parseError, "Missing --to value");
});

test("parseArgs rejects unknown long options instead of treating them as spec filters", () => {
  const parsed = parseArgs(["run", "--dryrn"]);
  assert.equal(parsed.parseError, "Unknown option: --dryrn");
  assert.deepEqual(parsed.specFilters, []);
});

test("runCommand prints help for --help", async () => {
  let logOutput = "";
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    logOutput += `${String(message)}\n`;
  };
  try {
    const exitCode = await runCommand(parseArgs(["--help"]));
    assert.equal(exitCode, 0);
  } finally {
    console.log = originalLog;
  }

  assert.match(logOutput, /Usage:\s+ralph \[run\] \[spec-filter\.\.\.\] \[options\]/);
  assert.match(logOutput, /--dry-run, --dryrun/);
  assert.match(logOutput, /Commands:\s+run, status, inspect, create-spec, mark-done/);
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
      toSpec: undefined,
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

test("runCommand mark-done updates state and writes a done report for the selected spec", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-cli-mark-done-"));
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
    const exitCode = await runCommand(parseArgs(["mark-done", "1001-one"]));
    assert.equal(exitCode, 0);
  } finally {
    process.chdir(previousCwd);
    console.log = originalLog;
  }

  const statePath = path.join(tempRoot, ".ralph", "state", "1001-one.json");
  const reportPath = path.join(tempRoot, ".ralph", "reports", "done", "1001-one.md");
  const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { status: string; lastCommit?: string; lastError?: string };
  const report = await fs.readFile(reportPath, "utf8");

  assert.equal(state.status, "done");
  assert.equal(state.lastCommit, undefined);
  assert.equal(state.lastError, undefined);
  assert.match(report, /# Done: 1001-one/);
  assert.match(report, /Commit: manual/);
  assert.match(report, /Manually marked done outside Ralph\./);
  assert.match(logOutput, /Marked 1001-one as done\./);
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
        toSpec: undefined,
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
        toSpec: undefined,
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

test("runCommand auto-detects a nested ralph project root when invoked from the workspace root", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-cli-workspace-"));
  const projectRoot = path.join(tempRoot, "ralph");
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "package.json"), '{"name":"ralph","type":"module"}\n', "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "cli.ts"), "export {};\n", "utf8");
  await fs.mkdir(path.join(projectRoot, "specs"), { recursive: true });
  await writeRunnableSpec(projectRoot, "1001-one.md", "1001 - One");

  const previousCwd = process.cwd();
  let executedSpecId: string | undefined;
  process.chdir(tempRoot);
  try {
    const exitCode = await runCommand(
      {
        command: "run",
        specFilters: [],
        workspaceRoot: undefined,
        model: undefined,
        maxIterations: 3,
        dryRun: true,
        toSpec: undefined,
        inspectTarget: undefined,
        createSpecTarget: undefined,
      },
      {
        executeSpec: async (_paths, _options, spec) => {
          executedSpecId = spec.specId;
          return {
            status: "needs_more_work",
            summary: "Dry run prepared worktree.",
            candidateCommit: undefined,
            nextAction: "re-run",
          };
        },
      },
    );
    assert.equal(exitCode, 0);
  } finally {
    process.chdir(previousCwd);
  }

  assert.equal(executedSpecId, "1001-one");
});

test("runCommand does not create runtime directories for dry-run", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-cli-dry-no-write-"));
  await fs.mkdir(path.join(tempRoot, "specs"), { recursive: true });
  await writeRunnableSpec(tempRoot, "1001-one.md", "1001 - One");

  const previousCwd = process.cwd();
  process.chdir(tempRoot);
  try {
    const exitCode = await runCommand(
      {
        command: "run",
        specFilters: [],
        workspaceRoot: tempRoot,
        model: undefined,
        maxIterations: 3,
        dryRun: true,
        inspectTarget: undefined,
        createSpecTarget: undefined,
        toSpec: undefined,
      },
      {
        executeSpec: async () => ({
          status: "needs_more_work",
          summary: "Dry run validated setup.",
          candidateCommit: undefined,
          nextAction: "none",
        }),
      },
    );
    assert.equal(exitCode, 0);
  } finally {
    process.chdir(previousCwd);
  }

  await assert.rejects(fs.access(path.join(tempRoot, ".ralph")));
});

test("runCommand with --to starts from the first spec that is not already done", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-cli-to-"));
  await fs.mkdir(path.join(tempRoot, "specs"), { recursive: true });
  await writeRunnableSpec(tempRoot, "1001-one.md", "1001 - One");
  await writeRunnableSpec(tempRoot, "1002-two.md", "1002 - Two");
  await writeRunnableSpec(tempRoot, "1003-three.md", "1003 - Three");
  await writeRunnableSpec(tempRoot, "1004-four.md", "1004 - Four");

  const paths = buildRuntimePaths(tempRoot, tempRoot);
  await ensureRuntimePaths(paths);
  await writeDoneState(paths, "1001-one");
  await writeDoneState(paths, "1002-two");

  const previousCwd = process.cwd();
  const executedSpecIds: string[] = [];
  let logOutput = "";
  const originalLog = console.log;
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
        toSpec: "1004",
      },
      {
        executeSpec: async (_paths, _options, spec) => {
          executedSpecIds.push(spec.specId);
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

  assert.deepEqual(executedSpecIds, ["1003-three", "1004-four"]);
  assert.match(logOutput, /Skipping 2 already done spec\(s\):/);
  assert.match(logOutput, /- 1001-one/);
  assert.match(logOutput, /- 1002-two/);
});

test("runCommand skips already done specs for ordinary runs and logs them explicitly", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-cli-skip-done-"));
  await fs.mkdir(path.join(tempRoot, "specs"), { recursive: true });
  await writeRunnableSpec(tempRoot, "1001-one.md", "1001 - One");
  await writeRunnableSpec(tempRoot, "1002-two.md", "1002 - Two");
  await writeRunnableSpec(tempRoot, "1003-three.md", "1003 - Three");

  const paths = buildRuntimePaths(tempRoot, tempRoot);
  await ensureRuntimePaths(paths);
  await writeDoneState(paths, "1002-two");

  const previousCwd = process.cwd();
  const executedSpecIds: string[] = [];
  let logOutput = "";
  const originalLog = console.log;
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
        toSpec: undefined,
      },
      {
        executeSpec: async (_paths, _options, spec) => {
          executedSpecIds.push(spec.specId);
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

  assert.deepEqual(executedSpecIds, ["1001-one", "1003-three"]);
  assert.match(logOutput, /Skipping 1 already done spec\(s\):/);
  assert.match(logOutput, /- 1002-two/);
  assert.doesNotMatch(logOutput, /\[2\/2\] 1002-two ::/);
});

test("runCommand stops immediately after a failed spec outcome and exits 1", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-cli-fail-continue-"));
  await fs.mkdir(path.join(tempRoot, "specs"), { recursive: true });
  await writeRunnableSpec(tempRoot, "1001-one.md", "1001 - One");
  await writeRunnableSpec(tempRoot, "1002-two.md", "1002 - Two");

  let logOutput = "";
  const executedSpecIds: string[] = [];
  const originalLog = console.log;
  const previousCwd = process.cwd();
  console.log = (message?: unknown) => {
    logOutput += `${String(message)}
`;
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
        dryRun: true,
        toSpec: undefined,
        inspectTarget: undefined,
        createSpecTarget: undefined,
      },
      {
        executeSpec: async (_paths, _options, spec) => {
          executedSpecIds.push(spec.specId);
          if (spec.specId === "1001-one") {
            return {
              status: "failed",
              summary: "Dry run found invalid branch wiring.",
              candidateCommit: undefined,
              nextAction: "Fix the spec graph.",
            };
          }
          return {
            status: "done",
            summary: "Second spec still ran.",
            candidateCommit: "1234567890abcdef1234567890abcdef12345678",
            nextAction: "none",
          };
        },
      },
    );
    assert.equal(exitCode, 1);
  } finally {
    process.chdir(previousCwd);
    console.log = originalLog;
  }

  assert.deepEqual(executedSpecIds, ["1001-one"]);
  assert.match(logOutput, /\[1\/2\] 1001-one :: 1001 - One/);
  assert.match(logOutput, /\[1\/2\] FAILED: Dry run found invalid branch wiring\./);
  assert.doesNotMatch(logOutput, /\[2\/2\] 1002-two :: 1002 - Two/);
  assert.doesNotMatch(logOutput, /\[2\/2\] DONE: Second spec still ran\./);
});

test("linked CLI wrapper resolves the packaged dist entrypoint from a copied bin directory", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-bin-wrapper-"));
  const installRoot = path.join(tempRoot, "image", "packages", "ralph");
  const binRoot = path.join(installRoot, "bin");
  const nodeModulesRoot = path.join(installRoot, "lib", "node_modules");
  const packageLink = path.join(nodeModulesRoot, "ralph");
  await fs.mkdir(binRoot, { recursive: true });
  await fs.mkdir(nodeModulesRoot, { recursive: true });
  await fs.copyFile(path.join(process.cwd(), "bin", "ralph.js"), path.join(binRoot, "ralph.js"));
  await fs.symlink(process.cwd(), packageLink, "dir");

  const { stdout, stderr } = await execFile("node", [path.join(binRoot, "ralph.js"), "--help"], {
    cwd: tempRoot,
  });

  assert.equal(stderr, "");
  assert.equal(stdout, "");
});
