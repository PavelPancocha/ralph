import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { Codex } from "@openai/codex-sdk";

import type {
  AgentRunArtifact,
  CodexThreadConfig,
  ImplementationReport,
  PlanningLens,
  PlanningView,
  RalphRunOptions,
  RecheckVerdict,
  ReviewLeadReport,
  ReviewFinding,
  ReviewerReport,
  RoleExecutionOptions,
  RunState,
  RuntimePaths,
  SpecDocument,
  SupervisorOutcome,
  SupervisorStrategy,
  UnderstandingPacket,
  WorkflowProgressEvent,
} from "./types.js";
import {
  buildPlanningHelperPrompt,
  buildSupervisorFinalPrompt,
  buildSupervisorPrompt,
  buildImplementerPrompt,
  buildRecheckPrompt,
  buildReviewLeadPrompt,
  buildReviewerPrompt,
  buildUnderstanderPrompt,
} from "./prompts.js";
import {
  appendRunEvent,
  createRunId,
  ensureCodexHome,
  ensureSpecWorktree,
  initialRunState,
  legacyDoneExists,
  loadRunState,
  resolveRepoPath,
  saveArtifact,
  saveDoneReport,
  saveRunState,
  validateImplementationCandidate,
  worktreeAdditionalDirectories,
} from "./runtime.js";

const supervisorStrategySchema = z.object({
  summary: z.string(),
  reviewerRoles: z.array(z.enum(["correctness", "tests", "security", "performance"])),
  keyRisks: z.array(z.string()),
  notesForUnderstander: z.array(z.string()),
});

const planningViewSchema = z.object({
  lens: z.enum(["spec", "repo", "risks"]),
  summary: z.string(),
  keyPoints: z.array(z.string()),
  suggestedFiles: z.array(z.string()),
  suggestedReviewers: z.array(z.enum(["correctness", "tests", "security", "performance"])),
  verificationHints: z.array(z.string()),
});

const understandingPacketSchema = z.object({
  summary: z.string(),
  repoPath: z.string(),
  worktreePath: z.string(),
  featureBranch: z.string(),
  targetFiles: z.array(z.string()),
  contextFiles: z.array(z.string()),
  executionPlan: z.array(z.string()).min(1),
  verificationCommands: z.array(z.string()).min(1),
  assumptions: z.array(z.string()),
  riskFlags: z.array(z.string()),
});

const implementationReportSchema = z.object({
  summary: z.string(),
  commitHash: z.string().regex(/^[0-9a-f]{40}$/),
  changedFiles: z.array(z.string()),
  verificationCommands: z.array(z.string()),
  verificationSummary: z.string(),
  concerns: z.array(z.string()),
});

const reviewFindingSchema = z.object({
  severity: z.enum(["info", "warning", "error"]),
  category: z.enum(["correctness", "tests", "security", "performance"]),
  title: z.string(),
  detail: z.string(),
  action: z.string(),
});

const reviewerReportSchema = z.object({
  reviewer: z.enum(["correctness", "tests", "security", "performance"]),
  status: z.enum(["approved", "changes_requested"]),
  summary: z.string(),
  findings: z.array(reviewFindingSchema),
});

const reviewLeadReportSchema = z.object({
  status: z.enum(["ready_for_recheck", "needs_targeted_follow_up"]),
  summary: z.string(),
  followUpReviewers: z.array(z.enum(["correctness", "tests", "security", "performance"])),
});

const recheckVerdictSchema = z.object({
  verdict: z.enum(["approve", "needs_fix", "invalidate_plan"]),
  summary: z.string(),
  acceptedFindings: z.array(reviewFindingSchema),
  rejectedFindings: z.array(z.string()),
  fixInstructions: z.array(z.string()),
});

const supervisorOutcomeSchema = z.object({
  status: z.enum(["done", "needs_more_work", "failed"]),
  summary: z.string(),
  candidateCommit: z.string().regex(/^[0-9a-f]{40}$/),
  nextAction: z.string(),
});

const defaultReviewerRoles: ReviewerReport["reviewer"][] = ["correctness", "tests"];
const planningHelperRoles = ["planning_spec", "planning_repo", "planning_risks"] as const;
const defaultPrimaryModel = "gpt-5.4";
const defaultHelperModel = "gpt-5.4-mini";

interface StructuredOutputSchema<T> {
  zod: z.ZodTypeAny;
  json: Record<string, unknown>;
}

const reviewFindingJsonSchema = {
  type: "object",
  properties: {
    severity: { type: "string", enum: ["info", "warning", "error"] },
    category: { type: "string", enum: ["correctness", "tests", "security", "performance"] },
    title: { type: "string" },
    detail: { type: "string" },
    action: { type: "string" },
  },
  required: ["severity", "category", "title", "detail", "action"],
  additionalProperties: false,
};

