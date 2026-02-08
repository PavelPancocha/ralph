# Planning Phase Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a planning phase to Ralph's pipeline so the flow becomes: spec -> plan -> implement -> verify -> done, with plan invalidation support.

**Architecture:** All changes are in `ralph.py` (single-file runner). We add a `PlanInfo` dataclass and `plans_root` to `Paths`, new plan state functions (load/save/invalidate), a planner prompt builder, a `run_planner()` function, a `parse_plan_invalidation()` helper, and rewire `run_spec_pipeline()` to run planning first and handle plan invalidation from the verifier.

**Tech Stack:** Python 3.12, no new dependencies

---

### Task 1: Add `PlanInfo` dataclass and expand `SessionPhase`

**Files:**
- Modify: `ralph.py:90` (SessionPhase)
- Modify: `ralph.py:93-104` (after Paths dataclass area)
- Modify: `ralph.py:141-148` (SessionInfo — add plan_session_id)

**Step 1: Edit `SessionPhase` type alias**

At line 90, change:
```python
SessionPhase: TypeAlias = Literal["impl", "verify"]
```
to:
```python
SessionPhase: TypeAlias = Literal["plan", "impl", "verify"]
```

**Step 2: Add `plans_root` to `Paths` dataclass**

At line 94, add `plans_root: Path` field after `sessions_root`:
```python
@dataclass(frozen=True)
class Paths:
    ralph_home: Path
    scratchpad: Path
    runs_root: Path

    specs_root: Path
    candidates_root: Path
    done_root: Path
    sessions_root: Path
    plans_root: Path

    runner_log: Path
```

**Step 3: Add `PlanInfo` dataclass**

Insert after the `SessionInfo` dataclass (after line 148):
```python
@dataclass(frozen=True)
class PlanInfo:
    spec_rel: str
    spec_id: str
    status: str  # "active" | "invalidated"
    created_at_utc: str
    invalidated_at_utc: str | None
    invalidation_reason: str | None
    attempt: int
```

**Step 4: Add `plan_session_id` to `SessionInfo`**

Update `SessionInfo` to include `plan_session_id`:
```python
@dataclass(frozen=True)
class SessionInfo:
    spec_rel: str
    spec_id: str
    plan_session_id: str | None
    impl_session_id: str | None
    verify_session_id: str | None
    updated_at_utc: str
```

**Step 5: Verify syntax**

Run: `python -c "import ast; ast.parse(open('ralph.py').read()); print('OK')"`
Expected: `OK`

**Step 6: Commit**

```bash
git add ralph.py
git commit -m "Add PlanInfo dataclass, plans_root to Paths, plan to SessionPhase"
```

---

### Task 2: Update `build_paths`, `discover_specs`, session load/save, and `main` for `plans_root`

**Files:**
- Modify: `ralph.py:418-429` (build_paths)
- Modify: `ralph.py:474-504` (discover_specs — exclude plans_root)
- Modify: `ralph.py:560-625` (session load/save/update — handle plan_session_id)
- Modify: `ralph.py:1375-1500` (main — mkdir plans_root, log it)

**Step 1: Update `build_paths` to include `plans_root`**

```python
def build_paths(ralph_home: Path) -> Paths:
    specs_root = ralph_home / "specs"
    return Paths(
        ralph_home=ralph_home,
        scratchpad=ralph_home / "SCRATCHPAD.md",
        runs_root=ralph_home / "runs",
        specs_root=specs_root,
        candidates_root=specs_root / "candidates",
        done_root=specs_root / "done",
        sessions_root=specs_root / "sessions",
        plans_root=specs_root / "plans",
        runner_log=ralph_home / "ralph.log",
    )
```

**Step 2: Exclude `plans_root` from spec discovery**

In `discover_specs`, add `plans_root` to the exclusion check:
```python
if (
    is_under_dir(p, paths.candidates_root)
    or is_under_dir(p, paths.done_root)
    or is_under_dir(p, paths.sessions_root)
    or is_under_dir(p, paths.plans_root)
):
    continue
```

**Step 3: Update `load_session_info` to handle `plan_session_id`**

```python
def load_session_info(paths: Paths, rel_from_specs: str) -> SessionInfo | None:
    spath: Path = session_path_for_spec(paths, rel_from_specs)
    if not spath.exists():
        return None
    try:
        raw: dict[str, Any] = json.loads(spath.read_text(encoding="utf-8"))
        return SessionInfo(
            spec_rel=raw["spec_rel"],
            spec_id=raw["spec_id"],
            plan_session_id=raw.get("plan_session_id"),
            impl_session_id=raw.get("impl_session_id"),
            verify_session_id=raw.get("verify_session_id"),
            updated_at_utc=raw["updated_at_utc"],
        )
    except Exception:
        return None
```

**Step 4: Update `save_session_info` to include `plan_session_id`**

```python
def save_session_info(paths: Paths, info: SessionInfo) -> Path:
    spath: Path = session_path_for_spec(paths, info.spec_rel)
    spath.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {
        "spec_rel": info.spec_rel,
        "spec_id": info.spec_id,
        "plan_session_id": info.plan_session_id,
        "impl_session_id": info.impl_session_id,
        "verify_session_id": info.verify_session_id,
        "updated_at_utc": info.updated_at_utc,
    }
    spath.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return spath
```

