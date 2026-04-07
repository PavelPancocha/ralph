import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";

import { buildRuntimePaths, ensureRuntimePaths, readJsonFile, runEventLogPath } from "../src/runtime.js";
import { parseSpecFile } from "../src/specs.js";
import { executeSpec } from "../src/workflow.js";
import type { CodexThreadConfig, RalphRunOptions, RunState, RuntimePaths, WorkflowProgressEvent } from "../src/types.js";

const execFile = promisify(execFileCb);

class FakeThread {
  constructor(
    public id: string | null,
    private readonly finalResponse: string,
    private readonly onRun: (threadId: string | null, prompt: string, outputSchema?: unknown) => void,
  ) {}

  async run(prompt: string, options?: { outputSchema?: unknown }) {
    const schema = options?.outputSchema;
    if (schema && typeof schema === "object" && !Array.isArray(schema)) {
      const objectSchema = schema as {
        type?: unknown;
        properties?: Record<string, unknown>;
        required?: unknown;
      };
      if (objectSchema.type === "object" && objectSchema.properties) {
        assert.ok(Array.isArray(objectSchema.required), "Output schema must declare required fields.");
        const required = new Set(objectSchema.required);
        for (const propertyName of Object.keys(objectSchema.properties)) {
          assert.ok(required.has(propertyName), `Output schema must require property ${propertyName}.`);
        }
      }
    }
    this.onRun(this.id, prompt, schema);
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
  public readonly prompts: Array<{ threadId: string | null; prompt: string; outputSchema?: unknown }> = [];
  public readonly threadConfigs: Array<{ method: "start" | "resume"; threadId: string | null; options?: CodexThreadConfig }> = [];

  constructor(responses: string[], threadIds: Array<string | null> = []) {
    this.responses = [...responses];
    this.threadIds = [...threadIds];
  }

  startThread(options?: CodexThreadConfig) {
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake response queued for startThread");
    }
    const queuedThreadId = this.threadIds.shift();
    const threadId = queuedThreadId === undefined ? `thread-${this.nextThreadIndex}` : queuedThreadId;
    if (queuedThreadId === undefined) {
      this.nextThreadIndex += 1;
    }
    this.threadConfigs.push(options ? { method: "start", threadId, options } : { method: "start", threadId });
    return new FakeThread(threadId, response, (nextThreadId, prompt, outputSchema) => {
      this.prompts.push({ threadId: nextThreadId, prompt, outputSchema });
    });
  }

  resumeThread(id: string, options?: CodexThreadConfig) {
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake response queued for resumeThread");
    }
    this.threadConfigs.push(options ? { method: "resume", threadId: id, options } : { method: "resume", threadId: id });
    return new FakeThread(id, response, (nextThreadId, prompt, outputSchema) => {
      this.prompts.push({ threadId: nextThreadId, prompt, outputSchema });
    });
  }
}