const supervisorStrategyOutputSchema: StructuredOutputSchema<SupervisorStrategy> = {
  zod: supervisorStrategySchema,
  json: {
    type: "object",
    properties: {
      summary: { type: "string" },
      reviewerRoles: {
        type: "array",
        items: { type: "string", enum: ["correctness", "tests", "security", "performance"] },
      },
      keyRisks: { type: "array", items: { type: "string" } },
      notesForUnderstander: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "reviewerRoles", "keyRisks", "notesForUnderstander"],
    additionalProperties: false,
  },
};

const planningViewOutputSchema: StructuredOutputSchema<PlanningView> = {
  zod: planningViewSchema,
  json: {
    type: "object",
    properties: {
      lens: { type: "string", enum: ["spec", "repo", "risks"] },
      summary: { type: "string" },
      keyPoints: { type: "array", items: { type: "string" } },
      suggestedFiles: { type: "array", items: { type: "string" } },
      suggestedReviewers: {
        type: "array",
        items: { type: "string", enum: ["correctness", "tests", "security", "performance"] },
      },
      verificationHints: { type: "array", items: { type: "string" } },
    },
    required: ["lens", "summary", "keyPoints", "suggestedFiles", "suggestedReviewers", "verificationHints"],
    additionalProperties: false,
  },
};

const understandingPacketOutputSchema: StructuredOutputSchema<UnderstandingPacket> = {
  zod: understandingPacketSchema,
  json: {
    type: "object",
    properties: {
      summary: { type: "string" },
      repoPath: { type: "string" },
      worktreePath: { type: "string" },
      featureBranch: { type: "string" },
      targetFiles: { type: "array", items: { type: "string" } },
      contextFiles: { type: "array", items: { type: "string" } },
      executionPlan: { type: "array", minItems: 1, items: { type: "string" } },
      verificationCommands: { type: "array", minItems: 1, items: { type: "string" } },
      assumptions: { type: "array", items: { type: "string" } },
      riskFlags: { type: "array", items: { type: "string" } },
    },
    required: [
      "summary",
      "repoPath",
      "worktreePath",
      "featureBranch",
      "targetFiles",
      "contextFiles",
      "executionPlan",
      "verificationCommands",
      "assumptions",
      "riskFlags",
    ],
    additionalProperties: false,
  },
};

const implementationReportOutputSchema: StructuredOutputSchema<ImplementationReport> = {
  zod: implementationReportSchema,
  json: {
    type: "object",
    properties: {
      summary: { type: "string" },
      commitHash: { type: "string", pattern: "^[0-9a-f]{40}$" },
      changedFiles: { type: "array", items: { type: "string" } },
      verificationCommands: { type: "array", items: { type: "string" } },
      verificationSummary: { type: "string" },
      concerns: { type: "array", items: { type: "string" } },
    },
    required: [
      "summary",
      "commitHash",
      "changedFiles",
      "verificationCommands",
      "verificationSummary",
      "concerns",
    ],
    additionalProperties: false,
  },
};

const reviewerReportOutputSchema: StructuredOutputSchema<ReviewerReport> = {
  zod: reviewerReportSchema,
  json: {
    type: "object",
    properties: {
      reviewer: { type: "string", enum: ["correctness", "tests", "security", "performance"] },
      status: { type: "string", enum: ["approved", "changes_requested"] },
      summary: { type: "string" },
      findings: {
        type: "array",
        items: reviewFindingJsonSchema,
      },
    },
    required: ["reviewer", "status", "summary", "findings"],
    additionalProperties: false,
  },
};

const reviewLeadReportOutputSchema: StructuredOutputSchema<ReviewLeadReport> = {
  zod: reviewLeadReportSchema,
  json: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["ready_for_recheck", "needs_targeted_follow_up"] },
      summary: { type: "string" },
      followUpReviewers: {
        type: "array",
        items: { type: "string", enum: ["correctness", "tests", "security", "performance"] },
      },
    },
    required: ["status", "summary", "followUpReviewers"],
    additionalProperties: false,
  },
};

const recheckVerdictOutputSchema: StructuredOutputSchema<RecheckVerdict> = {
  zod: recheckVerdictSchema,
  json: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["approve", "needs_fix", "invalidate_plan"] },
      summary: { type: "string" },
      acceptedFindings: {
        type: "array",
        items: reviewFindingJsonSchema,
      },
      rejectedFindings: { type: "array", items: { type: "string" } },
      fixInstructions: { type: "array", items: { type: "string" } },
    },
    required: ["verdict", "summary", "acceptedFindings", "rejectedFindings", "fixInstructions"],
    additionalProperties: false,
  },
};