**Step 5: Update `update_session_info` to handle `"plan"` phase**

```python
def update_session_info(
    *,
    paths: Paths,
    spec: SpecInfo,
    phase: SessionPhase,
    session_id: str,
) -> SessionInfo:
    existing: SessionInfo | None = load_session_info(paths, spec.rel_from_specs)
    plan_session_id: str | None = existing.plan_session_id if existing else None
    impl_session_id: str | None = existing.impl_session_id if existing else None
    verify_session_id: str | None = existing.verify_session_id if existing else None
    if phase == "plan":
        plan_session_id = session_id
    elif phase == "impl":
        impl_session_id = session_id
    else:
        verify_session_id = session_id
    updated_at_utc: str = datetime.now(timezone.utc).isoformat()
    info: SessionInfo = SessionInfo(
        spec_rel=spec.rel_from_specs,
        spec_id=spec.spec_id,
        plan_session_id=plan_session_id,
        impl_session_id=impl_session_id,
        verify_session_id=verify_session_id,
        updated_at_utc=updated_at_utc,
    )
    save_session_info(paths, info)
    return info
```

**Step 6: Update `get_resume_session_id` to handle `"plan"` phase**

```python
def get_resume_session_id(paths: Paths, rel_from_specs: str, phase: SessionPhase) -> str | None:
    info: SessionInfo | None = load_session_info(paths, rel_from_specs)
    if not info:
        return None
    if phase == "plan":
        return info.plan_session_id
    if phase == "impl":
        return info.impl_session_id
    return info.verify_session_id
```

**Step 7: In `main()`, add `plans_root` mkdir and logging**

After `paths.sessions_root.mkdir(...)`, add:
```python
paths.plans_root.mkdir(parents=True, exist_ok=True)
```

In the `logger.log("run_start", ...)` call, add:
```python
plans_root=paths.plans_root.as_posix(),
```

**Step 8: Verify syntax**

Run: `python -c "import ast; ast.parse(open('ralph.py').read()); print('OK')"`
Expected: `OK`

**Step 9: Commit**

```bash
git add ralph.py
git commit -m "Wire plans_root into Paths, discovery exclusion, session handling, and main"
```

---

### Task 3: Add plan state functions (load/save/invalidate/content)

**Files:**
- Modify: `ralph.py` — insert new functions after `session_path_for_spec` (around line 444), before the spec discovery section

**Step 1: Add path helpers**

Insert after `session_path_for_spec`:
```python
def plan_path_for_spec(paths: Paths, rel_from_specs: str) -> Path:
    return (paths.plans_root / rel_from_specs).with_suffix(".md")


def plan_meta_path_for_spec(paths: Paths, rel_from_specs: str) -> Path:
    return (paths.plans_root / rel_from_specs).with_suffix(".json")
```

**Step 2: Add `load_plan_info`**

```python
def load_plan_info(paths: Paths, rel_from_specs: str) -> PlanInfo | None:
    mpath: Path = plan_meta_path_for_spec(paths, rel_from_specs)
    ppath: Path = plan_path_for_spec(paths, rel_from_specs)
    if mpath.exists():
        try:
            raw: dict[str, Any] = json.loads(mpath.read_text(encoding="utf-8"))
            return PlanInfo(
                spec_rel=raw["spec_rel"],
                spec_id=raw["spec_id"],
                status=raw.get("status", "active"),
                created_at_utc=raw["created_at_utc"],
                invalidated_at_utc=raw.get("invalidated_at_utc"),
                invalidation_reason=raw.get("invalidation_reason"),
                attempt=raw.get("attempt", 1),
            )
        except Exception:
            return None
    # Hand-written plan: .md exists but no .json — treat as active
    if ppath.exists() and ppath.read_text(encoding="utf-8").strip():
        now_utc: str = datetime.now(timezone.utc).isoformat()
        info = PlanInfo(
            spec_rel=rel_from_specs,
            spec_id=Path(rel_from_specs).stem,
            status="active",
            created_at_utc=now_utc,
            invalidated_at_utc=None,
            invalidation_reason=None,
            attempt=1,
        )
        save_plan_info(paths, info)
        return info
    return None
```

**Step 3: Add `save_plan_info`**

```python
def save_plan_info(paths: Paths, info: PlanInfo) -> Path:
    mpath: Path = plan_meta_path_for_spec(paths, info.spec_rel)
    mpath.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {
        "spec_rel": info.spec_rel,
        "spec_id": info.spec_id,
        "status": info.status,
        "created_at_utc": info.created_at_utc,
        "invalidated_at_utc": info.invalidated_at_utc,
        "invalidation_reason": info.invalidation_reason,
        "attempt": info.attempt,
    }
    mpath.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return mpath
```

**Step 4: Add `load_plan_content`**

```python
def load_plan_content(paths: Paths, rel_from_specs: str) -> str | None:
    ppath: Path = plan_path_for_spec(paths, rel_from_specs)
    if not ppath.exists():
        return None
    content: str = ppath.read_text(encoding="utf-8")
    if not content.strip():
        return None
    return content
```

