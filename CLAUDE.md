# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Documentation sync rule:

- When CLI or runtime behavior changes, update `README.md` and `ralph_docs.md` in the same change.

## Overview

Ralph is an autonomous spec-based development runner for AI coding agents. It orchestrates the Codex SDK to implement specs in a multi-agent pipeline: **plan → implement → review → recheck**. A spec is only marked complete after it passes a structured review and recheck phase.

This repository contains the **v2 rewrite** in TypeScript. The legacy Python implementation still exists but the active development is in `src/`.

## Commands

```bash
# Basic run (from workspace root)
npm run dev

# Run specific spec(s) or filters
npm run dev -- 1001-demo area/0002

# Dry run (preview without running agents)
npm run dev -- --dry-run

# Run sequentially through a target spec
npm run dev -- --to 1003

# Override workspace root
npm run dev -- --workspace-root /path/to/workspace

# Override model for all roles
npm run dev -- --model gpt-5.4

# List run states
ralph status

# Inspect a spec file
ralph inspect specs/1001-demo.md

# Create a new spec from template
ralph create-spec area/1234-new-feature.md
```

## Architecture

### Multi-Agent Pipeline

1. **Planning**: `planning_spec`, `planning_repo`, and `planning_risks` roles analyze the task from different angles.
2. **Strategy**: `supervisor` role synthesizes plans into a strategy.
3. **Execution Packet**: `understander` role creates the concrete implementation plan.
4. **Implementation**: `implementer` role modifies code in an isolated git worktree.
5. **Review**: Multiple topic reviewers (`correctness`, `tests`, `security`, `performance`) validate the change.
6. **Synthesis**: `review_lead` summarizes the findings.
7. **Approval**: `recheck` role decides if the implementation is approved, needs a fix loop, or if the plan was invalid.

### Directory Structure

```
.
├── src/               # TypeScript implementation
├── tests/             # Vitest test suite
├── .ralph/            # Runtime state and artifacts
│   ├── state/         # Per-spec RunState JSON
│   ├── artifacts/     # Per-run role outputs and usage logs
│   ├── runs/          # Per-run event logs (events.log)
│   ├── reports/       # Final done/failed reports
│   └── worktrees/     # Isolated git worktrees per spec
├── specs/             # Spec backlog (markdown)
└── codex-support/     # Hooks and config for implementation worktrees
```

### Key Files

- `src/cli.ts`: Argument parsing and main orchestration.
- `src/workflow.ts`: Core pipeline logic and role execution.
- `src/runtime.ts`: State persistence, worktree management, and file utilities.
- `src/types.ts`: Shared TypeScript interfaces and types.
- `src/prompts.ts`: Prompt templates for each agent role.

## Writing Specs

Specs must be named with a 4-digit prefix: `1001-feature-name.md`.

### Required Sections

- **Repo**: Target repository name.
- **Workdir**: Subdirectory within the repo (usually same as Repo).
- **Goal**: Clear description of what to achieve.
- **Acceptance criteria**: Measurable outcomes.
- **Verification**: Bash commands to verify the change (e.g., `pytest` or `npm test`).

## Runtime State

Ralph tracks progress in `.ralph/state/<spec-id>.json`. If a run is interrupted, it resumes from the last successful phase. Use `--dry-run` to see what Ralph would do without executing any agents.