const supervisorOutcomeOutputSchema: StructuredOutputSchema<SupervisorOutcome> = {
  zod: supervisorOutcomeSchema,
  json: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["done", "needs_more_work", "failed"] },
      summary: { type: "string" },
      candidateCommit: { type: "string", pattern: "^[0-9a-f]{40}$" },
      nextAction: { type: "string" },
    },
    required: ["status", "summary", "candidateCommit", "nextAction"],
    additionalProperties: false,
  },
};

function mergeReviewerRoles(
  ...groups: Array<ReadonlyArray<ReviewerReport["reviewer"]>>
): ReviewerReport["reviewer"][] {
  return [...new Set(groups.flat())];
}

function resolveModel(modelOverride: string | undefined, fallback: string): string {
  return modelOverride ?? fallback;
}

function planningHelperLens(role: typeof planningHelperRoles[number]): PlanningLens {
  switch (role) {
    case "planning_spec":
      return "spec";
    case "planning_repo":
      return "repo";
    case "planning_risks":
      return "risks";
  }
}

function planningHelperOptions(
  role: typeof planningHelperRoles[number],
  modelOverride: string | undefined,
  worktreePath: string,
  additionalDirectories: string[],
  escalated: boolean,
): RoleExecutionOptions {
  return {
    role,
    model: resolveModel(modelOverride, escalated ? defaultPrimaryModel : defaultHelperModel),
    workingDirectory: worktreePath,
    additionalDirectories,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    reasoningEffort: escalated ? "xhigh" : role === "planning_risks" ? "high" : "medium",
  };
}

function supervisorOptions(
  modelOverride: string | undefined,
  worktreePath: string,
  additionalDirectories: string[],
): RoleExecutionOptions {
  return {
    role: "supervisor",
    model: resolveModel(modelOverride, defaultPrimaryModel),
    workingDirectory: worktreePath,
    additionalDirectories,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    reasoningEffort: "xhigh",
  };
}

function understanderOptions(
  modelOverride: string | undefined,
  worktreePath: string,
  additionalDirectories: string[],
): RoleExecutionOptions {
  return {
    role: "understander",
    model: resolveModel(modelOverride, defaultPrimaryModel),
    workingDirectory: worktreePath,
    additionalDirectories,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    reasoningEffort: "xhigh",
  };
}

function implementerOptions(
  modelOverride: string | undefined,
  worktreePath: string,
  additionalDirectories: string[],
  escalated: boolean,
): RoleExecutionOptions {
  return {
    role: "implementer",
    model: resolveModel(modelOverride, escalated ? defaultPrimaryModel : defaultHelperModel),
    workingDirectory: worktreePath,
    additionalDirectories,
    forceFreshThread: escalated,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    reasoningEffort: escalated ? "xhigh" : "high",
  };
}

function reviewerRoleOptions(
  worktreePath: string,
  modelOverride: string | undefined,
  role: ReviewerReport["reviewer"],
  additionalDirectories: string[],
  escalated = false,
): RoleExecutionOptions {
  const roleMap: Record<ReviewerReport["reviewer"], RoleExecutionOptions["role"]> = {
    correctness: "reviewer_correctness",
    tests: "reviewer_tests",
    security: "reviewer_security",
    performance: "reviewer_performance",
  };
  return {
    role: roleMap[role],
    model: resolveModel(modelOverride, escalated ? defaultPrimaryModel : defaultHelperModel),
    workingDirectory: worktreePath,
    additionalDirectories,
    forceFreshThread: escalated,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    reasoningEffort: escalated ? "xhigh" : "high",
  };
}

function reviewLeadOptions(
  modelOverride: string | undefined,
  worktreePath: string,
  additionalDirectories: string[],
): RoleExecutionOptions {
  return {
    role: "review_lead",
    model: resolveModel(modelOverride, defaultPrimaryModel),
    workingDirectory: worktreePath,
    additionalDirectories,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    reasoningEffort: "xhigh",
  };
}

function recheckOptions(
  modelOverride: string | undefined,
  worktreePath: string,
  additionalDirectories: string[],
): RoleExecutionOptions {
  return {
    role: "recheck",
    model: resolveModel(modelOverride, defaultPrimaryModel),
    workingDirectory: worktreePath,
    additionalDirectories,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    reasoningEffort: "xhigh",
  };
}