**Step 5: Add `invalidate_plan`**

```python
def invalidate_plan(paths: Paths, rel_from_specs: str, reason: str) -> PlanInfo:
    """Archive current plan as attempt-N.md and mark metadata as invalidated."""
    info: PlanInfo | None = load_plan_info(paths, rel_from_specs)
    current_attempt: int = info.attempt if info else 1
    created_at: str = info.created_at_utc if info else datetime.now(timezone.utc).isoformat()

    # Rename active plan to attempt-N
    ppath: Path = plan_path_for_spec(paths, rel_from_specs)
    if ppath.exists():
        archive_name: str = ppath.stem + f".attempt-{current_attempt}" + ppath.suffix
        archive_path: Path = ppath.with_name(archive_name)
        ppath.rename(archive_path)

    now_utc: str = datetime.now(timezone.utc).isoformat()
    updated: PlanInfo = PlanInfo(
        spec_rel=rel_from_specs,
        spec_id=Path(rel_from_specs).stem,
        status="invalidated",
        created_at_utc=created_at,
        invalidated_at_utc=now_utc,
        invalidation_reason=reason,
        attempt=current_attempt,
    )
    save_plan_info(paths, updated)
    return updated
```

**Step 6: Verify syntax**

Run: `python -c "import ast; ast.parse(open('ralph.py').read()); print('OK')"`
Expected: `OK`

**Step 7: Commit**

```bash
git add ralph.py
git commit -m "Add plan state functions: load/save/invalidate/content"
```

---

### Task 4: Add `build_planner_prompt` and `parse_plan_invalidation`

**Files:**
- Modify: `ralph.py` — insert in the Prompting section (after ~line 660, before `build_implementer_prompt`)

**Step 1: Add `PLAN_INVALIDATION_RE` constant**

Insert near the other regex constants (around line 199):
```python
PLAN_INVALIDATION_RE: Final[re.Pattern[str]] = re.compile(
    r"^PLAN_INVALIDATION:\s*(.+)$",
    re.MULTILINE,
)
```

**Step 2: Add `parse_plan_invalidation` helper**

Insert near the other parse helpers (after `parse_tokens_used`):
```python
def parse_plan_invalidation(output_text: str) -> str | None:
    match: re.Match[str] | None = PLAN_INVALIDATION_RE.search(output_text)
    if not match:
        return None
    return match.group(1).strip()
```

**Step 3: Add `planner_completed` helper**

Insert near `completion_tuple`:
```python
def planner_completed(output_text: str, plan_path: Path, phrase: str) -> bool:
    if not plan_path.exists():
        return False
    content: str = plan_path.read_text(encoding="utf-8")
    if not content.strip():
        return False
    lines: list[str] = [ln.strip() for ln in output_text.splitlines() if ln.strip()]
    return bool(lines) and lines[-1] == phrase
```

**Step 4: Add `build_planner_prompt`**

Insert before `build_implementer_prompt` in the Prompting section:
```python
def build_planner_prompt(
    *,
    spec: SpecInfo,
    paths: Paths,
    config: Config,
    previous_plan: str | None,
    invalidation_reason: str | None,
) -> str:
    plan_output_path: Path = plan_path_for_spec(paths, spec.rel_from_specs)

    replanning_block: str = ""
    if previous_plan and invalidation_reason:
        replanning_block = (
            "\n"
            "IMPORTANT: A previous plan was invalidated. Learn from its mistakes.\n"
            "\n"
            f"Invalidation reason: {invalidation_reason}\n"
            "\n"
            "Previous plan (DO NOT repeat the same approach):\n"
            "\n"
            f"{previous_plan.rstrip()}\n"
            "\n"
        )

    return f"""You are a planning agent in a Ralph Driven Development (RDD) pipeline.

NON-INTERACTIVE RULE: Do not ask the user questions. Make reasonable assumptions and record them in SCRATCHPAD.md.

Paths:

* Workspace root (repos live here): {config.workspace_root.as_posix()}
* Ralph home (tooling dir): {paths.ralph_home.as_posix()}
* Spec file (relative to workspace root): {spec.rel_from_workspace}
* Spec file (relative to specs root): {spec.rel_from_specs}
* Scratchpad: {paths.scratchpad.as_posix()}
* Plan output file: {plan_output_path.as_posix()}

Mission:

* Read and understand the spec fully.
* Explore the codebase to understand the target repo structure, existing patterns, and relevant files.
* Produce a concrete, step-by-step implementation plan.
* Write the plan to the plan output file above.

Constraints:

* READ-ONLY: Do NOT modify any code, do NOT create commits. Only write the plan file and update SCRATCHPAD.md.
* You may run any read-only commands: ls, cat, grep, find, git log, git show, etc.
* Do NOT run tests, builds, or anything that modifies state.

Plan format (write this to the plan output file):

```markdown
# Plan: {spec.spec_id}

## Analysis
- Target repo: <repo name and path>
- Key files to modify: <list with paths>
- Key files to read for context: <list with paths>
- Approach: <description of the approach>
- Risks/trade-offs: <any concerns>

