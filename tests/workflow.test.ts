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
import type {
  CodexThreadConfig,
  ImplementationReport,
  PublicationResult,
  RalphRunOptions,
  ReviewFinding,
  RunState,
  RuntimePaths,
  VerificationRun,
  WorkflowProgressEvent,
} from "../src/types.js";

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
  overrides: {
    onProgress?: (event: WorkflowProgressEvent) => void | Promise<void>;
    validateImplementationCandidate?: (
      worktreePath: string,
      report: ImplementationReport,
      baseRef?: string,
    ) => Promise<ReviewFinding | null>;
    runVerificationCommands?: (repoPath: string, featureBranch: string, commands: string[]) => Promise<VerificationRun>;
    publishApprovedSpec?: (
      repoPath: string,
      spec: { title: string; branchInstructions: { createBranch: string; prTarget?: string; draftPr?: boolean; labels?: string[] } },
      summary: string,
      candidateCommit: string,
    ) => Promise<PublicationResult>;
  } = {},
) {
  return {
    createCodex: () => fakeCodex,
    validateImplementationCandidate: async () => null,
    runVerificationCommands: async (repoPath: string, featureBranch: string, commands: string[]): Promise<VerificationRun> => ({
      repoPath,
      featureBranch,
      startingBranch: "dev",
      startingCommit: "0123456789abcdef0123456789abcdef01234567",
      restoredBranch: "dev",
      commands: commands.map((command) => ({
        command,
        exitCode: 0,
        stdout: "stubbed verification output\n",
        stderr: "",
      })),
      summary: `Stubbed verification for ${featureBranch}.`,
      succeeded: true,
    }),
    publishApprovedSpec: async (
      _repoPath: string,
      spec: { branchInstructions: { createBranch: string; draftPr?: boolean; labels?: string[] } },
      _summary: string,
      _candidateCommit: string,
    ): Promise<PublicationResult> => ({
      branch: spec.branchInstructions.createBranch,
      remote: "origin",
      prNumber: 1,
      prUrl: "https://example.test/pr/1",
      prCreated: true,
      draft: spec.branchInstructions.draftPr ?? false,
      labels: spec.branchInstructions.labels ?? [],
    }),
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
- Open a **draft** PR for this spec branch.
- Apply labels: \`Prototype\`, \`work in progress\`

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

async function writeWorkflowSpec(
  projectRoot: string,
  relativePath: string,
  options: {
    title: string;
    sourceBranch: string;
    createBranch: string;
    prTarget?: string;
    dependencies?: string[];
  },
): Promise<void> {
  const absolute = path.join(projectRoot, "specs", relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const dependencies = options.dependencies ?? ["None."];
  await fs.writeFile(
    absolute,
    `# ${options.title}

Repo: demo-repo
Workdir: demo-repo

## Branch Instructions
- Source branch: \`${options.sourceBranch}\`
- Create branch: \`${options.createBranch}\`
- PR target: \`${options.prTarget ?? "dev"}\`

## Goal
Exercise Ralph workflow behavior.

## Scope (In)
- Touch one file.

## Boundaries (Out, No Overlap)
- No unrelated changes.

## Constraints
- Keep it minimal.

## Dependencies
${dependencies.map((dependency) => `- ${dependency}`).join("\n")}

## Required Reading
- \`README.md\`

## Acceptance Criteria
- Workflow completes or reports the expected dry-run diagnostic.

## Commit Requirements
- Use the requested branch.

## Verification (Fast-First)
\`\`\`bash
git status --short
\`\`\`
`,
    "utf8",
  );
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

async function writeArtifactJson(
  paths: RuntimePaths,
  specId: string,
  runId: string,
  name: string,
  payload: unknown,
): Promise<void> {
  const dir = path.join(paths.artifactsRoot, specId, runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("executeSpec dry-run warns when a stacked parent branch is expected from an earlier spec", async () => {
  const { projectRoot, workspaceRoot, paths } = await createTempProject();
  await writeWorkflowSpec(projectRoot, "1002-stacked-child.md", {
    title: "1002 - Stacked Child",
    sourceBranch: "feature/demo",
    createBranch: "feature/stacked-child",
    dependencies: ["1001-demo.md"],
  });
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1002-stacked-child.md");
  const progressEvents: WorkflowProgressEvent[] = [];
  const published: Array<{ repoPath: string; summary: string; candidateCommit: string }> = [];

  const outcome = await executeSpec(
    paths,
    {
      workspaceRoot,
      projectRoot,
      model: undefined,
      maxIterations: 2,
      dryRun: true,
      specFilters: [],
    },
    spec,
    fakeWorkflowDeps(new FakeCodex([]), {
      onProgress: (event) => {
        progressEvents.push(event);
      },
    }),
  );

  assert.equal(outcome.status, "needs_more_work");
  assert.match(outcome.summary, /feature\/demo/);
  assert.match(outcome.summary, /1001-demo/);
  assert.match(outcome.summary, /dry-run/i);
  assert.equal(outcome.candidateCommit, undefined);
  assert.deepEqual(progressEvents.map((event) => event.phase), ["dry-run"]);
  assert.match(progressEvents[0]?.summary ?? "", /does not exist yet/i);
  assert.equal(
    await fs
      .access(path.join(paths.worktreesRoot, spec.specId))
      .then(() => true)
      .catch(() => false),
    false,
  );
});

test("executeSpec dry-run fails cleanly when a spec points at a later spec branch", async () => {
  const { projectRoot, workspaceRoot, paths } = await createTempProject();
  await writeWorkflowSpec(projectRoot, "1002-invalid-parent.md", {
    title: "1002 - Invalid Parent",
    sourceBranch: "feature/future-parent",
    createBranch: "feature/invalid-parent",
  });
  await writeWorkflowSpec(projectRoot, "1003-future-parent.md", {
    title: "1003 - Future Parent",
    sourceBranch: "dev",
    createBranch: "feature/future-parent",
  });
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1002-invalid-parent.md");
  const progressEvents: WorkflowProgressEvent[] = [];

  const outcome = await executeSpec(
    paths,
    {
      workspaceRoot,
      projectRoot,
      model: undefined,
      maxIterations: 2,
      dryRun: true,
      specFilters: [],
    },
    spec,
    fakeWorkflowDeps(new FakeCodex([]), {
      onProgress: (event) => {
        progressEvents.push(event);
      },
    }),
  );

  assert.equal(outcome.status, "failed");
  assert.match(outcome.summary, /feature\/future-parent/);
  assert.match(outcome.summary, /1003-future-parent/);
  assert.match(outcome.summary, /ascending order/i);
  assert.deepEqual(progressEvents.map((event) => event.phase), ["failed"]);
  assert.match(progressEvents[0]?.summary ?? "", /later spec/i);
});

test("executeSpec dry-run fails cleanly when the source branch is missing and no spec creates it", async () => {
  const { projectRoot, workspaceRoot, paths } = await createTempProject();
  await writeWorkflowSpec(projectRoot, "1002-missing-root.md", {
    title: "1002 - Missing Root",
    sourceBranch: "release/missing-root",
    createBranch: "feature/missing-root",
  });
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1002-missing-root.md");
  const progressEvents: WorkflowProgressEvent[] = [];

  const outcome = await executeSpec(
    paths,
    {
      workspaceRoot,
      projectRoot,
      model: undefined,
      maxIterations: 2,
      dryRun: true,
      specFilters: [],
    },
    spec,
    fakeWorkflowDeps(new FakeCodex([]), {
      onProgress: (event) => {
        progressEvents.push(event);
      },
    }),
  );

  assert.equal(outcome.status, "failed");
  assert.match(outcome.summary, /release\/missing-root/);
  assert.match(outcome.summary, /no spec in this project creates it/i);
  assert.deepEqual(progressEvents.map((event) => event.phase), ["failed"]);
  assert.match(progressEvents[0]?.summary ?? "", /no spec/i);
});

test("executeSpec completes the supervised loop with an injected Codex backend", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "1234567890abcdef1234567890abcdef12345678";
  const progressEvents: WorkflowProgressEvent[] = [];
  const published: Array<{ repoPath: string; summary: string; candidateCommit: string }> = [];
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
      checkoutMode: "worktree",
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
      publishApprovedSpec: async (repoPath, _spec, summary, candidateCommit) => {
        published.push({ repoPath, summary, candidateCommit });
        return {
          branch: _spec.branchInstructions.createBranch,
          remote: "origin",
          prNumber: 7,
          prUrl: "https://example.test/pr/7",
          prCreated: true,
          draft: true,
          labels: ["Prototype", "work in progress"],
        };
      },
      onProgress: (event) => {
        progressEvents.push(event);
      },
    }),
  );

  assert.equal(outcome.status, "done");
  assert.equal(outcome.candidateCommit, commitHash);
  assert.deepEqual(published, [
    {
      repoPath: repoRoot,
      summary: "Spec completed successfully.",
      candidateCommit: commitHash,
    },
  ]);
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
      ["publishing", "pushing branch and updating pull request"],
      ["done", "Spec completed successfully."],
    ],
  );
  const eventLog = await fs.readFile(runEventLogPath(paths, spec.specId, progressEvents[0]?.runId ?? ""), "utf8");
  assert.match(eventLog, /phase=setup .*worktree ready/);
  assert.match(eventLog, /phase=planning iteration=1 running planning_spec helper/);
  assert.match(eventLog, /phase=reviewing iteration=1 reviewer=correctness running correctness reviewer/);
  assert.match(eventLog, /phase=reviewing iteration=1 running review lead/);
  assert.match(eventLog, new RegExp(`phase=done iteration=1 commit=${commitHash} Spec completed successfully\\.`));
  const testsReviewerPrompt = fakeCodex.prompts.find((entry) => entry.prompt.includes("You are Ralph's tests reviewer."));
  assert.ok(testsReviewerPrompt?.prompt.includes("Tests reviewer execution scope:"));
  assert.ok(testsReviewerPrompt?.prompt.includes("Run only tests for affected modules derived from changed files."));
  assert.ok(testsReviewerPrompt?.prompt.includes("Do not run broad/repo-wide suites in the reviewer phase."));

  const doneReport = await fs.readFile(path.join(paths.reportsRoot, "done", `${spec.specId}.md`), "utf8");
  assert.match(doneReport, /Spec completed successfully\./);
  assert.match(doneReport, new RegExp(commitHash));
});

