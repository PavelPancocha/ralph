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
    public id: string | null,
    private readonly finalResponse: string,
    private readonly onRun: (threadId: string | null, prompt: string) => void,
  ) {}

  async run(prompt: string, _options?: unknown) {
    this.onRun(this.id, prompt);
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
  private readonly threadIds: Array<string | null>;
  private nextThreadIndex = 0;
  public readonly prompts: Array<{ threadId: string | null; prompt: string }> = [];

  constructor(responses: string[], threadIds: Array<string | null> = []) {
    this.responses = [...responses];
    this.threadIds = [...threadIds];
  }

  startThread() {
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake response queued for startThread");
    }
    const queuedThreadId = this.threadIds.shift();
    const threadId = queuedThreadId === undefined ? `thread-${this.nextThreadIndex}` : queuedThreadId;
    if (queuedThreadId === undefined) {
      this.nextThreadIndex += 1;
    }
    return new FakeThread(threadId, response, (nextThreadId, prompt) => {
      this.prompts.push({ threadId: nextThreadId, prompt });
    });
  }

  resumeThread(id: string) {
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake response queued for resumeThread");
    }
    return new FakeThread(id, response, (nextThreadId, prompt) => {
      this.prompts.push({ threadId: nextThreadId, prompt });
    });
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
      reviewerRoles: [],
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