function fakeWorkflowDeps(
  fakeCodex: FakeCodex,
  overrides: { onProgress?: (event: WorkflowProgressEvent) => void | Promise<void> } = {},
) {
  return {
    createCodex: () => fakeCodex,
    validateImplementationCandidate: async () => null,
    ...overrides,
  };
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

function planningViewResponse(
  lens: "spec" | "repo" | "risks",
  summary: string,
  overrides: Partial<{
    keyPoints: string[];
    suggestedFiles: string[];
    suggestedReviewers: Array<"correctness" | "tests" | "security" | "performance">;
    verificationHints: string[];
  }> = {},
): string {
  return JSON.stringify({
    lens,
    summary,
    keyPoints: overrides.keyPoints ?? [],
    suggestedFiles: overrides.suggestedFiles ?? [],
    suggestedReviewers: overrides.suggestedReviewers ?? [],
    verificationHints: overrides.verificationHints ?? [],
  });
}

function defaultPlanningResponses(repoRoot: string, worktreePath: string): string[] {
  return [
    planningViewResponse("spec", "Spec view is aligned.", {
      keyPoints: ["Keep the change scoped to the spec contract."],
    }),
    planningViewResponse("repo", "Repo view identifies the likely files.", {
      suggestedFiles: [path.join(repoRoot, "README.md"), path.join(worktreePath, "README.md")],
    }),
    planningViewResponse("risks", "Risk view confirms correctness/tests coverage.", {
      suggestedReviewers: ["correctness", "tests"],
      verificationHints: ["Prefer git status --short first."],
    }),
  ];
}

function reviewLeadReadyResponse(summary = "Review synthesis is ready for recheck."): string {
  return JSON.stringify({
    status: "ready_for_recheck",
    summary,
    followUpReviewers: [],
  });
}

function reviewLeadFollowUpResponse(
  followUpReviewers: Array<"correctness" | "tests" | "security" | "performance">,
  summary = "Need targeted follow-up review.",
): string {
  return JSON.stringify({
    status: "needs_targeted_follow_up",
    summary,
    followUpReviewers,
  });
}

test("executeSpec completes the supervised loop with an injected Codex backend", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "1234567890abcdef1234567890abcdef12345678";
  const progressEvents: WorkflowProgressEvent[] = [];
  const correctnessReview = {
    reviewer: "correctness" as const,
    status: "approved" as const,
    summary: "No correctness issues.",
    findings: [],
  };
  const testsReview = {
    reviewer: "tests" as const,
    status: "approved" as const,
    summary: "Verification coverage is sufficient.",
    findings: [],
  };

  const fakeCodex = new FakeCodex([
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
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
    JSON.stringify(correctnessReview),
    JSON.stringify(testsReview),
    reviewLeadReadyResponse(),
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
    model: undefined,
    maxIterations: 2,
    dryRun: false,
    specFilters: [],
  };

  const outcome = await executeSpec(
    paths,
    options,
    spec,
    fakeWorkflowDeps(fakeCodex, {
      onProgress: (event) => {
        progressEvents.push(event);
      },
    }),
  );

  assert.equal(outcome.status, "done");
  assert.equal(outcome.candidateCommit, commitHash);
  const implementerThread = fakeCodex.threadConfigs[5];
  assert.deepEqual(
    implementerThread?.options?.additionalDirectories?.sort(),
    [path.join(repoRoot, ".git"), path.join(repoRoot, ".git", "worktrees", spec.specId)].sort(),
  );
  assert.deepEqual(
    fakeCodex.threadConfigs.map((entry) => [entry.method, entry.options?.model, entry.options?.modelReasoningEffort]),
    [
      ["start", "gpt-5.4-mini", "medium"],
      ["start", "gpt-5.4-mini", "medium"],
      ["start", "gpt-5.4-mini", "high"],
      ["start", "gpt-5.4", "xhigh"],
      ["start", "gpt-5.4", "xhigh"],
      ["start", "gpt-5.4-mini", "high"],
      ["start", "gpt-5.4-mini", "high"],
      ["start", "gpt-5.4-mini", "high"],
      ["start", "gpt-5.4", "xhigh"],
      ["start", "gpt-5.4", "xhigh"],
      ["resume", "gpt-5.4", "xhigh"],
    ],
  );

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.status, "done");
  assert.equal(state.lastCommit, commitHash);
  assert.deepEqual(
    progressEvents.map((event) => [event.phase, event.summary]),
    [
      ["setup", `worktree ready at ${expectedWorktreePath}`],
      ["planning", "running planning_spec helper"],
      ["planning", "running planning_repo helper"],
      ["planning", "running planning_risks helper"],
      ["planning", "running supervisor strategy"],
      ["planning", "building understanding packet"],
      ["implementing", "running implementer"],
      ["implementing", "candidate commit validated"],
      ["reviewing", "running correctness reviewer"],
      ["reviewing", "running tests reviewer"],
      ["reviewing", "running review lead"],
      ["rechecking", "running recheck verdict"],
      ["rechecking", "running supervisor final decision"],
      ["done", "Spec completed successfully."],
    ],
  );
  const eventLog = await fs.readFile(runEventLogPath(paths, spec.specId, progressEvents[0]?.runId ?? ""), "utf8");
  assert.match(eventLog, /phase=setup .*worktree ready/);
  assert.match(eventLog, /phase=planning iteration=1 running planning_spec helper/);
  assert.match(eventLog, /phase=reviewing iteration=1 reviewer=correctness running correctness reviewer/);
  assert.match(eventLog, /phase=reviewing iteration=1 running review lead/);
  assert.match(eventLog, new RegExp(`phase=done iteration=1 commit=${commitHash} Spec completed successfully\\.`));

  const doneReport = await fs.readFile(path.join(paths.reportsRoot, "done", `${spec.specId}.md`), "utf8");
  assert.match(doneReport, /Spec completed successfully\./);
  assert.match(doneReport, new RegExp(commitHash));
});

