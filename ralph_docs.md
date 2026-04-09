Copyright (C) 2026 Zemtu OG

# Ralph v2 Architecture

This document describes the current Ralph implementation in this repository: the SDK-native Node/TypeScript runner, not the older Python loop.

## Summary

Ralph is a local spec runner that:

- reads markdown specs from `specs/`
- resolves the target repository from `Repo:` and `Workdir:`
- creates one isolated git worktree per spec
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
   Applies the change in the active worktree and emits an `ImplementationReport`.
5. `reviewers`
   Review the candidate implementation. `correctness` and `tests` always run; `security` and `performance` are added when the supervisor requests them.
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

If recheck returns `needs_fix`, the loop continues until `maxIterations` is reached.

If recheck returns `invalidate_plan`, Ralph clears planning-helper, supervisor, understander, implementer, reviewer, review-lead, and recheck thread references and starts a fresh stronger planning pass inside the same spec run.

If a spec is rerun after a prior failure, Ralph reuses the stored `lastError` as the restart context so the next planning pass starts from the last known problem instead of a blank slate.
That retry also escalates the first implementation and review pass to the stronger model tier so the rerun does not fall back to the cheap initial policy.

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

It parses command-line flags, loads specs, resolves `--to` bounded runs, creates runtime directories for real runs, and calls `executeSpec(...)`.

#### `src/specs.ts`

Responsible for:

- discovering runnable specs under `specs/`
- ignoring legacy state directories such as `done`, `plans`, `sessions`, and `candidates`
- parsing markdown sections into a normalized `SpecDocument`

The parser keeps compatibility with the existing spec backlog format.

#### `src/runtime.ts`

Responsible for:

- building `.ralph/` paths
- loading and saving run state
- writing artifacts and done reports
- writing per-run progress logs under `.ralph/runs/`
- resolving repository paths from workspace-relative spec metadata
- creating and reusing git worktrees
- copying `codex-support/` into the worktree as `.codex/`

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
- loops review/recheck iterations with role-aware model escalation
- writes the final done report on success
- seeds reruns from a prior `lastError` when a spec has already failed once, so `--to` retries start from the prior failure context

Dry-run special case:

- does not create worktrees
- does not create `.ralph/state`, `.ralph/artifacts`, `.ralph/runs`, or `codex-home`
- does not write event logs
- only validates dry-run preconditions and prints what Ralph would do

## Runtime Layout

The active runtime root is `.ralph/`.

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

The `Source branch` and `Create branch` fields are required.

For a runnable spec, `Repo:`, `Workdir:`, and non-empty `Source branch` / `Create branch` values are the hard parser requirements. The remaining sections are parsed when present and scaffolded by `create-spec` because they produce better execution packets and reviews.

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
- `SupervisorStrategy`
- `UnderstandingPacket`
- `ImplementationReport`
- `ReviewerReport`
- `ReviewLeadReport`
- `RecheckVerdict`
- `SupervisorOutcome`

This is the main runtime shift from the old Ralph loop.

## Worktree Behavior

Each spec gets a stable worktree path:

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

Candidate validation uses the full branch diff from `merge-base..HEAD`, not just the final commit, so multi-commit branches are judged as a branch rather than as one isolated patch commit.

The spec's `Verification (Fast-First)` commands are executed by Ralph itself on the host checkout of the feature branch. The feature branch is checked out only for the duration of the verification commands and the previous branch is restored immediately afterward so the transcript can be handed to recheck without leaving the checkout in a different state.

## Legacy Compatibility

What remains compatible:

- existing markdown specs
- existing spec directory layout under `specs/`
- legacy `specs/done/...` markers as a signal to skip already-completed specs

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
```

Dry-run is read-only. It prints spec-indexed progress lines, but it does not create worktrees, state files, artifacts, or event logs.

### Run through a target spec

```bash
npm run dev -- --to 1003
```

`--to <spec>` takes the ordered spec list up to the matching target spec and starts from the first spec in that bounded range that is not already done.

During a real `run`, Ralph prints spec-indexed progress lines such as `[1/3] planning iter 1/3 ...` and tells you where the matching `.ralph/runs/<spec-id>/<run-id>/events.log` file lives.

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
```

### Create a sample spec

```bash
npm run dev -- create-spec 1234-my-new-spec.md
npm run dev -- create-spec area/1235-follow-up-spec.md
```

This command creates a new markdown file under `specs/` and prepopulates it with:

- required sections the parser/runtime currently depend on
- recommended sections that help produce better execution packets and reviews
- placeholder branch instructions and verification blocks

### Installed CLI Usage

If you want the cleaner command form outside the repo wrapper:

```bash
npm run build
npm link

ralph --dry-run
ralph --dryrun
ralph --to 1003
ralph 1001-demo
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
- `--dry-run` is intentionally non-persistent: no `.ralph/` writes happen during dry-run.
- The current review loop is capped by `--max-iterations`.
- Success is determined by structured agent outputs and the recheck verdict, not by heuristics on plain terminal output.

## Recommended Next Documentation Updates

If the runtime expands, the next docs worth adding are:

- a migration note from Python v1 to TypeScript v2
- an operator guide for `.ralph/state/*.json`
- a spec authoring guide with several real examples
- a hook policy reference for `codex-support/`
