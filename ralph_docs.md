Copyright (C) 2026 Zemtu OG

# Ralph v2 Architecture

This document describes the current Ralph implementation in this repository: the SDK-native Node/TypeScript runner, not the older Python loop.

## Summary

Ralph is a local spec runner that:

- reads markdown specs from `specs/` by default, or from a custom `--spec-root`
- resolves the target repository from `Repo:` and `Workdir:`
- creates one isolated git worktree per spec by default
- supports `--checkout-mode root` for repos whose Docker setup is not worktree-safe
- runs a supervised multi-agent Codex workflow
- stores runtime state and artifacts under `.ralph/`
- marks successful specs with a done report under `.ralph/reports/done/`

The design goal is to preserve the old Ralph feel, meaning a file-first backlog and inspectable local artifacts, while replacing the runtime with the official Codex SDK and a stronger role-based loop.

Documentation rule:

- When CLI or runtime behavior changes, update [`README.md`](./README.md) and [`ralph_docs.md`](./ralph_docs.md) in the same change.

## High-Level Flow

For a runnable spec, Ralph executes this sequence:

1. `planning_spec`, `planning_repo`, `planning_risks`
   Build separate read-only planning views over the spec, repository, and failure surface.
2. `supervisor`
   Synthesizes those planning views and chooses any extra review coverage beyond the default correctness/tests pass.
3. `understander`
   Reads the spec, repository, planning views, and supervisor strategy, then emits an `UnderstandingPacket`.
4. `implementer`
   Applies the change in the active checkout and emits an `ImplementationReport`.
5. `reviewers`
   Review the candidate implementation. `correctness` and `tests` always run; `security` and `performance` are added when the supervisor requests them.
   The `tests` reviewer runs only affected-module tests derived from changed files and avoids broad/repo-wide suites during reviewer phase.
6. `review_lead`
   Synthesizes reviewer outputs and may request one targeted stronger re-review for a disputed topic before handing the review set to recheck.
7. Host verification
   Ralph runs the spec's verification commands on the host checkout of the feature branch, then restores the previous branch and passes the transcript into recheck.
8. `recheck`
   Accepts or rejects the synthesized review findings and returns one of:
   - `approve`
   - `needs_fix`
   - `invalidate_plan`
9. `supervisor`
   Produces the final `SupervisorOutcome`.
10. Publication
   After a successful final supervisor approval, Ralph pushes the feature branch and opens or updates the PR before the spec is marked `done`.

If recheck returns `needs_fix`, the loop continues until `maxIterations` is reached.

If recheck returns `invalidate_plan`, Ralph clears planning-helper, supervisor, understander, implementer, reviewer, review-lead, and recheck thread references and starts a fresh stronger planning pass inside the same spec run.

If a spec is rerun after a prior failure, Ralph reuses the stored `lastError` as the restart context so the next planning pass starts from the last known problem instead of a blank slate.
That retry also escalates the first implementation and review pass to the stronger model tier so the rerun does not fall back to the cheap initial policy.

Before execution, Ralph skips any specs that are already done and logs them explicitly.

If `--resume` is used, Ralph skips ahead to the latest feasible checkpoint it can reconstruct from the saved run state and artifacts. It prefers the furthest completed stage, restores saved planning context when it is available, and then continues from there instead of replaying earlier completed work. Ralph only advances the durable checkpoint pointer after it has written a new structured artifact, so an early setup failure does not make the previous resumable run disappear. The CLI prints a checkpoint banner so you can see whether it resumed from planning, reviewing, rechecking, or fell back to a fresh run.

In `--checkout-mode root`, Ralph also runs a recovery audit on ordinary reruns when the repo root is dirty. If the dirty tree can be linked to the same interrupted spec and exactly matches the saved implementation evidence, Ralph emits a `recovery` progress event and re-enters the implementer stage with recovery context instead of failing the setup preflight. If the dirty tree is linked to the same interrupted spec but fails the audit, Ralph writes recovery audit/stash artifacts, stashes the dirty checkout with `git stash push -u`, and restarts from a clean checkout. If the dirty tree cannot be linked to the same spec, Ralph preserves the existing fail-fast behavior and does not stash unrelated work.

