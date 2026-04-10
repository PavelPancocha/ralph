import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { Codex } from "@openai/codex-sdk";

import type {
  AgentRunArtifact,
  CheckoutMode,
  CodexThreadConfig,
  ImplementationReport,
  PlanningLens,
  PlanningView,
  PublicationResult,
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
  VerificationRun,
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
  checkoutAdditionalDirectories,
  createRunId,
  ensureCodexHome,
  ensureSpecWorktree,
  gitRefExists,
  initialRunState,
  legacyDoneExists,
  loadRunState,
  peekRunState,
  resolveRepoPath,
  listCandidateChangedFiles,
  readArtifactJson,
  saveArtifact,
  saveDoneReport,
  saveRunState,
  runVerificationCommands,
  publishApprovedSpec,
  prepareRootCheckout,
  validateImplementationCandidate,
} from "./runtime.js";
import { discoverSpecPaths, parseSpecFile } from "./specs.js";

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
  checkoutMode: z.enum(["worktree", "root"]).default("worktree"),
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
      checkoutMode: { type: "string", enum: ["worktree", "root"] },
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
      "checkoutMode",
      "targetFiles",
      "contextFiles",
      "executionPlan",
      "verificationCommands",
      "assumptions",
      "riskFlags",
      "featureBranch",
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

function resolveCheckoutMode(checkoutMode: CheckoutMode | undefined): CheckoutMode {
  return checkoutMode ?? "worktree";
}

function commandsNeedDockerSocket(commands: string[]): boolean {
  return commands.some((command) => /\bdocker(?:\s+compose)?\b/i.test(command));
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
  checkoutMode: CheckoutMode,
): RoleExecutionOptions {
  return {
    role,
    model: resolveModel(modelOverride, escalated ? defaultPrimaryModel : defaultHelperModel),
    workingDirectory: worktreePath,
    additionalDirectories,
    checkoutMode,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    reasoningEffort: escalated ? "xhigh" : role === "planning_risks" ? "high" : "medium",
  };
}

function supervisorOptions(
  modelOverride: string | undefined,
  worktreePath: string,
  additionalDirectories: string[],
  checkoutMode: CheckoutMode,
): RoleExecutionOptions {
  return {
    role: "supervisor",
    model: resolveModel(modelOverride, defaultPrimaryModel),
    workingDirectory: worktreePath,
    additionalDirectories,
    checkoutMode,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    reasoningEffort: "xhigh",
  };
}

