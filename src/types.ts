import type { ApprovalMode, ModelReasoningEffort, SandboxMode, ThreadOptions } from "@openai/codex-sdk";

export type CodexConfigValue =
  | string
  | number
  | boolean
  | CodexConfigValue[]
  | { [key: string]: CodexConfigValue };

export type RoleName =
  | "planning_spec"
  | "planning_repo"
  | "planning_risks"
  | "supervisor"
  | "understander"
  | "implementer"
  | "reviewer_correctness"
  | "reviewer_tests"
  | "reviewer_security"
  | "reviewer_performance"
  | "review_lead"
  | "recheck";

export type CheckoutMode = "worktree" | "root";

export interface BranchInstructions {
  sourceBranch: string;
  createBranch: string;
  prTarget?: string;
  nextSpecBase?: string;
  createPr?: boolean;
  draftPr?: boolean;
  labels?: string[];
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
  specRoot: string;
  specRootRuntimeId: string;
  isDefaultSpecRoot: boolean;
  ralphRoot: string;
  runsRoot: string;
  sessionsRoot: string;
  stateRoot: string;
  reportsRoot: string;
  worktreesRoot: string;
  artifactsRoot: string;
}

export interface AgentThreadRefs {
  planningSpec: string | undefined;
  planningRepo: string | undefined;
  planningRisks: string | undefined;
  supervisor: string | undefined;
  understander: string | undefined;
  implementer: string | undefined;
  reviewerCorrectness: string | undefined;
  reviewerTests: string | undefined;
  reviewerSecurity: string | undefined;
  reviewerPerformance: string | undefined;
  reviewLead: string | undefined;
  recheck: string | undefined;
}

export interface AgentThreadPolicies {
  planningSpec: string | undefined;
  planningRepo: string | undefined;
  planningRisks: string | undefined;
  supervisor: string | undefined;
  understander: string | undefined;
  implementer: string | undefined;
  reviewerCorrectness: string | undefined;
  reviewerTests: string | undefined;
  reviewerSecurity: string | undefined;
  reviewerPerformance: string | undefined;
  reviewLead: string | undefined;
  recheck: string | undefined;
}

export interface RunState {
  stateVersion: number;
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
  checkoutMode?: CheckoutMode;
  worktreePath: string | undefined;
  lastCommit: string | undefined;
  lastError: string | undefined;
  updatedAt: string;
  threads: AgentThreadRefs;
  threadPolicies: AgentThreadPolicies;
  legacyDoneDetected: boolean;
  invalidationReason: string | undefined;
}

export type WorkflowProgressPhase =
  | "setup"
  | "recovery"
  | "planning"
  | "implementing"
  | "reviewing"
  | "rechecking"
  | "publishing"
  | "dry-run"
  | "done"
  | "failed";

export interface WorkflowProgressEvent {
  timestamp: string;
  runId: string;
  specId: string;
  specTitle: string;
  phase: WorkflowProgressPhase;
  iteration?: number;
  summary: string;
  reviewer?: ReviewerReport["reviewer"];
  candidateCommit?: string;
}

export type PlanningLens = "spec" | "repo" | "risks";

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

export interface PlanningView {
  lens: PlanningLens;
  summary: string;
  keyPoints: string[];
  suggestedFiles: string[];
  suggestedReviewers: Array<"correctness" | "tests" | "security" | "performance">;
  verificationHints: string[];
}

export interface UnderstandingPacket {
  summary: string;
  repoPath: string;
  worktreePath: string;
  checkoutMode: CheckoutMode;
  featureBranch: string;
  targetFiles: string[];
  contextFiles: string[];
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

export interface VerificationCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface VerificationRun {
  repoPath: string;
  featureBranch: string;
  startingBranch: string | undefined;
  startingCommit: string;
  restoredBranch: string | undefined;
  commands: VerificationCommandResult[];
  summary: string;
  succeeded: boolean;
}

export interface RootRecoverySessionEvidence {
  sessionPath: string;
  matchedSignals: string[];
}

export interface RootRecoveryAuditEvidence {
  expectedFilesSource: "understanding" | "implementation";
  expectedFiles: string[];
  dirtyEntries: string[];
  dirtyFiles: string[];
  sessionEvidence?: RootRecoverySessionEvidence;
}

export interface RootRecoveryAudit {
  linked: boolean;
  passed: boolean;
  action: "continue" | "stash_and_restart" | "reject";
  reasons: string[];
  priorRunId?: string;
  expectedBranch: string;
  currentBranch?: string;
  evidence?: RootRecoveryAuditEvidence;
}

export interface ImplementerRecoveryContext {
  auditSummary: string;
  dirtyFiles: string[];
  expectedFilesSource: RootRecoveryAuditEvidence["expectedFilesSource"];
  sessionEvidence?: RootRecoverySessionEvidence;
}

export interface PublicationResult {
  branch: string;
  remote: string;
  prNumber?: number;
  prUrl?: string;
  prCreated: boolean;
  draft: boolean;
  labels: string[];
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

export interface ReviewLeadReport {
  status: "ready_for_recheck" | "needs_targeted_follow_up";
  summary: string;
  followUpReviewers: Array<"correctness" | "tests" | "security" | "performance">;
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
  model: string | undefined;
  maxIterations: number;
  dryRun: boolean;
  resume?: boolean;
  specFilters: string[];
  checkoutMode?: CheckoutMode;
}

export interface RoleExecutionOptions {
  role: RoleName;
  model: string;
  workingDirectory: string;
  additionalDirectories?: string[];
  checkoutMode?: CheckoutMode;
  forceFreshThread?: boolean;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
  reasoningEffort: ModelReasoningEffort;
  config?: { [key: string]: CodexConfigValue };
}

export type CodexThreadConfig = Omit<ThreadOptions, "model"> & {
  model: string;
  modelReasoningEffort: ModelReasoningEffort;
};
