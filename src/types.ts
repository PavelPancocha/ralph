import type { ApprovalMode, ModelReasoningEffort, SandboxMode, ThreadOptions } from "@openai/codex-sdk";

export type CodexConfigValue =
  | string
  | number
  | boolean
  | CodexConfigValue[]
  | { [key: string]: CodexConfigValue };

export type RoleName =
  | "supervisor"
  | "understander"
  | "implementer"
  | "reviewer_correctness"
  | "reviewer_tests"
  | "reviewer_security"
  | "reviewer_performance"
  | "recheck";

export interface BranchInstructions {
  sourceBranch: string;
  createBranch: string;
  prTarget?: string;
  nextSpecBase?: string;
}

export interface SpecDocument {
  specPath: string;
  relFromSpecs: string;
  relFromWorkspace: string;
  specId: string;
  title: string;
  repo: string;
  workdir: string;
  branchInstructions: BranchInstructions;
  bigPicture?: string;
  goal: string;
  scopeIn: string[];
  boundariesOut: string[];
  constraints: string[];
  dependencies: string[];
  requiredReading: string[];
  acceptanceCriteria: string[];
  commitRequirements: string[];
  verificationCommands: string[];
  rawSections: Record<string, string>;
}

export interface RuntimePaths {
  projectRoot: string;
  workspaceRoot: string;
  ralphRoot: string;
  runsRoot: string;
  sessionsRoot: string;
  stateRoot: string;
  reportsRoot: string;
  worktreesRoot: string;
  artifactsRoot: string;
}

export interface AgentThreadRefs {
  supervisor: string | undefined;
  understander: string | undefined;
  implementer: string | undefined;
  reviewerCorrectness: string | undefined;
  reviewerTests: string | undefined;
  reviewerSecurity: string | undefined;
  reviewerPerformance: string | undefined;
  recheck: string | undefined;
}

export interface RunState {
  specId: string;
  specRel: string;
  status:
    | "queued"
    | "planning"
    | "implementing"
    | "reviewing"
    | "rechecking"
    | "done"
    | "failed";
  currentIteration: number;
  runId: string | undefined;
  worktreePath: string | undefined;
  lastCommit: string | undefined;
  lastError: string | undefined;
  updatedAt: string;
  threads: AgentThreadRefs;
  legacyDoneDetected: boolean;
}

export interface AgentRunArtifact<TPayload> {
  role: RoleName;
  turnId: string;
  threadId: string | null;
  output: TPayload;
  usage?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  } | null;
  items: unknown[];
  rawResponse: string;
}

export interface SupervisorStrategy {
  summary: string;
  reviewerRoles: Array<"correctness" | "tests" | "security" | "performance">;
  keyRisks: string[];
  notesForUnderstander: string[];
}

export interface UnderstandingPacket {
  summary: string;
  repoPath: string;
  worktreePath: string;
  featureBranch: string;
  targetFiles: string[];
  contextFiles: string[];
  reviewerRoles: Array<"correctness" | "tests" | "security" | "performance">;
  executionPlan: string[];
  verificationCommands: string[];
  assumptions: string[];
  riskFlags: string[];
}

export interface ImplementationReport {
  summary: string;
  commitHash: string;
  changedFiles: string[];
  verificationCommands: string[];
  verificationSummary: string;
  concerns: string[];
}

export interface ReviewFinding {
  severity: "info" | "warning" | "error";
  category: "correctness" | "tests" | "security" | "performance";
  title: string;
  detail: string;
  action: string;
}

export interface ReviewerReport {
  reviewer: "correctness" | "tests" | "security" | "performance";
  status: "approved" | "changes_requested";
  summary: string;
  findings: ReviewFinding[];
}

export interface RecheckVerdict {
  verdict: "approve" | "needs_fix" | "invalidate_plan";
  summary: string;
  acceptedFindings: ReviewFinding[];
  rejectedFindings: string[];
  fixInstructions: string[];
}

export interface SupervisorOutcome {
  status: "done" | "needs_more_work" | "failed";
  summary: string;
  candidateCommit: string | undefined;
  nextAction: string;
}

export interface RalphRunOptions {
  workspaceRoot: string;
  projectRoot: string;
  model: string;
  maxIterations: number;
  dryRun: boolean;
  specFilters: string[];
}

export interface RoleExecutionOptions {
  role: RoleName;
  model: string;
  workingDirectory: string;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
  reasoningEffort: ModelReasoningEffort;
  config?: { [key: string]: CodexConfigValue };
}

export type CodexThreadConfig = Omit<ThreadOptions, "model"> & {
  model: string;
  modelReasoningEffort: ModelReasoningEffort;
};