## Default Model Policy

Without `--model`, Ralph uses a role-aware default policy:

- `gpt-5.4-mini`
  - `planning_spec`
  - `planning_repo`
  - `planning_risks`
  - first-pass `implementer`
  - first-pass topic reviewers
- `gpt-5.4` with `xhigh`
  - `supervisor`
  - `understander`
  - `review_lead`
  - `recheck`
  - final `supervisor`

If the first implementation or first-pass review is not accepted, Ralph escalates the next implementation attempt or targeted re-review to the stronger policy.

## Source Layout

```text
src/
├── cli.ts         # Command-line interface
├── prompts.ts     # Prompt builders for each role
├── runtime.ts     # Runtime paths, state, worktree management, artifacts
├── specs.ts       # Spec discovery and parsing
├── types.ts       # Shared types
└── workflow.ts    # Codex SDK orchestration
```

### Key modules

#### `src/cli.ts`

Provides the public CLI:

- `run`
- `status`
- `inspect`
- `create-spec`
- `mark-done`

It parses command-line flags, loads specs, resolves `--to` bounded runs, creates runtime directories for real runs, and calls `executeSpec(...)`.

#### `src/specs.ts`

Responsible for:

- discovering runnable specs under the selected spec root
- ignoring legacy state directories such as `done`, `plans`, `sessions`, and `candidates`
- parsing markdown sections into a normalized `SpecDocument`

The parser keeps compatibility with the existing spec backlog format.

#### `src/runtime.ts`

Responsible for:

- building `.ralph/` paths and spec-root namespaces
- loading and saving run state
- writing artifacts and done reports
- writing per-run progress logs under `.ralph/runs/`
- resolving repository paths from workspace-relative spec metadata
- creating and reusing git worktrees
- preparing the repo root checkout when `--checkout-mode root` is requested
- auditing dirty root-checkout reruns and stashing linked mismatches before a fresh restart
- copying `codex-support/` into the active checkout as `.codex/`
- publishing approved branches and pull requests

#### `src/prompts.ts`

Builds the role-specific prompt payloads for:

- planning helpers
- supervisor strategy
- understander
- implementer
- reviewer
- review lead
- recheck
- supervisor final outcome

#### `src/workflow.ts`

Implements the orchestration loop around `@openai/codex-sdk`.

It:

- creates or resumes Codex threads per role
- enforces structured outputs with schemas
- persists thread ids in run state
- writes structured JSON artifacts for each turn
- emits progress events for terminal streaming and `.ralph/runs/.../events.log`
- emits `recovery` progress events and persists recovery audit/stash artifacts for root-mode reruns
- loops review/recheck iterations with role-aware model escalation
- enters a dedicated `publishing` phase after approval
- writes the final done report on success
- seeds reruns from a prior `lastError` when a spec has already failed once, so `--to` retries start from the prior failure context
- supports `--resume` by loading the latest feasible checkpoint from saved state and artifacts, then continuing from that stage when possible

Dry-run special case:

- does not create worktrees or switch the repo root checkout
- does not create `.ralph/state`, `.ralph/artifacts`, `.ralph/runs`, or `codex-home`
- does not write event logs
- only validates dry-run preconditions and prints what Ralph would do

## Runtime Layout

The active runtime root is `.ralph/` for the default local `specs/` backlog.

```text
.ralph/
├── artifacts/
│   └── <spec-id>/<run-id>/
├── reports/
│   └── done/
├── runs/
├── sessions/
├── state/
│   └── <spec-id>.json
└── worktrees/
    └── <spec-id>/
```

When `--spec-root` points anywhere other than the default local `specs/` directory, Ralph writes to a namespaced runtime root:

```text
.ralph/spec-roots/<derived-id>/
├── artifacts/
├── reports/
├── runs/
├── sessions/
├── state/
└── worktrees/
```

