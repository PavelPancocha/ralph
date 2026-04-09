# Ralph

Ralph is a spec-driven development runner built around the official Codex SDK. It reads markdown specs from `specs/`, creates an isolated git worktree per spec, and executes a supervised multi-agent loop until the spec is either completed or fails review.

This repository is the v2 rewrite. The old Python runner still exists in the tree, but the active implementation documented here is the Node/TypeScript CLI under [`src/`](./src).

Documentation rule:

- When CLI or runtime behavior changes, update [`README.md`](./README.md) and [`ralph_docs.md`](./ralph_docs.md) in the same change.

## What Ralph Does

For each spec, Ralph runs a fixed role pipeline:

1. `planning_spec`, `planning_repo`, and `planning_risks` build separate read-only views of the spec, repository, and likely failure surface.
2. `supervisor` synthesizes those views into a strategy and optional extra review coverage.
3. `understander` turns that strategy into the concrete execution packet.
4. `implementer` makes the change in an isolated worktree and commits it.
5. Topic reviewers always run `correctness` and `tests`, with optional `security` and `performance` when the supervisor asks for them.
6. `review_lead` synthesizes the review set and can request one targeted stronger re-review when a topic is still ambiguous or high risk.
7. `recheck` decides whether the implementation is approved, needs another fix loop, or invalidates the plan.
8. `supervisor` closes the run and writes the final result.

The runner is file-first and local-first:

- Specs stay in `specs/`
- Runtime state stays in `.ralph/`
- Each spec gets a dedicated worktree under `.ralph/worktrees/`
- Human-readable and machine-readable artifacts are written to disk

## CLI Usage

The active CLI entrypoint is [`src/cli.ts`](./src/cli.ts).

Ralph is not currently published as a public npm package. This repository is the install source.

In normal use, prefer:

- `npm run dev -- ...` while working inside this repository
- `ralph ...` after linking or installing the package

The raw compiled file `dist/src/cli.js` still exists, but it should be treated as a low-level fallback rather than the primary operator interface.

### Development commands

```bash
npm install
npm run check
npm test
npm run build
```

### Install

If you just want to run Ralph from this repository, installation is:

```bash
npm install
```

Then run it directly from the repo:

```bash
npm run dev -- --help
npm run dev -- --dry-run
npm run dev -- --to 1003
```

If you want a real `ralph` command on your machine, install this repository as a linked CLI:

```bash
npm install
npm run build
npm link
```

Then use:

```bash
ralph --help
ralph --dry-run
ralph --to 1003
```

Because the package is currently private and not published, there is no `npm install -g ralph` or `npx ralph` flow yet. If we want that level of simplicity, the next step is to publish the package or ship release binaries.

### Run Ralph Locally

Inside this repository, the friendliest way to use Ralph is through the existing dev script:

```bash
# Run all specs
npm run dev

# Run matching specs only
npm run dev -- 1001-demo

# Dry run
npm run dev -- --dry-run

# Compact dry-run alias
npm run dev -- --dryrun

# Run sequentially through a target spec, starting at the first
# spec in that range that is not already done
npm run dev -- --to 1003

# Override workspace root
npm run dev -- --workspace-root /path/to/workspace

# Override all Ralph-managed roles to one model
npm run dev -- --model gpt-5.4

# Limit internal review/fix iterations
npm run dev -- --max-iterations 3

# Inspect parsed spec JSON
npm run dev -- inspect 1001-demo.md

# Inspect a nested spec (path is relative to specs/)
npm run dev -- inspect area/1235-follow-up-spec.md

# Create a new sample spec
npm run dev -- create-spec area/1234-sample-feature.md

# Show runtime state
npm run dev -- status

# Show CLI help
npm run dev -- --help
```

`run` is the default command, so the common path does not need the explicit `run` subcommand. `npm run dev -- --dry-run` is equivalent to `npm run dev -- run --dry-run`.

### Use As A Real CLI

If you want a cleaner operator experience outside the repo command wrapper:

```bash
npm run build
npm link

# Then use the linked CLI directly
ralph --help
ralph --dry-run
ralph --dryrun
ralph --to 1003
ralph 1001-demo
ralph status
ralph inspect 1001-demo.md
ralph create-spec area/1234-sample-feature.md
```

Explicit subcommands still work when you want them:

```bash
ralph run --dry-run
```

### Low-Level Fallback

Only use the compiled path directly if you are debugging the packaged entrypoint:

```bash
node dist/src/cli.js run --dry-run
```

`run` streams per-spec progress to the terminal with `[current/total]` prefixes, phase changes, and a per-run log path under `.ralph/runs/<spec-id>/<run-id>/events.log`.

`--to <spec>` runs sequentially through the ordered backlog up to the matching target spec and starts from the first spec in that bounded range that is not already done.

`--dry-run` is truly read-only. It does not create worktrees, runtime state, event logs, artifacts, or `codex-home`. It only validates dry-run preconditions and prints what Ralph would do.

When Ralph creates or reuses a real spec worktree, it prunes stale git worktree registrations first. That keeps interrupted or manually deleted worktrees from blocking the next run.

Without `--model`, Ralph uses a smart role policy by default:

- `gpt-5.4-mini` for planning helpers, first-pass implementation, and first-pass topic reviews
- `gpt-5.4` with `xhigh` reasoning for supervisor, understander, review lead, recheck, and final closeout
- implementation and targeted review escalation move from the cheaper first pass to the stronger policy only after rejection or invalidation

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

Dry-run exception:

- `--dry-run` does not populate `.ralph/`
- no worktree is created
- no state, artifact, or event-log files are written
- terminal output is the only dry-run output

## Spec Compatibility

Ralph v2 is designed to keep using the existing spec backlog format. Specs still live under `specs/` and still use the same `0001-...md` naming style.

To scaffold a new spec file with the required and recommended sections already in place:

```bash
npm run dev -- create-spec 1234-my-new-spec.md
npm run dev -- create-spec area/1235-follow-up-spec.md
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

Before creating or reusing a real worktree, Ralph prunes stale git worktree registrations so missing-but-registered paths do not block the run.

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

- CLI parsing and progress output
- spec discovery and parsing
- runtime path/state behavior
- injected-backend workflow execution for the supervised loop
- role-aware model selection and escalation behavior
- targeted review-lead follow-up behavior

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