test("executeSpec always includes correctness and tests reviewers when the supervisor adds extra coverage", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const correctnessReview = {
    reviewer: "correctness" as const,
    status: "approved" as const,
    summary: "No correctness issues.",
    findings: [],
  };
  const testsReview = {
    reviewer: "tests" as const,
    status: "approved" as const,
    summary: "No test issues.",
    findings: [],
  };
  const securityReview = {
    reviewer: "security" as const,
    status: "approved" as const,
    summary: "No security issues.",
    findings: [],
  };

  const fakeCodex = new FakeCodex([
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
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
    JSON.stringify(correctnessReview),
    JSON.stringify(testsReview),
    JSON.stringify(securityReview),
    reviewLeadReadyResponse(),
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

  const outcome = await executeSpec(paths, options, spec, fakeWorkflowDeps(fakeCodex));

  assert.equal(outcome.status, "done");

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.ok(state.threads.reviewerCorrectness);
  assert.ok(state.threads.reviewerTests);
  assert.ok(state.threads.reviewerSecurity);
  assert.equal(state.threads.reviewerPerformance, undefined);
  assert.ok(state.threads.reviewLead);
});

test("executeSpec reruns only targeted reviewers at stronger policy when the review lead asks for follow-up", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const correctnessReview = {
    reviewer: "correctness" as const,
    status: "approved" as const,
    summary: "No correctness issues.",
    findings: [],
  };
  const testsReview = {
    reviewer: "tests" as const,
    status: "approved" as const,
    summary: "No test issues.",
    findings: [],
  };
  const firstSecurityReview = {
    reviewer: "security" as const,
    status: "changes_requested" as const,
    summary: "Need a deeper security read.",
    findings: [
      {
        severity: "warning" as const,
        category: "security" as const,
        title: "Need more depth",
        detail: "The initial review is inconclusive.",
        action: "Inspect the risky path in more detail.",
      },
    ],
  };
  const finalSecurityReview = {
    reviewer: "security" as const,
    status: "approved" as const,
    summary: "Escalated security review is satisfied.",
    findings: [],
  };

  const fakeCodex = new FakeCodex([
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
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
    JSON.stringify(correctnessReview),
    JSON.stringify(testsReview),
    JSON.stringify(firstSecurityReview),
    reviewLeadFollowUpResponse(["security"]),
    JSON.stringify(finalSecurityReview),
    reviewLeadReadyResponse("Follow-up complete."),
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

  const outcome = await executeSpec(
    paths,
    {
      workspaceRoot,
      projectRoot,
      model: undefined,
      maxIterations: 2,
      dryRun: false,
      specFilters: [],
    },
    spec,
    fakeWorkflowDeps(fakeCodex),
  );

  assert.equal(outcome.status, "done");
  assert.equal(
    fakeCodex.prompts.filter((item) => item.prompt.includes("You are Ralph's security reviewer.")).length,
    2,
  );
  assert.equal(
    fakeCodex.prompts.filter((item) => item.prompt.includes("You are Ralph's review lead.")).length,
    2,
  );
  const securityConfigs = fakeCodex.threadConfigs.filter((entry) =>
    entry.options?.workingDirectory === expectedWorktreePath
      && (entry.options?.sandboxMode === "read-only")
      && (entry.options?.modelReasoningEffort === "high" || entry.options?.modelReasoningEffort === "xhigh")
      && entry.options?.model?.includes("gpt-5.4")
      && fakeCodex.prompts.some((prompt) => prompt.threadId === entry.threadId && prompt.prompt.includes("security reviewer")),
  );
  assert.deepEqual(
    securityConfigs.map((entry) => [entry.method, entry.options?.model, entry.options?.modelReasoningEffort]),
    [
      ["start", "gpt-5.4-mini", "high"],
      ["start", "gpt-5.4", "xhigh"],
    ],
  );

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  const artifactFiles = await fs.readdir(path.join(paths.artifactsRoot, spec.specId, state.runId!));
  assert.equal(artifactFiles.filter((name) => name.startsWith("reviewer_security-1")).length, 2);
  assert.equal(artifactFiles.filter((name) => name.startsWith("review_lead-1")).length, 2);
});

test("executeSpec carries accepted findings into the next implementer turn on needs_fix", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "9999999999999999999999999999999999999999";
  const fixAction = "Add the missing verification coverage.";
  const firstCorrectnessReview = {
    reviewer: "correctness" as const,
    status: "approved" as const,
    summary: "No correctness issues.",
    findings: [],
  };
  const firstTestsReview = {
    reviewer: "tests" as const,
    status: "changes_requested" as const,
    summary: "More verification is needed.",
    findings: [
      {
        severity: "warning" as const,
        category: "tests" as const,
        title: "More verification",
        detail: "The first pass did not cover the requested verification.",
        action: fixAction,
      },
    ],
  };
  const secondCorrectnessReview = {
    reviewer: "correctness" as const,
    status: "approved" as const,
    summary: "No correctness issues.",
    findings: [],
  };
  const secondTestsReview = {
    reviewer: "tests" as const,
    status: "approved" as const,
    summary: "Verification is now sufficient.",
    findings: [],
  };

  const fakeCodex = new FakeCodex([
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
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
    JSON.stringify(firstCorrectnessReview),
    JSON.stringify(firstTestsReview),
    reviewLeadReadyResponse(),
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
    JSON.stringify(secondCorrectnessReview),
    JSON.stringify(secondTestsReview),
    reviewLeadReadyResponse(),
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

  const outcome = await executeSpec(paths, options, spec, fakeWorkflowDeps(fakeCodex));

  assert.equal(outcome.status, "done");

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.threads.understander, "thread-4");
  assert.equal(state.threads.implementer, "thread-10");
  assert.equal(state.threads.reviewerCorrectness, "thread-6");
  assert.equal(state.threads.reviewerTests, "thread-7");
  assert.equal(state.threads.reviewLead, "thread-8");
  assert.equal(state.threads.recheck, "thread-9");

  const implementerPrompts = fakeCodex.prompts.filter((item) => item.prompt.includes("You are the implementer agent for Ralph."));
  assert.equal(implementerPrompts.length, 2);
  assert.ok(implementerPrompts[1]?.prompt.includes(fixAction));
  assert.deepEqual(
    fakeCodex.threadConfigs
      .filter((entry) => entry.options?.workingDirectory === expectedWorktreePath)
      .filter((entry) => entry.options?.modelReasoningEffort === "high" || entry.options?.modelReasoningEffort === "xhigh")
      .filter((entry) => entry.options?.sandboxMode === "workspace-write")
      .map((entry) => [entry.method, entry.options?.model, entry.options?.modelReasoningEffort]),
    [
      ["start", "gpt-5.3-codex", "high"],
      ["start", "gpt-5.3-codex", "xhigh"],
    ],
  );
});

test("executeSpec clears reviewer state when recheck invalidates the plan", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "fedcbafedcbafedcbafedcbafedcbafedcbafedc";
  const staleAction = "Remove the stale migration plan.";
  const invalidationReason = "The first plan targeted the wrong files.";
  const firstCorrectnessReview = {
    reviewer: "correctness" as const,
    status: "approved" as const,
    summary: "No correctness issues.",
    findings: [],
  };
  const firstTestsReview = {
    reviewer: "tests" as const,
    status: "changes_requested" as const,
    summary: "The plan was wrong.",
    findings: [
      {
        severity: "error" as const,
        category: "tests" as const,
        title: "Wrong target",
        detail: "The first plan changed the wrong area.",
        action: staleAction,
      },
    ],
  };
  const secondCorrectnessReview = {
    reviewer: "correctness" as const,
    status: "approved" as const,
    summary: "No correctness issues.",
    findings: [],
  };
  const secondTestsReview = {
    reviewer: "tests" as const,
    status: "approved" as const,
    summary: "No test issues.",
    findings: [],
  };

  const fakeCodex = new FakeCodex([
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
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
    JSON.stringify(firstCorrectnessReview),
    JSON.stringify(firstTestsReview),
    reviewLeadReadyResponse(),
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
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
    JSON.stringify({
      summary: "Use standard correctness and tests reviewers.",
      reviewerRoles: [],
      keyRisks: [],
      notesForUnderstander: [],
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
    JSON.stringify(secondCorrectnessReview),
    JSON.stringify(secondTestsReview),
    reviewLeadReadyResponse(),
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

  const outcome = await executeSpec(paths, options, spec, fakeWorkflowDeps(fakeCodex));

  assert.equal(outcome.status, "done");

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.currentIteration, 2);
  assert.notEqual(state.threads.planningSpec, "thread-0");
  assert.notEqual(state.threads.planningRepo, "thread-1");
  assert.notEqual(state.threads.planningRisks, "thread-2");
  assert.notEqual(state.threads.understander, "thread-4");
  assert.notEqual(state.threads.implementer, "thread-5");
  assert.notEqual(state.threads.reviewLead, "thread-8");
  assert.notEqual(state.threads.recheck, "thread-9");

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
    fakeWorkflowDeps(fakeCodex),
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
    fakeWorkflowDeps(fakeCodex),
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
  const correctnessReview = {
    reviewer: "correctness" as const,
    status: "approved" as const,
    summary: "No correctness issues.",
    findings: [],
  };
  const testsReview = {
    reviewer: "tests" as const,
    status: "changes_requested" as const,
    summary: "The run still needs fixes.",
    findings: [
      {
        severity: "warning" as const,
        category: "tests" as const,
        title: "More verification",
        detail: "One iteration was not enough.",
        action: "Add more verification.",
      },
    ],
  };

  const fakeCodex = new FakeCodex([
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
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
    JSON.stringify(correctnessReview),
    JSON.stringify(testsReview),
    reviewLeadReadyResponse(),
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
    fakeWorkflowDeps(fakeCodex),
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
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
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
      fakeWorkflowDeps(fakeCodex),
    ),
    /Reviewer output mismatch/,
  );
});

test("executeSpec warns and drops resume state when the SDK returns a null thread id", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "6666666666666666666666666666666666666666";
  const correctnessReview = {
    reviewer: "correctness" as const,
    status: "approved" as const,
    summary: "No correctness issues.",
    findings: [],
  };
  const testsReview = {
    reviewer: "tests" as const,
    status: "approved" as const,
    summary: "Verification coverage is sufficient.",
    findings: [],
  };

  const fakeCodex = new FakeCodex(
    [
      ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
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
      JSON.stringify(correctnessReview),
      JSON.stringify(testsReview),
      reviewLeadReadyResponse(),
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
    ["planning-spec-thread", "planning-repo-thread", "planning-risks-thread", null],
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
      fakeWorkflowDeps(fakeCodex),
    );
    assert.equal(outcome.status, "done");
  } finally {
    console.warn = originalWarn;
  }

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.threads.supervisor, "thread-6");
  assert.match(warningOutput, /Thread id missing for role=supervisor/);

  const supervisorPrompts = fakeCodex.prompts.filter((item) => item.prompt.includes("You are Ralph's supervisor agent"));
  assert.equal(supervisorPrompts[0]?.threadId, null);
  assert.equal(supervisorPrompts[1]?.threadId, "thread-6");
});

test("executeSpec fails when the final supervisor outcome is not done", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "0123456789abcdef0123456789abcdef01234567";
  const correctnessReview = {
    reviewer: "correctness" as const,
    status: "approved" as const,
    summary: "No correctness issues.",
    findings: [],
  };
  const testsReview = {
    reviewer: "tests" as const,
    status: "approved" as const,
    summary: "Verification coverage is sufficient.",
    findings: [],
  };
  const fakeCodex = new FakeCodex([
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
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
    JSON.stringify(correctnessReview),
    JSON.stringify(testsReview),
    reviewLeadReadyResponse(),
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

  const outcome = await executeSpec(paths, options, spec, fakeWorkflowDeps(fakeCodex));

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.candidateCommit, commitHash);
  assert.equal(outcome.nextAction, "Inspect the final outcome.");

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.status, "failed");
  assert.equal(state.lastError, "The run should not be marked done yet.");
  await assert.rejects(fs.access(path.join(paths.reportsRoot, "done", `${spec.specId}.md`)));
});

test("executeSpec normalizes legacy run state and starts fresh threads when policy metadata is missing", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "1357913579135791357913579135791357913579";

  await fs.writeFile(
    path.join(paths.stateRoot, `${spec.specId}.json`),
    `${JSON.stringify({
      specId: spec.specId,
      specRel: spec.relFromSpecs,
      status: "planning",
      currentIteration: 1,
      runId: "legacy-run",
      worktreePath: expectedWorktreePath,
      updatedAt: "2026-04-07T09:00:00.000Z",
      threads: {
        planningSpec: "legacy-planning-spec",
        planningRepo: "legacy-planning-repo",
      },
      legacyDoneDetected: false,
    }, null, 2)}\n`,
    "utf8",
  );

  const fakeCodex = new FakeCodex([
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
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
    reviewLeadReadyResponse(),
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

  const outcome = await executeSpec(
    paths,
    { workspaceRoot, projectRoot, model: undefined, maxIterations: 1, dryRun: false, specFilters: [] },
    spec,
    fakeWorkflowDeps(fakeCodex),
  );

  assert.equal(outcome.status, "done");
  assert.equal(fakeCodex.threadConfigs[0]?.method, "start");
  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.stateVersion, 2);
  assert.equal(state.threads.planningSpec, "thread-0");
  assert.ok(state.threadPolicies.planningSpec);
});

test("executeSpec resumes a persisted thread when the saved policy matches", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "11223344556677889900aabbccddeeff00112233";
  const additionalDirectories = [
    path.join(repoRoot, ".git"),
    path.join(repoRoot, ".git", "worktrees", spec.specId),
  ];
  const planningSpecPolicy = JSON.stringify({
    role: "planning_spec",
    model: "gpt-5.4-mini",
    workingDirectory: path.resolve(expectedWorktreePath),
    additionalDirectories: additionalDirectories.map((dir) => path.resolve(dir)).sort(),
    sandboxMode: "read-only",
    approvalPolicy: "never",
    reasoningEffort: "medium",
  });

  await fs.writeFile(
    path.join(paths.stateRoot, `${spec.specId}.json`),
    `${JSON.stringify({
      stateVersion: 2,
      specId: spec.specId,
      specRel: spec.relFromSpecs,
      status: "planning",
      currentIteration: 0,
      runId: "saved-run",
      worktreePath: expectedWorktreePath,
      updatedAt: "2026-04-07T09:00:00.000Z",
      threads: {
        planningSpec: "saved-planning-spec",
      },
      threadPolicies: {
        planningSpec: planningSpecPolicy,
      },
      legacyDoneDetected: false,
    }, null, 2)}\n`,
    "utf8",
  );

  const fakeCodex = new FakeCodex([
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
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
    reviewLeadReadyResponse(),
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

  const outcome = await executeSpec(
    paths,
    { workspaceRoot, projectRoot, model: undefined, maxIterations: 1, dryRun: false, specFilters: [] },
    spec,
    fakeWorkflowDeps(fakeCodex),
  );

  assert.equal(outcome.status, "done");
  assert.equal(fakeCodex.threadConfigs[0]?.method, "resume");
  assert.equal(fakeCodex.threadConfigs[0]?.threadId, "saved-planning-spec");
});

test("executeSpec starts a fresh thread when persisted thread policy metadata mismatches", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "2468024680246802468024680246802468024680";

  await fs.writeFile(
    path.join(paths.stateRoot, `${spec.specId}.json`),
    `${JSON.stringify({
      stateVersion: 2,
      specId: spec.specId,
      specRel: spec.relFromSpecs,
      status: "planning",
      currentIteration: 0,
      runId: "saved-run",
      worktreePath: expectedWorktreePath,
      updatedAt: "2026-04-07T09:00:00.000Z",
      threads: {
        planningSpec: "stale-planning-spec",
      },
      threadPolicies: {
        planningSpec: "wrong-policy",
      },
      legacyDoneDetected: false,
    }, null, 2)}\n`,
    "utf8",
  );

  const fakeCodex = new FakeCodex([
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
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
    reviewLeadReadyResponse(),
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

  const outcome = await executeSpec(
    paths,
    { workspaceRoot, projectRoot, model: "gpt-5.3-codex", maxIterations: 1, dryRun: false, specFilters: [] },
    spec,
    fakeWorkflowDeps(fakeCodex),
  );

  assert.equal(outcome.status, "done");
  assert.equal(fakeCodex.threadConfigs[0]?.method, "start");
  assert.equal(fakeCodex.threadConfigs[0]?.threadId, "thread-0");
});

test("executeSpec keeps mismatched persisted thread state when fresh replacement start fails", async () => {
  const { projectRoot, workspaceRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);

  await fs.writeFile(
    path.join(paths.stateRoot, `${spec.specId}.json`),
    `${JSON.stringify({
      stateVersion: 2,
      specId: spec.specId,
      specRel: spec.relFromSpecs,
      status: "planning",
      currentIteration: 0,
      runId: "saved-run",
      worktreePath: expectedWorktreePath,
      updatedAt: "2026-04-07T09:00:00.000Z",
      threads: {
        planningSpec: "stale-planning-spec",
      },
      threadPolicies: {
        planningSpec: "wrong-policy",
      },
      legacyDoneDetected: false,
    }, null, 2)}\n`,
    "utf8",
  );

  await assert.rejects(
    executeSpec(
      paths,
      { workspaceRoot, projectRoot, model: "gpt-5.3-codex", maxIterations: 1, dryRun: false, specFilters: [] },
      spec,
      {
        createCodex: () => ({
          startThread: (options?: CodexThreadConfig) => {
            assert.ok(options);
            return {
              id: "replacement-thread",
              run: async () => {
                throw new Error("synthetic start failure");
              },
            };
          },
          resumeThread: () => {
            throw new Error("resumeThread should not be used");
          },
        }),
        validateImplementationCandidate: async () => null,
      },
    ),
    /synthetic start failure/,
  );

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.threads.planningSpec, "stale-planning-spec");
  assert.equal(state.threadPolicies.planningSpec, "wrong-policy");
});

test("executeSpec loads persisted invalidation reason and replans at escalated policy after restart", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "3141592653589793238462643383279502884197";

  await fs.writeFile(
    path.join(paths.stateRoot, `${spec.specId}.json`),
    `${JSON.stringify({
      stateVersion: 2,
      specId: spec.specId,
      specRel: spec.relFromSpecs,
      status: "planning",
      currentIteration: 1,
      runId: "prior-run",
      worktreePath: expectedWorktreePath,
      updatedAt: "2026-04-07T09:00:00.000Z",
      threads: {},
      threadPolicies: {},
      legacyDoneDetected: false,
      invalidationReason: "Persisted invalidation context from earlier run.",
    }, null, 2)}\n`,
    "utf8",
  );

  const fakeCodex = new FakeCodex([
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
    JSON.stringify({
      summary: "Use standard correctness and tests reviewers.",
      reviewerRoles: [],
      keyRisks: [],
      notesForUnderstander: [],
    }),
    JSON.stringify({
      summary: "Single pass after restart.",
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
    reviewLeadReadyResponse(),
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

  const outcome = await executeSpec(
    paths,
    { workspaceRoot, projectRoot, model: undefined, maxIterations: 1, dryRun: false, specFilters: [] },
    spec,
    fakeWorkflowDeps(fakeCodex),
  );

  assert.equal(outcome.status, "done");
  assert.deepEqual(
    fakeCodex.threadConfigs.slice(0, 3).map((entry) => [entry.options?.model, entry.options?.modelReasoningEffort]),
    [
      ["gpt-5.4", "xhigh"],
      ["gpt-5.4", "xhigh"],
      ["gpt-5.4", "xhigh"],
    ],
  );
  const planningPrompts = fakeCodex.prompts.slice(0, 3).map((entry) => entry.prompt);
  for (const prompt of planningPrompts) {
    assert.match(prompt, /Previous plan invalidation reason: Persisted invalidation context from earlier run\./);
  }
});

test("executeSpec keeps invalidation reason persisted after replanning resumes", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "abcdef0123456789abcdef0123456789abcdef01";
  const invalidationReason = "The first plan targeted the wrong files.";

  const fakeCodex = new FakeCodex([
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
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
          action: "Re-plan around the right files.",
        },
      ],
    }),
    reviewLeadReadyResponse(),
    JSON.stringify({
      verdict: "invalidate_plan",
      summary: invalidationReason,
      acceptedFindings: [],
      rejectedFindings: [],
      fixInstructions: ["Re-plan around the right files."],
    }),
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
    JSON.stringify({
      summary: "Use standard correctness and tests reviewers.",
      reviewerRoles: [],
      keyRisks: [],
      notesForUnderstander: [],
    }),
  ]);

  await assert.rejects(
    executeSpec(
      paths,
      { workspaceRoot, projectRoot, model: undefined, maxIterations: 2, dryRun: false, specFilters: [] },
      spec,
      fakeWorkflowDeps(fakeCodex, {
        onProgress: (event) => {
          if (event.iteration === 2 && event.summary === "building understanding packet") {
            throw new Error("interrupt during replanned understanding");
          }
        },
      }),
    ),
    /interrupt during replanned understanding/,
  );

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.invalidationReason, invalidationReason);
  assert.equal(state.lastCommit, undefined);
  assert.ok(state.threads.planningSpec);
  assert.ok(state.threads.planningRepo);
  assert.ok(state.threads.planningRisks);
  assert.ok(state.threads.supervisor);
});