interface ThreadLike {
  id: string | null;
  run(prompt: string, options?: { outputSchema?: Record<string, unknown> }): Promise<{
    finalResponse: string;
    items: unknown[];
    usage: {
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
    } | null;
  }>;
}

interface CodexLike {
  startThread(options?: CodexThreadConfig): ThreadLike;
  resumeThread(id: string, options?: CodexThreadConfig): ThreadLike;
}

export interface WorkflowDependencies {
  createCodex?: (paths: RuntimePaths, model: string) => CodexLike;
  validateImplementationCandidate?: (
    worktreePath: string,
    report: ImplementationReport,
  ) => Promise<ReviewFinding | null>;
  onProgress?: (event: WorkflowProgressEvent) => void | Promise<void>;
}

function createCodex(paths: RuntimePaths, model: string): CodexLike {
  const codexHome = path.join(paths.ralphRoot, "codex-home");
  return new Codex({
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
    } as Record<string, string>,
    config: {
      model,
      features: {
        codex_hooks: true,
        multi_agent: true,
      },
    },
  });
}

function roleThreadOptions(options: RoleExecutionOptions): CodexThreadConfig {
  return {
    model: options.model,
    modelReasoningEffort: options.reasoningEffort,
    workingDirectory: options.workingDirectory,
    ...(options.additionalDirectories ? { additionalDirectories: options.additionalDirectories } : {}),
    sandboxMode: options.sandboxMode,
    approvalPolicy: options.approvalPolicy,
    skipGitRepoCheck: false,
    networkAccessEnabled: false,
  };
}

function roleStateKey(role: RoleExecutionOptions["role"]): keyof RunState["threads"] {
  switch (role) {
    case "planning_spec":
      return "planningSpec";
    case "planning_repo":
      return "planningRepo";
    case "planning_risks":
      return "planningRisks";
    case "supervisor":
      return "supervisor";
    case "understander":
      return "understander";
    case "implementer":
      return "implementer";
    case "reviewer_correctness":
      return "reviewerCorrectness";
    case "reviewer_tests":
      return "reviewerTests";
    case "reviewer_security":
      return "reviewerSecurity";
    case "reviewer_performance":
      return "reviewerPerformance";
    case "review_lead":
      return "reviewLead";
    case "recheck":
      return "recheck";
  }
}

function rolePolicyFingerprint(options: RoleExecutionOptions): string {
  return JSON.stringify({
    role: options.role,
    model: options.model,
    workingDirectory: path.resolve(options.workingDirectory),
    additionalDirectories: [...(options.additionalDirectories ?? [])].map((dir) => path.resolve(dir)).sort(),
    sandboxMode: options.sandboxMode,
    approvalPolicy: options.approvalPolicy,
    reasoningEffort: options.reasoningEffort,
  });
}

async function runStructuredTurn<T>(
  codex: CodexLike,
  paths: RuntimePaths,
  spec: SpecDocument,
  state: RunState,
  runId: string,
  options: RoleExecutionOptions,
  schema: StructuredOutputSchema<T>,
  prompt: string,
): Promise<AgentRunArtifact<T>> {
  const threadKey = roleStateKey(options.role);
  const policyFingerprint = rolePolicyFingerprint(options);
  const persistedThreadId = options.forceFreshThread ? undefined : state.threads[threadKey];
  const persistedThreadPolicy = state.threadPolicies[threadKey];
  const existingThreadId =
    persistedThreadId && persistedThreadPolicy === policyFingerprint ? persistedThreadId : undefined;
  if (persistedThreadId && !existingThreadId) {
    state.threads[threadKey] = undefined;
    state.threadPolicies[threadKey] = undefined;
    state.updatedAt = new Date().toISOString();
    await saveRunState(paths, state);
  }
  const thread = existingThreadId
    ? codex.resumeThread(existingThreadId as string, roleThreadOptions(options))
    : codex.startThread(roleThreadOptions(options));
  const turn = await thread.run(prompt, { outputSchema: schema.json });
  const parsed = schema.zod.parse(JSON.parse(turn.finalResponse)) as T;
  if (thread.id === null) {
    console.warn(`[ralph] Thread id missing for role=${options.role}, spec=${spec.specId}; resume context may be lost.`);
    state.threads[threadKey] = undefined;
    state.threadPolicies[threadKey] = undefined;
  } else {
    state.threads[threadKey] = thread.id;
    state.threadPolicies[threadKey] = policyFingerprint;
  }
  state.updatedAt = new Date().toISOString();
  await saveRunState(paths, state);
  const artifact: AgentRunArtifact<T> = {
    role: options.role,
    turnId: `${options.role}:${runId}`,
    threadId: thread.id,
    output: parsed,
    usage: turn.usage
      ? {
          inputTokens: turn.usage.input_tokens,
          cachedInputTokens: turn.usage.cached_input_tokens,
          outputTokens: turn.usage.output_tokens,
        }
      : null,
    items: turn.items as unknown[],
    rawResponse: turn.finalResponse,
  };
  const artifactIteration = state.currentIteration > 0 ? state.currentIteration : "setup";
  await saveArtifact(paths, spec.specId, runId, `${options.role}-${artifactIteration}`, artifact);
  return artifact;
}

