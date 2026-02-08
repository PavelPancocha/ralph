# Planning Phase for Ralph

**Date:** 2026-02-08
**Status:** Approved

## Problem

Ralph currently runs a two-phase pipeline: implement then verify. The implementer receives only the raw spec and must figure out the approach on its own. This leads to wasted attempts when the agent picks a wrong approach that only gets caught during verification. A dedicated planning phase would front-load codebase analysis and produce a concrete plan before any code changes happen.

## Design

### Updated Pipeline

```
spec -> plan -> implement -> verify -> done
                    ^                    |
                    +------ (retry) -----+
                    ^                    |
         plan <-----+-- (invalidate) ---+
```

**Phases:**
1. **Planner** - reads spec, explores codebase (read-only), writes implementation plan
2. **Implementer** - follows the plan, commits code
3. **Verifier** - validates the implementation, can invalidate the plan if approach was wrong

### State Model

| State | Marker | Meaning |
|-------|--------|---------|
| Not started | nothing | Fresh spec |
| Planned | `specs/plans/<rel>.md` + `.json` with `status: "active"` | Plan ready |
| Candidate | `specs/candidates/<rel>.json` | Implementation done, needs verification |
| Done | `specs/done/<rel>.md` | Verified and complete |

### Directory Structure

```
specs/
  plans/
    0001-foo.md              # active plan (human-readable)
    0001-foo.json            # metadata (status, attempt count, invalidation reason)
    0001-foo.attempt-1.md    # historical invalidated plan (kept for reference)
    area/0002-bar.md         # nested specs mirrored
    area/0002-bar.json
```

### Resume Behavior

Ralph checks `specs/plans/<rel>.json` on startup:
- **Missing json AND missing md** -> fresh plan needed
- **json with `status: "active"` AND md exists** -> skip planning, proceed to implement
- **json with `status: "invalidated"`** -> re-plan with old plan + reason as context
- **md exists but no json** -> treat as active (hand-written plan), create json

### Plan Invalidation Flow

1. Verifier concludes the plan approach itself was wrong (not just implementation bugs)
2. Verifier includes `PLAN_INVALIDATION: <reason>` in failure output
3. Ralph detects marker, parses reason
4. Ralph renames `<rel>.md` to `<rel>.attempt-N.md` (preserving history)
5. Ralph updates `<rel>.json` to `status: "invalidated"` with reason and timestamp
6. Next iteration: planner re-runs with previous plan + invalidation reason as context
7. New plan written to `<rel>.md`, json updated to `status: "active"`, attempt incremented

Normal verify failures (bugs, missed criteria) keep the plan active and re-run implementation with verifier feedback, same as today.

## Planner Phase Details

### Completion Contract

Simpler than impl/verify since there is no commit:
1. Plan file must exist at `specs/plans/<rel>.md` and be non-empty
2. Last non-empty output line must be the magic phrase
3. No commit hash required

### Planner Prompt

The planner receives:
- Full spec text
- Paths (workspace root, ralph home, plan output path)
- SCRATCHPAD content
- If re-planning: previous plan content + invalidation reason

The planner is allowed to:
- Run commands to explore the codebase (read files, list dirs, grep, etc.)
- Read any file in the workspace

The planner must NOT:
- Modify any code
- Create commits
- Change anything outside `specs/plans/` and `SCRATCHPAD.md`

### Plan Output Format

The agent writes this to `specs/plans/<rel>.md`:

```markdown
# Plan: <spec-id>

## Analysis
- Target repo: ...
- Key files: ...
- Approach: ...
- Risks/trade-offs: ...

## Steps
1. ...
2. ...
3. ...

## Verification strategy
- ...
```

## Updated Implementer Prompt

The implementer prompt gains a new section injected between paths and the mission:

```
## Implementation Plan

The following plan was created by analyzing the spec and codebase.
Follow this plan closely. If you discover the plan is wrong or
incomplete, adapt and still complete the implementation.

<plan content>
```

Everything else in the implementer prompt stays the same.

## Updated Verifier Prompt

The verifier prompt gains plan evaluation responsibility:

```
## Plan evaluation

You also received the implementation plan that guided the implementer.
If the implementation failed due to a fundamentally flawed plan
(wrong approach, wrong files, incorrect assumptions about the codebase),
include this EXACT line in your failure report:

PLAN_INVALIDATION: <one-line reason why the plan approach is wrong>

Only use PLAN_INVALIDATION when the plan's approach itself is wrong,
NOT when the implementer just made bugs or missed details.
```

The verifier also receives the plan content so it can distinguish bad execution from bad strategy.

## Code Changes

### New/Modified Data Structures

```python
# SessionPhase expanded
SessionPhase: TypeAlias = Literal["plan", "impl", "verify"]

# New dataclass
@dataclass(frozen=True)
class PlanInfo:
    spec_rel: str
    spec_id: str
    status: str          # "active" | "invalidated"
    created_at_utc: str
    invalidated_at_utc: str | None
    invalidation_reason: str | None
    attempt: int

# Paths gains plans_root
@dataclass(frozen=True)
class Paths:
    # ... existing fields ...
    plans_root: Path     # specs/plans/
```

### New Functions

| Function | Purpose |
|----------|---------|
| `plan_path_for_spec(paths, rel)` | `specs/plans/<rel>.md` |
| `plan_meta_path_for_spec(paths, rel)` | `specs/plans/<rel>.json` |
| `load_plan_info(paths, rel)` | Read json metadata, return `PlanInfo` or None |
| `save_plan_info(paths, info)` | Write json metadata |
| `load_plan_content(paths, rel)` | Read plan `.md` text, return str or None |
| `invalidate_plan(paths, rel, reason)` | Rename md to attempt-N, update json |
| `build_planner_prompt(spec, paths, config, prev_plan, invalidation_reason)` | Planner prompt |
| `run_planner(spec, paths, config, logger, prev_plan, invalidation_reason)` | Execute planner Codex run |
| `planner_completed(output, plan_path, phrase)` | Check plan file exists + magic phrase |
| `parse_plan_invalidation(output)` | Extract `PLAN_INVALIDATION: ...` from verifier output |

### Updated `run_spec_pipeline` Flow

```
1. skip if done (and not forced)
2. load plan info
   - if no active plan: run planner phase
   - if planner fails: retry with backoff (counts against max_attempts)
3. load plan content
4. if candidate exists: verify (with plan context)
5. else: implement (with plan context) -> candidate -> verify
6. on verify pass: done
7. on verify fail with PLAN_INVALIDATION:
   - invalidate plan (archive old, save reason)
   - loop to step 2
8. on verify fail (normal):
   - re-implement with feedback (keep plan)
   - loop to step 5
```

### Run Log Filenames

```
runs/<spec_id>/<timestamp>/
  plan-attempt-1.log      # NEW
  impl-attempt-1.log
  verify.log
```

### No New CLI Flags

Zero configuration. Planning always runs. Plans are reused automatically.
