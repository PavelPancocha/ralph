import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

import { discoverSpecPaths, parseSpecFile } from "../src/specs.js";

const execFile = promisify(execFileCb);

async function createTempSpecProject(): Promise<{
  projectRoot: string;
  workspaceRoot: string;
  specsRoot: string;
}> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-specs-"));
  const projectRoot = path.join(workspaceRoot, "ralph");
  const specsRoot = path.join(projectRoot, "specs");
  await fs.mkdir(path.join(specsRoot, "area"), { recursive: true });
  await fs.mkdir(path.join(specsRoot, "done"), { recursive: true });
  await fs.mkdir(path.join(specsRoot, "plans"), { recursive: true });
  return { projectRoot, workspaceRoot, specsRoot };
}

async function createGitFallbackSpecProject(): Promise<{
  projectRoot: string;
  workspaceRoot: string;
  repoRoot: string;
  specsRoot: string;
}> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-specs-git-fallback-"));
  const projectRoot = path.join(workspaceRoot, "ralph");
  const repoRoot = path.join(workspaceRoot, "zemtu");
  const specsRoot = path.join(repoRoot, "docs", "specs", "payment-toolbox");

  await fs.mkdir(specsRoot, { recursive: true });
  await execFile("git", ["init", "-b", "dev"], { cwd: repoRoot });
  await execFile("git", ["config", "user.email", "ralph@example.com"], { cwd: repoRoot });
  await execFile("git", ["config", "user.name", "Ralph Test"], { cwd: repoRoot });

  const runnable = `# 2003 - Stop Runtime Effective-Date Usage

Repo: zemtu
Workdir: .

## Branch Instructions
- Source branch: \`dev\`
- Create branch: \`feature/payment-toolbox/2003-stop-runtime-effective-date-usage\`

## Goal
Ship the change.

## Verification (Fast-First)
\`\`\`bash
git status --short
\`\`\`
`;
  const second = runnable
    .replace("# 2003 - Stop Runtime Effective-Date Usage", "# 2004 - coverage_guard: Define CoverageDecisionRecord")
    .replace("feature/payment-toolbox/2003-stop-runtime-effective-date-usage", "feature/payment-toolbox/2004-define-coverage-decision-record");

  await fs.writeFile(path.join(specsRoot, "2003-stop-runtime-effective-date-usage.md"), runnable, "utf8");
  await fs.writeFile(path.join(specsRoot, "2004-coverage_guard-define-coverage-decision-record.md"), second, "utf8");
  await execFile("git", ["add", "."], { cwd: repoRoot });
  await execFile("git", ["commit", "-m", "add payment toolbox specs"], { cwd: repoRoot });
  const { stdout: devCommit } = await execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  await execFile("git", ["update-ref", "refs/remotes/origin/dev", devCommit.trim()], { cwd: repoRoot });
  await execFile("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/dev"], { cwd: repoRoot });
  await execFile("git", ["checkout", "-b", "feature/missing-spec-root"], { cwd: repoRoot });
  await fs.rm(path.join(repoRoot, "docs"), { recursive: true, force: true });
  await execFile("git", ["add", "-A"], { cwd: repoRoot });
  await execFile("git", ["commit", "-m", "remove specs from branch"], { cwd: repoRoot });

  return { projectRoot, workspaceRoot, repoRoot, specsRoot };
}

test("discoverSpecPaths ignores legacy state directories and unrunnable spec-like files", async () => {
  const { projectRoot, workspaceRoot, specsRoot } = await createTempSpecProject();

  const runnable = `# 1001 - Runnable

Repo: demo-repo
Workdir: demo-repo

## Branch Instructions
- Source branch: \`dev\`
- Create branch: \`feature/runnable\`

## Goal
Ship the change.

## Verification (Fast-First)
\`\`\`bash
git status --short
\`\`\`
`;
  const nestedRunnable = runnable
    .replace("# 1001 - Runnable", "# 1002 - Nested Runnable")
    .replace("feature/runnable", "feature/nested");
  const debate = `# 10326 - Debate

This is analysis, not a runnable spec.
`;
  const draft = `# 2345 - Draft

Repo: demo-repo
Workdir: demo-repo

## Branch Instructions
- Source branch: \`\`
- Create branch: \`\`
`;

  await fs.writeFile(path.join(specsRoot, "1001-runnable.md"), runnable, "utf8");
  await fs.writeFile(path.join(specsRoot, "area", "1002-nested-runnable.md"), nestedRunnable, "utf8");
  await fs.writeFile(path.join(specsRoot, "10326-debate.md"), debate, "utf8");
  await fs.writeFile(path.join(specsRoot, "area", "2345-draft.md"), draft, "utf8");
  await fs.writeFile(path.join(specsRoot, "done", "1003-done.md"), runnable, "utf8");
  await fs.writeFile(path.join(specsRoot, "plans", "1004-plan.md"), runnable, "utf8");

  const specs = await discoverSpecPaths(specsRoot);
  assert.deepEqual(specs, ["1001-runnable.md", "area/1002-nested-runnable.md"]);
  await assert.rejects(parseSpecFile(projectRoot, workspaceRoot, "area/2345-draft.md"));
});

