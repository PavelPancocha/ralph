"""Prompt template builders for planner, implementer, and verifier phases."""

from __future__ import annotations

from pathlib import Path

from _types import Config, Paths, SpecInfo
from _paths import plan_path_for_spec


def build_planner_prompt(
    *,
    spec: SpecInfo,
    paths: Paths,
    config: Config,
    spec_content: str,
    previous_plan: str | None,
    invalidation_reason: str | None,
) -> str:
    plan_output_path: Path = plan_path_for_spec(paths, spec.rel_from_specs)

    replanning_block: str = ""
    if previous_plan and invalidation_reason:
        replanning_block = (
            "\n"
            "<replanning-context>\n"
            "A previous plan was INVALIDATED. You MUST take a fundamentally different approach.\n"
            "\n"
            f"Invalidation reason: {invalidation_reason}\n"
            "\n"
            "Previous plan (DO NOT repeat this approach):\n"
            f"{previous_plan.rstrip()}\n"
            "</replanning-context>\n"
        )

    return f"""\
<role>
You are a planning agent in a Ralph Driven Development (RDD) pipeline.
Your job: read the spec, explore the codebase, and produce a concrete implementation plan.
</role>

<rules>
- NON-INTERACTIVE: Do not ask questions. Make reasonable assumptions and note them in SCRATCHPAD.md.
- READ-ONLY: Do NOT modify any source code, do NOT create branches, do NOT create commits.
- You MAY run read-only commands: ls, cat, grep, find, git log, git show, git branch, etc.
- Do NOT run tests, builds, or anything that modifies state.
- Only write two files: (1) the plan output file, (2) SCRATCHPAD.md.
</rules>

<spec file="{spec.rel_from_workspace}">
{spec_content.rstrip()}
</spec>

<paths>
- Workspace root (repos live here): {config.workspace_root.as_posix()}
- Ralph home (tooling dir): {paths.ralph_home.as_posix()}
- Spec file: {spec.rel_from_workspace}
- Scratchpad: {paths.scratchpad.as_posix()}
- Plan output file: {plan_output_path.as_posix()}
</paths>

<instructions>
Follow these steps in order:

1. Read and internalize the spec above — identify the target repo, branch instructions, constraints, required reading, and acceptance criteria.
2. Navigate to the target repo and explore the codebase:
   - Read all files listed under "Required Reading" in the spec.
   - Explore existing patterns, tests, and related code.
   - Understand the current state of the branch specified in "Branch Instructions".
3. Produce a concrete, step-by-step implementation plan.
4. Write the plan to: {plan_output_path.as_posix()}
5. Update SCRATCHPAD.md with: what you explored, key findings, why you chose this approach, assumptions made.
</instructions>

<plan-format>
Write exactly this structure to the plan output file:

# Plan: {spec.spec_id}

## Analysis
- Target repo: (name and absolute path)
- Source branch: (branch to start from, per spec's Branch Instructions)
- Feature branch: (branch to create, per spec's Branch Instructions)
- Key files to modify: (list with paths)
- Key files to read for context: (list with paths)
- Approach: (description)
- Risks/trade-offs: (concerns)

## Steps
1. (concrete step with file paths and what to change)
2. (next step)
...

## Verification strategy
- (specific test commands to run, copied/adapted from spec)
- (what to check)
</plan-format>

<output-contract>
STRICT — when finished:
1. Write the plan to the plan output file.
2. Print ONLY this exact magic phrase on its own line as the FINAL non-empty line of your output:
   {config.magic_phrase}

Do not print anything after the magic phrase.
</output-contract>
{replanning_block}"""


def build_implementer_prompt(
    *,
    spec: SpecInfo,
    paths: Paths,
    config: Config,
    spec_content: str,
    verifier_feedback: str | None,
    plan_content: str | None,
) -> str:
    feedback_block = ""
    if verifier_feedback:
        feedback_block = (
            "\n"
            "<verifier-feedback>\n"
            "The last verification attempt FAILED. Fix these issues before anything else:\n"
            "\n"
            f"{verifier_feedback.rstrip()}\n"
            "</verifier-feedback>\n"
        )

    plan_block: str = ""
    if plan_content:
        plan_block = (
            "\n"
            "<implementation-plan>\n"
            "This plan was created by analyzing the spec and codebase. Follow it closely,\n"
            "but adapt if you discover it is wrong or incomplete.\n"
            "\n"
            f"{plan_content.rstrip()}\n"
            "</implementation-plan>\n"
        )

    return f"""\
<role>
You are an autonomous coding agent in a Ralph Driven Development (RDD) pipeline.
Your job: implement the spec precisely, verify your work, and commit.
</role>

<rules>
- NON-INTERACTIVE: Do not ask questions. Make reasonable assumptions and note them in SCRATCHPAD.md.
- You have full access: edit files, run tests, use git, docker, gh, curl, etc.
- Do NOT modify Ralph state dirs (candidates/, done/, runs/) unless the spec explicitly says so.
</rules>

<spec file="{spec.rel_from_workspace}">
{spec_content.rstrip()}
</spec>
{plan_block}
<paths>
- Workspace root: {config.workspace_root.as_posix()}
- Ralph home: {paths.ralph_home.as_posix()}
- Spec file: {spec.rel_from_workspace}
- Scratchpad: {paths.scratchpad.as_posix()}
</paths>

<git-workflow priority="critical">
The spec above contains "Branch Instructions". You MUST follow them precisely.

Step-by-step:
1. cd into the target repo specified by Repo: / Workdir: in the spec.
2. Check out the source branch specified in Branch Instructions (e.g. dev, feature/xyz).
   Run: git checkout [source-branch]
   If the spec says "git pull", do that too.
3. Create the feature branch specified in Branch Instructions:
   Run: git checkout -b [feature-branch]
   If the feature branch already exists (prior attempt), check it out and verify it is based on the correct source branch.
4. Work on the feature branch. All your commits go here.
5. Commit when done. Message format: {spec.spec_id}: [concise description]
6. Before reporting the commit hash, verify HEAD is on the feature branch:
   Run: git rev-parse --abbrev-ref HEAD

Common mistakes to AVOID:
- Do NOT work in detached HEAD state.
- Do NOT create branches from the wrong base (e.g. from master when spec says dev).
- Do NOT forget to cd into the target repo before any git operations.
- Do NOT amend commits from previous specs.
</git-workflow>

<instructions>
Follow these steps in order:

1. Read the spec above. Identify target repo, branch instructions, constraints, tasks, and acceptance criteria.
2. Execute the git workflow: cd into repo → checkout source branch → create feature branch.
3. Implement the spec:
   - If a plan exists above, follow it step by step.
   - If there is verifier feedback below, fix those issues first.
   - Follow the spec's constraints and required patterns.
4. Run verification (fast-first):
   - Run the specific test commands from the spec's "Verification" section.
   - If those pass, you are likely done. Avoid full test suite unless necessary.
5. Commit your changes on the feature branch:
   git add [specific files]
   git commit -m "{spec.spec_id}: [description]"
6. Update SCRATCHPAD.md with: target repo, key decisions, commands run, risks/follow-ups.
</instructions>

<output-contract>
STRICT — when finished, output exactly this sequence:

1. A short DONE REPORT: list changed files, verification commands run, and key notes.
2. The 40-character git commit hash on its own line (output of: git rev-parse HEAD).
3. ONLY this exact magic phrase on its own line as the FINAL non-empty line:
   {config.magic_phrase}

Do not print anything after the magic phrase.
</output-contract>
{feedback_block}"""