## Steps
1. <concrete step with file paths and what to do>
2. <next step>
...

## Verification strategy
- <specific test commands to run>
- <what to check>
```

Update SCRATCHPAD.md with:

* What you explored and key findings
* Why you chose this approach
* Any assumptions you made

Output contract (STRICT):

1. Write the plan to the plan output file.
2. Print ONLY this exact magic phrase on its own line as the FINAL non-empty line:
   {config.magic_phrase}

Do not print anything after the magic phrase.
{replanning_block}
Now read the spec and plan the implementation.
"""
```

**Step 5: Verify syntax**

Run: `python -c "import ast; ast.parse(open('ralph.py').read()); print('OK')"`
Expected: `OK`

**Step 6: Commit**

```bash
git add ralph.py
git commit -m "Add planner prompt, planner_completed check, and plan invalidation parser"
```

---

### Task 5: Update `build_implementer_prompt` and `build_verifier_prompt`

**Files:**
- Modify: `ralph.py` — `build_implementer_prompt` and `build_verifier_prompt` functions

**Step 1: Add `plan_content` parameter to `build_implementer_prompt`**

Update the signature to accept `plan_content: str | None`:
```python
def build_implementer_prompt(
    *,
    spec: SpecInfo,
    paths: Paths,
    config: Config,
    verifier_feedback: str | None,
    plan_content: str | None,
) -> str:
```

Add the plan block after the paths section, before Mission. Insert this after the State dirs block:
```python
    plan_block: str = ""
    if plan_content:
        plan_block = (
            "\n"
            "Implementation Plan (created by analyzing the spec and codebase — follow closely,\n"
            "but adapt if you discover it is wrong or incomplete):\n"
            "\n"
            f"{plan_content.rstrip()}\n"
            "\n"
        )
```

Then inject `{plan_block}` in the f-string between the State dirs block and the Mission block.

**Step 2: Add `plan_content` parameter to `build_verifier_prompt`**

Update the signature:
```python
def build_verifier_prompt(
    *,
    spec: SpecInfo,
    paths: Paths,
    config: Config,
    candidate_commit: str,
    plan_content: str | None,
) -> str:
```

Add a plan evaluation section at the end of the verifier prompt (before the closing `"""`):
```python
    plan_eval_block: str = ""
    if plan_content:
        plan_eval_block = (
            "\n"
            "Plan evaluation:\n"
            "\n"
            "The implementer followed this plan:\n"
            "\n"
            f"{plan_content.rstrip()}\n"
            "\n"
            "If the implementation failed due to a fundamentally flawed plan\n"
            "(wrong approach, wrong files, incorrect assumptions about the codebase),\n"
            "include this EXACT line in your failure report:\n"
            "\n"
            "PLAN_INVALIDATION: <one-line reason why the plan approach is wrong>\n"
            "\n"
            "Only use PLAN_INVALIDATION when the plan's APPROACH itself is wrong,\n"
            "NOT when the implementer just made bugs or missed details.\n"
        )
```

Inject `{plan_eval_block}` at the end of the verifier prompt f-string.

**Step 3: Verify syntax**

Run: `python -c "import ast; ast.parse(open('ralph.py').read()); print('OK')"`
Expected: `OK`

**Step 4: Commit**

```bash
git add ralph.py
git commit -m "Update implementer and verifier prompts to include plan content"
```

---

### Task 6: Add `run_planner` function

**Files:**
- Modify: `ralph.py` — insert after `run_codex` / before `verify_candidate` (in the core pipeline section)

**Step 1: Add `run_planner` function**

