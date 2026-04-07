import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { Codex } from "@openai/codex-sdk";

import type {
  AgentRunArtifact,
  CodexThreadConfig,
  ImplementationReport,
  RalphRunOptions,
  RecheckVerdict,
  ReviewFinding,
  ReviewerReport,
  RoleExecutionOptions,
  RunState,
  RuntimePaths,
  SpecDocument,
  SupervisorOutcome,
  SupervisorStrategy,
  UnderstandingPacket,
} from "./types.js";
import {
  buildSupervisorFinalPrompt,
  buildSupervisorPrompt,
  buildImplementerPrompt,
  buildRecheckPrompt,
  buildReviewerPrompt,
  buildUnderstanderPrompt,
} from "./prompts.js";
import {
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
} from "./runtime.js";

const reviewerRoleByName = {
  correctness: "reviewerCorrectness",
  tests: "reviewerTests",
  security: "reviewerSecurity",
  performance: "reviewerPerformance",
} as const;

const supervisorStrategySchema = z.object({
  summary: z.string(),
  reviewerRoles: z.array(z.enum(["correctness", "tests", "security", "performance"])).min(2),
  keyRisks: z.array(z.string()),
  notesForUnderstander: z.array(z.string()),
});

const understandingPacketSchema = z.object({
  summary: z.string(),
  repoPath: z.string(),
  worktreePath: z.string(),
  featureBranch: z.string(),
  targetFiles: z.array(z.string()),
  contextFiles: z.array(z.string()),
  reviewerRoles: z.array(z.enum(["correctness", "tests", "security", "performance"])).min(2),
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
  candidateCommit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  nextAction: z.string(),
});

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
    sandboxMode: options.sandboxMode,
    approvalPolicy: options.approvalPolicy,
    skipGitRepoCheck: false,
    networkAccessEnabled: false,
  };
}

function roleStateKey(role: RoleExecutionOptions["role"]): keyof RunState["threads"] {
  switch (role) {
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
    case "recheck":
      return "recheck";
  }
}

async function runStructuredTurn<T>(
  codex: CodexLike,
  paths: RuntimePaths,
  spec: SpecDocument,
  state: RunState,
  runId: string,
  options: RoleExecutionOptions,
  schema: z.ZodType<T>,
  prompt: string,
): Promise<AgentRunArtifact<T>> {
  const threadKey = roleStateKey(options.role);
  const thread = state.threads[threadKey]
    ? codex.resumeThread(state.threads[threadKey] as string, roleThreadOptions(options))
    : codex.startThread(roleThreadOptions(options));
  const turn = await thread.run(prompt, { outputSchema: schemaToJsonSchema(schema) });
  const parsed = schema.parse(JSON.parse(turn.finalResponse));
  state.threads[threadKey] = thread.id ?? undefined;
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
  await saveArtifact(paths, spec.specId, runId, options.role, artifact);
  return artifact;
}

function schemaToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema === supervisorStrategySchema) {
    return {
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
    };
  }
  if (schema === understandingPacketSchema) {
    return {
      type: "object",
      properties: {
        summary: { type: "string" },
        repoPath: { type: "string" },
        worktreePath: { type: "string" },
        featureBranch: { type: "string" },
        targetFiles: { type: "array", items: { type: "string" } },
        contextFiles: { type: "array", items: { type: "string" } },
        reviewerRoles: {
          type: "array",
          items: { type: "string", enum: ["correctness", "tests", "security", "performance"] },
        },
        executionPlan: { type: "array", items: { type: "string" } },
        verificationCommands: { type: "array", items: { type: "string" } },
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
        "reviewerRoles",
        "executionPlan",
        "verificationCommands",
        "assumptions",
        "riskFlags",
      ],
      additionalProperties: false,
    };
  }
  if (schema === implementationReportSchema) {
    return {
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
    };
  }
  if (schema === reviewerReportSchema) {
    return {
      type: "object",
      properties: {
        reviewer: { type: "string", enum: ["correctness", "tests", "security", "performance"] },
        status: { type: "string", enum: ["approved", "changes_requested"] },
        summary: { type: "string" },
        findings: {
          type: "array",
          items: {
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
          },
        },
      },
      required: ["reviewer", "status", "summary", "findings"],
      additionalProperties: false,
    };
  }
  if (schema === recheckVerdictSchema) {
    return {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["approve", "needs_fix", "invalidate_plan"] },
        summary: { type: "string" },
        acceptedFindings: {
          type: "array",
          items: {
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
          },
        },
        rejectedFindings: { type: "array", items: { type: "string" } },
        fixInstructions: { type: "array", items: { type: "string" } },
      },
      required: ["verdict", "summary", "acceptedFindings", "rejectedFindings", "fixInstructions"],
      additionalProperties: false,
    };
  }
  if (schema === supervisorOutcomeSchema) {
    return {
      type: "object",
      properties: {
        status: { type: "string", enum: ["done", "needs_more_work", "failed"] },
        summary: { type: "string" },
        candidateCommit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        nextAction: { type: "string" },
      },
      required: ["status", "summary", "nextAction"],
      additionalProperties: false,
    };
  }
  throw new Error("Unsupported schema");
}

function implementationPromptFixes(findings: ReviewFinding[]): string[] {
  return findings.map((finding) => `${finding.category}: ${finding.action}`);
}