test("executeSpec always includes correctness and tests reviewers when the supervisor adds extra coverage", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";

  const fakeCodex = new FakeCodex([
    JSON.stringify({
      summary: "Security needs extra attention.",
      reviewerRoles: ["security"],
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
      summary: "No test issues.",
      findings: [],
    }),
    JSON.stringify({
      reviewer: "security",
      status: "approved",
      summary: "No security issues.",
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

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.ok(state.threads.reviewerCorrectness);
  assert.ok(state.threads.reviewerTests);
  assert.ok(state.threads.reviewerSecurity);
  assert.equal(state.threads.reviewerPerformance, undefined);
});

test("executeSpec carries accepted findings into the next implementer turn on needs_fix", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "9999999999999999999999999999999999999999";
  const fixAction = "Add the missing verification coverage.";

  const fakeCodex = new FakeCodex([
    JSON.stringify({
      summary: "Use standard correctness and tests reviewers.",
      reviewerRoles: [],
      keyRisks: [],
      notesForUnderstander: [],
    }),
    JSON.stringify({
      summary: "First pass plan.",
      repoPath: repoRoot,
      worktreePath: expectedWorktreePath,
      featureBranch: "feature/demo",
      targetFiles: ["README.md"],
      contextFiles: ["README.md"],
      executionPlan: ["Update README.md", "Run git status --short"],
      verificationCommands: ["git status --short"],
      assumptions: [],
      riskFlags: [],
    }),
    JSON.stringify({
      summary: "First attempt committed.",
      commitHash,
      changedFiles: ["README.md"],
      verificationCommands: ["git status --short"],
      verificationSummary: "Verified locally.",
      concerns: [],
    }),
    JSON.stringify({
      reviewer: "correctness",
      status: "approved",
      summary: "No correctness issues.",
      findings: [],
    }),
    JSON.stringify({
      reviewer: "tests",
      status: "changes_requested",
      summary: "More verification is needed.",
      findings: [
        {
          severity: "warning",
          category: "tests",
          title: "More verification",
          detail: "The first pass did not cover the requested verification.",
          action: fixAction,
        },
      ],
    }),
    JSON.stringify({
      verdict: "needs_fix",
      summary: "Address the accepted reviewer findings.",
      acceptedFindings: [
        {
          severity: "warning",
          category: "tests",
          title: "More verification",
          detail: "The first pass did not cover the requested verification.",
          action: fixAction,
        },
      ],
      rejectedFindings: [],
      fixInstructions: [fixAction],
    }),
    JSON.stringify({
      summary: "Second pass plan.",
      repoPath: repoRoot,
      worktreePath: expectedWorktreePath,
      featureBranch: "feature/demo",
      targetFiles: ["README.md"],
      contextFiles: ["README.md"],
      executionPlan: ["Update README.md again", "Run git status --short"],
      verificationCommands: ["git status --short"],
      assumptions: [],
      riskFlags: [],
    }),
    JSON.stringify({
      summary: "Second attempt committed.",
      commitHash,
      changedFiles: ["README.md"],
      verificationCommands: ["git status --short"],
      verificationSummary: "Verified locally again.",
      concerns: [],
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
      summary: "Verification is now sufficient.",
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
    maxIterations: 3,
    dryRun: false,
    specFilters: [],
  };

  const outcome = await executeSpec(paths, options, spec, {
    createCodex: () => fakeCodex,
  });

  assert.equal(outcome.status, "done");

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.threads.understander, "thread-1");
  assert.equal(state.threads.implementer, "thread-2");
  assert.equal(state.threads.reviewerCorrectness, "thread-3");
  assert.equal(state.threads.reviewerTests, "thread-4");
  assert.equal(state.threads.recheck, "thread-5");

  const implementerPrompts = fakeCodex.prompts.filter((item) => item.prompt.includes("You are the implementer agent for Ralph."));
  assert.equal(implementerPrompts.length, 2);
  assert.ok(implementerPrompts[1]?.prompt.includes(fixAction));
});

test("executeSpec clears reviewer state when recheck invalidates the plan", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "fedcbafedcbafedcbafedcbafedcbafedcbafedc";
  const staleAction = "Remove the stale migration plan.";
  const invalidationReason = "The first plan targeted the wrong files.";

  const fakeCodex = new FakeCodex([
    JSON.stringify({
      summary: "Use standard correctness and tests reviewers.",
      reviewerRoles: [],
      keyRisks: [],
      notesForUnderstander: [],
    }),
    JSON.stringify({
      summary: "First plan targets the wrong file.",
      repoPath: repoRoot,
      worktreePath: expectedWorktreePath,
      featureBranch: "feature/demo",
      targetFiles: ["README.md"],
      contextFiles: ["README.md"],
      executionPlan: ["Change the wrong thing first."],
      verificationCommands: ["git status --short"],
      assumptions: [],
      riskFlags: [],
    }),
    JSON.stringify({
      summary: "Committed the first attempt.",
      commitHash,
      changedFiles: ["README.md"],
      verificationCommands: ["git status --short"],
      verificationSummary: "Verified locally.",
      concerns: [],
    }),
    JSON.stringify({
      reviewer: "correctness",
      status: "approved",
      summary: "No correctness issues.",
      findings: [],
    }),
    JSON.stringify({
      reviewer: "tests",
      status: "changes_requested",
      summary: "The plan was wrong.",
      findings: [
        {
          severity: "error",
          category: "tests",
          title: "Wrong target",
          detail: "The first plan changed the wrong area.",
          action: staleAction,
        },
      ],
    }),
    JSON.stringify({
      verdict: "invalidate_plan",
      summary: invalidationReason,
      acceptedFindings: [
        {
          severity: "error",
          category: "tests",
          title: "Wrong target",
          detail: "The first plan changed the wrong area.",
          action: staleAction,
        },
      ],
      rejectedFindings: [],
      fixInstructions: ["Re-plan around the right files."],
    }),
    JSON.stringify({
      summary: "Second plan targets the correct file.",
      repoPath: repoRoot,
      worktreePath: expectedWorktreePath,
      featureBranch: "feature/demo",
      targetFiles: ["README.md"],
      contextFiles: ["README.md"],
      executionPlan: ["Change the correct thing next."],
      verificationCommands: ["git status --short"],
      assumptions: [],
      riskFlags: [],
    }),
    JSON.stringify({
      summary: "Committed the second attempt.",
      commitHash,
      changedFiles: ["README.md"],
      verificationCommands: ["git status --short"],
      verificationSummary: "Verified locally.",
      concerns: [],
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
      summary: "No test issues.",
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
    maxIterations: 3,
    dryRun: false,
    specFilters: [],
  };

  const outcome = await executeSpec(paths, options, spec, {
    createCodex: () => fakeCodex,
  });

  assert.equal(outcome.status, "done");

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.currentIteration, 2);
  assert.notEqual(state.threads.understander, "thread-1");
  assert.notEqual(state.threads.implementer, "thread-2");
  assert.notEqual(state.threads.recheck, "thread-5");

  const understanderPrompts = fakeCodex.prompts.filter((item) => item.prompt.includes("You are the understander agent for Ralph."));
  assert.equal(understanderPrompts.length, 2);
  assert.ok(understanderPrompts[1]?.prompt.includes(`Previous plan invalidation reason: ${invalidationReason}`));

  const implementerPrompts = fakeCodex.prompts.filter((item) => item.prompt.includes("You are the implementer agent for Ralph."));
  assert.equal(implementerPrompts.length, 2);
  assert.ok(!implementerPrompts[1]?.prompt.includes(staleAction));
});

test("executeSpec returns early for dry runs without starting agent threads", async () => {
  const { projectRoot, workspaceRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const fakeCodex = new FakeCodex([]);

  const outcome = await executeSpec(
    paths,
    {
      workspaceRoot,
      projectRoot,
      model: "gpt-5.3-codex",
      maxIterations: 2,
      dryRun: true,
      specFilters: [],
    },
    spec,
    { createCodex: () => fakeCodex },
  );

  assert.equal(outcome.status, "needs_more_work");
  assert.deepEqual(fakeCodex.prompts, []);

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.worktreePath, path.join(paths.worktreesRoot, spec.specId));
  await fs.access(path.join(paths.artifactsRoot, spec.specId, state.runId!, "dry-run.json"));
});

test("executeSpec skips specs with a legacy done marker before starting any agent threads", async () => {
  const { projectRoot, workspaceRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const fakeCodex = new FakeCodex([]);

  await fs.mkdir(path.join(projectRoot, "specs", "done"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "specs", "done", "1001-demo.md"), "# done\n", "utf8");

  const outcome = await executeSpec(
    paths,
    {
      workspaceRoot,
      projectRoot,
      model: "gpt-5.3-codex",
      maxIterations: 2,
      dryRun: false,
      specFilters: [],
    },
    spec,
    { createCodex: () => fakeCodex },
  );

  assert.equal(outcome.status, "done");
  assert.match(outcome.summary, /Legacy done marker detected/);
  assert.deepEqual(fakeCodex.prompts, []);
  await assert.rejects(fs.access(path.join(paths.worktreesRoot, spec.specId)));
});

test("executeSpec fails after maxIterations is exhausted on needs_fix without calling supervisor final", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "8888888888888888888888888888888888888888";

  const fakeCodex = new FakeCodex([
    JSON.stringify({
      summary: "Use standard correctness and tests reviewers.",
      reviewerRoles: [],
      keyRisks: [],
      notesForUnderstander: [],
    }),
    JSON.stringify({
      summary: "Only pass.",
      repoPath: repoRoot,
      worktreePath: expectedWorktreePath,
      featureBranch: "feature/demo",
      targetFiles: ["README.md"],
      contextFiles: ["README.md"],
      executionPlan: ["Update README.md", "Run git status --short"],
      verificationCommands: ["git status --short"],
      assumptions: [],
      riskFlags: [],
    }),
    JSON.stringify({
      summary: "Committed one attempt.",
      commitHash,
      changedFiles: ["README.md"],
      verificationCommands: ["git status --short"],
      verificationSummary: "Verified locally.",
      concerns: [],
    }),
    JSON.stringify({
      reviewer: "correctness",
      status: "approved",
      summary: "No correctness issues.",
      findings: [],
    }),
    JSON.stringify({
      reviewer: "tests",
      status: "changes_requested",
      summary: "The run still needs fixes.",
      findings: [
        {
          severity: "warning",
          category: "tests",
          title: "More verification",
          detail: "One iteration was not enough.",
          action: "Add more verification.",
        },
      ],
    }),
    JSON.stringify({
      verdict: "needs_fix",
      summary: "The implementation still needs work.",
      acceptedFindings: [
        {
          severity: "warning",
          category: "tests",
          title: "More verification",
          detail: "One iteration was not enough.",
          action: "Add more verification.",
        },
      ],
      rejectedFindings: [],
      fixInstructions: ["Add more verification."],
    }),
  ]);

  const outcome = await executeSpec(
    paths,
    {
      workspaceRoot,
      projectRoot,
      model: "gpt-5.3-codex",
      maxIterations: 1,
      dryRun: false,
      specFilters: [],
    },
    spec,
    { createCodex: () => fakeCodex },
  );

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.summary, "The implementation still needs work.");

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.status, "failed");
  assert.equal(state.lastError, "The implementation still needs work.");
  assert.equal(
    fakeCodex.prompts.filter((item) => item.prompt.includes("You are Ralph's supervisor agent closing the loop.")).length,
    0,
  );
});

test("executeSpec throws when a reviewer reports the wrong reviewer identity", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "7777777777777777777777777777777777777777";

  const fakeCodex = new FakeCodex([
    JSON.stringify({
      summary: "Use standard correctness and tests reviewers.",
      reviewerRoles: [],
      keyRisks: [],
      notesForUnderstander: [],
    }),
    JSON.stringify({
      summary: "Single pass.",
      repoPath: repoRoot,
      worktreePath: expectedWorktreePath,
      featureBranch: "feature/demo",
      targetFiles: ["README.md"],
      contextFiles: ["README.md"],
      executionPlan: ["Update README.md", "Run git status --short"],
      verificationCommands: ["git status --short"],
      assumptions: [],
      riskFlags: [],
    }),
    JSON.stringify({
      summary: "Committed one attempt.",
      commitHash,
      changedFiles: ["README.md"],
      verificationCommands: ["git status --short"],
      verificationSummary: "Verified locally.",
      concerns: [],
    }),
    JSON.stringify({
      reviewer: "tests",
      status: "approved",
      summary: "Wrong reviewer identity.",
      findings: [],
    }),
  ]);

  await assert.rejects(
    executeSpec(
      paths,
      {
        workspaceRoot,
        projectRoot,
        model: "gpt-5.3-codex",
        maxIterations: 1,
        dryRun: false,
        specFilters: [],
      },
      spec,
      { createCodex: () => fakeCodex },
    ),
    /Reviewer output mismatch/,
  );
});

test("executeSpec warns and drops resume state when the SDK returns a null thread id", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "6666666666666666666666666666666666666666";

  const fakeCodex = new FakeCodex(
    [
      JSON.stringify({
        summary: "Use standard correctness and tests reviewers.",
        reviewerRoles: [],
        keyRisks: [],
        notesForUnderstander: [],
      }),
      JSON.stringify({
        summary: "Single pass.",
        repoPath: repoRoot,
        worktreePath: expectedWorktreePath,
        featureBranch: "feature/demo",
        targetFiles: ["README.md"],
        contextFiles: ["README.md"],
        executionPlan: ["Update README.md", "Run git status --short"],
        verificationCommands: ["git status --short"],
        assumptions: [],
        riskFlags: [],
      }),
      JSON.stringify({
        summary: "Committed one attempt.",
        commitHash,
        changedFiles: ["README.md"],
        verificationCommands: ["git status --short"],
        verificationSummary: "Verified locally.",
        concerns: [],
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
    ],
    [null],
  );

  let warningOutput = "";
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warningOutput += `${String(message)}\n`;
  };
  try {
    const outcome = await executeSpec(
      paths,
      {
        workspaceRoot,
        projectRoot,
        model: "gpt-5.3-codex",
        maxIterations: 1,
        dryRun: false,
        specFilters: [],
      },
      spec,
      { createCodex: () => fakeCodex },
    );
    assert.equal(outcome.status, "done");
  } finally {
    console.warn = originalWarn;
  }

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.threads.supervisor, "thread-5");
  assert.match(warningOutput, /Thread id missing for role=supervisor/);

  const supervisorPrompts = fakeCodex.prompts.filter((item) => item.prompt.includes("You are Ralph's supervisor agent"));
  assert.equal(supervisorPrompts[0]?.threadId, null);
  assert.equal(supervisorPrompts[1]?.threadId, "thread-5");
});

test("executeSpec fails when the final supervisor outcome is not done", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "0123456789abcdef0123456789abcdef01234567";

  const fakeCodex = new FakeCodex([
    JSON.stringify({
      summary: "Use standard correctness and tests reviewers.",
      reviewerRoles: [],
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
      status: "needs_more_work",
      summary: "The run should not be marked done yet.",
      candidateCommit: commitHash,
      nextAction: "Inspect the final outcome.",
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

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.candidateCommit, commitHash);
  assert.equal(outcome.nextAction, "Inspect the final outcome.");

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.status, "failed");
  assert.equal(state.lastError, "The run should not be marked done yet.");
  await assert.rejects(fs.access(path.join(paths.reportsRoot, "done", `${spec.specId}.md`)));
});