```python
def run_planner(
    *,
    spec: SpecInfo,
    paths: Paths,
    config: Config,
    logger: Logger,
    previous_plan: str | None,
    invalidation_reason: str | None,
    attempt: int,
) -> tuple[bool, str]:
    """
    Returns (success, planner_output_text).
    Success means: plan file exists, non-empty, and magic phrase in output.
    """
    plan_run_dir: Path = make_run_dir(paths, spec.spec_id)
    plan_prompt: str = build_planner_prompt(
        spec=spec,
        paths=paths,
        config=config,
        previous_plan=previous_plan,
        invalidation_reason=invalidation_reason,
    )
    resume_session_id: str | None = get_resume_session_id(paths, spec.rel_from_specs, "plan")

    logger.log(
        "plan_start",
        spec=spec.rel_from_specs,
        attempt=attempt,
        run_dir=to_rel_posix(plan_run_dir, paths.ralph_home),
        replanning=previous_plan is not None,
    )

    try:
        res: CodexRunResult = run_codex(
            codex_exe=config.codex_exe,
            codex_args=config.codex_args,
            prompt=plan_prompt,
            workspace_root=config.workspace_root,
            stream_to_console=config.stream_output,
            resume_session_id=resume_session_id,
        )
    except Exception:
        err = traceback.format_exc()
        write_run_log(plan_run_dir, "plan-exception.log", err)
        logger.log("plan_exception", spec=spec.rel_from_specs, attempt=attempt, error=err)
        return False, "[exception]\n" + err

    write_run_log(plan_run_dir, f"plan-attempt-{attempt}.log", res.output_text)
    summary: dict[str, Any] = summarize_output(res.output_text)
    tokens_used: int | None = parse_tokens_used(res.output_text)
    session_id: str | None = parse_session_id(res.output_text)
    if session_id is not None:
        update_session_info(paths=paths, spec=spec, phase="plan", session_id=session_id)

    plan_file: Path = plan_path_for_spec(paths, spec.rel_from_specs)
    completed: bool = planner_completed(res.output_text, plan_file, config.magic_phrase)

    logger.log(
        "plan_run_complete",
        spec=spec.rel_from_specs,
        attempt=attempt,
        exit_code=res.exit_code,
        completed=completed,
        plan_file_exists=plan_file.exists(),
        session_id=session_id,
        resumed_from_session=resume_session_id,
        tokens_used=tokens_used,
        run_dir=to_rel_posix(plan_run_dir, paths.ralph_home),
        **summary,
    )

    # Handle usage limits
    usage_text: str = output_tail(res.output_text, max_lines=USAGE_LIMIT_TAIL_LINES)
    if not completed and looks_like_usage_limit(usage_text):
        reset: int | None = parse_reset_seconds(usage_text)
        wait_s: int
        reason: str
        msg: str
        if reset is not None:
            wait_s = reset + 30
            reason = "reset_seconds"
            msg = f"usage limit reached during plan; sleeping {wait_s}s before retry"
        else:
            wait_s = DEFAULT_USAGE_LIMIT_WAIT_SECONDS
            reason = "unknown_reset"
            msg = f"usage limit reached during plan; sleeping {wait_s}s before retry (no reset info)"
        logger.log(
            "usage_limit_wait",
            phase="plan",
            spec=spec.rel_from_specs,
            attempt=attempt,
            wait_seconds=wait_s,
            reset_seconds=reset,
            reason=reason,
        )
        print_status("wait", msg, color="yellow", enabled=config.color_output)
        time.sleep(wait_s)
        return False, res.output_text

    if completed:
        # Save plan metadata
        plan_info: PlanInfo | None = load_plan_info(paths, spec.rel_from_specs)
        new_attempt: int = (plan_info.attempt + 1) if (plan_info and plan_info.status == "invalidated") else 1
        if plan_info and plan_info.status == "active":
            new_attempt = plan_info.attempt
        else:
            new_attempt = (plan_info.attempt + 1) if plan_info else 1
        active_info: PlanInfo = PlanInfo(
            spec_rel=spec.rel_from_specs,
            spec_id=spec.spec_id,
            status="active",
            created_at_utc=datetime.now(timezone.utc).isoformat(),
            invalidated_at_utc=None,
            invalidation_reason=None,
            attempt=new_attempt,
        )
        save_plan_info(paths, active_info)
        logger.log(
            "plan_pass",
            spec=spec.rel_from_specs,
            attempt=attempt,
            plan_attempt=new_attempt,
            plan_file=to_rel_posix(plan_file, paths.ralph_home),
        )

    return completed, res.output_text
```

**Step 2: Verify syntax**

Run: `python -c "import ast; ast.parse(open('ralph.py').read()); print('OK')"`
Expected: `OK`

**Step 3: Commit**

```bash
git add ralph.py
git commit -m "Add run_planner function for the planning phase"
```

---

### Task 7: Rewire `run_spec_pipeline` for plan -> implement -> verify flow

This is the core change. The pipeline logic needs to:
1. Ensure an active plan exists before implementing
2. Pass plan content to implementer and verifier prompts
3. Handle `PLAN_INVALIDATION` from verifier output
4. Update all `build_implementer_prompt` and `build_verifier_prompt` call sites

**Files:**
- Modify: `ralph.py` — `run_spec_pipeline` function (lines ~1061-1334)
- Modify: `ralph.py` — `verify_candidate` function (lines ~916-1058, pass plan_content through)

**Step 1: Update `verify_candidate` to accept and pass `plan_content`**

Add `plan_content: str | None` parameter:
```python
def verify_candidate(
    *,
    spec: SpecInfo,
    paths: Paths,
    config: Config,
    logger: Logger,
    candidate: CandidateInfo,
    attempt: int,
    plan_content: str | None,
) -> tuple[bool, str]:
```

Update the `build_verifier_prompt` call inside to pass `plan_content`:
```python
    verify_prompt: str = build_verifier_prompt(
        spec=spec,
        paths=paths,
        config=config,
        candidate_commit=candidate.candidate_commit,
        plan_content=plan_content,
    )
```

**Step 2: Rewrite `run_spec_pipeline`**

Replace the entire function body with the new flow:

