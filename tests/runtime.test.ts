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
  validateImplementationCandidate,
} from "../src/runtime.js";
import type { ImplementationReport, RuntimePaths, SpecDocument } from "../src/types.js";

const execFile = promisify(execFileCb);

async function createRuntimeFixture(): Promise<{
  repoRoot: string;
  paths: RuntimePaths;
  spec: SpecDocument;
  featureCommit: string;
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
  const { repoRoot, paths, spec, featureCommit } = await createRuntimeFixture();
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
  const invalidFinding = await validateImplementationCandidate(worktreePath, invalidReport);
  assert.ok(invalidFinding);
  assert.match(invalidFinding.detail, /Reported changed files README\.md do not match committed files feature\.txt\./);
  assert.match(invalidFinding.detail, /Worktree is not clean after the reported commit: M README\.md\./);

  await execFile("git", ["-C", worktreePath, "add", "README.md"]);
  await execFile("git", ["-C", worktreePath, "commit", "-m", "smoke"], { cwd: worktreePath });
  const { stdout: validCommit } = await execFile("git", ["-C", worktreePath, "rev-parse", "HEAD"]);

  const validReport: ImplementationReport = {
    ...invalidReport,
    summary: "Committed the README change cleanly.",
    commitHash: validCommit.trim(),
  };
  const validFinding = await validateImplementationCandidate(worktreePath, validReport);
  assert.equal(validFinding, null);
});
