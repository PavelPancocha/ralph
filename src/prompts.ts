import type {
  ImplementerRecoveryContext,
  ImplementationReport,
  PlanningLens,
  PlanningView,
  RecheckVerdict,
  ReviewerReport,
  SpecDocument,
  SupervisorStrategy,
  VerificationRun,
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

function renderPlanningViews(planningViews: PlanningView[]): string[] {
  if (planningViews.length === 0) {
    return ["Planning helper views:", "(none)"];
  }

  return [
    "Planning helper views:",
    ...planningViews.flatMap((view) => [
      `- ${view.lens}: ${view.summary}`,
      ...view.keyPoints.map((item) => `  point: ${item}`),
      ...view.suggestedFiles.map((item) => `  file: ${item}`),
      ...view.suggestedReviewers.map((item) => `  reviewer: ${item}`),
      ...view.verificationHints.map((item) => `  verify: ${item}`),
    ]),
  ];
}

function renderVerificationRun(verificationRun: VerificationRun | undefined): string[] {
  if (!verificationRun) {
    return ["Host verification:", "(not run)"];
  }

  const commandBlocks = verificationRun.commands.flatMap((commandResult, index) => {
    const stdoutLines = commandResult.stdout.trimEnd().split("\n").filter((line) => line.length > 0);
    const stderrLines = commandResult.stderr.trimEnd().split("\n").filter((line) => line.length > 0);
    return [
      `- Command ${index + 1}: ${commandResult.command}`,
      `  exitCode: ${commandResult.exitCode}`,
      "  stdout:",
      ...(stdoutLines.length > 0 ? stdoutLines.map((line) => `    ${line}`) : ["    (empty)"]),
      "  stderr:",
      ...(stderrLines.length > 0 ? stderrLines.map((line) => `    ${line}`) : ["    (empty)"]),
    ];
  });

  return [
    "Host verification:",
    `- Repo path: ${verificationRun.repoPath}`,
    `- Feature branch: ${verificationRun.featureBranch}`,
    `- Starting branch: ${verificationRun.startingBranch ?? "(detached)"}`,
    `- Restored branch: ${verificationRun.restoredBranch ?? "(detached)"}`,
    `- Summary: ${verificationRun.summary}`,
    `- Succeeded: ${verificationRun.succeeded ? "yes" : "no"}`,
    "Transcript:",
    ...commandBlocks,
  ];
}

function renderAffectedTestModules(changedFiles: string[]): string[] {
  const moduleTargets = new Set<string>();
  for (const file of changedFiles) {
    if (!file.endsWith(".py")) {
      continue;
    }
    if (!file.includes("/tests/")) {
      continue;
    }
    moduleTargets.add(file.replace(/\.py$/u, "").replaceAll("/", "."));
  }
  return [...moduleTargets].sort();
}

export function buildPlanningHelperPrompt(
  spec: SpecDocument,
  worktreePath: string,
  lens: PlanningLens,
  previousInvalidationReason?: string,
): string {
  const lensInstructions: Record<PlanningLens, string[]> = {
    spec: [
      "Focus on scope, acceptance criteria, dependencies, and boundary mistakes.",
      "Call out ambiguous or risky parts of the spec contract.",
    ],
    repo: [
      "Focus on the current code shape, likely files, existing conventions, and integration points.",
      "Prefer concrete file and module suggestions over abstract advice.",
    ],
    risks: [
      "Focus on failure modes, review coverage, and fast-first verification hints.",
      "Suggest extra reviewer categories only when they are justified.",
    ],
  };

  const lines = [
    `You are Ralph's planning helper for the ${lens} lens.`,
    "Stay read-only. Do not edit files, create commits, or change branches.",
    "",
    `Checkout root: ${worktreePath}`,
    "",
    ...lensInstructions[lens],
    "",
    renderSpec(spec),
  ];

  if (previousInvalidationReason) {
    lines.push(
      "",
      `Previous plan invalidation reason: ${previousInvalidationReason}`,
      "Use this as evidence of what the prior planning pass got wrong.",
    );
  }

  lines.push(
    "",
    "Return a compact planning view for your assigned lens only.",
  );
  return lines.join("\n");
}

export function buildSupervisorPrompt(
  spec: SpecDocument,
  worktreePath: string,
  planningViews: PlanningView[],
  previousInvalidationReason?: string,
): string {
  return [
    "You are Ralph's supervisor agent.",
    "Your job is to decide the best specialist flow for this spec and identify review coverage.",
    "Correctness and tests reviewers are always included. Use reviewerRoles only for any extra security or performance coverage that the spec justifies.",
    "Do not edit files or run mutating commands.",
    "",
    `Active checkout: ${worktreePath}`,
    "",
    ...renderPlanningViews(planningViews),
    "",
    renderSpec(spec),
    ...(previousInvalidationReason
      ? ["", `Previous plan invalidation reason: ${previousInvalidationReason}`]
      : []),
    "",
    "Return a concise execution strategy for this single spec.",
  ].join("\n");
}

export function buildUnderstanderPrompt(
  spec: SpecDocument,
  worktreePath: string,
  strategy: SupervisorStrategy,
  planningViews: PlanningView[],
  previousInvalidationReason?: string,
): string {
  const lines = [
    "You are the understander agent for Ralph.",
    "Read the spec, inspect the repository, and produce a precise execution packet for the implementer and reviewers.",
    "Stay read-only. Do not edit code, create commits, or change branches.",
    "",
    `Checkout root: ${worktreePath}`,
    "",
    "Supervisor strategy:",
    strategy.summary,
    "",
    ...renderPlanningViews(planningViews),
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
  escalated: boolean,
  recoveryContext?: ImplementerRecoveryContext,
): string {
  const fixBlock =
    priorFixInstructions.length > 0
      ? ["", "Outstanding fixes to address first:", ...priorFixInstructions.map((item) => `- ${item}`)].join("\n")
      : "";
  const recoveryBlock = recoveryContext
    ? [
        "",
        "Recovery audit summary:",
        recoveryContext.auditSummary,
        "",
        `Recovered expected-file source: ${recoveryContext.expectedFilesSource}`,
        "Recovered dirty files:",
        ...recoveryContext.dirtyFiles.map((item) => `- ${item}`),
        ...(recoveryContext.sessionEvidence
          ? [
              "",
              `Saved implementer session evidence: ${recoveryContext.sessionEvidence.sessionPath}`,
              ...recoveryContext.sessionEvidence.matchedSignals.map((item) => `- ${item}`),
            ]
          : []),
        "",
        "Inspect the existing dirty changes first. Reuse them if they are correct, make only the minimal corrections needed, then commit and report normally.",
      ].join("\n")
    : "";

  return [
    "You are the implementer agent for Ralph.",
    "You may edit files, run commands, and commit changes inside the active checkout.",
    "Follow the understanding packet exactly unless the repository proves it wrong.",
    "If you discover the packet is fundamentally wrong, explain that in concerns but still make the best grounded attempt.",
    ...(escalated
      ? [
          "This is an escalated retry because the earlier solution was not accepted.",
          "Think deeper, verify more aggressively, and do not preserve a rejected approach unless the repository clearly proves it was correct.",
        ]
      : ["This is the first implementation pass. Stay focused and avoid speculative extra changes."]),
    "",
    `Active checkout: ${worktreePath}`,
    `Required feature branch: ${spec.branchInstructions.createBranch}`,
    recoveryBlock,
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
    "- List changed files for the full feature-branch diff (source merge-base..reported commit), not only the latest commit.",
    "- Summarize verification evidence honestly.",
  ].join("\n");
}

export function buildReviewerPrompt(
  reviewer: ReviewerReport["reviewer"],
  spec: SpecDocument,
  understanding: UnderstandingPacket,
  implementation: ImplementationReport,
  worktreePath: string,
  escalated: boolean,
): string {
  const affectedTestModules = reviewer === "tests" ? renderAffectedTestModules(implementation.changedFiles) : [];
  const testsScopeBlock = reviewer !== "tests"
    ? []
    : [
      "",
      "Tests reviewer execution scope:",
      "- Run only tests for affected modules derived from changed files.",
      "- Do not run broad/repo-wide suites in the reviewer phase.",
      ...(affectedTestModules.length > 0
        ? [
            "Affected test modules:",
            ...affectedTestModules.map((item) => `- ${item}`),
          ]
        : ["- No direct test modules were detected from changed files; perform static testability review only."]),
    ];

  return [
    `You are Ralph's ${reviewer} reviewer.`,
    "You are independent from the implementer.",
    "Stay read-only. You may inspect the repo and run read-only or test commands.",
    "Review only for your assigned category. Do not rewrite the task or broaden scope.",
    ...(escalated
      ? [
          "This is an escalated follow-up review. Go deeper on disputed or high-risk details and resolve ambiguity decisively.",
        ]
      : []),
    "",
    `Checkout root: ${worktreePath}`,
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
    ...testsScopeBlock,
    "",
    "Return either approval or actionable findings.",
  ].join("\n");
}

export function buildReviewLeadPrompt(
  spec: SpecDocument,
  understanding: UnderstandingPacket,
  implementation: ImplementationReport,
  reviewerReports: ReviewerReport[],
  worktreePath: string,
  allowFollowUp: boolean,
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
    "You are Ralph's review lead.",
    "Synthesize the reviewer reports into a concise summary for recheck.",
    "Do not replace or rewrite reviewer findings; the raw reviewer reports will be passed to recheck separately.",
    allowFollowUp
      ? "If one or more reviewer topics need materially deeper investigation, request targeted follow-up only for those topics."
      : "No more follow-up is allowed in this turn. You must return a final synthesized review packet.",
    "Stay read-only.",
    "",
    `Checkout root: ${worktreePath}`,
    "",
    renderSpec(spec),
    "",
    "Understanding packet:",
    understanding.summary,
    "",
    "Implementer report:",
    implementation.summary,
    "",
    "Reviewer reports:",
    findings || "(none)",
  ].join("\n");
}

export function buildRecheckPrompt(
  spec: SpecDocument,
  understanding: UnderstandingPacket,
  implementation: ImplementationReport,
  reviewerReports: ReviewerReport[],
  reviewLeadSummary: string,
  worktreePath: string,
  verificationRun?: VerificationRun,
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
    `Checkout root: ${worktreePath}`,
    "",
    renderSpec(spec),
    "",
    "Original understanding packet:",
    understanding.summary,
    "",
    "Implementer report:",
    implementation.summary,
    "",
    "Review lead summary:",
    reviewLeadSummary,
    "",
    ...renderVerificationRun(verificationRun),
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
