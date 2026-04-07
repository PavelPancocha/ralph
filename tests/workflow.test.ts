import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";

import { buildRuntimePaths, ensureRuntimePaths, readJsonFile } from "../src/runtime.js";
import { parseSpecFile } from "../src/specs.js";
import { executeSpec } from "../src/workflow.js";
import type { RalphRunOptions, RunState, RuntimePaths } from "../src/types.js";

const execFile = promisify(execFileCb);

class FakeThread {
  constructor(
    public id: string,
    private readonly finalResponse: string,
  ) {}

  async run(_prompt: string, _options?: unknown) {
    return {
      finalResponse: this.finalResponse,
      items: [],
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
      },
    };
  }
}

class FakeCodex {
  private readonly responses: string[];
  private nextThreadIndex = 0;

  constructor(responses: string[]) {
    this.responses = [...responses];
  }

  startThread() {
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake response queued for startThread");
    }
    const threadId = `thread-${this.nextThreadIndex}`;
    this.nextThreadIndex += 1;
    return new FakeThread(threadId, response);
  }

  resumeThread(id: string) {
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake response queued for resumeThread");
    }
    return new FakeThread(id, response);
  }
}

async function createTempProject(): Promise<{
  projectRoot: string;
  workspaceRoot: string;
  repoRoot: string;
  paths: RuntimePaths;
}> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-workflow-"));
  const projectRoot = path.join(workspaceRoot, "ralph");
  const repoRoot = path.join(workspaceRoot, "demo-repo");

  await fs.mkdir(path.join(projectRoot, "specs"), { recursive: true });
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

  const spec = `# 1001 - Demo Spec

Repo: demo-repo
Workdir: demo-repo

## Branch Instructions
- Source branch: \`dev\`
- Create branch: \`feature/demo\`
- PR target: \`dev\`

## Goal
Make a tiny safe change.

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
  await fs.writeFile(path.join(projectRoot, "specs", "1001-demo.md"), spec, "utf8");

  const paths = buildRuntimePaths(projectRoot, workspaceRoot);
  await ensureRuntimePaths(paths);
  return { projectRoot, workspaceRoot, repoRoot, paths };
}

test("executeSpec completes the supervised loop with an injected Codex backend", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "1234567890abcdef1234567890abcdef12345678";

  const fakeCodex = new FakeCodex([
    JSON.stringify({
      summary: "Use standard correctness and tests reviewers.",
      reviewerRoles: ["correctness", "tests"],
      keyRisks: [],
      notesForUnderstander: [],
    }),
    JSON.stringify({
      summary: "Edit README and verify with git status.",
      repoPath: repoRoot,
      worktreePath: expectedWorktreePath,
      featureBranch: "feature/demo",
      targetFiles: ["README.md"],
      contextFiles: ["README.md"],
      reviewerRoles: ["correctness", "tests"],
      executionPlan: ["Update README.md", "Run git status --short"],
      verificationCommands: ["git status --short"],
      assumptions: [],
      riskFlags: [],
    }),
    JSON.stringify({
      summary: "Implemented change and committed it.",
      commitHash,
      changedFiles: ["README.md"],
      verificationCommands: ["git status --short"],
      verificationSummary: "Verified locally.",
      concerns: [],
      reviewerHandover:
        "What I did: updated README.md only. Motivation: keep the implementation aligned with the tiny safe change requested by the spec. What to check: confirm README.md is the only modified file and matches the requested goal. Potential gaps: no broader docs cleanup was attempted.",
    }),
    JSON.stringify({
      reviewer: "correctness",
      status: "approved",
      summary: "No correctness issues.",
      findings: [],
    }),
    JSON.stringify({
      reviewer: "tests",
      status: "approved",
      summary: "Verification coverage is sufficient.",
      findings: [],
    }),
    JSON.stringify({
      verdict: "approve",
      summary: "Implementation matches the spec.",
      acceptedFindings: [],
      rejectedFindings: [],
      fixInstructions: [],
    }),
    JSON.stringify({
      status: "done",
      summary: "Spec completed successfully.",
      candidateCommit: commitHash,
      nextAction: "none",
    }),
  ]);

  const options: RalphRunOptions = {
    workspaceRoot,
    projectRoot,
    model: "gpt-5.3-codex",
    maxIterations: 2,
    dryRun: false,
    specFilters: [],
  };

  const outcome = await executeSpec(paths, options, spec, {
    createCodex: () => fakeCodex,
  });

  assert.equal(outcome.status, "done");
  assert.equal(outcome.candidateCommit, commitHash);

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.status, "done");
  assert.equal(state.lastCommit, commitHash);

  const doneReport = await fs.readFile(path.join(paths.reportsRoot, "done", `${spec.specId}.md`), "utf8");
  assert.match(doneReport, /Spec completed successfully\./);
  assert.match(doneReport, new RegExp(commitHash));
});
