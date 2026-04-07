# Ralph

Ralph is a spec-driven development runner built around the official Codex SDK. It reads markdown specs from `specs/`, creates an isolated git worktree per spec, and executes a supervised multi-agent loop until the spec is either completed or fails review.

This repository is the v2 rewrite. The old Python runner still exists in the tree, but the active implementation documented here is the Node/TypeScript CLI under [`src/`](./src).

## What Ralph Does

For each spec, Ralph runs a fixed role pipeline:

1. `supervisor` chooses any additional review coverage beyond the default pass.
2. `understander` reads the spec and repo, then produces an execution packet.
3. `implementer` makes the change in an isolated worktree and commits it.
4. `reviewers` always run correctness and tests, with optional security and performance review when the supervisor asks for it.
5. `recheck` decides whether the implementation is approved, needs another fix loop, or invalidates the plan.
6. `supervisor` closes the run and writes the final result.

The runner is file-first and local-first:

- Specs stay in `specs/`
- Runtime state stays in `.ralph/`
- Each spec gets a dedicated worktree under `.ralph/worktrees/`
- Human-readable and machine-readable artifacts are written to disk

## Current CLI

The current entrypoint is [`src/cli.ts`](./src/cli.ts). After building, the executable is `dist/src/cli.js`.

### Development commands

```bash
npm install
npm run check
npm test
npm run build
```

### Run Ralph

```bash
# Run all specs
node dist/src/cli.js run

# Run matching specs only
node dist/src/cli.js run 1001-demo

# Dry run
node dist/src/cli.js run --dry-run

# Override workspace root
node dist/src/cli.js run --workspace-root /path/to/workspace

# Override model
node dist/src/cli.js run --model gpt-5.3-codex

# Limit internal review/fix iterations
node dist/src/cli.js run --max-iterations 3

# Inspect parsed spec JSON
node dist/src/cli.js inspect 1001-demo.md

# Inspect a nested spec (path is relative to specs/)
node dist/src/cli.js inspect area/1235-follow-up-spec.md

# Create a new sample spec
node dist/src/cli.js create-spec area/1234-sample-feature.md

# Show runtime state
node dist/src/cli.js status
```

For local development without building first:

```bash
node --import tsx ./src/cli.ts run
```

`run` streams per-spec progress to the terminal with `[current/total]` prefixes, phase changes, and a per-run log path under `.ralph/runs/<spec-id>/<run-id>/events.log`.

## Requirements

- Node.js 20+
- `git`
- A workspace where target repositories live next to `ralph/`
- Codex SDK authentication/config available to the runtime environment

## Directory Layout

```text
ralph/
├── src/                     # TypeScript CLI and orchestration
├── tests/                   # Automated tests
├── codex-support/           # Hook/config bundle copied into worktrees
├── specs/                   # Spec backlog
├── .ralph/
│   ├── artifacts/           # Per-run structured and human-readable artifacts
│   ├── reports/
│   │   └── done/            # Final done reports
│   ├── state/               # Per-spec run state JSON
│   ├── sessions/            # Reserved runtime area
│   ├── runs/                # Per-run terminal/event logs
│   └── worktrees/           # One isolated worktree per spec
├── README.md
└── ralph_docs.md
```

## Spec Compatibility

Ralph v2 is designed to keep using the existing spec backlog format. Specs still live under `specs/` and still use the same `0001-...md` naming style.

To scaffold a new spec file with the required and recommended sections already in place:

```bash
node dist/src/cli.js create-spec 1234-my-new-spec.md
node dist/src/cli.js create-spec area/1235-follow-up-spec.md
```

For a runnable spec, the parser currently requires:

- `Repo: ...`
- `Workdir: ...`
- `## Branch Instructions` with non-empty `Source branch` and `Create branch` values

It also understands and preserves these sections when present:

- `## Goal`
- `## Constraints`
- `## Dependencies`
- `## Required Reading`
- `## Acceptance Criteria`
- `## Verification (Fast-First)`
- `## Big Picture`
- `## Scope (In)`
- `## Boundaries (Out, No Overlap)` or `## Boundaries (Out)`
- `## Commit Requirements`

The scaffolded template includes the fuller recommended spec shape, with placeholders you should fill in before running a real spec.

The `run` command only selects runnable specs. Draft or analysis markdown files that happen to match the filename pattern are ignored until they provide that minimum runnable contract.

### Example spec

````md
# 1001 - Demo Spec

Repo: demo-repo
Workdir: demo-repo

## Branch Instructions
- Source branch: `dev`
- Create branch: `feature/demo`
- PR target: `dev`

## Goal
Make a small, safe change.

## Scope (In)
- Touch one file.

## Boundaries (Out, No Overlap)
- No unrelated refactors.

## Constraints
- Keep it minimal.

## Dependencies
- None.

## Required Reading
- `README.md`

## Acceptance Criteria
- Runner completes the loop.

## Commit Requirements
- Use the requested branch.

## Verification (Fast-First)
```bash
git status --short
```
````

## Runtime Artifacts

Ralph writes its state under `.ralph/` instead of mutating legacy `specs/candidates/`, `specs/plans/`, or `specs/sessions/`.

Important outputs:

- `.ralph/state/<spec-id>.json`
  Current run state, threads, last commit, status, and iteration count.
- `.ralph/artifacts/<spec-id>/<run-id>/`
  Structured JSON outputs and human-readable artifacts from each agent turn.
- `.ralph/runs/<spec-id>/<run-id>/events.log`
  Human-readable per-run progress log matching the streamed terminal phases.
- `.ralph/reports/done/<spec-id>.md`
  Final completion report for a successful spec.
- `.ralph/worktrees/<spec-id>/`
  Git worktree used for the spec run.

Legacy `specs/done/...` markers are still recognized as a skip signal when present, but new successful runs write done reports under `.ralph/reports/done/`.

## Codex Hooks

Ralph copies [`codex-support/`](./codex-support) into each active worktree as `.codex/`.

That bundle currently includes:

- `config.toml`
- `hooks.json`
- `hooks/pre_tool_use_policy.mjs`
- `hooks/post_tool_use_review.mjs`
- `hooks/stop_continue.mjs`

These hooks are intended to keep the workflow constrained and auditable inside the spec worktree.

## Testing

Ralph development now follows TDD for the v2 codepath. The current automated suite covers:

- spec discovery and parsing
- runtime path/state behavior
- injected-backend workflow execution for the supervised loop

Run locally:

```bash
npm run check
npm test
npm run build
```

GitHub Actions runs the same checks on push and pull request through [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

## What Is Not Documented As Supported

The following belonged to the old runner and should not be assumed for v2 unless reintroduced explicitly:

- `python ralph/ralph.py`
- magic-phrase completion parsing
- `specs/candidates/` as the active runtime contract
- `specs/plans/` as the active planner artifact store
- the old implementer/verifier-only pipeline

## More Detail

See [`ralph_docs.md`](./ralph_docs.md) for the fuller architecture and workflow reference.