test("executeSpec root checkout mode uses the repo root and grants Docker access only to implementer and reviewers", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  spec.verificationCommands = ["git status --short"];
  const commitHash = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const progressEvents: WorkflowProgressEvent[] = [];

  const fakeCodex = new FakeCodex([
    ...defaultPlanningResponses(repoRoot, repoRoot),
    JSON.stringify({
      summary: "Use standard correctness and tests reviewers.",
      reviewerRoles: [],
      keyRisks: [],
      notesForUnderstander: [],
    }),
    JSON.stringify({
      summary: "Operate directly in the repo root checkout.",
      repoPath: repoRoot,
      worktreePath: repoRoot,
      checkoutMode: "root",
      featureBranch: "feature/demo",
      targetFiles: ["README.md"],
      contextFiles: ["README.md"],
      executionPlan: ["Update README.md from the repo root checkout."],
      verificationCommands: ["docker compose run --rm app pytest billing/tests/test_demo.py"],
      assumptions: [],
      riskFlags: [],
    }),
    JSON.stringify({
      summary: "Implemented change and committed it.",
      commitHash,
      changedFiles: ["README.md"],
      verificationCommands: ["docker compose run --rm app pytest billing/tests/test_demo.py"],
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
      summary: "Docker-backed verification coverage is sufficient.",
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
    {
      workspaceRoot,
      projectRoot,
      model: undefined,
      maxIterations: 1,
      dryRun: false,
      specFilters: [],
      checkoutMode: "root",
    },
    spec,
    {
      ...fakeWorkflowDeps(fakeCodex, {
        publishApprovedSpec: async (_repoPath, _spec, _summary, _candidateCommit) => ({
          branch: _spec.branchInstructions.createBranch,
          remote: "origin",
          prNumber: 9,
          prUrl: "https://example.test/pr/9",
          prCreated: true,
          draft: true,
          labels: ["Prototype", "work in progress"],
        }),
      }),
      validateImplementationCandidate: async () => null,
      onProgress: (event) => {
        progressEvents.push(event);
      },
    },
  );

  assert.equal(outcome.status, "done");
  await assert.rejects(fs.access(path.join(paths.worktreesRoot, spec.specId)));

  const implementerThread = fakeCodex.threadConfigs[5];
  const correctnessReviewerThread = fakeCodex.threadConfigs[6];
  const testsReviewerThread = fakeCodex.threadConfigs[7];
  const supervisorThread = fakeCodex.threadConfigs[3];

  assert.deepEqual(
    implementerThread?.options?.additionalDirectories?.sort(),
    ["/var/run", path.join(repoRoot, ".git")].sort(),
  );
  assert.deepEqual(
    correctnessReviewerThread?.options?.additionalDirectories?.sort(),
    ["/var/run", path.join(repoRoot, ".git")].sort(),
  );
  assert.deepEqual(
    testsReviewerThread?.options?.additionalDirectories?.sort(),
    ["/var/run", path.join(repoRoot, ".git")].sort(),
  );
  assert.deepEqual(supervisorThread?.options?.additionalDirectories, [path.join(repoRoot, ".git")]);

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.worktreePath, repoRoot);
  assert.equal(state.checkoutMode, "root");
  assert.match(state.threadPolicies.implementer ?? "", /"checkoutMode":"root"/);
  assert.deepEqual(
    progressEvents.map((event) => [event.phase, event.summary])[0],
    ["setup", `checkout ready at ${repoRoot}`],
  );
});

test("executeSpec root checkout mode resumes from a dirty feature-branch checkout without failing the setup preflight", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const commitHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const savedRunId = "root-resume-run";

  await execFile("git", ["checkout", "-b", "feature/demo"], { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, "DIRTY.txt"), "in progress\n", "utf8");

  await fs.writeFile(
    path.join(paths.stateRoot, `${spec.specId}.json`),
    `${JSON.stringify({
      stateVersion: 2,
      specId: spec.specId,
      specRel: spec.relFromSpecs,
      status: "reviewing",
      currentIteration: 1,
      runId: savedRunId,
      checkoutMode: "root",
      worktreePath: repoRoot,
      lastCommit: commitHash,
      updatedAt: new Date("2026-04-10T09:00:00.000Z").toISOString(),
      threads: {},
      threadPolicies: {},
      legacyDoneDetected: false,
    }, null, 2)}\n`,
    "utf8",
  );

  await writeArtifactJson(paths, spec.specId, savedRunId, "understander-1", {
    role: "understander",
    turnId: "understander:root-resume-run",
    threadId: "saved-understander",
    output: {
      summary: "Resume from the dirty root checkout.",
      repoPath: repoRoot,
      worktreePath: repoRoot,
      checkoutMode: "root",
      featureBranch: "feature/demo",
      targetFiles: ["README.md"],
      contextFiles: ["README.md"],
      executionPlan: ["Continue from the existing dirty checkout state."],
      verificationCommands: ["git status --short"],
      assumptions: [],
      riskFlags: [],
    },
    usage: null,
    items: [],
    rawResponse: "{}",
  });

  await writeArtifactJson(paths, spec.specId, savedRunId, "implementer-1", {
    role: "implementer",
    turnId: "implementer:root-resume-run",
    threadId: "saved-implementer",
    output: {
      summary: "Resume from the already-created candidate commit.",
      commitHash,
      changedFiles: ["README.md"],
      verificationCommands: ["git status --short"],
      verificationSummary: "Resume artifact only.",
      concerns: [],
    },
    usage: null,
    items: [],
    rawResponse: "{}",
  });

  const fakeCodex = new FakeCodex([
    JSON.stringify({
      reviewer: "correctness",
      status: "approved",
      summary: "No correctness issues.",
      findings: [],
    }),
    JSON.stringify({
      reviewer: "tests",
      status: "approved",
      summary: "Resume verification is sufficient.",
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
    {
      workspaceRoot,
      projectRoot,
      model: undefined,
      maxIterations: 2,
      dryRun: false,
      resume: true,
      specFilters: [],
      checkoutMode: "root",
    },
    spec,
    fakeWorkflowDeps(fakeCodex, {
      publishApprovedSpec: async (_repoPath, _spec, _summary, _candidateCommit) => ({
        branch: _spec.branchInstructions.createBranch,
        remote: "origin",
        prNumber: 17,
        prUrl: "https://example.test/pr/17",
        prCreated: false,
        draft: true,
        labels: ["Prototype"],
      }),
      runVerificationCommands: async () => ({
        repoPath: repoRoot,
        featureBranch: "feature/demo",
        startingBranch: "feature/demo",
        startingCommit: commitHash,
        restoredBranch: "feature/demo",
        commands: [
          {
            command: "git status --short",
            exitCode: 0,
            stdout: " M DIRTY.txt\n",
            stderr: "",
          },
        ],
        summary: "Stubbed resume verification.",
        succeeded: true,
      }),
    }),
  );

  assert.equal(outcome.status, "done");
  const { stdout: branchName } = await execFile("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(branchName.trim(), "feature/demo");
  assert.equal(await fs.readFile(path.join(repoRoot, "DIRTY.txt"), "utf8"), "in progress\n");
});

test("executeSpec normalizes implementer changedFiles to branch-wide diff before validation", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);

  await execFile("git", ["checkout", "-b", "feature/demo"], { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, "preexisting.txt"), "preexisting branch change\n", "utf8");
  await execFile("git", ["add", "preexisting.txt"], { cwd: repoRoot });
  await execFile("git", ["commit", "-m", "preexisting feature branch change"], { cwd: repoRoot });
  const { stdout: preexistingCommitStdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  const preexistingCommit = preexistingCommitStdout.trim();
  await execFile("git", ["checkout", "dev"], { cwd: repoRoot });

  const fakeCodex = new FakeCodex([
    ...defaultPlanningResponses(repoRoot, expectedWorktreePath),
    JSON.stringify({
      summary: "Use standard correctness and tests reviewers.",
      reviewerRoles: [],
      keyRisks: [],
      notesForUnderstander: [],
    }),
    JSON.stringify({
      summary: "Use existing branch commit for the candidate.",
      repoPath: repoRoot,
      worktreePath: expectedWorktreePath,
      checkoutMode: "worktree",
      featureBranch: "feature/demo",
      targetFiles: ["README.md"],
      contextFiles: ["README.md"],
      executionPlan: ["Validate existing feature branch candidate."],
      verificationCommands: ["git status --short"],
      assumptions: [],
      riskFlags: [],
    }),
    JSON.stringify({
      summary: "Reported only this iteration's touched files.",
      commitHash: preexistingCommit,
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
      candidateCommit: preexistingCommit,
      nextAction: "none",
    }),
  ]);

  let normalizedReportChangedFiles: string[] | undefined;
  const outcome = await executeSpec(
    paths,
    { workspaceRoot, projectRoot, model: undefined, maxIterations: 1, dryRun: false, specFilters: [] },
    spec,
    {
      ...fakeWorkflowDeps(fakeCodex, {
        runVerificationCommands: async () => ({
          repoPath: repoRoot,
          featureBranch: "feature/demo",
          startingBranch: "dev",
          startingCommit: "0123456789abcdef0123456789abcdef01234567",
          restoredBranch: "dev",
          commands: [
            {
              command: "git status --short",
              exitCode: 0,
              stdout: "",
              stderr: "",
            },
          ],
          summary: "Stubbed verification succeeded.",
          succeeded: true,
        }),
      }),
      validateImplementationCandidate: async (_worktreePath, report) => {
        normalizedReportChangedFiles = report.changedFiles;
        return null;
      },
    },
  );

  assert.equal(outcome.status, "done");
  assert.deepEqual(normalizedReportChangedFiles, ["preexisting.txt"]);
  const reviewerPrompt = fakeCodex.prompts.find((entry) => entry.prompt.includes("You are Ralph's correctness reviewer."));
  assert.ok(reviewerPrompt?.prompt.includes("- preexisting.txt"));
});

test("executeSpec --resume continues from the latest review checkpoint", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const savedRunId = "saved-run";
  const commitHash = "1357913579135791357913579135791357913579";
  const published: string[] = [];
  let logOutput = "";
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    logOutput += `${String(message)}\n`;
  };

  const supervisorPolicy = JSON.stringify({
    role: "supervisor",
    model: "gpt-5.4",
    checkoutMode: "worktree",
    workingDirectory: path.resolve(expectedWorktreePath),
    additionalDirectories: [path.join(repoRoot, ".git"), path.join(repoRoot, ".git", "worktrees", spec.specId)]
      .map((dir) => path.resolve(dir))
      .sort(),
    sandboxMode: "read-only",
    approvalPolicy: "never",
    reasoningEffort: "xhigh",
  });

  await fs.writeFile(
    path.join(paths.stateRoot, `${spec.specId}.json`),
    `${JSON.stringify({
      stateVersion: 2,
      specId: spec.specId,
      specRel: spec.relFromSpecs,
      status: "reviewing",
      currentIteration: 1,
      runId: savedRunId,
      worktreePath: expectedWorktreePath,
      checkoutMode: "worktree",
      lastCommit: commitHash,
      updatedAt: new Date("2026-04-09T09:00:00.000Z").toISOString(),
      threads: {
        understander: "saved-understander",
        implementer: "saved-implementer",
        supervisor: "saved-supervisor",
      },
      threadPolicies: {
        understander: JSON.stringify({
          role: "understander",
          model: "gpt-5.4",
          checkoutMode: "worktree",
          workingDirectory: path.resolve(expectedWorktreePath),
          additionalDirectories: [path.join(repoRoot, ".git"), path.join(repoRoot, ".git", "worktrees", spec.specId)]
            .map((dir) => path.resolve(dir))
            .sort(),
          sandboxMode: "read-only",
          approvalPolicy: "never",
          reasoningEffort: "xhigh",
        }),
        implementer: JSON.stringify({
          role: "implementer",
          model: "gpt-5.4-mini",
          checkoutMode: "worktree",
          workingDirectory: path.resolve(expectedWorktreePath),
          additionalDirectories: [path.join(repoRoot, ".git"), path.join(repoRoot, ".git", "worktrees", spec.specId)]
            .map((dir) => path.resolve(dir))
            .sort(),
          sandboxMode: "workspace-write",
          approvalPolicy: "never",
          reasoningEffort: "high",
        }),
        supervisor: supervisorPolicy,
      },
      legacyDoneDetected: false,
    }, null, 2)}\n`,
    "utf8",
  );
  await writeArtifactJson(paths, spec.specId, savedRunId, "understander-1", {
    role: "understander",
    turnId: "understander:saved-run",
    threadId: "saved-understander",
    output: {
      summary: "Cached understanding packet.",
      repoPath: repoRoot,
      worktreePath: expectedWorktreePath,
      checkoutMode: "worktree",
      featureBranch: "feature/demo",
      targetFiles: ["README.md"],
      contextFiles: ["README.md"],
      executionPlan: ["Edit README.md", "Run verification"],
      verificationCommands: ["git status --short"],
      assumptions: [],
      riskFlags: [],
    },
    usage: null,
    items: [],
    rawResponse: "{}",
  });
  await writeArtifactJson(paths, spec.specId, savedRunId, "implementer-1", {
    role: "implementer",
    turnId: "implementer:saved-run",
    threadId: "saved-implementer",
    output: {
      summary: "Cached implementation report.",
      commitHash,
      changedFiles: ["README.md"],
      verificationCommands: ["git status --short"],
      verificationSummary: "Verified locally.",
      concerns: [],
    },
    usage: null,
    items: [],
    rawResponse: "{}",
  });

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
    JSON.stringify(correctnessReview),
    JSON.stringify(testsReview),
    reviewLeadReadyResponse("Resumed review is ready."),
    JSON.stringify({
      verdict: "approve",
      summary: "Implementation still matches the spec.",
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

  let outcome;
  try {
    outcome = await executeSpec(
      paths,
      {
        workspaceRoot,
        projectRoot,
        model: undefined,
        maxIterations: 2,
        dryRun: false,
        resume: true,
        specFilters: [],
      },
      spec,
      fakeWorkflowDeps(fakeCodex, {
        publishApprovedSpec: async (_repoPath, _spec, _summary, candidateCommit) => {
          published.push(candidateCommit);
          return {
            branch: _spec.branchInstructions.createBranch,
            remote: "origin",
            prNumber: 11,
            prUrl: "https://example.test/pr/11",
            prCreated: false,
            draft: true,
            labels: ["Prototype", "work in progress"],
          };
        },
      }),
    );
  } finally {
    console.log = originalLog;
  }

  assert.equal(outcome.status, "done");
  assert.deepEqual(published, [commitHash]);
  assert.match(logOutput, /\[resume\] checkpoint: stage=reviewing iteration=1/);
  assert.ok(fakeCodex.prompts.every((item) => !item.prompt.includes("planning helper")));
  assert.ok(fakeCodex.prompts.every((item) => !item.prompt.includes("You are the implementer agent for Ralph.")));
  assert.ok(fakeCodex.prompts.some((item) => item.prompt.includes("You are Ralph's review lead.")));
  assert.equal(
    fakeCodex.threadConfigs.filter((entry) => entry.method === "resume" || entry.method === "start").length,
    5,
  );
  assert.equal(
    fakeCodex.threadConfigs.some((entry) => entry.method === "resume" && entry.threadId === "saved-supervisor"),
    true,
  );
});

test("executeSpec keeps the prior durable runId when a resumed attempt fails before the first new artifact", async () => {
  const { projectRoot, workspaceRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const priorRunId = "saved-run";

  await fs.writeFile(
    path.join(paths.stateRoot, `${spec.specId}.json`),
    `${JSON.stringify({
      stateVersion: 2,
      specId: spec.specId,
      specRel: spec.relFromSpecs,
      status: "failed",
      currentIteration: 1,
      runId: priorRunId,
      worktreePath: expectedWorktreePath,
      checkoutMode: "worktree",
      lastCommit: undefined,
      lastError: "Previous run failed before checkpointing.",
      updatedAt: new Date("2026-04-09T09:00:00.000Z").toISOString(),
      threads: {},
      threadPolicies: {},
      legacyDoneDetected: false,
    }, null, 2)}
`,
    "utf8",
  );

  await assert.rejects(
    executeSpec(
      paths,
      {
        workspaceRoot,
        projectRoot,
        model: undefined,
        maxIterations: 2,
        dryRun: false,
        resume: true,
        specFilters: [],
      },
      spec,
      fakeWorkflowDeps(new FakeCodex([]), {
        onProgress: (event) => {
          if (event.phase === "setup") {
            throw new Error("interrupt during setup");
          }
        },
      }),
    ),
    /interrupt during setup/,
  );

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.runId, priorRunId);
});

test("executeSpec reuses restored planning context after resumed implementation validation failure", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const savedRunId = "saved-run";
  const firstRetryCommit = "2468246824682468246824682468246824682468";
  const secondRetryCommit = "9753197531975319753197531975319753197531";

  await fs.writeFile(
    path.join(paths.stateRoot, `${spec.specId}.json`),
    `${JSON.stringify({
      stateVersion: 2,
      specId: spec.specId,
      specRel: spec.relFromSpecs,
      status: "failed",
      currentIteration: 1,
      runId: savedRunId,
      worktreePath: expectedWorktreePath,
      checkoutMode: "worktree",
      lastCommit: firstRetryCommit,
      lastError: "Previous attempt needs targeted fixes.",
      updatedAt: new Date("2026-04-09T09:00:00.000Z").toISOString(),
      threads: {},
      threadPolicies: {},
      legacyDoneDetected: false,
    }, null, 2)}
`,
    "utf8",
  );

  await writeArtifactJson(paths, spec.specId, savedRunId, "planning_spec-1", {
    role: "planning_spec",
    turnId: "planning_spec:saved-run",
    threadId: "saved-planning-spec",
    output: JSON.parse(planningViewResponse("spec", "Saved spec view.")),
    usage: null,
    items: [],
    rawResponse: "{}",
  });
  await writeArtifactJson(paths, spec.specId, savedRunId, "planning_repo-1", {
    role: "planning_repo",
    turnId: "planning_repo:saved-run",
    threadId: "saved-planning-repo",
    output: JSON.parse(planningViewResponse("repo", "Saved repo view.", {
      suggestedFiles: [path.join(repoRoot, "README.md")],
    })),
    usage: null,
    items: [],
    rawResponse: "{}",
  });
  await writeArtifactJson(paths, spec.specId, savedRunId, "planning_risks-1", {
    role: "planning_risks",
    turnId: "planning_risks:saved-run",
    threadId: "saved-planning-risks",
    output: JSON.parse(planningViewResponse("risks", "Saved risk view.")),
    usage: null,
    items: [],
    rawResponse: "{}",
  });
  await writeArtifactJson(paths, spec.specId, savedRunId, "supervisor-1", {
    role: "supervisor",
    turnId: "supervisor:saved-run",
    threadId: "saved-supervisor",
    output: {
      summary: "Saved supervisor strategy.",
      reviewerRoles: [],
      keyRisks: [],
      notesForUnderstander: [],
    },
    usage: null,
    items: [],
    rawResponse: "{}",
  });
  await writeArtifactJson(paths, spec.specId, savedRunId, "understander-1", {
    role: "understander",
    turnId: "understander:saved-run",
    threadId: "saved-understander",
    output: {
      summary: "Saved understanding packet.",
      repoPath: repoRoot,
      worktreePath: expectedWorktreePath,
      checkoutMode: "worktree",
      featureBranch: "feature/demo",
      targetFiles: ["README.md"],
      contextFiles: ["README.md"],
      executionPlan: ["Update README.md", "Run verification"],
      verificationCommands: ["git status --short"],
      assumptions: [],
      riskFlags: [],
    },
    usage: null,
    items: [],
    rawResponse: "{}",
  });
  await writeArtifactJson(paths, spec.specId, savedRunId, "recheck-1", {
    role: "recheck",
    turnId: "recheck:saved-run",
    threadId: "saved-recheck",
    output: {
      verdict: "needs_fix",
      summary: "Tighten the implementation based on the previous findings.",
      acceptedFindings: [
        {
          severity: "warning",
          category: "tests",
          title: "Retry required",
          detail: "The previous retry needs one more pass.",
          action: "Tighten the retry without re-planning.",
        },
      ],
      rejectedFindings: [],
      fixInstructions: ["Tighten the retry without re-planning."],
    },
    usage: null,
    items: [],
    rawResponse: "{}",
  });

  let validationCalls = 0;
  const fakeCodex = new FakeCodex([
    JSON.stringify({
      summary: "Resumed implementer retry.",
      commitHash: firstRetryCommit,
      changedFiles: ["README.md"],
      verificationCommands: ["git status --short"],
      verificationSummary: "Verified locally.",
      concerns: [],
    }),
    JSON.stringify({
      summary: "Rebuilt understanding from restored strategy.",
      repoPath: repoRoot,
      worktreePath: expectedWorktreePath,
      checkoutMode: "worktree",
      featureBranch: "feature/demo",
      targetFiles: ["README.md"],
      contextFiles: ["README.md"],
      executionPlan: ["Update README.md", "Run verification again"],
      verificationCommands: ["git status --short"],
      assumptions: [],
      riskFlags: [],
    }),
    JSON.stringify({
      summary: "Committed the fixed retry.",
      commitHash: secondRetryCommit,
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
    reviewLeadReadyResponse("Recovered review is ready."),
    JSON.stringify({
      verdict: "approve",
      summary: "The resumed retry is acceptable.",
      acceptedFindings: [],
      rejectedFindings: [],
      fixInstructions: [],
    }),
    JSON.stringify({
      status: "done",
      summary: "Spec completed successfully after resumed retry.",
      candidateCommit: secondRetryCommit,
      nextAction: "none",
    }),
  ]);

  const outcome = await executeSpec(
    paths,
    {
      workspaceRoot,
      projectRoot,
      model: undefined,
      maxIterations: 3,
      dryRun: false,
      resume: true,
      specFilters: [],
    },
    spec,
    fakeWorkflowDeps(fakeCodex, {
      validateImplementationCandidate: async () => {
        validationCalls += 1;
        if (validationCalls === 1) {
          return {
            severity: "warning",
            category: "tests",
            title: "Retry still incomplete",
            detail: "The resumed retry still needs one more pass.",
            action: "Retry once more using the same plan.",
          };
        }
        return null;
      },
    }),
  );

  assert.equal(outcome.status, "done");
  assert.equal(validationCalls, 2);
  assert.equal(
    fakeCodex.prompts.filter((entry) => entry.prompt.includes("You are Ralph's planning helper")).length,
    0,
  );
  assert.equal(
    fakeCodex.prompts.filter((entry) => entry.prompt.includes("You are the understander agent for Ralph.")).length,
    1,
  );
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
      checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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

test("executeSpec persists failed state when an escalated follow-up reviewer returns the wrong identity", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "abababababababababababababababababababab";
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
      checkoutMode: "worktree",
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
    JSON.stringify({
      reviewer: "tests",
      status: "approved",
      summary: "Wrong reviewer identity on escalated rerun.",
      findings: [],
    }),
  ]);

  await assert.rejects(
    executeSpec(
      paths,
      {
        workspaceRoot,
        projectRoot,
        model: undefined,
        maxIterations: 1,
        dryRun: false,
        specFilters: [],
      },
      spec,
      fakeWorkflowDeps(fakeCodex),
    ),
    /Reviewer output mismatch/,
  );

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.status, "failed");
  assert.match(state.lastError ?? "", /Reviewer output mismatch/);
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
      checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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
  const progressEvents: WorkflowProgressEvent[] = [];

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
    fakeWorkflowDeps(fakeCodex, {
      onProgress: (event) => {
        progressEvents.push(event);
      },
    }),
  );

  assert.equal(outcome.status, "needs_more_work");
  assert.deepEqual(fakeCodex.prompts, []);
  assert.deepEqual(progressEvents.map((event) => event.phase), ["dry-run"]);
  assert.match(progressEvents[0]?.summary ?? "", /would use worktree/i);
  await assert.rejects(fs.access(path.join(paths.stateRoot, `${spec.specId}.json`)));
  await assert.rejects(fs.access(path.join(paths.artifactsRoot, spec.specId)));
  await assert.rejects(fs.access(path.join(paths.worktreesRoot, spec.specId)));
  await assert.rejects(fs.access(path.join(paths.ralphRoot, "codex-home")));
  const runLogs = await fs.readdir(path.join(paths.runsRoot, spec.specId)).catch(() => []);
  assert.deepEqual(runLogs, []);
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
      checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.status, "failed");
  assert.match(state.lastError ?? "", /Reviewer output mismatch/);
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
      checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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
    checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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

test("executeSpec seeds reruns from the previous lastError and escalates the first retry", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "9753197531975319753197531975319753197531";
  const lastError = "The previous run failed during verification and should not restart from scratch.";

  await fs.writeFile(
    path.join(paths.stateRoot, `${spec.specId}.json`),
    `${JSON.stringify({
      stateVersion: 2,
      specId: spec.specId,
      specRel: spec.relFromSpecs,
      status: "failed",
      currentIteration: 1,
      runId: "prior-run",
      worktreePath: expectedWorktreePath,
      checkoutMode: "worktree",
      lastCommit: commitHash,
      lastError,
      updatedAt: "2026-04-09T09:00:00.000Z",
      threads: {},
      threadPolicies: {},
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
      summary: "Rerun starts from the previous failure context.",
      repoPath: repoRoot,
      worktreePath: expectedWorktreePath,
      checkoutMode: "worktree",
      featureBranch: "feature/demo",
      targetFiles: ["README.md"],
      contextFiles: ["README.md"],
      executionPlan: ["Update README.md", "Run git status --short"],
      verificationCommands: ["git status --short"],
      assumptions: [],
      riskFlags: [],
    }),
    JSON.stringify({
      summary: "Committed after restarting from the prior error.",
      commitHash,
      changedFiles: ["README.md"],
      verificationCommands: ["git status --short"],
      verificationSummary: "Verified locally.",
      concerns: [],
    }),
    JSON.stringify({
      reviewer: "correctness" as const,
      status: "approved" as const,
      summary: "No correctness issues.",
      findings: [],
    }),
    JSON.stringify({
      reviewer: "tests" as const,
      status: "approved" as const,
      summary: "Verification coverage is sufficient.",
      findings: [],
    }),
    reviewLeadReadyResponse("The rerun review synthesis is ready."),
    JSON.stringify({
      verdict: "approve",
      summary: "The rerun resolves the prior failure.",
      acceptedFindings: [],
      rejectedFindings: [],
      fixInstructions: [],
    }),
    JSON.stringify({
      status: "done",
      summary: "Spec completed successfully after rerun.",
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
    fakeCodex.threadConfigs.slice(0, 8).map((entry) => [entry.options?.model, entry.options?.modelReasoningEffort]),
    [
      ["gpt-5.4", "xhigh"],
      ["gpt-5.4", "xhigh"],
      ["gpt-5.4", "xhigh"],
      ["gpt-5.4", "xhigh"],
      ["gpt-5.4", "xhigh"],
      ["gpt-5.4", "xhigh"],
      ["gpt-5.4", "xhigh"],
      ["gpt-5.4", "xhigh"],
    ],
  );
  const planningPrompts = fakeCodex.prompts.slice(0, 3).map((entry) => entry.prompt);
  for (const prompt of planningPrompts) {
    assert.match(prompt, new RegExp(lastError.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const state = await readJsonFile<RunState>(path.join(paths.stateRoot, `${spec.specId}.json`));
  assert.equal(state.status, "done");
  assert.equal(state.lastCommit, commitHash);
  assert.equal(state.lastError, undefined);
  assert.equal(state.invalidationReason, undefined);
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
      checkoutMode: "worktree",
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
      checkoutMode: "worktree",
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

test("executeSpec passes host verification output into the recheck prompt", async () => {
  const { projectRoot, workspaceRoot, repoRoot, paths } = await createTempProject();
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-demo.md");
  const expectedWorktreePath = path.join(paths.worktreesRoot, spec.specId);
  const commitHash = "fedcba9876543210fedcba9876543210fedcba98";
  const hostVerification: VerificationRun = {
    repoPath: repoRoot,
    featureBranch: "feature/demo",
    startingBranch: "dev",
    startingCommit: "1111111111111111111111111111111111111111",
    restoredBranch: "dev",
    commands: [
      {
        command: "echo host verification",
        exitCode: 0,
        stdout: "host verification\n",
        stderr: "",
      },
    ],
    summary: "Host verification ran on the main Zemtu checkout.",
    succeeded: true,
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
      summary: "Single pass.",
      repoPath: repoRoot,
      worktreePath: expectedWorktreePath,
      checkoutMode: "worktree",
      featureBranch: "feature/demo",
      targetFiles: ["README.md"],
      contextFiles: ["README.md"],
      executionPlan: ["Update README.md", "Run git status --short"],
      verificationCommands: ["echo host verification"],
      assumptions: [],
      riskFlags: [],
    }),
    JSON.stringify({
      summary: "Committed one attempt.",
      commitHash,
      changedFiles: ["README.md"],
      verificationCommands: ["echo host verification"],
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
    reviewLeadReadyResponse("Verification synthesis is ready for recheck."),
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
    fakeWorkflowDeps(fakeCodex, {
      runVerificationCommands: async () => hostVerification,
    }),
  );

  assert.equal(outcome.status, "failed");
  const recheckPrompt = fakeCodex.prompts.find((entry) => entry.prompt.includes("You are the understander re-check agent for Ralph."));
  assert.ok(recheckPrompt?.prompt.includes("Host verification ran on the main Zemtu checkout."));
  assert.ok(recheckPrompt?.prompt.includes("echo host verification"));
  assert.ok(recheckPrompt?.prompt.includes("host verification"));
  assert.ok(recheckPrompt?.prompt.includes("Feature branch: feature/demo"));
});