### What each area means

- `.ralph/state/<spec-id>.json`
  The authoritative per-spec state file.
- `.ralph/artifacts/<spec-id>/<run-id>/`
  Structured outputs from every role, plus human-readable understanding artifacts.
- `.ralph/runs/<spec-id>/<run-id>/events.log`
  Human-readable progress log for the streamed workflow phases.
- `.ralph/reports/done/<spec-id>.md`
  Final success report.
- `.ralph/worktrees/<spec-id>/`
  The isolated git worktree for the spec.

`sessions/` still exists as part of the runtime structure, while `runs/` now stores per-run progress logs.

## Spec Contract

Ralph still expects specs to be markdown files named with a numeric prefix such as:

- `0001-seed.md`
- `area/0002-feature.md`
- `1001-demo.md`

The current parser recognizes:

- preamble lines:
  - `Repo: ...`
  - `Workdir: ...`
- section headers:
  - `## Branch Instructions`
  - `## Big Picture`
  - `## Goal`
  - `## Scope (In)`
  - `## Boundaries (Out, No Overlap)`
  - `## Boundaries (Out)`
  - `## Constraints`
  - `## Dependencies`
  - `## Required Reading`
  - `## Acceptance Criteria`
  - `## Commit Requirements`
  - `## Verification (Fast-First)`

### Branch Instructions

`## Branch Instructions` is important in v2 because the worktree is branch-aware. It currently supports:

- `Source branch: ...`
- `Create branch: ...`
- `PR target: ...`
- `Next spec base: ...`
- `Open a PR for this spec branch.`
- `Open a **draft** PR for this spec branch.`
- `Apply labels: \`...\`, \`...\`.`

The `Source branch` and `Create branch` fields are required.

For a runnable spec, `Repo:`, `Workdir:`, and non-empty `Source branch` / `Create branch` values are the hard parser requirements. The remaining sections are parsed when present and scaffolded by `create-spec` because they produce better execution packets and reviews.

Publication defaults:

- Ralph always pushes the approved branch.
- Ralph always opens or updates a PR.
- The PR is draft by default unless the spec explicitly says `Open a PR for this spec branch.`
- Ralph always applies the `Prototype` label.
- `Apply labels: ...` adds extra labels on top of `Prototype`.
- Ralph carries issue-reference lines from the spec branch commits into the PR body so issue linkage survives PR-based merging.
- If the target repo has a PR template, Ralph fills that template instead of posting a bare summary body.
- If a requested GitHub label does not exist yet, Ralph creates it before applying it.

The `run` command only picks runnable specs from the backlog. Draft or analysis files that match the filename pattern but do not satisfy that minimum contract are ignored until they are filled in.

## Run State Model

The current `RunState.status` values are:

- `queued`
- `planning`
- `implementing`
- `reviewing`
- `rechecking`
- `done`
- `failed`

Each state file also stores:

- `currentIteration`
- `runId`
- `checkoutMode`
- `worktreePath`
- `lastCommit`
- `lastError`
- `updatedAt`
- thread ids for all agent roles
- `legacyDoneDetected`

## Structured Outputs

Ralph v2 does not rely on magic phrases or stdout parsing for correctness. Instead, each role is required to return JSON matching a strict schema.

Important payloads:

- `PlanningView`
  Ralph derives `PlanningView.lens` from the planning-helper role (`planning_spec`, `planning_repo`, `planning_risks`) and treats the model response as the body only.
- `SupervisorStrategy`
- `UnderstandingPacket`
- `ImplementationReport`
- `ReviewerReport`
- `ReviewLeadReport`
- `RecheckVerdict`
- `SupervisorOutcome`

This is the main runtime shift from the old Ralph loop.

## Checkout Behavior

Default mode is `--checkout-mode worktree`. Each spec gets a stable worktree path:

```text
.ralph/worktrees/<spec-id>/
```

If the worktree already exists on the expected feature branch, Ralph reuses it. Otherwise it removes the old worktree and recreates it from the source branch declared by the spec.