```python
def run_spec_pipeline(
    *,
    spec: SpecInfo,
    paths: Paths,
    config: Config,
    logger: Logger,
    done_set: set[str],
) -> SpecResult:
    """
    For a single spec:
    - If done and not forced: skip
    - Ensure active plan exists (run planner if needed)
    - If candidate exists: verify; if verified mark done
    - Otherwise: implement -> candidate -> verify -> done
    - On verify fail with PLAN_INVALIDATION: invalidate plan, re-plan, re-implement
    - On verify fail (normal): re-implement with feedback
    """
    rel: str = spec.rel_from_specs
    forced: bool = rel in config.force_specs
    logger.log("spec_start", spec=rel, forced=forced, already_done=rel in done_set, dry_run=config.dry_run)

    if rel in done_set and not forced:
        print_status("skip", f"already done: {rel}", color="gray", enabled=config.color_output)
        logger.log("spec_skipped", spec=rel)
        return SpecResult.SKIPPED

    if config.dry_run:
        print_status("dry-run", f"would run: {rel}", color="yellow", enabled=config.color_output)
        logger.log("spec_dry_run", spec=rel)
        return SpecResult.DRY_RUN

    verifier_feedback: str | None = None
    candidate: CandidateInfo | None = load_candidate(paths, rel)

    attempt: int = 1
    while attempt <= config.max_attempts:
        # --- Phase 1: Ensure active plan exists ---
        plan_info: PlanInfo | None = load_plan_info(paths, rel)
        if plan_info is None or plan_info.status == "invalidated":
            # Need to (re-)plan
            previous_plan: str | None = None
            invalidation_reason: str | None = None
            if plan_info and plan_info.status == "invalidated":
                # Load the archived plan for context
                archive_name: str = Path(rel).stem + f".attempt-{plan_info.attempt}" + Path(rel).suffix
                archive_path: Path = plan_path_for_spec(paths, rel).with_name(archive_name)
                if archive_path.exists():
                    previous_plan = archive_path.read_text(encoding="utf-8")
                invalidation_reason = plan_info.invalidation_reason

            print_status(
                "plan",
                f"{rel} | planning attempt {attempt}/{config.max_attempts}"
                + (f" (re-plan: {invalidation_reason})" if invalidation_reason else ""),
                color="blue",
                enabled=config.color_output,
            )

            plan_ok: bool
            plan_output: str
            plan_ok, plan_output = run_planner(
                spec=spec,
                paths=paths,
                config=config,
                logger=logger,
                previous_plan=previous_plan,
                invalidation_reason=invalidation_reason,
                attempt=attempt,
            )

            if not plan_ok:
                delay: float = backoff_delay(attempt)
                logger.log("backoff_wait", phase="plan", spec=rel, attempt=attempt, wait_seconds=delay, reason="plan_failed")
                print_status(
                    "retry",
                    f"planner failed; backing off {delay:.1f}s",
                    color="yellow",
                    enabled=config.color_output,
                )
                time.sleep(delay)
                attempt += 1
                continue

            print_status(
                "planned",
                f"{rel} | plan ready",
                color="cyan",
                enabled=config.color_output,
            )
            # Clear candidate and feedback when re-planning (fresh start for implementation)
            if invalidation_reason:
                candidate = None
                verifier_feedback = None

        # --- Load plan content for impl/verify ---
        plan_content: str | None = load_plan_content(paths, rel)

        # --- Phase 2: Verify existing candidate ---
        if candidate and not forced and candidate.status != "verified":
            logger.log(
                "candidate_loaded",
                spec=rel,
                candidate_commit=candidate.candidate_commit,
                status=candidate.status,
                last_impl_run_dir=candidate.last_impl_run_dir,
                last_verify_run_dir=candidate.last_verify_run_dir,
                attempt=attempt,
            )
            print_status(
                "pending",
                f"candidate exists for {rel} @ {candidate.candidate_commit[:8]}... - verifying",
                color="cyan",
                enabled=config.color_output,
            )
            verified: bool
            vout: str
            verified, vout = verify_candidate(
                spec=spec,
                paths=paths,
                config=config,
                logger=logger,
                candidate=candidate,
                attempt=attempt,
                plan_content=plan_content,
            )
            if verified:
                done_set.add(rel)
                print_status(
                    "done",
                    f"{rel} (verified commit: {candidate.candidate_commit[:8]})",
                    color="green",
                    enabled=config.color_output,
                )
                return SpecResult.COMPLETED

            # Check for plan invalidation
            inv_reason: str | None = parse_plan_invalidation(vout)
            if inv_reason:
                logger.log("plan_invalidated", spec=rel, reason=inv_reason, attempt=attempt)
                print_status(
                    "plan-invalid",
                    f"plan invalidated: {inv_reason}",
                    color="yellow",
                    enabled=config.color_output,
                )
                invalidate_plan(paths, rel, inv_reason)
                candidate = None
                verifier_feedback = None
                delay: float = backoff_delay(attempt)
                logger.log("backoff_wait", phase="plan", spec=rel, attempt=attempt, wait_seconds=delay, reason="plan_invalidated")
                time.sleep(delay)
                attempt += 1
                continue

            verifier_feedback = output_tail(vout)
            candidate = None
            delay: float = backoff_delay(attempt)
            logger.log("backoff_wait", phase="verify", spec=rel, attempt=attempt, wait_seconds=delay, reason="verify_failed")
            print_status(
                "retry",
                f"verifier failed; backing off {delay:.1f}s before implement attempt",
                color="yellow",
                enabled=config.color_output,
            )
            time.sleep(delay)
            attempt += 1
            continue

        # --- Phase 3: Implement ---
        print_status(
            "start",
            f"{rel} | implement attempt {attempt}/{config.max_attempts}",
            color="blue",
            enabled=config.color_output,
        )
        logger.log("impl_start", spec=rel, attempt=attempt)

        impl_run_dir: Path = make_run_dir(paths, spec.spec_id)
        impl_prompt: str = build_implementer_prompt(
            spec=spec,
            paths=paths,
            config=config,
            verifier_feedback=verifier_feedback,
            plan_content=plan_content,
        )
        resume_session_id: str | None = get_resume_session_id(paths, rel, "impl")

        try:
            res: CodexRunResult = run_codex(
                codex_exe=config.codex_exe,
                codex_args=config.codex_args,
                prompt=impl_prompt,
                workspace_root=config.workspace_root,
                stream_to_console=config.stream_output,
                resume_session_id=resume_session_id,
            )
        except Exception:
            err = traceback.format_exc()
            write_run_log(impl_run_dir, "impl-exception.log", err)
            logger.log("impl_exception", spec=rel, attempt=attempt, error=err)
            delay: float = backoff_delay(attempt)
            logger.log("backoff_wait", phase="impl", spec=rel, attempt=attempt, wait_seconds=delay, reason="exception")
            print_status(
                "wait",
                f"backing off {delay:.1f}s before retry",
                color="yellow",
                enabled=config.color_output,
            )
            time.sleep(delay)
            attempt += 1
            continue

        write_run_log(impl_run_dir, f"impl-attempt-{attempt}.log", res.output_text)
        summary: dict[str, Any] = summarize_output(res.output_text)
        tokens_used: int | None = parse_tokens_used(res.output_text)
        session_id: str | None = parse_session_id(res.output_text)
        if session_id is not None:
            update_session_info(paths=paths, spec=spec, phase="impl", session_id=session_id)
        ok: bool
        commit: str | None
        ok, commit = completion_tuple(res.output_text, config.magic_phrase)
        logger.log(
            "impl_run_complete",
            spec=rel,
            attempt=attempt,
            exit_code=res.exit_code,
            completion_ok=ok,
            completion_commit=commit,
            session_id=session_id,
            resumed_from_session=resume_session_id,
            tokens_used=tokens_used,
            run_dir=to_rel_posix(impl_run_dir, paths.ralph_home),
            **summary,
        )

        usage_text: str = output_tail(res.output_text, max_lines=USAGE_LIMIT_TAIL_LINES)
        if not ok and looks_like_usage_limit(usage_text):
            reset: int | None = parse_reset_seconds(usage_text)
            wait_s: int
            reason: str
            msg: str
            if reset is not None:
                wait_s = reset + 30
                reason = "reset_seconds"
                msg = f"usage limit reached; sleeping {wait_s}s before retry"
            else:
                wait_s = DEFAULT_USAGE_LIMIT_WAIT_SECONDS
                reason = "unknown_reset"
                msg = f"usage limit reached; sleeping {wait_s}s before retry (no reset info)"
            logger.log(
                "usage_limit_wait",
                phase="impl",
                spec=rel,
                attempt=attempt,
                wait_seconds=wait_s,
                reset_seconds=reset,
                reason=reason,
            )
            print_status("wait", msg, color="yellow", enabled=config.color_output)
            time.sleep(wait_s)
            attempt += 1
            continue

        if res.exit_code != 0:
            logger.log("impl_nonzero_exit", spec=rel, attempt=attempt, exit_code=res.exit_code)
            delay: float = backoff_delay(attempt)
            logger.log("backoff_wait", phase="impl", spec=rel, attempt=attempt, wait_seconds=delay, reason="nonzero_exit")
            print_status(
                "wait",
                f"codex exit {res.exit_code}; backing off {delay:.1f}s",
                color="yellow",
                enabled=config.color_output,
            )
            time.sleep(delay)
            attempt += 1
            continue

        if not ok or commit is None:
            logger.log("impl_no_completion", spec=rel, attempt=attempt)
            delay: float = backoff_delay(attempt)
            logger.log("backoff_wait", phase="impl", spec=rel, attempt=attempt, wait_seconds=delay, reason="no_completion")
            print_status(
                "retry",
                f"impl completion contract not satisfied; backing off {delay:.1f}s",
                color="yellow",
                enabled=config.color_output,
            )
            time.sleep(delay)
            attempt += 1
            continue

        # Save candidate
        c = CandidateInfo(
            spec_rel=rel,
            spec_id=spec.spec_id,
            candidate_commit=commit,
            created_at_utc=datetime.now(timezone.utc).isoformat(),
            last_impl_run_dir=to_rel_posix(impl_run_dir, paths.ralph_home),
            last_verify_run_dir=None,
            status="candidate",
        )
        cpath = save_candidate(paths, c)
        logger.log(
            "candidate_written",
            spec=rel,
            attempt=attempt,
            candidate_commit=commit,
            candidate_file=to_rel_posix(cpath, paths.ralph_home),
        )
        print_status(
            "candidate",
            f"{rel} -> {commit[:8]} (saved {to_rel_posix(cpath, paths.ralph_home)})",
            color="cyan",
            enabled=config.color_output,
        )

        # Verify candidate immediately
        candidate = c
        verified: bool
        vout: str
        verified, vout = verify_candidate(
            spec=spec,
            paths=paths,
            config=config,
            logger=logger,
            candidate=c,
            attempt=attempt,
            plan_content=plan_content,
        )
        if verified:
            done_set.add(rel)
            print_status(
                "done",
                f"{rel} (verified commit: {commit[:8]})",
                color="green",
                enabled=config.color_output,
            )
            return SpecResult.COMPLETED

        # Check plan invalidation
        inv_reason: str | None = parse_plan_invalidation(vout)
        if inv_reason:
            logger.log("plan_invalidated", spec=rel, reason=inv_reason, attempt=attempt)
            print_status(
                "plan-invalid",
                f"plan invalidated: {inv_reason}",
                color="yellow",
                enabled=config.color_output,
            )
            invalidate_plan(paths, rel, inv_reason)
            candidate = None
            verifier_feedback = None
            delay: float = backoff_delay(attempt)
            logger.log("backoff_wait", phase="plan", spec=rel, attempt=attempt, wait_seconds=delay, reason="plan_invalidated")
            time.sleep(delay)
            attempt += 1
            continue

        verifier_feedback = output_tail(vout)
        candidate = None
        delay: float = backoff_delay(attempt)
        logger.log("backoff_wait", phase="impl", spec=rel, attempt=attempt, wait_seconds=delay, reason="verify_failed")
        print_status(
            "retry",
            f"verifier failed; backing off {delay:.1f}s before next implement attempt",
            color="yellow",
            enabled=config.color_output,
        )
        time.sleep(delay)
        attempt += 1

    logger.log("spec_failed", spec=rel, error="max attempts exceeded")
    print_status(
        "failed",
        f"max attempts exceeded for {rel}",
        color="red",
        enabled=config.color_output,
    )
    return SpecResult.FAILED
```

