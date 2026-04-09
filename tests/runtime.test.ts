import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";

import {
  buildRuntimePaths,
  defaultCodexHome,
  ensureCodexHome,
  ensureRuntimePaths,
  ensureSpecWorktree,
  initialRunState,
  listRunStates,
  publishApprovedSpec,
  renderPullRequestBody,
  validateImplementationCandidate,
} from "../src/runtime.js";
import type { ImplementationReport, RuntimePaths, SpecDocument } from "../src/types.js";

const execFile = promisify(execFileCb);

async function createRuntimeFixture(): Promise<{
  repoRoot: string;
  paths: RuntimePaths;
  spec: SpecDocument;
  featureCommit: string;
  branchChangedFiles: string[];
}> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-runtime-"));
  const projectRoot = path.join(workspaceRoot, "ralph");
  const repoRoot = path.join(workspaceRoot, "demo-repo");

  await fs.mkdir(path.join(projectRoot, "codex-support", "hooks"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "codex-support", "config.toml"), "model = \"gpt-5.3-codex\"\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "codex-support", "hooks.json"), "{\"hooks\":{}}\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "codex-support", "hooks", "noop.mjs"), "export {};\n", "utf8");

  await fs.mkdir(repoRoot, { recursive: true });
  await execFile("git", ["init", "-b", "dev"], { cwd: repoRoot });
  await execFile("git", ["config", "user.email", "ralph@example.com"], { cwd: repoRoot });
  await execFile("git", ["config", "user.name", "Ralph Test"], { cwd: repoRoot });
  await execFile("git", ["config", "commit.gpgsign", "false"], { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, "README.md"), "# demo\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: repoRoot });
  await execFile("git", ["commit", "-m", "init"], { cwd: repoRoot });
  await execFile("git", ["checkout", "-b", "feature/example"], { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, "feature.txt"), "feature change\n", "utf8");
  await execFile("git", ["add", "feature.txt"], { cwd: repoRoot });
  await execFile("git", ["commit", "-m", "feature work"], { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, "docs.txt"), "docs change\n", "utf8");
  await execFile("git", ["add", "docs.txt"], { cwd: repoRoot });
  await execFile("git", ["commit", "-m", "docs work"], { cwd: repoRoot });
  const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  await execFile("git", ["checkout", "dev"], { cwd: repoRoot });

  const paths = buildRuntimePaths(projectRoot, workspaceRoot);
  await ensureRuntimePaths(paths);

  const spec: SpecDocument = {
    specPath: path.join(projectRoot, "specs", "1001-example.md"),
    relFromSpecs: "1001-example.md",
    relFromWorkspace: "ralph/specs/1001-example.md",
    specId: "1001-example",
    title: "1001 - Example",
    repo: "demo-repo",
    workdir: "demo-repo",
    branchInstructions: {
      sourceBranch: "dev",
      createBranch: "feature/example",
    },
    goal: "Goal",
    scopeIn: [],
    boundariesOut: [],
    constraints: [],
    dependencies: [],
    requiredReading: [],
    acceptanceCriteria: [],
    commitRequirements: [],
    verificationCommands: [],
    rawSections: {},
  };

  return {
    repoRoot,
    paths,
    spec,
    featureCommit: stdout.trim(),
    branchChangedFiles: ["docs.txt", "feature.txt"],
  };
}

test("buildRuntimePaths places state under .ralph", () => {
  const paths = buildRuntimePaths("/tmp/ralph", "/tmp");
  assert.equal(paths.ralphRoot, "/tmp/ralph/.ralph");
  assert.equal(paths.worktreesRoot, "/tmp/ralph/.ralph/worktrees");
});

test("initialRunState starts queued when no legacy done marker exists", () => {
  const state = initialRunState(
    {
      specPath: "/tmp/specs/1001-example.md",
      relFromSpecs: "1001-example.md",
      relFromWorkspace: "ralph/specs/1001-example.md",
      specId: "1001-example",
      title: "1001 - Example",
      repo: "repo",
      workdir: "repo",
      branchInstructions: {
        sourceBranch: "dev",
        createBranch: "feature/example",
      },
      goal: "Goal",
      scopeIn: [],
      boundariesOut: [],
      constraints: [],
      dependencies: [],
      requiredReading: [],
      acceptanceCriteria: [],
      commitRequirements: [],
      verificationCommands: [],
      rawSections: {},
    },
    false,
  );
  assert.equal(state.status, "queued");
  assert.equal(state.currentIteration, 0);
});

test("initialRunState starts done when a legacy done marker exists", () => {
  const state = initialRunState(
    {
      specPath: "/tmp/specs/1001-example.md",
      relFromSpecs: "1001-example.md",
      relFromWorkspace: "ralph/specs/1001-example.md",
      specId: "1001-example",
      title: "1001 - Example",
      repo: "repo",
      workdir: "repo",
      branchInstructions: {
        sourceBranch: "dev",
        createBranch: "feature/example",
      },
      goal: "Goal",
      scopeIn: [],
      boundariesOut: [],
      constraints: [],
      dependencies: [],
      requiredReading: [],
      acceptanceCriteria: [],
      commitRequirements: [],
      verificationCommands: [],
      rawSections: {},
    },
    true,
  );
  assert.equal(state.status, "done");
  assert.equal(state.legacyDoneDetected, true);
});

test("listRunStates normalizes legacy state without rewriting the file", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-runtime-state-"));
  const projectRoot = path.join(workspaceRoot, "ralph");
  const paths = buildRuntimePaths(projectRoot, workspaceRoot);
  await ensureRuntimePaths(paths);

  const legacyRaw = `${JSON.stringify(
    {
      specId: "1001-example",
      specRel: "1001-example.md",
      status: "planning",
      currentIteration: 1,
      runId: "legacy-run",
      worktreePath: "/tmp/worktree",
      updatedAt: "2026-04-07T09:00:00.000Z",
      threads: {
        planningSpec: "legacy-thread",
      },
      legacyDoneDetected: false,
    },
    null,
    2,
  )}\n`;
  const statePath = path.join(paths.stateRoot, "1001-example.json");
  await fs.writeFile(statePath, legacyRaw, "utf8");

  const states = await listRunStates(paths);

  assert.equal(states.length, 1);
  assert.equal(states[0]?.stateVersion, 2);
  assert.equal(states[0]?.threads.planningSpec, "legacy-thread");
  assert.equal(await fs.readFile(statePath, "utf8"), legacyRaw);
});

test("ensureSpecWorktree reuses an existing feature branch without resetting it", async () => {
  const { repoRoot, paths, spec, featureCommit } = await createRuntimeFixture();

  const worktreePath = await ensureSpecWorktree(paths, spec, repoRoot);
  const { stdout: worktreeHead } = await execFile("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
  const { stdout: worktreeStatus } = await execFile("git", ["-C", worktreePath, "status", "--short"]);

  assert.equal(worktreeHead.trim(), featureCommit);
  assert.equal(worktreeStatus.trim(), "");
  assert.equal(await fs.readFile(path.join(worktreePath, "feature.txt"), "utf8"), "feature change\n");
  await fs.access(path.join(worktreePath, ".codex", "config.toml"));

  const reusedPath = await ensureSpecWorktree(paths, spec, repoRoot);
  assert.equal(reusedPath, worktreePath);
  await fs.access(path.join(worktreePath, ".codex", "hooks", "noop.mjs"));
});

test("ensureSpecWorktree recreates a missing but still registered worktree", async () => {
  const { repoRoot, paths, spec } = await createRuntimeFixture();

  const worktreePath = await ensureSpecWorktree(paths, spec, repoRoot);
  await fs.rm(worktreePath, { recursive: true, force: true });

  const recreatedPath = await ensureSpecWorktree(paths, spec, repoRoot);
  assert.equal(recreatedPath, worktreePath);
  await fs.access(path.join(worktreePath, ".codex", "hooks", "noop.mjs"));
});

test("runVerificationCommands checks out the feature branch in the main repo and restores the original branch", async () => {
  const { repoRoot, spec } = await createRuntimeFixture();
  const { runVerificationCommands } = await import("../src/runtime.js");

  const result = await runVerificationCommands(repoRoot, spec.branchInstructions.createBranch, [
    "git rev-parse --abbrev-ref HEAD",
    "printf 'host verification\\n'",
  ]);

  assert.equal(result.featureBranch, spec.branchInstructions.createBranch);
  assert.equal(result.startingBranch, "dev");
  assert.equal(result.restoredBranch, "dev");
  assert.equal(result.succeeded, true);
  assert.match(result.commands[0]?.stdout ?? "", /feature\/example/);
  assert.match(result.commands[1]?.stdout ?? "", /host verification/);

  const { stdout: restoredBranch } = await execFile("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(restoredBranch.trim(), "dev");
});

test("publishApprovedSpec pushes the branch and creates a draft PR with the default Prototype label", async () => {
  const { repoRoot, spec, featureCommit } = await createRuntimeFixture();
  const remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-remote-"));
  const remoteRepo = path.join(remoteRoot, "origin.git");
  const fakeGhRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-gh-"));
  const fakeGhLog = path.join(fakeGhRoot, "gh.log");
  const fakeGhCount = path.join(fakeGhRoot, "gh-count.txt");
  const fakeGhPath = path.join(fakeGhRoot, "gh");

  await execFile("git", ["init", "--bare", remoteRepo]);
  await execFile("git", ["remote", "add", "origin", remoteRepo], { cwd: repoRoot });
  await execFile("git", ["push", "-u", "origin", "dev"], { cwd: repoRoot });
  await fs.writeFile(
    fakeGhPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf '%s\\n' \"$*\" >> \"$RALPH_FAKE_GH_LOG\"",
      "case \"$1 $2\" in",
      "  \"api repos/demo/demo/labels?per_page=200\")",
      "    printf '[{\"name\":\"prototype\"}]'",
      "    ;;",
      "  \"repo view\")",
      "    printf '{\"nameWithOwner\":\"demo/demo\"}'",
      "    ;;",
      "  \"label create\")",
      "    printf 'label ok\\n'",
      "    ;;",
      "  \"pr list\")",
      "    count=0",
      "    if [[ -f \"$RALPH_FAKE_GH_COUNT\" ]]; then count=$(cat \"$RALPH_FAKE_GH_COUNT\"); fi",
      "    count=$((count + 1))",
      "    printf '%s' \"$count\" > \"$RALPH_FAKE_GH_COUNT\"",
      "    if [[ \"$count\" -eq 1 ]]; then",
      "      printf '[]'",
      "    else",
      "      printf '[{\"number\":42,\"url\":\"https://example.test/pr/42\",\"isDraft\":true}]'",
      "    fi",
      "    ;;",
      "  \"pr create\")",
      "    printf 'created\\n'",
      "    ;;",
      "  \"pr edit\")",
      "    printf 'edited\\n'",
      "    ;;",
      "  *)",
      "    printf 'unexpected gh invocation: %s\\n' \"$*\" >&2",
      "    exit 1",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(fakeGhPath, 0o755);

  const originalPath = process.env.PATH;
  const originalGhLog = process.env.RALPH_FAKE_GH_LOG;
  const originalGhCount = process.env.RALPH_FAKE_GH_COUNT;
  process.env.PATH = `${fakeGhRoot}:${originalPath ?? ""}`;
  process.env.RALPH_FAKE_GH_LOG = fakeGhLog;
  process.env.RALPH_FAKE_GH_COUNT = fakeGhCount;
  try {
    const result = await publishApprovedSpec(
      repoRoot,
      {
        ...spec,
        branchInstructions: {
          ...spec.branchInstructions,
          prTarget: "dev",
        },
      },
      "Spec completed successfully.",
      featureCommit,
    );

    assert.equal(result.branch, "feature/example");
    assert.equal(result.remote, "origin");
    assert.equal(result.prNumber, 42);
    assert.equal(result.prUrl, "https://example.test/pr/42");
    assert.equal(result.prCreated, true);
    assert.equal(result.draft, true);
    assert.deepEqual(result.labels, ["prototype"]);

    const { stdout: pushedBranch } = await execFile("git", ["ls-remote", "--heads", "origin", "feature/example"], {
      cwd: repoRoot,
    });
    assert.match(pushedBranch, /refs\/heads\/feature\/example/);

    const ghLog = await fs.readFile(fakeGhLog, "utf8");
    assert.match(ghLog, /api repos\/demo\/demo\/labels\?per_page=200/);
    assert.match(ghLog, /repo view --json nameWithOwner/);
    assert.doesNotMatch(ghLog, /label create Prototype --repo demo\/demo --color D4D4D4/);
    assert.match(ghLog, /pr list --repo demo\/demo --head feature\/example --state all --json number,url,isDraft/);
    assert.match(ghLog, /pr create .*--repo demo\/demo .*--head feature\/example .*--base dev/);
    assert.match(ghLog, /--draft/);
    assert.match(ghLog, /--label prototype/);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalGhLog === undefined) {
      delete process.env.RALPH_FAKE_GH_LOG;
    } else {
      process.env.RALPH_FAKE_GH_LOG = originalGhLog;
    }
    if (originalGhCount === undefined) {
      delete process.env.RALPH_FAKE_GH_COUNT;
    } else {
      process.env.RALPH_FAKE_GH_COUNT = originalGhCount;
    }
  }
});

test("renderPullRequestBody fills the Zemtu-style PR template when one exists", () => {
  const template = `### Summary
<!-- summary -->

---

### UI?
- [ ] No UI changes
- [ ] UI-related (uncomment “Screenshots” below)


### Type
- [ ] UI polish (visual/non-functional)
- [ ] Bugfix
- [ ] Feature
- [ ] Refactor / Cleanup
- [ ] Performance
- [ ] Chore (deps/infra/docs)

### Risk / Impact
- **Blast radius**:
  - [ ] Low
  - [ ] Medium
  - [ ] High
- **Migrations**:
  - [ ] Yes
  - [ ] No
- **New packages**:
  - [ ] Yes
  - [ ] No

### Testing
- [ ] Automated tests added/updated
- [ ] Manual verification of happy **and** unhappy paths
- [ ] Lint/type/format pass locally
`;

  const body = renderPullRequestBody(
    template,
    {
      specPath: "/tmp/specs/1001-example.md",
      relFromSpecs: "1001-example.md",
      relFromWorkspace: "ralph/specs/1001-example.md",
      specId: "1001-example",
      title: "1001 - Example",
      repo: "demo-repo",
      workdir: "demo-repo",
      branchInstructions: {
        sourceBranch: "dev",
        createBranch: "feature/example",
        prTarget: "dev",
      },
      goal: "Goal",
      scopeIn: [],
      boundariesOut: [],
      constraints: [],
      dependencies: [],
      requiredReading: [],
      acceptanceCriteria: [],
      commitRequirements: [],
      verificationCommands: ["pytest billing/tests/test_example.py", "ruff check ."],
      rawSections: {},
    },
    "Converted the targeted Stripe tests to mocked bases and kept the scope test-only.",
    "1234567890abcdef1234567890abcdef12345678",
    [
      "billing/models_plus/tests/tests_meta_payment.py",
      "billing/stripe/utils/tests/tests_calculator.py",
    ],
  );

  assert.match(body, /Converted the targeted Stripe tests to mocked bases/);
  assert.match(body, /Spec: 1001-example\.md/);
  assert.match(body, /Commit: 1234567890abcdef1234567890abcdef12345678/);
  assert.match(body, /### UI\?\n- \[x\] No UI changes/);
  assert.match(body, /### Type[\s\S]*- \[x\] Refactor \/ Cleanup/);
  assert.match(body, /### Risk \/ Impact[\s\S]*- \[x\] Low/);
  assert.match(body, /### Risk \/ Impact[\s\S]*- \[x\] No/);
  assert.match(body, /### Testing[\s\S]*- \[x\] Automated tests added\/updated/);
  assert.match(body, /### Testing[\s\S]*- \[x\] Lint\/type\/format pass locally/);
});

test("ensureCodexHome seeds auth and config from the user Codex home without overwriting local files", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-codex-home-"));
  const projectRoot = path.join(workspaceRoot, "ralph");
  const paths = buildRuntimePaths(projectRoot, workspaceRoot);
  await ensureRuntimePaths(paths);

  const externalCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-user-codex-"));
  await fs.writeFile(path.join(externalCodexHome, "auth.json"), "{\"access_token\":\"test-token\"}\n", "utf8");
  await fs.writeFile(path.join(externalCodexHome, "config.toml"), "model = \"gpt-5.3-codex\"\n", "utf8");

  const originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = externalCodexHome;
  try {
    const codexHome = await ensureCodexHome(paths);
    assert.equal(codexHome, defaultCodexHome(paths));
    assert.equal(
      await fs.readFile(path.join(codexHome, "auth.json"), "utf8"),
      "{\"access_token\":\"test-token\"}\n",
    );
    assert.equal(
      await fs.readFile(path.join(codexHome, "config.toml"), "utf8"),
      "model = \"gpt-5.3-codex\"\n",
    );

    await fs.writeFile(path.join(codexHome, "config.toml"), "model = \"local-override\"\n", "utf8");
    await ensureCodexHome(paths);
    assert.equal(
      await fs.readFile(path.join(codexHome, "config.toml"), "utf8"),
      "model = \"local-override\"\n",
    );
  } finally {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
  }
});

test("validateImplementationCandidate rejects dirty or mismatched reports and accepts a clean commit", async () => {
  const { repoRoot, paths, spec, featureCommit, branchChangedFiles } = await createRuntimeFixture();
  const worktreePath = await ensureSpecWorktree(paths, spec, repoRoot);
  await fs.writeFile(path.join(worktreePath, "README.md"), "# demo\n\nRalph e2e smoke test.\n", "utf8");

  const invalidReport: ImplementationReport = {
    summary: "Claimed a commit without creating one.",
    commitHash: featureCommit,
    changedFiles: ["README.md"],
    verificationCommands: ["git status --short"],
    verificationSummary: "README was edited.",
    concerns: [],
  };
  const invalidFinding = await validateImplementationCandidate(
    worktreePath,
    invalidReport,
    spec.branchInstructions.sourceBranch,
  );
  assert.ok(invalidFinding);
  assert.match(
    invalidFinding.detail,
    new RegExp(`Reported changed files README\\.md do not match committed files ${branchChangedFiles.join(", ").replaceAll(".", "\\.")}\\.`, "u"),
  );
  assert.match(invalidFinding.detail, /Worktree is not clean after the reported commit: M README\.md\./);

  await execFile("git", ["-C", worktreePath, "add", "README.md"]);
  await execFile("git", ["-C", worktreePath, "commit", "-m", "smoke"], { cwd: worktreePath });
  const { stdout: validCommit } = await execFile("git", ["-C", worktreePath, "rev-parse", "HEAD"]);

  const validReport: ImplementationReport = {
    ...invalidReport,
    summary: "Committed the README change cleanly.",
    commitHash: validCommit.trim(),
    changedFiles: ["README.md", ...branchChangedFiles],
  };
  const validFinding = await validateImplementationCandidate(
    worktreePath,
    validReport,
    spec.branchInstructions.sourceBranch,
  );
  assert.equal(validFinding, null);
});