Before either reuse or recreation, Ralph prunes stale git worktree registrations so a missing-but-registered worktree path does not block the run.

After worktree creation, Ralph copies `codex-support/` into:

```text
.ralph/worktrees/<spec-id>/.codex/
```

That gives every spec run its own local Codex hook/config bundle.

`--checkout-mode root` is the fallback for repositories where Docker, bind mounts, or compose project naming make Ralph worktrees unusable. In this mode Ralph:

- reuses the repository root itself as the active checkout
- supports the same spec-selection shapes as ordinary runs, including `--to`
- snapshots the selected specs before branch switching so later spec reads stay stable even when the spec root lives inside the target repo
- requires a clean repository and refuses detached HEAD, except for same-spec interrupted reruns that pass the root recovery audit
- checks out or creates each spec feature branch directly in the repo root
- leaves the repo on the last processed branch after setup and after the run
- refuses to overwrite an existing user-owned `.codex/` directory in the repo root
- exposes `/var/run` to implementer and reviewer sandboxes when the spec's verification commands reference Docker

For root-mode recovery Ralph links the dirty checkout to the interrupted spec by checking the current feature branch, saved root-mode run state, saved understanding artifact, and saved `events.log` evidence that the implementer had already started. It then audits the current dirty file set against the saved expected file list, runs `git diff --check` plus `git diff --cached --check`, and, when no implementation artifact exists yet, requires matching implementer session evidence from `codex-home/sessions/`. Passing audits continue automatically. Failing linked audits stash and restart. Unlinked dirty checkouts still fail immediately.

Candidate validation uses the full branch diff from `merge-base..HEAD`, not just the final commit, so multi-commit branches are judged as a branch rather than as one isolated patch commit.

The spec's `Verification (Fast-First)` commands are executed by Ralph itself on the host checkout of the feature branch. The feature branch is checked out only for the duration of the verification commands and the previous branch is restored immediately afterward so the transcript can be handed to recheck without leaving the checkout in a different state.

## Legacy Compatibility

What remains compatible:

- existing markdown specs
- existing spec directory layout under `specs/`
- legacy `done/...` markers inside the selected spec root as a signal to skip already-completed specs

What is no longer the active runtime contract:

- `python ralph/ralph.py`
- planner/implementer/verifier magic-phrase completion parsing
- `specs/candidates/` as the active candidate state
- `specs/plans/` as the active planning state

The old Python files are still present in the repository, but they are not the current runtime described here.

## Commands

### Install and verify

Ralph is not currently published as a public npm package. This repository is the install source.

```bash
npm install
npm run check
npm test
npm run build
```

### Install options

If you are operating Ralph from this repository, the lightest setup is:

```bash
npm install
```

Then run it directly:

```bash
npm run dev -- --help
npm run dev -- --dry-run
```

If you want a machine-level `ralph` command, link this repository as a CLI:

```bash
npm install
npm run build
npm link
```

Then use:

```bash
ralph --help
ralph --dry-run
```

Because the package is still private, there is no public `npm install -g ralph` or `npx ralph` flow yet.

### Recommended Local Usage

When you are working inside this repository, prefer the dev script instead of calling the compiled file directly.

```bash
npm run dev
```

### Run selected specs

```bash
npm run dev -- 1001-demo
```

### Dry run

```bash
npm run dev -- --dry-run
npm run dev -- --dryrun
npm run dev -- --spec-root ../zemtu/docs/plans/payment-toolbox/specs --dry-run
npm run dev -- --workspace-root ../zemtu --spec-root ../zemtu/docs/specs/payment-toolbox --dry-run 2003-stop-runtime-effective-date-usage
npm run dev -- 2003-stop-runtime-effective-date-usage --checkout-mode root
```

Dry-run is read-only. It prints spec-indexed progress lines, but it does not create worktrees, switch a repo root checkout, create state files, write artifacts, or write event logs.

### Run through a target spec

```bash
npm run dev -- --to 1003
```