function implementationPromptFixes(findings: ReviewFinding[]): string[] {
  return findings.map((finding) => `${finding.category}: ${finding.action}`);
}

async function writeHumanArtifact(
  paths: RuntimePaths,
  specId: string,
  runId: string,
  filename: string,
  content: string,
): Promise<void> {
  const dir = path.join(paths.artifactsRoot, specId, runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), content, "utf8");
}

async function emitProgress(
  paths: RuntimePaths,
  spec: SpecDocument,
  runId: string,
  deps: WorkflowDependencies,
  event: Omit<WorkflowProgressEvent, "timestamp" | "runId" | "specId" | "specTitle">,
): Promise<void> {
  const progressEvent: WorkflowProgressEvent = {
    timestamp: new Date().toISOString(),
    runId,
    specId: spec.specId,
    specTitle: spec.title,
    ...event,
  };
  await appendRunEvent(paths, progressEvent);
  await deps.onProgress?.(progressEvent);
}

function clearRoleThread(state: RunState, role: RoleExecutionOptions["role"]): void {
  const threadKey = roleStateKey(role);
  state.threads[threadKey] = undefined;
  state.threadPolicies[threadKey] = undefined;
}

function clearPlanningThreads(state: RunState): void {
  clearRoleThread(state, "planning_spec");
  clearRoleThread(state, "planning_repo");
  clearRoleThread(state, "planning_risks");
}

function clearReviewThreads(state: RunState): void {
  clearRoleThread(state, "reviewer_correctness");
  clearRoleThread(state, "reviewer_tests");
  clearRoleThread(state, "reviewer_security");
  clearRoleThread(state, "reviewer_performance");
  clearRoleThread(state, "review_lead");
}