def build_verifier_prompt(
    *,
    spec: SpecInfo,
    paths: Paths,
    config: Config,
    spec_content: str,
    candidate_commit: str,
    plan_content: str | None,
) -> str:
    plan_eval_block: str = ""
    if plan_content:
        plan_eval_block = (
            "\n"
            "<plan-evaluation>\n"
            "The implementer followed this plan. If the implementation failed because the\n"
            "plan's fundamental approach is wrong (wrong files, wrong architecture, incorrect\n"
            "assumptions about the codebase), output a line starting with PLAN_INVALIDATION:\n"
            "followed by your specific reason describing what is wrong with the plan.\n"
            "\n"
            "Example: PLAN_INVALIDATION: plan targets billing/admin.py but the logic lives in billing/views.py\n"
            "Example: PLAN_INVALIDATION: assumed queryset uses subquery but it actually uses annotation\n"
            "\n"
            "Only use PLAN_INVALIDATION when the plan's APPROACH itself is wrong,\n"
            "NOT when the implementer just made bugs or missed details.\n"
            "\n"
            f"{plan_content.rstrip()}\n"
            "</plan-evaluation>\n"
        )

    return f"""\
<role>
You are an independent verifier agent in a Ralph Driven Development (RDD) pipeline.
Your job: verify that the spec is truly completed at commit {candidate_commit}.
</role>

<rules>
- NON-INTERACTIVE: Do not ask questions.
- READ-ONLY: Do NOT modify code, do NOT create commits, do NOT create branches.
- You MAY run read-only commands and test commands.
- If you find issues requiring code changes, describe them precisely for the implementer.
</rules>

<spec file="{spec.rel_from_workspace}">
{spec_content.rstrip()}
</spec>

<verification-target>
- Candidate commit: {candidate_commit}
- Spec: {spec.rel_from_specs}
</verification-target>

<paths>
- Workspace root: {config.workspace_root.as_posix()}
- Ralph home: {paths.ralph_home.as_posix()}
- Spec file: {spec.rel_from_workspace}
- Scratchpad: {paths.scratchpad.as_posix()}
</paths>

<verification-procedure>
Follow these steps in order:

1. Read the spec above. Extract and restate all acceptance criteria as a checklist.
2. Identify the target repo from the spec's Repo: / Workdir: fields and cd into it.
3. Verify the candidate commit exists:
   git cat-file -t {candidate_commit}
4. Check out the commit if HEAD is not already there:
   git checkout {candidate_commit}
5. Verify the commit is on the expected feature branch (per spec's Branch Instructions):
   git branch --contains {candidate_commit}
   This should include the feature branch name from the spec.
6. Inspect the changes:
   git show --stat {candidate_commit}
   Review modified files against spec scope.
7. Check each acceptance criterion:
   - Run the verification commands from the spec's "Verification" section.
   - Inspect code changes against spec requirements.
   - Prefer fast, targeted verification over full-suite runs.
8. Decide: VERIFIED or NOT VERIFIED.

Update SCRATCHPAD.md with: what you verified, commands run, and any checkout decisions.
</verification-procedure>

<output-contract>
STRICT — two possible outcomes:

IF VERIFIED:
1. Print a short VERIFICATION REPORT (checklist of acceptance criteria, all passing).
2. Print the candidate commit hash on its own line: {candidate_commit}
3. Print ONLY this exact magic phrase on its own line as the FINAL non-empty line:
   {config.magic_phrase}
Do not print anything after the magic phrase.

IF NOT VERIFIED:
1. Print a detailed FAILURE REPORT:
   - Which acceptance criteria failed and why.
   - Exact commands that showed the failure.
   - Specific, actionable fixes the implementer should make.
2. Do NOT print the magic phrase anywhere in your output.
</output-contract>
{plan_eval_block}"""
