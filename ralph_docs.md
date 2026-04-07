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

## High-Level Flow

For a runnable spec, Ralph executes this sequence:

1. `supervisor`
   Chooses any additional review coverage beyond the default correctness/tests pass.
2. `understander`
   Reads the spec and repository, then emits an `UnderstandingPacket`.
3. `implementer`
   Applies the change in the active worktree and emits an `ImplementationReport`.
4. `reviewers`
   Review the candidate implementation. `correctness` and `tests` always run; `security` and `performance` are added when the supervisor requests them.
5. `recheck`
   Accepts or rejects reviewer findings and returns one of:
   - `approve`
   - `needs_fix`
   - `invalidate_plan`
6. `supervisor`
   Produces the final `SupervisorOutcome`.

If recheck returns `needs_fix`, the loop continues until `maxIterations` is reached.

If recheck returns `invalidate_plan`, Ralph clears the understander/implementer/reviewer/recheck thread references and starts a fresh planning pass inside the same spec run.

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

It parses command-line flags, loads specs, creates runtime directories, and calls `executeSpec(...)`.

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
- resolving repository paths from workspace-relative spec metadata
- creating and reusing git worktrees
- copying `codex-support/` into the worktree as `.codex/`

#### `src/prompts.ts`

Builds the role-specific prompt payloads for:

- supervisor strategy
- understander
- implementer
- reviewer
- recheck
- supervisor final outcome

#### `src/workflow.ts`

Implements the orchestration loop around `@openai/codex-sdk`.

It:

- creates or resumes Codex threads per role
- enforces structured outputs with schemas
- persists thread ids in run state
- writes structured JSON artifacts for each turn
- loops review/recheck iterations
- writes the final done report on success

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
- `.ralph/reports/done/<spec-id>.md`
  Final success report.
- `.ralph/worktrees/<spec-id>/`
  The isolated git worktree for the spec.

`runs/` and `sessions/` already exist as part of the runtime structure even though the current implementation does not yet use them heavily.

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

- `SupervisorStrategy`
- `UnderstandingPacket`
- `ImplementationReport`
- `ReviewerReport`
- `RecheckVerdict`
- `SupervisorOutcome`

This is the main runtime shift from the old Ralph loop.

## Worktree Behavior

Each spec gets a stable worktree path:

```text
.ralph/worktrees/<spec-id>/
```

If the worktree already exists on the expected feature branch, Ralph reuses it. Otherwise it removes the old worktree and recreates it from the source branch declared by the spec.

After worktree creation, Ralph copies `codex-support/` into:

```text
.ralph/worktrees/<spec-id>/.codex/
```

That gives every spec run its own local Codex hook/config bundle.

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

```bash
npm install
npm run check
npm test
npm run build
```

### Run

```bash
node dist/src/cli.js run
```

### Run selected specs

```bash
node dist/src/cli.js run 1001-demo
```

### Dry run

```bash
node dist/src/cli.js run --dry-run
```

### Status

```bash
node dist/src/cli.js status
```

### Inspect parsed spec output

```bash
node dist/src/cli.js inspect 1001-demo.md
```

### Create a sample spec

```bash
node dist/src/cli.js create-spec 1234-my-new-spec.md
node dist/src/cli.js create-spec area/1235-follow-up-spec.md
```

This command creates a new markdown file under `specs/` and prepopulates it with:

- required sections the parser/runtime currently depend on
- recommended sections that help produce better execution packets and reviews
- placeholder branch instructions and verification blocks

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
- The CLI currently exposes `run`, `status`, and `inspect`. There is no dedicated `resume` command yet because persistent state plus stable worktree paths already provide the base for restart-safe execution.
- The current review loop is capped by `--max-iterations`.
- Success is determined by structured agent outputs and the recheck verdict, not by heuristics on plain terminal output.

## Recommended Next Documentation Updates

If the runtime expands, the next docs worth adding are:

- a migration note from Python v1 to TypeScript v2
- an operator guide for `.ralph/state/*.json`
- a spec authoring guide with several real examples
- a hook policy reference for `codex-support/`