test("parseSpecFile preserves the supported markdown spec format", async () => {
  const { projectRoot, workspaceRoot, specsRoot } = await createTempSpecProject();

  const raw = `# 1001 - Demo Spec

Repo: demo-repo
Workdir: demo-repo

## Branch Instructions
- Source branch: \`dev\`
- Create branch: \`feature/demo\`
- PR target: \`dev\`
- Open a **draft** PR for this spec branch.
- Apply labels: \`Prototype\`, \`work in progress\`

## Goal
Make a safe change.

## Scope (In)
- Touch one file.

## Boundaries (Out, No Overlap)
- No unrelated changes.

## Constraints
- Keep it minimal.

## Dependencies
- None.

## Required Reading
- \`README.md\`

## Acceptance Criteria
- Runner completes the loop.

## Commit Requirements
- Use the requested branch.

## Verification (Fast-First)
\`\`\`bash
git status --short
\`\`\`
`;
  await fs.writeFile(path.join(specsRoot, "1001-demo.md"), raw, "utf8");

  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  assert.equal(spec.repo, "demo-repo");
  assert.equal(spec.workdir, "demo-repo");
  assert.equal(spec.branchInstructions.sourceBranch, "dev");
  assert.equal(spec.branchInstructions.createBranch, "feature/demo");
  assert.equal(spec.branchInstructions.prTarget, "dev");
  assert.equal(spec.branchInstructions.createPr, true);
  assert.equal(spec.branchInstructions.draftPr, true);
  assert.deepEqual(spec.branchInstructions.labels, ["Prototype", "work in progress"]);
  assert.ok(spec.acceptanceCriteria.some((item) => item.includes("Runner completes the loop.")));
  assert.equal(spec.verificationCommands[0], "git status --short");
});

test("parseSpecFile rejects empty Repo and Workdir values", async () => {
  const { projectRoot, workspaceRoot, specsRoot } = await createTempSpecProject();

  const raw = `# 1003 - Empty Values

Repo:
Workdir:

## Branch Instructions
- Source branch: \`dev\`
- Create branch: \`feature/demo\`
`;
  await fs.writeFile(path.join(specsRoot, "1003-empty-values.md"), raw, "utf8");

  await assert.rejects(
    parseSpecFile(projectRoot, workspaceRoot, "1003-empty-values.md"),
    /must provide non-empty Repo: and Workdir: values/,
  );
});

test("discoverSpecPaths falls back to origin/HEAD when the live spec root is missing", async () => {
  const { specsRoot } = await createGitFallbackSpecProject();
  const warnings: string[] = [];

  const specs = await discoverSpecPaths(specsRoot, {
    onWarning: (message) => {
      warnings.push(message);
    },
  });

  assert.deepEqual(specs, [
    "2003-stop-runtime-effective-date-usage.md",
    "2004-coverage_guard-define-coverage-decision-record.md",
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /origin\/dev/);
});

test("parseSpecFile falls back to origin/HEAD when the live spec root is missing", async () => {
  const { projectRoot, workspaceRoot, specsRoot } = await createGitFallbackSpecProject();
  const warnings: string[] = [];

  const spec = await parseSpecFile(
    projectRoot,
    workspaceRoot,
    "2004-coverage_guard-define-coverage-decision-record.md",
    specsRoot,
    {
      onWarning: (message) => {
        warnings.push(message);
      },
    },
  );

  assert.equal(spec.specId, "2004-coverage_guard-define-coverage-decision-record");
  assert.equal(spec.repo, "zemtu");
  assert.equal(spec.workdir, ".");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /origin\/dev/);
});

test("discoverSpecPaths fails clearly when fallback ref is unavailable", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-specs-git-missing-fallback-"));
  const repoRoot = path.join(workspaceRoot, "zemtu");
  const specsRoot = path.join(repoRoot, "docs", "specs", "payment-toolbox");

  await fs.mkdir(specsRoot, { recursive: true });
  await execFile("git", ["init", "-b", "dev"], { cwd: repoRoot });
  await execFile("git", ["config", "user.email", "ralph@example.com"], { cwd: repoRoot });
  await execFile("git", ["config", "user.name", "Ralph Test"], { cwd: repoRoot });
  await fs.writeFile(path.join(specsRoot, "2003-stop-runtime-effective-date-usage.md"), "# draft\n", "utf8");
  await execFile("git", ["add", "."], { cwd: repoRoot });
  await execFile("git", ["commit", "-m", "add draft spec root"], { cwd: repoRoot });
  await execFile("git", ["checkout", "-b", "feature/missing-spec-root"], { cwd: repoRoot });
  await fs.rm(path.join(repoRoot, "docs"), { recursive: true, force: true });
  await execFile("git", ["add", "-A"], { cwd: repoRoot });
  await execFile("git", ["commit", "-m", "remove specs from branch"], { cwd: repoRoot });

  await assert.rejects(
    discoverSpecPaths(specsRoot),
    /origin\/HEAD is not available/,
  );
});