function reviewerRoleOptions(worktreePath: string, model: string, role: ReviewerReport["reviewer"]): RoleExecutionOptions {
  const roleMap: Record<ReviewerReport["reviewer"], RoleExecutionOptions["role"]> = {
    correctness: "reviewer_correctness",
    tests: "reviewer_tests",
    security: "reviewer_security",
    performance: "reviewer_performance",
  };
  return {
    role: roleMap[role],
    model,
    workingDirectory: worktreePath,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    reasoningEffort: "high",
  };
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
  state.worktreePath = worktreePath;
  await saveRunState(paths, state);

  if (options.dryRun) {
    const dryOutcome: SupervisorOutcome = {
      status: "needs_more_work",
      summary: `Dry run prepared worktree at ${worktreePath}`,
      candidateCommit: undefined,
      nextAction: "Run without --dry-run to execute the workflow.",
    };
    await saveArtifact(paths, spec.specId, runId, "dry-run", { spec, worktreePath, repoPath });
    return dryOutcome;
  }

  const codexFactory = deps.createCodex ?? createCodex;
  const codex = codexFactory(paths, options.model);

  state.status = "planning";
  await saveRunState(paths, state);
  const supervisorStrategy = await runStructuredTurn(
    codex,
    paths,
    spec,
    state,
    runId,
    {
      role: "supervisor",
      model: options.model,
      workingDirectory: worktreePath,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      reasoningEffort: "high",
    },
    supervisorStrategySchema,
    buildSupervisorPrompt(spec, worktreePath),
  );

  let invalidationReason: string | undefined;
  let acceptedFindings: ReviewFinding[] = [];
  let implementationReport: ImplementationReport | undefined;
  let understandingPacket: UnderstandingPacket | undefined;
  let recheckVerdict: RecheckVerdict | undefined;

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    state.currentIteration = iteration;
    state.status = "planning";
    await saveRunState(paths, state);

    const understanding = await runStructuredTurn(
      codex,
      paths,
      spec,
      state,
      runId,
      {
        role: "understander",
        model: options.model,
        workingDirectory: worktreePath,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        reasoningEffort: "high",
      },
      understandingPacketSchema,
      buildUnderstanderPrompt(spec, worktreePath, supervisorStrategy.output, invalidationReason),
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

    state.status = "implementing";
    await saveRunState(paths, state);
    const implementation = await runStructuredTurn(
      codex,
      paths,
      spec,
      state,
      runId,
      {
        role: "implementer",
        model: options.model,
        workingDirectory: worktreePath,
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        reasoningEffort: "medium",
      },
      implementationReportSchema,
      buildImplementerPrompt(spec, understanding.output, worktreePath, implementationPromptFixes(acceptedFindings)),
    );
    implementationReport = implementation.output;
    state.lastCommit = implementation.output.commitHash;
    await saveRunState(paths, state);

    state.status = "reviewing";
    await saveRunState(paths, state);
    const reviewerRoles = understanding.output.reviewerRoles;
    const reviewerReports = await Promise.all(
      reviewerRoles.map((reviewer) =>
        runStructuredTurn(
          codex,
          paths,
          spec,
          state,
          runId,
          reviewerRoleOptions(worktreePath, options.model, reviewer),
          reviewerReportSchema,
          buildReviewerPrompt(reviewer, spec, understanding.output, implementation.output, worktreePath),
        ),
      ),
    );
    const reviewerOutputs = reviewerReports.map((item) => item.output);

    state.status = "rechecking";
    await saveRunState(paths, state);
    const recheck = await runStructuredTurn(
      codex,
      paths,
      spec,
      state,
      runId,
      {
        role: "recheck",
        model: options.model,
        workingDirectory: worktreePath,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        reasoningEffort: "high",
      },
      recheckVerdictSchema,
      buildRecheckPrompt(spec, understanding.output, implementation.output, reviewerOutputs, worktreePath),
    );
    recheckVerdict = recheck.output;
    acceptedFindings = recheck.output.acceptedFindings;

    if (recheck.output.verdict === "approve") {
      break;
    }
    if (recheck.output.verdict === "invalidate_plan") {
      invalidationReason = recheck.output.summary;
      state.threads.understander = undefined;
      state.threads.implementer = undefined;
      state.threads.reviewerCorrectness = undefined;
      state.threads.reviewerTests = undefined;
      state.threads.reviewerSecurity = undefined;
      state.threads.reviewerPerformance = undefined;
      state.threads.recheck = undefined;
      continue;
    }
  }

  if (!understandingPacket || !implementationReport || !recheckVerdict) {
    const failed: SupervisorOutcome = {
      status: "failed",
      summary: `Spec ${spec.specId} failed before producing complete artifacts.`,
      candidateCommit: undefined,
      nextAction: "Inspect .ralph artifacts and rerun.",
    };
    state.status = "failed";
    state.lastError = failed.summary;
    await saveRunState(paths, state);
    return failed;
  }

  const supervisorFinal = await runStructuredTurn(
    codex,
    paths,
    spec,
    state,
    runId,
    {
      role: "supervisor",
      model: options.model,
      workingDirectory: worktreePath,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      reasoningEffort: "high",
    },
    supervisorOutcomeSchema,
    buildSupervisorFinalPrompt(spec, understandingPacket, implementationReport, recheckVerdict),
  );

  if (recheckVerdict.verdict !== "approve") {
    state.status = "failed";
    state.lastError = recheckVerdict.summary;
    await saveRunState(paths, state);
    return {
      status: "failed",
      summary: recheckVerdict.summary,
      candidateCommit: implementationReport.commitHash,
      nextAction: "Rerun after inspecting accepted findings.",
    };
  }

  await saveDoneReport(paths, spec, supervisorFinal.output.summary, implementationReport.commitHash);
  state.status = "done";
  state.lastCommit = implementationReport.commitHash;
  await saveRunState(paths, state);
  return {
    status: "done",
    summary: supervisorFinal.output.summary,
    candidateCommit: implementationReport.commitHash,
    nextAction: supervisorFinal.output.nextAction,
  };
}