export async function executeSpec(
  paths: RuntimePaths,
  options: RalphRunOptions,
  spec: SpecDocument,
  deps: WorkflowDependencies = {},
): Promise<SupervisorOutcome> {
  await ensureCodexHome(paths);
  const repoPath = await resolveRepoPath(paths, spec);
  const legacyDone = await legacyDoneExists(paths.projectRoot, spec);
  let state = (await loadRunState(paths, spec.specId)) ?? initialRunState(spec, legacyDone);
  if (state.status === "done") {
    return {
      status: "done",
      summary: legacyDone
        ? `Legacy done marker detected for ${spec.specId}; skipping.`
        : `Spec ${spec.specId} already completed.`,
      candidateCommit: state.lastCommit,
      nextAction: "none",
    };
  }

  const runId = createRunId();
  state.runId = runId;
  state.updatedAt = new Date().toISOString();
  const worktreePath = await ensureSpecWorktree(paths, spec, repoPath);
  const additionalDirectories = await worktreeAdditionalDirectories(worktreePath);
  state.worktreePath = worktreePath;
  await saveRunState(paths, state);
  await emitProgress(paths, spec, runId, deps, {
    phase: "setup",
    summary: `worktree ready at ${worktreePath}`,
  });

  if (options.dryRun) {
    const dryOutcome: SupervisorOutcome = {
      status: "needs_more_work",
      summary: `Dry run prepared worktree at ${worktreePath}`,
      candidateCommit: undefined,
      nextAction: "Run without --dry-run to execute the workflow.",
    };
    await saveArtifact(paths, spec.specId, runId, "dry-run", { spec, worktreePath, repoPath });
    await emitProgress(paths, spec, runId, deps, {
      phase: "dry-run",
      summary: `prepared worktree at ${worktreePath}`,
    });
    return dryOutcome;
  }

  const codexFactory = deps.createCodex ?? createCodex;
  const implementationCandidateValidator = deps.validateImplementationCandidate ?? validateImplementationCandidate;
  const codex = codexFactory(paths, resolveModel(options.model, defaultPrimaryModel));

  let invalidationReason = state.invalidationReason;
  let acceptedFindings: ReviewFinding[] = [];
  let implementationReport: ImplementationReport | undefined;
  let understandingPacket: UnderstandingPacket | undefined;
  let recheckVerdict: RecheckVerdict | undefined;
  let planningViews: PlanningView[] = [];
  let supervisorStrategy: AgentRunArtifact<SupervisorStrategy> | undefined;
  let plannedReviewerRoles = [...defaultReviewerRoles];
  let shouldReplan = true;

  const runPlanningCycle = async (escalated: boolean): Promise<void> => {
    state.status = "planning";
    await saveRunState(paths, state);
    planningViews = [];

    for (const helperRole of planningHelperRoles) {
      await emitProgress(paths, spec, runId, deps, {
        phase: "planning",
        iteration: state.currentIteration,
        summary: `running ${helperRole} helper`,
      });
      const planningView = await runStructuredTurn(
        codex,
        paths,
        spec,
        state,
        runId,
        planningHelperOptions(helperRole, options.model, worktreePath, additionalDirectories, escalated),
        planningViewOutputSchema,
        buildPlanningHelperPrompt(spec, worktreePath, planningHelperLens(helperRole), invalidationReason),
      );
      if (planningView.output.lens !== planningHelperLens(helperRole)) {
        throw new Error(
          `Planning helper output mismatch for spec ${spec.specId}: expected ${planningHelperLens(helperRole)}, got ${planningView.output.lens}`,
        );
      }
      planningViews.push(planningView.output);
    }

    await emitProgress(paths, spec, runId, deps, {
      phase: "planning",
      iteration: state.currentIteration,
      summary: "running supervisor strategy",
    });
    supervisorStrategy = await runStructuredTurn(
      codex,
      paths,
      spec,
      state,
      runId,
      supervisorOptions(options.model, worktreePath, additionalDirectories),
      supervisorStrategyOutputSchema,
      buildSupervisorPrompt(spec, worktreePath, planningViews, invalidationReason),
    );
    plannedReviewerRoles = mergeReviewerRoles(defaultReviewerRoles, supervisorStrategy.output.reviewerRoles);
    if (state.invalidationReason) {
      state.invalidationReason = undefined;
      state.updatedAt = new Date().toISOString();
      await saveRunState(paths, state);
    }
    shouldReplan = false;
  };

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    state.currentIteration = iteration;
    const currentInvalidationReason = invalidationReason;
    if (shouldReplan) {
      await runPlanningCycle(currentInvalidationReason !== undefined);
    }
    if (!supervisorStrategy) {
      throw new Error(`Supervisor strategy missing for spec ${spec.specId}`);
    }

    state.status = "planning";
    await saveRunState(paths, state);
    await emitProgress(paths, spec, runId, deps, {
      phase: "planning",
      iteration,
      summary: "building understanding packet",
    });

    const understanding = await runStructuredTurn(
      codex,
      paths,
      spec,
      state,
      runId,
      understanderOptions(options.model, worktreePath, additionalDirectories),
      understandingPacketOutputSchema,
      buildUnderstanderPrompt(spec, worktreePath, supervisorStrategy.output, planningViews, currentInvalidationReason),
    );
    if (currentInvalidationReason !== undefined && state.invalidationReason === undefined) {
      invalidationReason = undefined;
    }
    understandingPacket = understanding.output;
    await writeHumanArtifact(
      paths,
      spec.specId,
      runId,
      `understanding-${iteration}.md`,
      [
        `# Understanding: ${spec.specId}`,
        "",
        understanding.output.summary,
        "",
        "Execution plan:",
        ...understanding.output.executionPlan.map((item, index) => `${index + 1}. ${item}`),
        "",
        "Verification commands:",
        ...understanding.output.verificationCommands.map((item) => `- ${item}`),
        "",
      ].join("\n"),
    );

    state.status = "implementing";
    await saveRunState(paths, state);
    await emitProgress(paths, spec, runId, deps, {
      phase: "implementing",
      iteration,
      summary: "running implementer",
    });
    const implementation = await runStructuredTurn(
      codex,
      paths,
      spec,
      state,
      runId,
      implementerOptions(options.model, worktreePath, additionalDirectories, iteration > 1),
      implementationReportOutputSchema,
      buildImplementerPrompt(spec, understanding.output, worktreePath, implementationPromptFixes(acceptedFindings), iteration > 1),
    );
    implementationReport = implementation.output;
    const implementationValidation = await implementationCandidateValidator(worktreePath, implementation.output);
    if (implementationValidation) {
      acceptedFindings = [...acceptedFindings, implementationValidation];
      state.lastCommit = undefined;
      state.lastError = implementationValidation.detail;
      state.status = "planning";
      await saveRunState(paths, state);
      await saveArtifact(paths, spec.specId, runId, `implementation-validation-${iteration}`, {
        report: implementation.output,
        finding: implementationValidation,
      });
      await emitProgress(paths, spec, runId, deps, {
        phase: "planning",
        iteration,
        summary: `candidate validation failed: ${implementationValidation.detail}`,
      });
      continue;
    }
    state.lastCommit = implementation.output.commitHash;
    await saveRunState(paths, state);
    await emitProgress(paths, spec, runId, deps, {
      phase: "implementing",
      iteration,
      summary: "candidate commit validated",
      candidateCommit: implementation.output.commitHash,
    });

    state.status = "reviewing";
    await saveRunState(paths, state);
    const reviewerOutputs: ReviewerReport[] = [];
    for (const reviewer of plannedReviewerRoles) {
      await emitProgress(paths, spec, runId, deps, {
        phase: "reviewing",
        iteration,
        reviewer,
        summary: `running ${reviewer} reviewer`,
      });
      const reviewerReport = await runStructuredTurn(
        codex,
        paths,
        spec,
        state,
        runId,
        reviewerRoleOptions(worktreePath, options.model, reviewer, additionalDirectories),
        reviewerReportOutputSchema,
        buildReviewerPrompt(reviewer, spec, understanding.output, implementation.output, worktreePath, false),
      );
      if (reviewerReport.output.reviewer !== reviewer) {
        throw new Error(
          `Reviewer output mismatch for spec ${spec.specId}: expected ${reviewer}, got ${reviewerReport.output.reviewer}`,
        );
      }
      reviewerOutputs.push(reviewerReport.output);
    }

    await emitProgress(paths, spec, runId, deps, {
      phase: "reviewing",
      iteration,
      summary: "running review lead",
    });
    let reviewLead = await runStructuredTurn(
      codex,
      paths,
      spec,
      state,
      runId,
      reviewLeadOptions(options.model, worktreePath, additionalDirectories),
      reviewLeadReportOutputSchema,
      buildReviewLeadPrompt(spec, understanding.output, implementation.output, reviewerOutputs, worktreePath, true),
    );
    const finalReviewerMap = new Map<ReviewerReport["reviewer"], ReviewerReport>(reviewerOutputs.map((report) => [report.reviewer, report]));

    if (reviewLead.output.status === "needs_targeted_follow_up") {
      const followUpReviewers = reviewLead.output.followUpReviewers.filter((reviewer) => plannedReviewerRoles.includes(reviewer));
      if (followUpReviewers.length === 0) {
        throw new Error(`Review lead requested follow-up without valid reviewer roles for spec ${spec.specId}`);
      }
      for (const reviewer of followUpReviewers) {
        await emitProgress(paths, spec, runId, deps, {
          phase: "reviewing",
          iteration,
          reviewer,
          summary: `rerunning ${reviewer} reviewer at escalated policy`,
        });
        const reviewerReport = await runStructuredTurn(
          codex,
          paths,
          spec,
          state,
          runId,
          reviewerRoleOptions(worktreePath, options.model, reviewer, additionalDirectories, true),
          reviewerReportOutputSchema,
          buildReviewerPrompt(reviewer, spec, understanding.output, implementation.output, worktreePath, true),
        );
        if (reviewerReport.output.reviewer !== reviewer) {
          throw new Error(
            `Reviewer output mismatch for spec ${spec.specId}: expected ${reviewer}, got ${reviewerReport.output.reviewer}`,
          );
        }
        finalReviewerMap.set(reviewer, reviewerReport.output);
      }
      await emitProgress(paths, spec, runId, deps, {
        phase: "reviewing",
        iteration,
        summary: "rerunning review lead after targeted follow-up",
      });
      reviewLead = await runStructuredTurn(
        codex,
        paths,
        spec,
        state,
        runId,
        reviewLeadOptions(options.model, worktreePath, additionalDirectories),
        reviewLeadReportOutputSchema,
        buildReviewLeadPrompt(
          spec,
          understanding.output,
          implementation.output,
          [...finalReviewerMap.values()],
          worktreePath,
          false,
        ),
      );
      if (reviewLead.output.status !== "ready_for_recheck") {
        throw new Error(`Review lead requested more than one targeted follow-up round for spec ${spec.specId}`);
      }
    }

    const finalReviewerOutputs = plannedReviewerRoles.map((reviewer) => {
      const review = finalReviewerMap.get(reviewer);
      if (!review) {
        throw new Error(`Missing review report for ${reviewer} in spec ${spec.specId}`);
      }
      return review;
    });

    state.status = "rechecking";
    await saveRunState(paths, state);
    await emitProgress(paths, spec, runId, deps, {
      phase: "rechecking",
      iteration,
      summary: "running recheck verdict",
    });
    const recheck = await runStructuredTurn(
      codex,
      paths,
      spec,
      state,
      runId,
      recheckOptions(options.model, worktreePath, additionalDirectories),
      recheckVerdictOutputSchema,
      buildRecheckPrompt(
        spec,
        understanding.output,
        implementation.output,
        finalReviewerOutputs,
        reviewLead.output.summary,
        worktreePath,
      ),
    );
    recheckVerdict = recheck.output;
    acceptedFindings = recheck.output.acceptedFindings;

    if (recheck.output.verdict === "approve") {
      break;
    }
    if (recheck.output.verdict === "invalidate_plan") {
      invalidationReason = recheck.output.summary;
      state.invalidationReason = recheck.output.summary;
      acceptedFindings = [];
      clearPlanningThreads(state);
      clearRoleThread(state, "supervisor");
      clearRoleThread(state, "understander");
      clearRoleThread(state, "implementer");
      clearReviewThreads(state);
      clearRoleThread(state, "recheck");
      shouldReplan = true;
      state.updatedAt = new Date().toISOString();
      await saveRunState(paths, state);
      await emitProgress(paths, spec, runId, deps, {
        phase: "planning",
        iteration,
        summary: `plan invalidated: ${recheck.output.summary}`,
      });
      continue;
    }
    await emitProgress(paths, spec, runId, deps, {
      phase: "planning",
      iteration,
      summary: `continuing with fixes: ${recheck.output.summary}`,
    });
  }

  if (!understandingPacket || !implementationReport || !recheckVerdict) {
    const failed: SupervisorOutcome = {
      status: "failed",
      summary: `Spec ${spec.specId} failed before producing complete artifacts.`,
      candidateCommit: undefined,
      nextAction: "Inspect .ralph artifacts and rerun.",
    };
    if (state.lastError) {
      failed.summary = state.lastError;
    }
    state.status = "failed";
    state.lastError = failed.summary;
    await saveRunState(paths, state);
    await emitProgress(
      paths,
      spec,
      runId,
      deps,
      state.currentIteration > 0
        ? {
            phase: "failed",
            iteration: state.currentIteration,
            summary: failed.summary,
          }
        : {
            phase: "failed",
            summary: failed.summary,
          },
    );
    return failed;
  }

  if (recheckVerdict.verdict !== "approve") {
    state.status = "failed";
    state.lastError = recheckVerdict.summary;
    await saveRunState(paths, state);
    await emitProgress(paths, spec, runId, deps, {
      phase: "failed",
      iteration: state.currentIteration,
      summary: recheckVerdict.summary,
      candidateCommit: implementationReport.commitHash,
    });
    return {
      status: "failed",
      summary: recheckVerdict.summary,
      candidateCommit: implementationReport.commitHash,
      nextAction: "Rerun after inspecting accepted findings.",
    };
  }

  await emitProgress(paths, spec, runId, deps, {
    phase: "rechecking",
    iteration: state.currentIteration,
    summary: "running supervisor final decision",
    candidateCommit: implementationReport.commitHash,
  });
  const supervisorFinal = await runStructuredTurn(
    codex,
    paths,
    spec,
    state,
    runId,
    supervisorOptions(options.model, worktreePath, additionalDirectories),
    supervisorOutcomeOutputSchema,
    buildSupervisorFinalPrompt(spec, understandingPacket, implementationReport, recheckVerdict),
  );

  if (supervisorFinal.output.status !== "done") {
    state.status = "failed";
    state.lastError = supervisorFinal.output.summary;
    await saveRunState(paths, state);
    await emitProgress(paths, spec, runId, deps, {
      phase: "failed",
      iteration: state.currentIteration,
      summary: supervisorFinal.output.summary,
      candidateCommit: implementationReport.commitHash,
    });
    return {
      status: "failed",
      summary: supervisorFinal.output.summary,
      candidateCommit: implementationReport.commitHash,
      nextAction: supervisorFinal.output.nextAction,
    };
  }

  await saveDoneReport(paths, spec, supervisorFinal.output.summary, implementationReport.commitHash);
  state.status = "done";
  state.lastCommit = implementationReport.commitHash;
  await saveRunState(paths, state);
  await emitProgress(paths, spec, runId, deps, {
    phase: "done",
    iteration: state.currentIteration,
    summary: supervisorFinal.output.summary,
    candidateCommit: implementationReport.commitHash,
  });
  return {
    status: "done",
    summary: supervisorFinal.output.summary,
    candidateCommit: implementationReport.commitHash,
    nextAction: supervisorFinal.output.nextAction,
  };
}
