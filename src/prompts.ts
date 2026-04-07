import type {
  ImplementationReport,
  RecheckVerdict,
  ReviewerReport,
  SpecDocument,
  SupervisorStrategy,
  UnderstandingPacket,
} from "./types.js";

function renderSpec(spec: SpecDocument): string {
  const blocks = [
    `Spec: ${spec.specId}`,
    `Title: ${spec.title}`,
    `Repo: ${spec.repo}`,
    `Workdir: ${spec.workdir}`,
    "",
    "Branch Instructions:",
    `- Source branch: ${spec.branchInstructions.sourceBranch}`,
    `- Create branch: ${spec.branchInstructions.createBranch}`,
  ];

  if (spec.branchInstructions.prTarget) {
    blocks.push(`- PR target: ${spec.branchInstructions.prTarget}`);
  }
  if (spec.branchInstructions.nextSpecBase) {
    blocks.push(`- Next spec base: ${spec.branchInstructions.nextSpecBase}`);
  }

  if (spec.bigPicture) {
    blocks.push("", `Big Picture: ${spec.bigPicture}`);
  }
  blocks.push("", `Goal: ${spec.goal}`);
  blocks.push("", "Scope (In):", ...spec.scopeIn.map((item) => `- ${item}`));
  blocks.push("", "Boundaries (Out):", ...spec.boundariesOut.map((item) => `- ${item}`));
  blocks.push("", "Constraints:", ...spec.constraints.map((item) => `- ${item}`));
  blocks.push("", "Dependencies:", ...spec.dependencies.map((item) => `- ${item}`));
  blocks.push("", "Required Reading:", ...spec.requiredReading.map((item) => `- ${item}`));
  blocks.push("", "Acceptance Criteria:", ...spec.acceptanceCriteria.map((item) => `- ${item}`));
  blocks.push("", "Commit Requirements:", ...spec.commitRequirements.map((item) => `- ${item}`));
  blocks.push("", "Verification commands:", ...spec.verificationCommands.map((cmd) => `- ${cmd}`));
  return blocks.join("\n");
}

export function buildSupervisorPrompt(spec: SpecDocument, worktreePath: string): string {
  return [
    "You are Ralph's supervisor agent.",
    "Your job is to decide the best specialist flow for this spec and identify review coverage.",
    "Correctness and tests reviewers are always included. Use reviewerRoles only for any extra security or performance coverage that the spec justifies.",
    "Do not edit files or run mutating commands.",
    "",
    `Active worktree: ${worktreePath}`,
    "",
    renderSpec(spec),
    "",
    "Return a concise execution strategy for this single spec.",
  ].join("\n");
}

export function buildUnderstanderPrompt(
  spec: SpecDocument,
  worktreePath: string,
  strategy: SupervisorStrategy,
  previousInvalidationReason?: string,
): string {
  const lines = [
    "You are the understander agent for Ralph.",
    "Read the spec, inspect the repository, and produce a precise execution packet for the implementer and reviewers.",
    "Stay read-only. Do not edit code, create commits, or change branches.",
    "",
    `Worktree root: ${worktreePath}`,
    "",
    "Supervisor strategy:",
    strategy.summary,
    "",
    renderSpec(spec),
  ];

  if (previousInvalidationReason) {
    lines.push(
      "",
      `Previous plan invalidation reason: ${previousInvalidationReason}`,
      "Treat the prior supervisor strategy as historical context only when it conflicts with this invalidation reason.",
    );
  }

  lines.push(
    "",
    "Your packet must name the concrete files to edit, the verification commands to trust first, and the assumptions that matter.",
  );
  return lines.join("\n");
}

export function buildImplementerPrompt(
  spec: SpecDocument,
  understanding: UnderstandingPacket,
  worktreePath: string,
  priorFixInstructions: string[],
): string {
  const fixBlock =
    priorFixInstructions.length > 0
      ? ["", "Outstanding fixes to address first:", ...priorFixInstructions.map((item) => `- ${item}`)].join("\n")
      : "";

  return [
    "You are the implementer agent for Ralph.",
    "You may edit files, run commands, and commit changes inside the active worktree.",
    "Follow the understanding packet exactly unless the repository proves it wrong.",
    "If you discover the packet is fundamentally wrong, explain that in concerns but still make the best grounded attempt.",
    "",
    `Active worktree: ${worktreePath}`,
    `Required feature branch: ${spec.branchInstructions.createBranch}`,
    "",
    renderSpec(spec),
    "",
    "Understanding packet summary:",
    understanding.summary,
    "",
    "Execution plan:",
    ...understanding.executionPlan.map((item, index) => `${index + 1}. ${item}`),
    "",
    "Verification commands:",
    ...understanding.verificationCommands.map((item) => `- ${item}`),
    fixBlock,
    "",
    "Required output facts:",
    "- Commit your work before finishing.",
    "- Report the exact 40-character commit hash.",
    "- List changed files.",
    "- Summarize verification evidence honestly.",
  ].join("\n");
}

export function buildReviewerPrompt(
  reviewer: ReviewerReport["reviewer"],
  spec: SpecDocument,
  understanding: UnderstandingPacket,
  implementation: ImplementationReport,
  worktreePath: string,
): string {
  return [
    `You are Ralph's ${reviewer} reviewer.`,
    "You are independent from the implementer.",
    "Stay read-only. You may inspect the repo and run read-only or test commands.",
    "Review only for your assigned category. Do not rewrite the task or broaden scope.",
    "",
    `Worktree root: ${worktreePath}`,
    `Candidate commit: ${implementation.commitHash}`,
    "",
    renderSpec(spec),
    "",
    "Understanding packet:",
    understanding.summary,
    "",
    "Implementer report:",
    implementation.summary,
    "",
    "Changed files:",
    ...implementation.changedFiles.map((item) => `- ${item}`),
    "",
    "Return either approval or actionable findings.",
  ].join("\n");
}

export function buildRecheckPrompt(
  spec: SpecDocument,
  understanding: UnderstandingPacket,
  implementation: ImplementationReport,
  reviewerReports: ReviewerReport[],
  worktreePath: string,
): string {
  const findings = reviewerReports
    .map((report) => [
      `Reviewer: ${report.reviewer}`,
      `Status: ${report.status}`,
      `Summary: ${report.summary}`,
      ...report.findings.map((finding) => `- [${finding.severity}] ${finding.title}: ${finding.detail} | action=${finding.action}`),
    ].join("\n"))
    .join("\n\n");

  return [
    "You are the understander re-check agent for Ralph.",
    "Decide whether the implementation should be approved, fixed, or whether the original plan should be invalidated.",
    "Stay read-only.",
    "",
    `Worktree root: ${worktreePath}`,
    "",
    renderSpec(spec),
    "",
    "Original understanding packet:",
    understanding.summary,
    "",
    "Implementer report:",
    implementation.summary,
    "",
    "Reviewer reports:",
    findings || "(none)",
  ].join("\n");
}

export function buildSupervisorFinalPrompt(
  spec: SpecDocument,
  understanding: UnderstandingPacket,
  implementation: ImplementationReport,
  recheck: RecheckVerdict,
): string {
  return [
    "You are Ralph's supervisor agent closing the loop.",
    "Decide whether this spec is done or what must happen next.",
    "Use the re-check verdict as the source of truth.",
    "",
    renderSpec(spec),
    "",
    `Understanding summary: ${understanding.summary}`,
    `Implementation summary: ${implementation.summary}`,
    `Recheck verdict: ${recheck.verdict}`,
    `Recheck summary: ${recheck.summary}`,
    "",
    "Return the final supervisor outcome for this iteration.",
  ].join("\n");
}