test("executeSpec rejects out-of-plan review lead follow-up requests", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "2718281828459045235360287471352662497757";

  const fakeCodex = new FakeCodex([
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
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
      summary: "No test issues.",
      findings: [],
    }),
    reviewLeadFollowUpResponse(["security"]),
  ]);

  await assert.rejects(
    executeSpec(
      paths,
      { workspaceRoot, projectRoot, model: undefined, maxIterations: 1, dryRun: false, specFilters: [] },
      spec,
      fakeWorkflowDeps(fakeCodex),
    ),
    /Review lead requested follow-up without valid reviewer roles/,
  );

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.status, "failed");
  assert.match(state.lastError ?? "", /Review lead requested follow-up without valid reviewer roles/);
});

test("executeSpec sends recheck the real reviewer reports plus the review lead summary", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "0123456789abcdef0123456789abcdef01234567";
  const reviewLeadSummary = "Synthesis: tests concerns remain unresolved.";

  const fakeCodex = new FakeCodex([
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
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
      status: "changes_requested",
      summary: "Raw reviewer report must survive.",
      findings: [
        {
          severity: "warning",
          category: "tests",
          title: "Missing verification",
          detail: "Reviewer found missing verification coverage.",
          action: "Add the missing verification coverage.",
        },
      ],
    }),
    reviewLeadReadyResponse(reviewLeadSummary),
    JSON.stringify({
      verdict: "needs_fix",
      summary: "Address the accepted reviewer findings.",
      acceptedFindings: [
        {
          severity: "warning",
          category: "tests",
          title: "Missing verification",
          detail: "Reviewer found missing verification coverage.",
          action: "Add the missing verification coverage.",
        },
      ],
      rejectedFindings: [],
      fixInstructions: ["Add the missing verification coverage."],
    }),
  ]);

  const outcome = await executeSpec(
    paths,
    { workspaceRoot, projectRoot, model: undefined, maxIterations: 1, dryRun: false, specFilters: [] },
    spec,
    fakeWorkflowDeps(fakeCodex),
  );

  assert.equal(outcome.status, "failed");
  const recheckPrompt = fakeCodex.prompts.find((entry) => entry.prompt.includes("You are the understander re-check agent for Ralph."));
  assert.ok(recheckPrompt?.prompt.includes("Review lead summary:"));
  assert.ok(recheckPrompt?.prompt.includes(reviewLeadSummary));
  assert.ok(recheckPrompt?.prompt.includes("Raw reviewer report must survive."));
  assert.ok(recheckPrompt?.prompt.includes("Reviewer found missing verification coverage."));
});
