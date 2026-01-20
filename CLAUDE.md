# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Ralph is an autonomous spec-based development runner for AI coding agents. It orchestrates [Codex](https://github.com/openai/codex) to implement specs in a two-phase loop: **implement → verify → done**. A spec is only marked complete after an independent verification run confirms the implementation.

## Commands

```bash
# Basic run (from workspace root)
python ralph/ralph.py

# Stream agent output live
python ralph/ralph.py --stream-agent-output

# Dry run (preview without running Codex)
python ralph/ralph.py --dry-run

# Force re-run specific spec(s)
python ralph/ralph.py --force 0003-feature.md area/0007-bugfix.md

# Override workspace root
python ralph/ralph.py --workspace-root /path/to/workspace

# Override max attempts (default: 10)
python ralph/ralph.py --max-attempts-per-spec 20

# JSON logs for parsing
python ralph/ralph.py --json-logs
```

## Architecture

### Two-Phase Pipeline

1. **Phase A (Implementer)**: Codex implements the spec, commits, and outputs:
   - DONE REPORT
   - 40-char commit hash (own line)
   - Magic phrase: `I AM HYPER SURE I AM DONE!` (final line)

2. **Phase B (Verifier)**: Independent Codex run validates the candidate commit:
   - Reads spec and checks acceptance criteria
   - Runs targeted verification (fast-first)
   - Does NOT modify code
   - If verified, outputs same commit hash + magic phrase

### Directory Structure

```
ralph/
├── ralph.py           # The runner
├── SCRATCHPAD.md      # Shared memory for agent handover
├── ralph.log          # Runner event log
├── specs/
│   ├── 0001-*.md      # Spec files (your backlog)
│   ├── area/0002-*.md # Nested specs supported
│   ├── candidates/    # Candidate completion markers (.json)
│   └── done/          # Verified completion markers (.md)
└── runs/
    └── <spec_id>/<timestamp>/
        ├── impl-attempt-*.log
        └── verify.log
```

### Key Files

- `ralph.py` - Single-file runner (~1300 lines)
- `SCRATCHPAD.md` - Agent handover notes (read/update between runs)
- `specs/` - Spec backlog (only `^\d{4}-.*\.md$` files are executed)
- `ralph.log` - Runner events (text or JSONL)

## Writing Specs

Specs must be named with 4-digit prefix: `0001-your-feature.md`

### Recommended Structure

```markdown
# 0007 - Add webhook retries

Repo: my-service
Workdir: my-service

## Goal
Add retry logic for failed webhook deliveries.

## Dependencies
- 0006-webhook-base.md

## Constraints
- Follow existing patterns in `webhooks/`

## Required reading
- `webhooks/delivery.py`

## Acceptance criteria
- Webhook delivery retries up to 3 times
- Exponential backoff between retries

## Verification (fast-first)
```bash
pytest webhooks/tests/test_delivery.py -v
```
```

### Best Practices

- **One spec = one logical PR** — Keep specs small and focused
- **Deterministic steps only** — Avoid conditional logic
- **List required reading** — Helps agent understand context faster
- **Acceptance criteria are measurable** — Tie to tests or observables
- **Verification is fast-first** — Targeted tests over full suite
- **Explicit dependencies** — Mark prerequisites in Dependencies section

## Resume Behavior

Safe to restart at any time:
- Specs with `done/` marker are skipped
- Specs with `candidates/` but no `done/` marker → Ralph tries verification first
- If verification fails → re-runs implementation with verifier feedback

## Defaults

- **Magic phrase**: `I AM HYPER SURE I AM DONE!`
- **Max attempts**: 10
- **Workspace root**: Parent of `ralph/` directory
- **Codex args**: `exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check`