`--to <spec>` takes the ordered spec list up to the matching target spec and starts from the first spec in that bounded range that is not already done.
Any already-done specs in the selected run are skipped and printed before execution starts. Ralph stops at the first failed spec instead of continuing through later specs in the batch.

During a real `run`, Ralph prints spec-indexed progress lines such as `[1/3] planning iter 1/5 ...` and tells you where the matching `.ralph/runs/<spec-id>/<run-id>/events.log` file lives.

`run` is the default command, so `npm run dev -- --dry-run` is equivalent to `npm run dev -- run --dry-run`.

### Status

```bash
npm run dev -- status
```

### Help

```bash
npm run dev -- --help
```

### Inspect parsed spec output

```bash
npm run dev -- inspect 1001-demo.md
npm run dev -- inspect --spec-root ../zemtu/docs/plans/payment-toolbox/specs 1001-payment-toolbox.md
```

### Create a sample spec

```bash
npm run dev -- create-spec 1234-my-new-spec.md
npm run dev -- create-spec area/1235-follow-up-spec.md
npm run dev -- create-spec --spec-root ../zemtu/docs/plans/payment-toolbox/specs 1001-payment-toolbox.md
```

This command creates a new markdown file under the selected spec root and prepopulates it with:

- required sections the parser/runtime currently depend on
- recommended sections that help produce better execution packets and reviews
- placeholder branch instructions and verification blocks

### Mark a spec done manually

```bash
npm run dev -- mark-done 1001-demo
```

Use this when a spec was resolved outside Ralph and you want future runs to skip it. The command sets the persisted run state to `done`, clears prior failure/invalidation context for that spec, and writes a manual report under `.ralph/reports/done/`.

### Installed CLI Usage

If you want the cleaner command form outside the repo wrapper:

```bash
npm run build
npm link

ralph --dry-run
ralph --dryrun
ralph --to 1003
ralph --spec-root ../zemtu/docs/plans/payment-toolbox/specs
ralph 1001-demo
ralph mark-done 1001-demo
ralph status
ralph inspect 1001-demo.md
ralph create-spec area/1235-follow-up-spec.md
```

### Low-Level Fallback

The compiled entrypoint is still available, but it should mostly be treated as a packaging/debugging fallback:

```bash
node dist/src/cli.js run --dry-run
```

## Testing And CI

The current automated test suite covers:

- `tests/specs.test.ts`
  Spec discovery and parsing behavior.
- `tests/runtime.test.ts`
  Runtime path and initial state behavior.
- `tests/workflow.test.ts`
  End-to-end supervised workflow execution using an injected fake Codex backend.

GitHub Actions runs:

1. `npm ci`
2. `npm run check`
3. `npm test`
4. `npm run build`

The workflow file is:

- [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)

## Operational Notes

- Ralph is local-first. It expects to operate on repositories already present in the workspace.
- The CLI exposes `run`, `status`, `inspect`, and `create-spec`. There is no dedicated `resume` command yet because persistent state plus stable worktree paths already provide the base for restart-safe execution.
- `--to <spec>` is the built-in bounded batch operator flow for sequential backlog execution.
- `--workspace-root <path>` accepts either an absolute path or a path relative to the Ralph project root.
- `--spec-root <path>` accepts either an absolute path or a path relative to the Ralph project root. Positional spec paths remain relative to that selected spec root.
- If a custom spec root lives inside the target repo and is missing on the current checkout, Ralph falls back to reading specs from `origin/HEAD` and emits a one-time warning with the fallback ref.
- `--dry-run` is intentionally non-persistent: no `.ralph/` writes happen during dry-run.
- The current review loop is capped by `--max-iterations` (default: `5`).
- Success is determined by structured agent outputs and the recheck verdict, not by heuristics on plain terminal output.

## Recommended Next Documentation Updates

If the runtime expands, the next docs worth adding are:

- a migration note from Python v1 to TypeScript v2
- an operator guide for `.ralph/state/*.json`
- a spec authoring guide with several real examples
- a hook policy reference for `codex-support/`