**Step 3: Verify syntax**

Run: `python -c "import ast; ast.parse(open('ralph.py').read()); print('OK')"`
Expected: `OK`

**Step 4: Commit**

```bash
git add ralph.py
git commit -m "Rewire run_spec_pipeline for plan -> implement -> verify flow with plan invalidation"
```

---

### Task 8: Update docstring and state model documentation at top of file

**Files:**
- Modify: `ralph.py:1-42` (module docstring)

**Step 1: Update the module docstring**

Replace the state model and directory layout in the docstring:
```python
"""

ralph.py - Ralph Driven Development (RDD) runner (Codex-oriented)

State model per spec:
- Not started: no plan file, no candidate file, no done file
- Planned: specs/plans/<rel_spec>.md + .json exists (status: "active")
- Candidate: specs/candidates/<rel_spec>.json exists (contains candidate commit hash)
- Verified done: specs/done/<rel_spec>.md exists (contains candidate commit hash)

Directory layout (relative to this script dir, i.e. ralph/):
  ralph/
    ralph.py
    SCRATCHPAD.md
    runs/
      <spec_id>/<utcstamp>/plan-attempt-1.log
      <spec_id>/<utcstamp>/impl-attempt-1.log
      <spec_id>/<utcstamp>/verify-attempt-1.log
      ...
    specs/
      0001-foo.md
      area/0002-bar.md
      plans/
        0001-foo.md          (active plan)
        0001-foo.json        (plan metadata)
        0001-foo.attempt-1.md (archived invalidated plan)
      candidates/
        0001-foo.json
        area/0002-bar.json
      done/
        0001-foo.md
        area/0002-bar.md

Workspace root:
- Default: parent directory of ralph/ (so repos can be siblings of ralph/)
- Override with --workspace-root

Completion contract (strict) for implementer and verifier runs:
- Second-to-last non-empty line: 40-char git commit hash (lowercase hex)
- Last non-empty line: magic phrase (default: I AM HYPER SURE I AM DONE!)

Completion contract (strict) for planner runs:
- Plan file must exist and be non-empty
- Last non-empty line: magic phrase

Pipeline: spec -> plan -> implement -> verify -> done
- Verifier can invalidate the plan (PLAN_INVALIDATION marker) to trigger re-planning.

Important:
- The runner does NOT run your tests itself.
- Verification is done by a separate Codex run ("verifier") before marking done.
"""
```

**Step 2: Verify syntax**

Run: `python -c "import ast; ast.parse(open('ralph.py').read()); print('OK')"`
Expected: `OK`

**Step 3: Commit**

```bash
git add ralph.py
git commit -m "Update module docstring with new plan phase state model and directory layout"
```

---

### Task 9: Final end-to-end dry-run verification

**Step 1: Verify the full file parses**

Run: `python -c "import ast; ast.parse(open('ralph.py').read()); print('OK')"`
Expected: `OK`

**Step 2: Run dry-run to ensure no runtime errors on startup**

Run: `python ralph.py --dry-run --skip-validation`
Expected: Dry-run output showing specs would be processed, no errors.

**Step 3: Verify plans directory is created**

Run: `ls -la specs/plans/`
Expected: Empty directory exists

**Step 4: Commit if any final fixes were needed**

```bash
git add ralph.py
git commit -m "Final verification: planning phase complete"
```
