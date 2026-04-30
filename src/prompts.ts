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
      "Success means the spec contract, acceptance criteria, dependencies, and boundary risks are clear.",
      "Call out ambiguity only when it can change implementation or review decisions.",
    ],
    repo: [
      "Success means Ralph has concrete target files, conventions, and integration points.",
      "Prefer repo-backed file and module suggestions over abstract advice.",
    ],
    risks: [
      "Success means likely failure modes, review coverage, and fast-first checks are identified.",
      "Suggest extra reviewer categories only when the spec or code shape justifies them.",
    ],
  };

  const lines = [
    `You are Ralph's planning helper for the ${lens} lens.`,
    "",
    "# Goal",
    "Produce the smallest useful read-only planning view for this lens.",
    "",
    "# Success criteria",
    ...lensInstructions[lens].map((item) => `- ${item}`),
    "- Stop once the lens has enough evidence for the supervisor and understander.",
    "",
    "# Constraints",
    "- Stay read-only: do not edit files, create commits, or change branches.",
    "- Use the provided checkout, spec, and required reading as the source of truth.",
    "",
    "# Evidence budget",
    "- Inspect required reading and directly relevant files first.",
    "- Expand repo search only when a required file, owner, behavior, or verification command is still missing.",
    "",
    `Checkout root: ${worktreePath}`,
    "",
    "# Context",
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
    "# Output",
    "Return only the structured planning view for your assigned lens.",
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
    "",
    "# Goal",
    "Choose the implementation strategy and review coverage that best satisfies this single spec.",
    "",
    "# Success criteria",
    "- The strategy names the outcome, main risks, and useful notes for the understander.",
    "- Correctness and tests reviewers are assumed; add security or performance only when justified.",
    "- Stop when the available planning views and spec are enough to route the work.",
    "",
    "# Constraints",
    "- Stay read-only: do not edit files or run mutating commands.",
    "- Do not broaden the spec beyond its acceptance criteria and boundaries.",
    "",
    `Active checkout: ${worktreePath}`,
    "",
    "# Context",
    ...renderPlanningViews(planningViews),
    "",
    renderSpec(spec),
    ...(previousInvalidationReason
      ? ["", `Previous plan invalidation reason: ${previousInvalidationReason}`]
      : []),
    "",
    "# Output",
    "Return only the structured execution strategy for this spec.",
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
    "",
    "# Goal",
    "Produce a precise execution packet the implementer can act on and reviewers can verify.",
    "",
    "# Success criteria",
    "- Name the concrete files to edit and context files to inspect.",
    "- Map the plan to the spec outcome, acceptance criteria, and verification evidence.",
    "- Record assumptions and risks only when they could affect implementation or review.",
    "",
    "# Constraints",
    "- Stay read-only: do not edit code, create commits, or change branches.",
    "- Prefer the repo's existing conventions and local helper APIs.",
    "",
    "# Evidence budget",
    "- Start with required reading, likely target files, and directly referenced integration points.",
    "- Search wider only when the target files, data flow, or validation commands remain uncertain.",
    "",
    `Checkout root: ${worktreePath}`,
    "",
    "# Context",
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
    "# Output",
    "Return only the structured execution packet.",
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
    "",
    "# Goal",
    "Implement the spec end to end in the active checkout and commit the result.",
    "",
    "# Success criteria",
    "- The committed diff satisfies the spec outcome and acceptance criteria.",
    "- The diff stays inside the requested scope unless the repo proves a small adjacent change is necessary.",
    "- Verification evidence is captured honestly before finishing.",
    "",
    "# Constraints",
    "- You may edit files, run commands, and commit changes inside the active checkout.",
    "- Follow the understanding packet unless repository evidence proves a better path.",
    "- If the packet is fundamentally wrong, make the best grounded attempt and explain the concern.",
    ...(escalated
      ? [
          "This is an escalated retry because the earlier solution was not accepted.",
          "Verify more thoroughly and do not preserve a rejected approach unless repository evidence proves it was correct.",
        ]
      : ["This is the first implementation pass. Stay focused and avoid speculative extra changes."]),
    "",
    "# Validation",
    "- Run the most relevant targeted validation available before committing.",
    "- Prefer changed-behavior unit tests, type checks, lint/build checks, or the spec's fast-first commands.",
    "- If a validation command cannot run, explain why and describe the next best evidence.",
    "",
    `Active checkout: ${worktreePath}`,
    `Required feature branch: ${spec.branchInstructions.createBranch}`,
    recoveryBlock,
    "",
    "# Context",
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
    "# Output facts",
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
    "",
    "# Goal",
    `Decide whether the candidate should pass ${reviewer} review for this spec.`,
    "",
    "# Success criteria",
    "- Findings are actionable, evidence-backed, and limited to your assigned category.",
    "- Approval means no material issue remains for this category.",
    "- Stop once you have enough evidence to approve or request changes.",
    "",
    "# Constraints",
    "- You are independent from the implementer.",
    "- Stay read-only. You may inspect the repo and run read-only or test commands.",
    "- Do not rewrite the task or broaden scope.",
    ...(escalated
      ? [
          "This is an escalated follow-up review. Go deeper only on disputed or high-risk details.",
        ]
      : []),
    "",
    "# Evidence budget",
    "- Inspect the changed files, nearby affected code, and directly relevant tests first.",
    "- Run targeted checks only when they materially improve the review decision.",
    "",
    `Checkout root: ${worktreePath}`,
    `Candidate commit: ${implementation.commitHash}`,
    "",
    "# Context",
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
    "# Output",
    "Return only the structured review decision.",
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
    "",
    "# Goal",
    "Decide whether the review set is ready for recheck or needs one targeted follow-up.",
    "",
    "# Success criteria",
    "- The summary preserves the important review signal without duplicating raw reports.",
    "- Follow-up is requested only when a reviewer topic needs materially deeper investigation.",
    "- Stop when the review set can be handed to recheck.",
    "",
    "# Constraints",
    "- Stay read-only.",
    "- Do not replace or rewrite reviewer findings; raw reviewer reports are passed to recheck separately.",
    allowFollowUp
      ? "Follow-up is allowed for specific reviewer topics."
      : "No more follow-up is allowed in this turn. You must return a final synthesized review packet.",
    "",
    `Checkout root: ${worktreePath}`,
    "",
    "# Context",
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
    "",
    "# Output",
    "Return only the structured review-lead decision.",
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
    "",
    "# Goal",
    "Make the final quality gate decision for this iteration.",
    "",
    "# Success criteria",
    "- Approve only when the implementation, reviews, and host verification satisfy the spec.",
    "- Request fixes only for accepted actionable findings that can be corrected without replanning.",
    "- Invalidate the plan only when the execution packet or strategy targeted the wrong work.",
    "",
    "# Constraints",
    "- Stay read-only.",
    "- Treat host verification and reviewer evidence as inputs, not as automatic pass/fail decisions.",
    "",
    `Checkout root: ${worktreePath}`,
    "",
    "# Context",
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
    "",
    "# Output",
    "Return only the structured recheck verdict.",
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
    "",
    "# Goal",
    "Close the supervised loop for this spec.",
    "",
    "# Success criteria",
    "- Use the re-check verdict as the source of truth.",
    "- Mark done only when recheck approved the candidate.",
    "- Otherwise name the next concrete action.",
    "",
    "# Context",
    renderSpec(spec),
    "",
    `Understanding summary: ${understanding.summary}`,
    `Implementation summary: ${implementation.summary}`,
    `Recheck verdict: ${recheck.verdict}`,
    `Recheck summary: ${recheck.summary}`,
    "",
    "# Output",
    "Return only the structured supervisor outcome.",
  ].join("\n");
}