function understanderOptions(
  modelOverride: string | undefined,
  worktreePath: string,
  additionalDirectories: string[],
  checkoutMode: CheckoutMode,
): RoleExecutionOptions {
  return {
    role: "understander",
    model: resolveModel(modelOverride, defaultPrimaryModel),
    workingDirectory: worktreePath,
    additionalDirectories,
    checkoutMode,
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
  checkoutMode: CheckoutMode,
): RoleExecutionOptions {
  return {
    role: "implementer",
    model: resolveModel(modelOverride, escalated ? defaultPrimaryModel : defaultHelperModel),
    workingDirectory: worktreePath,
    additionalDirectories,
    checkoutMode,
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
  checkoutMode: CheckoutMode,
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
    checkoutMode,
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
  checkoutMode: CheckoutMode,
): RoleExecutionOptions {
  return {
    role: "review_lead",
    model: resolveModel(modelOverride, defaultPrimaryModel),
    workingDirectory: worktreePath,
    additionalDirectories,
    checkoutMode,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    reasoningEffort: "xhigh",
  };
}

function recheckOptions(
  modelOverride: string | undefined,
  worktreePath: string,
  additionalDirectories: string[],
  checkoutMode: CheckoutMode,
): RoleExecutionOptions {
  return {
    role: "recheck",
    model: resolveModel(modelOverride, defaultPrimaryModel),
    workingDirectory: worktreePath,
    additionalDirectories,
    checkoutMode,
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
    baseRef?: string,
  ) => Promise<ReviewFinding | null>;
  runVerificationCommands?: (
    repoPath: string,
    featureBranch: string,
    commands: string[],
  ) => Promise<VerificationRun>;
  publishApprovedSpec?: (
    repoPath: string,
    spec: SpecDocument,
    summary: string,
    candidateCommit: string,
  ) => Promise<PublicationResult>;
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
    checkoutMode: resolveCheckoutMode(options.checkoutMode),
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
  const thread = existingThreadId
    ? codex.resumeThread(existingThreadId as string, roleThreadOptions(options))
    : codex.startThread(roleThreadOptions(options));
  const turn = await thread.run(prompt, { outputSchema: schema.json });
  const parsed = schema.zod.parse(JSON.parse(turn.finalResponse)) as T;
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
  if (thread.id === null) {
    console.warn(`[ralph] Thread id missing for role=${options.role}, spec=${spec.specId}; resume context may be lost.`);
    state.threads[threadKey] = undefined;
    state.threadPolicies[threadKey] = undefined;
  } else {
    state.threads[threadKey] = thread.id;
    state.threadPolicies[threadKey] = policyFingerprint;
  }
  state.runId = runId;
  state.updatedAt = new Date().toISOString();
  await saveRunState(paths, state);
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
  persist = true,
): Promise<void> {
  const progressEvent: WorkflowProgressEvent = {
    timestamp: new Date().toISOString(),
    runId,
    specId: spec.specId,
    specTitle: spec.title,
    ...event,
  };
  if (persist) {
    await appendRunEvent(paths, progressEvent);
  }
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

type ResumeStage = "planning" | "implementing" | "reviewing" | "rechecking" | "supervisor_final";

interface ResumeCheckpoint {
  stage: ResumeStage;
  seedIteration: number;
  startIteration: number;
  planningViews?: PlanningView[];
  supervisorStrategy?: AgentRunArtifact<SupervisorStrategy>;
  understanding?: AgentRunArtifact<UnderstandingPacket>;
  implementation?: AgentRunArtifact<ImplementationReport>;
  reviewerOutputs?: ReviewerReport[];
  reviewLead?: AgentRunArtifact<ReviewLeadReport>;
  verificationRun?: VerificationRun;
  recheckVerdict?: AgentRunArtifact<RecheckVerdict>;
  acceptedFindings: ReviewFinding[];
  invalidationReason?: string;
}

async function loadAgentArtifact<T>(
  paths: RuntimePaths,
  specId: string,
  runId: string,
  name: string,
): Promise<AgentRunArtifact<T> | null> {
  return readArtifactJson<AgentRunArtifact<T>>(paths, specId, runId, name);
}

async function loadPlanningCheckpointArtifacts(
  paths: RuntimePaths,
  specId: string,
  runId: string,
  seedIteration: number,
): Promise<{
  planningViews?: PlanningView[];
  supervisorStrategy?: AgentRunArtifact<SupervisorStrategy>;
}> {
  const [planningSpec, planningRepo, planningRisks, supervisorStrategy] = await Promise.all([
    loadAgentArtifact<PlanningView>(paths, specId, runId, `planning_spec-${seedIteration}`),
    loadAgentArtifact<PlanningView>(paths, specId, runId, `planning_repo-${seedIteration}`),
    loadAgentArtifact<PlanningView>(paths, specId, runId, `planning_risks-${seedIteration}`),
    loadAgentArtifact<SupervisorStrategy>(paths, specId, runId, `supervisor-${seedIteration}`),
  ]);
  const planningArtifacts = [planningSpec, planningRepo, planningRisks];
  const planningViews = planningArtifacts.every((artifact) => artifact !== null)
    ? planningArtifacts.map((artifact) => artifact.output)
    : undefined;
  return {
    ...(planningViews ? { planningViews } : {}),
    ...(supervisorStrategy ? { supervisorStrategy } : {}),
  };
}

async function inferResumeCheckpoint(paths: RuntimePaths, spec: SpecDocument, state: RunState): Promise<ResumeCheckpoint | null> {
  if (!state.runId) {
    return null;
  }

  const runId = state.runId;
  const seedIteration = state.currentIteration > 0 ? state.currentIteration : 1;
  const planningCheckpoint = await loadPlanningCheckpointArtifacts(paths, spec.specId, runId, seedIteration);
  const understanding = await loadAgentArtifact<UnderstandingPacket>(paths, spec.specId, runId, `understander-${seedIteration}`);
  const implementation = await loadAgentArtifact<ImplementationReport>(paths, spec.specId, runId, `implementer-${seedIteration}`);
  const reviewLead = await loadAgentArtifact<ReviewLeadReport>(paths, spec.specId, runId, `review_lead-${seedIteration}`);
  const verificationRun = await readArtifactJson<VerificationRun>(paths, spec.specId, runId, `verification-${seedIteration}`);
  const recheckVerdict = await loadAgentArtifact<RecheckVerdict>(paths, spec.specId, runId, `recheck-${seedIteration}`);
  const reviewerOutputs = (
    await Promise.all(
      defaultReviewerRoles.map(async (reviewer) => {
        const loaded = await loadAgentArtifact<ReviewerReport>(paths, spec.specId, runId, `reviewer_${reviewer}-${seedIteration}`);
        return loaded?.output;
      }),
    )
  ).filter((item): item is ReviewerReport => item !== undefined);

  if (state.status === "failed" && recheckVerdict?.output.verdict === "needs_fix") {
    return {
      stage: "implementing",
      seedIteration,
      startIteration: seedIteration + 1,
      ...planningCheckpoint,
      ...(understanding ? { understanding } : {}),
      acceptedFindings: recheckVerdict.output.acceptedFindings,
    };
  }

  if (state.status === "failed" && recheckVerdict?.output.verdict === "invalidate_plan") {
    return {
      stage: "planning",
      seedIteration,
      startIteration: seedIteration + 1,
      ...(understanding ? { understanding } : {}),
      acceptedFindings: [],
      invalidationReason: recheckVerdict.output.summary,
    };
  }

  if (recheckVerdict && recheckVerdict.output.verdict === "approve") {
    return {
      stage: "supervisor_final",
      seedIteration,
      startIteration: seedIteration,
      ...planningCheckpoint,
      ...(understanding ? { understanding } : {}),
      ...(implementation ? { implementation } : {}),
      reviewerOutputs,
      ...(reviewLead ? { reviewLead } : {}),
      ...(verificationRun ? { verificationRun } : {}),
      recheckVerdict,
      acceptedFindings: recheckVerdict.output.acceptedFindings,
    };
  }

  if (reviewLead || reviewerOutputs.length > 0) {
    return {
      stage: "rechecking",
      seedIteration,
      startIteration: seedIteration,
      ...planningCheckpoint,
      ...(understanding ? { understanding } : {}),
      ...(implementation ? { implementation } : {}),
      reviewerOutputs,
      ...(reviewLead ? { reviewLead } : {}),
      ...(verificationRun ? { verificationRun } : {}),
      acceptedFindings: [],
    };
  }

  if (implementation) {
    return {
      stage: "reviewing",
      seedIteration,
      startIteration: seedIteration,
      ...planningCheckpoint,
      ...(understanding ? { understanding } : {}),
      ...(implementation ? { implementation } : {}),
      reviewerOutputs: [],
      acceptedFindings: [],
    };
  }

  if (understanding) {
    return {
      stage: "implementing",
      seedIteration,
      startIteration: seedIteration,
      ...planningCheckpoint,
      understanding,
      acceptedFindings: [],
    };
  }

  return {
    stage: "planning",
    seedIteration,
    startIteration: seedIteration,
    acceptedFindings: [],
  };
}

function formatResumeCheckpointMessage(resumeCheckpoint: ResumeCheckpoint | null): string {
  if (!resumeCheckpoint) {
    return "[resume] no reusable checkpoint found — starting from scratch";
  }
  const planningNote = resumeCheckpoint.stage === "planning" ? " (planning will rerun)" : "";
  return `[resume] checkpoint: stage=${resumeCheckpoint.stage} iteration=${resumeCheckpoint.startIteration}${planningNote}`;
}

interface DryRunOutcome {
  outcome: SupervisorOutcome;
  phase: WorkflowProgressEvent["phase"];
  artifact: Record<string, unknown>;
}

async function analyzeDryRunSourceBranch(
  paths: RuntimePaths,
  spec: SpecDocument,
  repoPath: string,
): Promise<DryRunOutcome | null> {
  if (await gitRefExists(repoPath, `refs/heads/${spec.branchInstructions.createBranch}`)) {
    return null;
  }

  if (await gitRefExists(repoPath, spec.branchInstructions.sourceBranch)) {
    return null;
  }

  const specPaths = await discoverSpecPaths(paths.specRoot);
  const parsedSpecs = await Promise.all(
    specPaths.map((relFromSpecs) => parseSpecFile(paths.projectRoot, paths.workspaceRoot, relFromSpecs, paths.specRoot)),
  );
  const currentIndex = parsedSpecs.findIndex((candidate) => candidate.relFromSpecs === spec.relFromSpecs);
  const sourceProducer = parsedSpecs.find(
    (candidate) =>
      candidate.relFromSpecs !== spec.relFromSpecs
      && candidate.branchInstructions.createBranch === spec.branchInstructions.sourceBranch,
  );

  if (!sourceProducer) {
    return {
      phase: "failed",
      outcome: {
        status: "failed",
        summary: `Dry run found missing source branch ${spec.branchInstructions.sourceBranch}: it is not a Git ref in ${repoPath}, and no spec in this project creates it.`,
        candidateCommit: undefined,
        nextAction: "Create or rename the external base branch, or fix the spec's Branch Instructions.",
      },
      artifact: {
        classification: "missing-external-root-branch",
        sourceBranch: spec.branchInstructions.sourceBranch,
        createBranch: spec.branchInstructions.createBranch,
        repoPath,
        spec: spec.relFromSpecs,
      },
    };
  }

  const sourceProducerIndex = parsedSpecs.findIndex((candidate) => candidate.relFromSpecs === sourceProducer.relFromSpecs);
  if (sourceProducerIndex !== -1 && currentIndex !== -1 && sourceProducerIndex < currentIndex) {
    return {
      phase: "dry-run",
      outcome: {
        status: "needs_more_work",
        summary: `Dry run skipped worktree setup: source branch ${spec.branchInstructions.sourceBranch} should be created earlier by ${sourceProducer.specId}, so it does not exist yet in a clean dry-run traversal.`,
        candidateCommit: undefined,
        nextAction: `Run the stack normally or materialize ${sourceProducer.branchInstructions.createBranch} before rerunning ${spec.specId}.`,
      },
      artifact: {
        classification: "expected-earlier-parent-spec",
        sourceBranch: spec.branchInstructions.sourceBranch,
        createBranch: spec.branchInstructions.createBranch,
        producerSpecId: sourceProducer.specId,
        producerSpecPath: sourceProducer.relFromSpecs,
        repoPath,
        spec: spec.relFromSpecs,
      },
    };
  }

  return {
    phase: "failed",
    outcome: {
      status: "failed",
      summary: `Dry run found invalid branch wiring: source branch ${spec.branchInstructions.sourceBranch} is created by later spec ${sourceProducer.specId}, but Ralph executes specs in ascending order.`,
      candidateCommit: undefined,
      nextAction: `Fix the spec graph so ${spec.specId} starts from an earlier branch or renumber the stack.`,
    },
    artifact: {
      classification: "future-parent-spec",
      sourceBranch: spec.branchInstructions.sourceBranch,
      createBranch: spec.branchInstructions.createBranch,
      producerSpecId: sourceProducer.specId,
      producerSpecPath: sourceProducer.relFromSpecs,
      repoPath,
      spec: spec.relFromSpecs,
    },
  };
}

async function failWorkflowState(paths: RuntimePaths, state: RunState, message: string): Promise<never> {
  state.status = "failed";
  state.lastError = message;
  await saveRunState(paths, state);
  throw new Error(message);
}

async function normalizeImplementationChangedFiles(
  worktreePath: string,
  report: ImplementationReport,
  baseRef?: string,
): Promise<ImplementationReport> {
  try {
    const changedFiles = await listCandidateChangedFiles(worktreePath, report.commitHash, baseRef);
    return {
      ...report,
      changedFiles,
    };
  } catch {
    return report;
  }
}

export async function executeSpec(
  paths: RuntimePaths,
  options: RalphRunOptions,
  spec: SpecDocument,
  deps: WorkflowDependencies = {},
): Promise<SupervisorOutcome> {
  const repoPath = await resolveRepoPath(paths, spec);
  const legacyDone = await legacyDoneExists(paths.specRoot, spec);
  let state = ((options.dryRun ? await peekRunState(paths, spec.specId) : await loadRunState(paths, spec.specId)))
    ?? initialRunState(spec, legacyDone);
  const checkoutMode = resolveCheckoutMode(options.checkoutMode);
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

  const resumeCheckpoint = options.resume ? await inferResumeCheckpoint(paths, spec, state) : null;
  if (options.resume) {
    console.log(formatResumeCheckpointMessage(resumeCheckpoint));
  }
  const runId = createRunId();
  state.updatedAt = new Date().toISOString();
  const restartFailureContext = state.invalidationReason ?? state.lastError;
  const allowDirtyRootCheckout = checkoutMode === "root" && options.resume === true && resumeCheckpoint !== null;

  if (options.dryRun) {
    const dryRunSourceOutcome = await analyzeDryRunSourceBranch(paths, spec, repoPath);
    if (dryRunSourceOutcome) {
      await emitProgress(paths, spec, runId, deps, {
        phase: dryRunSourceOutcome.phase,
        summary: dryRunSourceOutcome.outcome.summary,
      }, false);
      return dryRunSourceOutcome.outcome;
    }
    const plannedCheckoutPath = checkoutMode === "root" ? repoPath : path.join(paths.worktreesRoot, spec.specId);
    const plannedCheckoutLabel = checkoutMode === "root" ? "root checkout" : "worktree";
    const dryOutcome: SupervisorOutcome = {
      status: "needs_more_work",
      summary: `Dry run would use ${plannedCheckoutLabel} at ${plannedCheckoutPath} for branch ${spec.branchInstructions.createBranch}.`,
      candidateCommit: undefined,
      nextAction: "Run without --dry-run to execute the workflow.",
    };
    await emitProgress(paths, spec, runId, deps, {
      phase: "dry-run",
      summary: `would use ${plannedCheckoutLabel} at ${plannedCheckoutPath}`,
    }, false);
    return dryOutcome;
  }

  // If this spec already failed once, treat the prior failure message as the
  // next run's restart context so reruns pick up from the last error rather
  // than re-planning from a blank slate.
  if (!state.invalidationReason && restartFailureContext) {
    state.invalidationReason = restartFailureContext;
    await saveRunState(paths, state);
  }

  await ensureCodexHome(paths);
  await saveRunState(paths, state);

  const worktreePath = checkoutMode === "root"
    ? await prepareRootCheckout(paths, spec, repoPath, { allowDirty: allowDirtyRootCheckout })
    : await ensureSpecWorktree(paths, spec, repoPath);
  const additionalDirectories = await checkoutAdditionalDirectories(worktreePath);
  state.checkoutMode = checkoutMode;
  state.worktreePath = worktreePath;
  await saveRunState(paths, state);
  await emitProgress(paths, spec, runId, deps, {
    phase: "setup",
    summary: `${checkoutMode === "root" ? "checkout" : "worktree"} ready at ${worktreePath}`,
  });

  const codexFactory = deps.createCodex ?? createCodex;
  const implementationCandidateValidator = deps.validateImplementationCandidate ?? validateImplementationCandidate;
  const approvedSpecPublisher = deps.publishApprovedSpec ?? publishApprovedSpec;
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
  let verificationRun: VerificationRun | undefined;
  const retryingFromFailure = restartFailureContext !== undefined;

  const finalizeApprovedSpec = async (
    iteration: number,
    summary: string,
    candidateCommit: string,
    nextAction: string,
  ): Promise<SupervisorOutcome> => {
    await emitProgress(paths, spec, runId, deps, {
      phase: "publishing",
      iteration,
      summary: "pushing branch and updating pull request",
      candidateCommit,
    });
    try {
      await approvedSpecPublisher(repoPath, spec, summary, candidateCommit);
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      state.status = "failed";
      state.lastError = `Publication failed for spec ${spec.specId}: ${message}`;
      state.lastCommit = candidateCommit;
      await saveRunState(paths, state);
      await emitProgress(paths, spec, runId, deps, {
        phase: "failed",
        iteration,
        summary: state.lastError,
        candidateCommit,
      });
      return {
        status: "failed",
        summary: state.lastError,
        candidateCommit,
        nextAction: "Inspect git push / GitHub PR access and rerun with --resume.",
      };
    }

    await saveDoneReport(paths, spec, summary, candidateCommit);
    state.status = "done";
    state.lastCommit = candidateCommit;
    state.lastError = undefined;
    state.invalidationReason = undefined;
    await saveRunState(paths, state);
    await emitProgress(paths, spec, runId, deps, {
      phase: "done",
      iteration,
      summary,
      candidateCommit,
    });
    return {
      status: "done",
      summary,
      candidateCommit,
      nextAction,
    };
  };

  const failSupervisorFinal = async (
    iteration: number,
    summary: string,
    candidateCommit: string,
    nextAction: string,
  ): Promise<SupervisorOutcome> => {
    state.status = "failed";
    state.lastError = summary;
    await saveRunState(paths, state);
    await emitProgress(paths, spec, runId, deps, {
      phase: "failed",
      iteration: state.currentIteration,
      summary,
      candidateCommit,
    });
    return {
      status: "failed",
      summary,
      candidateCommit,
      nextAction,
    };
  };

  const runSupervisorFinalDecision = async (
    iteration: number,
    currentUnderstanding: UnderstandingPacket,
    currentImplementation: ImplementationReport,
    currentRecheckVerdict: RecheckVerdict,
  ): Promise<SupervisorOutcome> => {
    await emitProgress(paths, spec, runId, deps, {
      phase: "rechecking",
      iteration,
      summary: "running supervisor final decision",
      candidateCommit: currentImplementation.commitHash,
    });
    const supervisorFinal = await runStructuredTurn(
      codex,
      paths,
      spec,
      state,
      runId,
      supervisorOptions(options.model, worktreePath, additionalDirectories, checkoutMode),
      supervisorOutcomeOutputSchema,
      buildSupervisorFinalPrompt(spec, currentUnderstanding, currentImplementation, currentRecheckVerdict),
    );

    if (supervisorFinal.output.status !== "done") {
      return failSupervisorFinal(
        iteration,
        supervisorFinal.output.summary,
        currentImplementation.commitHash,
        supervisorFinal.output.nextAction,
      );
    }

    return finalizeApprovedSpec(
      iteration,
      supervisorFinal.output.summary,
      currentImplementation.commitHash,
      supervisorFinal.output.nextAction,
    );
  };

  const handleImplementationValidationFailure = async (
    iteration: number,
    currentImplementation: ImplementationReport,
    validationFinding: ReviewFinding,
  ): Promise<void> => {
    acceptedFindings = [...acceptedFindings, validationFinding];
    state.lastCommit = undefined;
    state.lastError = validationFinding.detail;
    state.status = "planning";
    shouldReplan = supervisorStrategy === undefined;
    await saveRunState(paths, state);
    await saveArtifact(paths, spec.specId, runId, `implementation-validation-${iteration}`, {
      report: currentImplementation,
      finding: validationFinding,
    });
    await emitProgress(paths, spec, runId, deps, {
      phase: "planning",
      iteration,
      summary: `candidate validation failed: ${validationFinding.detail}`,
    });
  };

  const runImplementationPass = async (
    iteration: number,
    currentUnderstanding: UnderstandingPacket,
    escalated: boolean,
  ): Promise<ImplementationReport | null> => {
    const implementationAdditionalDirectories =
      checkoutMode === "root" && commandsNeedDockerSocket(currentUnderstanding.verificationCommands)
        ? [...new Set([...additionalDirectories, "/var/run"])]
        : additionalDirectories;
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
      implementerOptions(options.model, worktreePath, implementationAdditionalDirectories, escalated, checkoutMode),
      implementationReportOutputSchema,
      buildImplementerPrompt(
        spec,
        currentUnderstanding,
        worktreePath,
        implementationPromptFixes(acceptedFindings),
        escalated,
      ),
    );
    const normalizedImplementation = await normalizeImplementationChangedFiles(
      worktreePath,
      implementation.output,
      spec.branchInstructions.sourceBranch,
    );
    implementation.output.changedFiles = normalizedImplementation.changedFiles;
    const implementationValidation = await implementationCandidateValidator(
      worktreePath,
      normalizedImplementation,
      spec.branchInstructions.sourceBranch,
    );
    if (implementationValidation) {
      await handleImplementationValidationFailure(iteration, normalizedImplementation, implementationValidation);
      return null;
    }
    state.lastCommit = normalizedImplementation.commitHash;
    await saveRunState(paths, state);
    await emitProgress(paths, spec, runId, deps, {
      phase: "implementing",
      iteration,
      summary: "candidate commit validated",
      candidateCommit: normalizedImplementation.commitHash,
    });
    return normalizedImplementation;
  };

  if (resumeCheckpoint) {
    invalidationReason = resumeCheckpoint.invalidationReason ?? invalidationReason;
    acceptedFindings = [...resumeCheckpoint.acceptedFindings];
    planningViews = [...(resumeCheckpoint.planningViews ?? [])];
    supervisorStrategy = resumeCheckpoint.supervisorStrategy;
    understandingPacket = resumeCheckpoint.understanding?.output;
    implementationReport = resumeCheckpoint.implementation?.output;
    recheckVerdict = resumeCheckpoint.recheckVerdict?.output;
    const resumeReviewerOutputs = resumeCheckpoint.reviewerOutputs ?? [];
    if (resumeReviewerOutputs.length > 0) {
      plannedReviewerRoles = mergeReviewerRoles(
        defaultReviewerRoles,
        resumeReviewerOutputs.map((report) => report.reviewer),
      );
    }
    if (resumeCheckpoint.verificationRun) {
      verificationRun = resumeCheckpoint.verificationRun;
    }
    shouldReplan = resumeCheckpoint.stage === "planning";
  }

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
        planningHelperOptions(helperRole, options.model, worktreePath, additionalDirectories, escalated, checkoutMode),
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
      supervisorOptions(options.model, worktreePath, additionalDirectories, checkoutMode),
      supervisorStrategyOutputSchema,
      buildSupervisorPrompt(spec, worktreePath, planningViews, invalidationReason),
    );
    plannedReviewerRoles = mergeReviewerRoles(defaultReviewerRoles, supervisorStrategy.output.reviewerRoles);
    shouldReplan = false;
  };

  const runReviewApprovalCycle = async (
    iteration: number,
    currentUnderstanding: UnderstandingPacket,
    currentImplementation: ImplementationReport,
    checkpoint: ResumeCheckpoint | null,
  ): Promise<SupervisorOutcome | "continue"> => {
    const reviewAdditionalDirectories =
      checkoutMode === "root" && commandsNeedDockerSocket(currentUnderstanding.verificationCommands)
        ? [...new Set([...additionalDirectories, "/var/run"])]
        : additionalDirectories;
    state.status = "reviewing";
    await saveRunState(paths, state);

    const reviewerOutputs: ReviewerReport[] = [...(checkpoint?.reviewerOutputs ?? [])];
    const reviewerMap = new Map<ReviewerReport["reviewer"], ReviewerReport>(
      reviewerOutputs.map((report) => [report.reviewer, report]),
    );

    for (const reviewer of plannedReviewerRoles) {
      if (reviewerMap.has(reviewer)) {
        continue;
      }
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
        reviewerRoleOptions(
          worktreePath,
          options.model,
          reviewer,
          reviewAdditionalDirectories,
          checkoutMode,
          retryingFromFailure,
        ),
        reviewerReportOutputSchema,
        buildReviewerPrompt(reviewer, spec, currentUnderstanding, currentImplementation, worktreePath, retryingFromFailure),
      );
      if (reviewerReport.output.reviewer !== reviewer) {
        await failWorkflowState(
          paths,
          state,
          `Reviewer output mismatch for spec ${spec.specId}: expected ${reviewer}, got ${reviewerReport.output.reviewer}`,
        );
      }
      reviewerOutputs.push(reviewerReport.output);
      reviewerMap.set(reviewer, reviewerReport.output);
    }

    let reviewLead = checkpoint?.reviewLead;
    if (!reviewLead || reviewLead.output.status === "needs_targeted_follow_up") {
      await emitProgress(paths, spec, runId, deps, {
        phase: "reviewing",
        iteration,
        summary: "running review lead",
      });
      reviewLead = await runStructuredTurn(
        codex,
        paths,
        spec,
        state,
        runId,
        reviewLeadOptions(options.model, worktreePath, additionalDirectories, checkoutMode),
        reviewLeadReportOutputSchema,
        buildReviewLeadPrompt(spec, currentUnderstanding, currentImplementation, reviewerOutputs, worktreePath, true),
      );

      if (reviewLead.output.status === "needs_targeted_follow_up") {
        const followUpReviewers = reviewLead.output.followUpReviewers.filter((reviewer) => plannedReviewerRoles.includes(reviewer));
        if (followUpReviewers.length === 0) {
          await failWorkflowState(
            paths,
            state,
            `Review lead requested follow-up without valid reviewer roles for spec ${spec.specId}`,
          );
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
            reviewerRoleOptions(worktreePath, options.model, reviewer, reviewAdditionalDirectories, checkoutMode, true),
            reviewerReportOutputSchema,
            buildReviewerPrompt(reviewer, spec, currentUnderstanding, currentImplementation, worktreePath, true),
          );
          if (reviewerReport.output.reviewer !== reviewer) {
            await failWorkflowState(
              paths,
              state,
              `Reviewer output mismatch for spec ${spec.specId}: expected ${reviewer}, got ${reviewerReport.output.reviewer}`,
            );
          }
          reviewerMap.set(reviewer, reviewerReport.output);
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
          reviewLeadOptions(options.model, worktreePath, additionalDirectories, checkoutMode),
          reviewLeadReportOutputSchema,
          buildReviewLeadPrompt(
            spec,
            currentUnderstanding,
            currentImplementation,
            [...reviewerMap.values()],
            worktreePath,
            false,
          ),
        );
        if (reviewLead.output.status !== "ready_for_recheck") {
          await failWorkflowState(
            paths,
            state,
            `Review lead requested more than one targeted follow-up round for spec ${spec.specId}`,
          );
        }
      }
    }

    if (!reviewLead) {
      throw new Error(`Review lead checkpoint missing after review stage for spec ${spec.specId}`);
    }

    state.status = "rechecking";
    await saveRunState(paths, state);
    try {
      verificationRun = checkpoint?.verificationRun ?? (await (deps.runVerificationCommands ?? runVerificationCommands)(
        repoPath,
        spec.branchInstructions.createBranch,
        spec.verificationCommands,
      ));
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      await failWorkflowState(
        paths,
        state,
        `Host verification failed for spec ${spec.specId}: ${message}`,
      );
    }
    await saveArtifact(paths, spec.specId, runId, `verification-${iteration}`, verificationRun);

    const finalReviewerOutputs = plannedReviewerRoles.map((reviewer) => {
      const review = reviewerMap.get(reviewer);
      if (!review) {
        throw new Error(`Missing review report for ${reviewer} in spec ${spec.specId}`);
      }
      return review;
    });

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
      recheckOptions(options.model, worktreePath, additionalDirectories, checkoutMode),
      recheckVerdictOutputSchema,
      buildRecheckPrompt(
        spec,
        currentUnderstanding,
        currentImplementation,
        finalReviewerOutputs,
        reviewLead.output.summary,
        worktreePath,
        verificationRun,
      ),
    );
    recheckVerdict = recheck.output;
    acceptedFindings = recheck.output.acceptedFindings;

    if (recheck.output.verdict === "approve") {
      return runSupervisorFinalDecision(iteration, currentUnderstanding, currentImplementation, recheck.output);
    }

    if (recheck.output.verdict === "invalidate_plan") {
      invalidationReason = recheck.output.summary;
      state.invalidationReason = recheck.output.summary;
      state.lastCommit = undefined;
      state.status = "planning";
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
      return "continue";
    }

    await emitProgress(paths, spec, runId, deps, {
      phase: "planning",
      iteration,
      summary: `continuing with fixes: ${recheck.output.summary}`,
    });
    return "continue";
  };

  for (let iteration = resumeCheckpoint?.startIteration ?? 1; iteration <= options.maxIterations; iteration += 1) {
    state.currentIteration = iteration;
    const currentInvalidationReason = invalidationReason;

    if (resumeCheckpoint && iteration === resumeCheckpoint.startIteration && resumeCheckpoint.stage !== "planning") {
      if (resumeCheckpoint.stage === "supervisor_final") {
        if (!resumeCheckpoint.understanding || !resumeCheckpoint.implementation || !resumeCheckpoint.recheckVerdict) {
          throw new Error(`Resume checkpoint for spec ${spec.specId} is missing final-supervisor artifacts.`);
        }
        understandingPacket = resumeCheckpoint.understanding.output;
        implementationReport = resumeCheckpoint.implementation.output;
        recheckVerdict = resumeCheckpoint.recheckVerdict.output;
        return runSupervisorFinalDecision(iteration, understandingPacket, implementationReport, recheckVerdict);
      }

      if (resumeCheckpoint.stage === "implementing") {
        if (!resumeCheckpoint.understanding) {
          throw new Error(`Resume checkpoint for spec ${spec.specId} is missing understanding artifacts.`);
        }
        understandingPacket = resumeCheckpoint.understanding.output;
        const resumedImplementation = await runImplementationPass(
          iteration,
          understandingPacket,
          iteration > 1 || retryingFromFailure,
        );
        if (!resumedImplementation) {
          continue;
        }
        implementationReport = resumedImplementation;
      }

      if (resumeCheckpoint.stage === "reviewing" || resumeCheckpoint.stage === "rechecking") {
        if (!resumeCheckpoint.understanding || !resumeCheckpoint.implementation) {
          throw new Error(`Resume checkpoint for spec ${spec.specId} is missing review-stage artifacts.`);
        }
        understandingPacket = resumeCheckpoint.understanding.output;
        implementationReport = await normalizeImplementationChangedFiles(
          worktreePath,
          resumeCheckpoint.implementation.output,
          spec.branchInstructions.sourceBranch,
        );
      }

      if (implementationReport && understandingPacket) {
        const resumedOutcome = await runReviewApprovalCycle(
          iteration,
          understandingPacket,
          implementationReport,
          resumeCheckpoint.stage === "reviewing" || resumeCheckpoint.stage === "rechecking"
            ? resumeCheckpoint
          : null,
        );
        if (resumedOutcome === "continue") {
          shouldReplan = shouldReplan || supervisorStrategy === undefined;
          continue;
        }
        return resumedOutcome;
      }
    }

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
      understanderOptions(options.model, worktreePath, additionalDirectories, checkoutMode),
      understandingPacketOutputSchema,
      buildUnderstanderPrompt(spec, worktreePath, supervisorStrategy.output, planningViews, currentInvalidationReason),
    );
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

    const freshImplementation = await runImplementationPass(
      iteration,
      understanding.output,
      iteration > 1 || retryingFromFailure,
    );
    if (!freshImplementation) {
      continue;
    }
    implementationReport = freshImplementation;
    const reviewOutcome = await runReviewApprovalCycle(iteration, understanding.output, implementationReport, null);
    if (reviewOutcome === "continue") {
      continue;
    }
    return reviewOutcome;
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
    supervisorOptions(options.model, worktreePath, additionalDirectories, checkoutMode),
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

  return finalizeApprovedSpec(
    state.currentIteration,
    supervisorFinal.output.summary,
    implementationReport.commitHash,
    supervisorFinal.output.nextAction,
  );
}
