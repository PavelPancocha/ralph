import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { discoverSpecPaths, parseSpecFile } from "../src/specs.js";

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
