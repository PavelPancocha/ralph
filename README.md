# Ralph

**Ralph Driven Development (RDD)** — an autonomous spec-based development runner for AI coding agents.

Ralph orchestrates AI agents (via [Codex](https://github.com/openai/codex)) to implement specs in a controlled, verifiable loop. Each spec goes through implementation and independent verification before being marked complete.
xxxx
## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        SPEC PIPELINE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   specs/0001-feature.md                                         │
│           │                                                     │
│           ▼                                                     │
│   ┌───────────────┐                                             │
│   │ IMPLEMENTER   │  Codex implements spec, commits, outputs:   │
│   │    (Phase A)  │  • DONE REPORT                              │
│   └───────┬───────┘  • <commit-hash>                            │
│           │          • I AM HYPER SURE I AM DONE!               │
│           ▼                                                     │
│   specs/candidates/0001-feature.json  (candidate marker)        │
│           │                                                     │
│           ▼                                                     │
│   ┌───────────────┐                                             │
│   │   VERIFIER    │  Independent run validates the commit:      │
│   │    (Phase B)  │  • Reads spec & checks acceptance criteria  │
│   └───────┬───────┘  • Runs targeted verification (fast-first)  │
│           │          • Does NOT modify code                     │
│           ▼                                                     │
│   specs/done/0001-feature.md  (verified completion)             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

A spec is **only marked done** after an independent verification run confirms the implementation at the exact candidate commit.

## Features

- **Two-phase verification** — Implementation and verification are separate agent runs
- **Multi-repo workspaces** — Specs can target different repos in your workspace
- **Automatic retries** — Configurable retry with exponential backoff
- **Resume support** — Safe to restart; picks up from candidates or done state
- **Rate limit handling** — Detects usage limits and waits automatically
- **Structured logging** — Text or JSON logs for observability
- **Colorized output** — Clear status indicators in terminal

## Quick Start

```bash
# From anywhere in your workspace
python ralph/ralph.py

# Stream agent output live
python ralph/ralph.py --stream-agent-output

# Dry run (shows what would execute)
python ralph/ralph.py --dry-run
```

## Directory Structure

```
ralph/
├── ralph.py           # The runner
├── SCRATCHPAD.md      # Shared memory for agent handover
├── ralph.log          # Runner event log
├── specs/
│   ├── 0001-feature.md      # Spec files (your backlog)
│   ├── area/0002-api.md     # Nested specs supported
│   ├── candidates/          # Candidate completion markers
│   │   └── 0001-feature.json
│   └── done/                # Verified completion markers
│       └── 0001-feature.md
└── runs/
    └── 0001-feature/        # Attempt logs per spec
        └── 20250115-143022Z/
            ├── impl-attempt-1.log
            └── verify.log
```

## Writing Specs

Specs must be named with a 4-digit prefix: `0001-your-feature.md`

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
- Maintain test coverage

## Required reading

- `webhooks/delivery.py`
- `webhooks/tests/test_delivery.py`

## Acceptance criteria

- Webhook delivery retries up to 3 times on failure
- Exponential backoff between retries
- Failed deliveries logged with reason

## Verification (fast-first)

```bash
pytest webhooks/tests/test_delivery.py -v
```
```

### Best Practices

- **One spec = one logical PR** — Keep specs small and focused
- **Deterministic steps only** — Avoid conditional logic in specs
- **List required reading** — Helps agent understand context faster
- **Acceptance criteria are measurable** — Tie each to a test or observable
- **Verification is fast-first** — Targeted tests over full suite

## CLI Options

| Option | Description |
|--------|-------------|
| `--stream-agent-output` | Show agent output in real-time |
| `--dry-run` | Preview without running Codex |
| `--force SPEC [SPEC ...]` | Force re-run specific specs |
| `--workspace-root PATH` | Override workspace root |
| `--max-attempts-per-spec N` | Max retries per spec (default: 10) |
| `--magic-phrase PHRASE` | Custom completion phrase |
| `--json-logs` | Output logs as JSONL |
| `--no-color` | Disable colored output |
| `--codex-exe PATH` | Path to codex executable |
| `--codex-args ARGS` | Additional codex arguments |

## Examples

```bash
# Force re-run a specific spec
python ralph/ralph.py --force 0003-feature.md

# Override workspace root
python ralph/ralph.py --workspace-root /path/to/workspace

# Increase max attempts
python ralph/ralph.py --max-attempts-per-spec 20

# JSON logs for parsing
python ralph/ralph.py --json-logs
```

## Completion Contract

Both implementer and verifier must satisfy this strict output format:

```
[... agent output ...]

<DONE REPORT or VERIFICATION REPORT>

49cd4de0f0dfb466f1a162eff8d915588b073f92
I AM HYPER SURE I AM DONE!
```

- Second-to-last non-empty line: 40-character git commit hash
- Last non-empty line: magic phrase (exactly as configured)

## Troubleshooting

### Spec keeps retrying

Check `runs/<spec_id>/<timestamp>/` for:
- `impl-attempt-*.log` — Implementation output
- `verify.log` — Verification output

Common causes:
- Agent not printing strict completion format
- Verifier failing acceptance criteria
- Rate limiting (check for "usage_limit" in logs)

### Candidate exists but never completes

The verifier is failing. Check verify logs and fix issues the verifier identifies.

### Multi-repo confusion

Add explicit `Repo:` and `Workdir:` to specs so agents `cd` into the correct directory.

## Documentation

For detailed documentation, see [ralph_docs.md](ralph_docs.md).

