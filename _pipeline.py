"""Pipeline functions: plan -> implement -> verify -> done, with DRY helpers."""

from __future__ import annotations

import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from _types import (
    DEFAULT_USAGE_LIMIT_WAIT_SECONDS,
    CandidateInfo,
    CandidateStatus,
    Config,
    Paths,
    PlanInfo,
    PlanStatus,
    SpecInfo,
    SpecResult,
)
from _util import backoff_delay, print_status, to_rel_posix
from _parsing import (
    completion_tuple,
    looks_like_usage_limit,
    output_tail,
    parse_plan_invalidation,
    parse_reset_seconds,
    parse_session_id,
    parse_tokens_used,
    planner_completed,
    summarize_output,
)
from _logger import Logger
from _paths import candidate_path_for_spec, plan_path_for_spec
from _state import (
    get_resume_session_id,
    invalidate_plan,
    load_candidate,
    load_plan_content,
    load_plan_info,
    save_candidate,
    save_done_file,
    save_plan_info,
    update_session_info,
)
from _prompts import build_implementer_prompt, build_planner_prompt, build_verifier_prompt
from _codex import make_run_dir, run_codex, write_run_log


# -----------------------------
# DRY helpers
# -----------------------------


def handle_usage_limit(
    *,
    output_text: str,
    completed: bool,
    phase: str,
    spec_rel: str,
    attempt: int,
    logger: Logger,
    config: Config,
) -> bool:
    """Check for usage limit, log+sleep if found. Returns True if handled."""
    usage_text: str = output_tail(output_text)
    if completed or not looks_like_usage_limit(usage_text):
        return False

    reset: int | None = parse_reset_seconds(usage_text)
    wait_s: int
    reason: str
    msg: str
    if reset is not None:
        wait_s = reset + 30
        reason = "reset_seconds"
        msg = f"usage limit reached during {phase}; sleeping {wait_s}s before retry"
    else:
        wait_s = DEFAULT_USAGE_LIMIT_WAIT_SECONDS
        reason = "unknown_reset"
        msg = f"usage limit reached during {phase}; sleeping {wait_s}s before retry (no reset info)"

    logger.log(
        "usage_limit_wait",
        phase=phase,
        spec=spec_rel,
        attempt=attempt,
        wait_seconds=wait_s,
        reset_seconds=reset,
        reason=reason,
    )
    print_status("wait", msg, color="yellow", enabled=config.color_output)
    time.sleep(wait_s)
    return True


def handle_plan_invalidation(
    *,
    verifier_output: str,
    spec_rel: str,
    attempt: int,
    paths: Paths,
    logger: Logger,
    config: Config,
) -> bool:
    """Check for PLAN_INVALIDATION marker, handle if found. Returns True if handled."""
    inv_reason: str | None = parse_plan_invalidation(verifier_output)
    if not inv_reason:
        return False

    logger.log(
        "plan_invalidated", spec=spec_rel,
        reason=inv_reason, attempt=attempt,
    )
    print_status(
        "plan-invalid",
        f"plan invalidated: {inv_reason}",
        color="yellow", enabled=config.color_output,
    )
    invalidate_plan(paths, spec_rel, inv_reason)
    # Remove stale candidate so restart doesn't re-verify old commit
    cpath_stale = candidate_path_for_spec(paths, spec_rel)
    if cpath_stale.exists():
        cpath_stale.unlink()

    delay = backoff_delay(attempt)
    logger.log(
        "backoff_wait", phase="plan", spec=spec_rel,
        attempt=attempt, wait_seconds=delay,
        reason="plan_invalidated",
    )
    time.sleep(delay)
    return True


# -----------------------------
# Pipeline phases
# -----------------------------


def run_planner(
    *,
    spec: SpecInfo,
    paths: Paths,
    config: Config,
    logger: Logger,
    spec_content: str,
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
        spec_content=spec_content,
        previous_plan=previous_plan,
        invalidation_reason=invalidation_reason,
    )
    resume_session_id: str | None = get_resume_session_id(
        paths, spec.rel_from_specs, "plan",
    )

    logger.log(
        "plan_start",
        spec=spec.rel_from_specs,
        attempt=attempt,
        run_dir=to_rel_posix(plan_run_dir, paths.ralph_home),
        replanning=previous_plan is not None,
    )

    try:
        res = run_codex(
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
        logger.log(
            "plan_exception",
            spec=spec.rel_from_specs, attempt=attempt, error=err,
        )
        return False, "[exception]\n" + err

    write_run_log(plan_run_dir, f"plan-attempt-{attempt}.log", res.output_text)
    summary: dict[str, Any] = summarize_output(res.output_text)
    tokens_used: int | None = parse_tokens_used(res.output_text)
    session_id: str | None = parse_session_id(res.output_text)
    if session_id is not None:
        update_session_info(
            paths=paths, spec=spec, phase="plan", session_id=session_id,
        )

    plan_file: Path = plan_path_for_spec(paths, spec.rel_from_specs)
    completed: bool = planner_completed(
        res.output_text, plan_file, config.magic_phrase,
    )

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
    if handle_usage_limit(
        output_text=res.output_text,
        completed=completed,
        phase="plan",
        spec_rel=spec.rel_from_specs,
        attempt=attempt,
        logger=logger,
        config=config,
    ):
        return False, res.output_text

    if completed:
        # Save plan metadata
        old_info: PlanInfo | None = load_plan_info(paths, spec.rel_from_specs)
        if old_info and old_info.status == PlanStatus.INVALIDATED:
            new_attempt: int = old_info.attempt + 1
        elif old_info and old_info.status == PlanStatus.ACTIVE:
            new_attempt = old_info.attempt
        else:
            new_attempt = 1
        active_info: PlanInfo = PlanInfo(
            spec_rel=spec.rel_from_specs,
            spec_id=spec.spec_id,
            status=PlanStatus.ACTIVE,
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


def verify_candidate(
    *,
    spec: SpecInfo,
    paths: Paths,
    config: Config,
    logger: Logger,
    spec_content: str,
    candidate: CandidateInfo,
    attempt: int,
    plan_content: str | None,
) -> tuple[bool, str]:
    """
    Returns (verified, verifier_output_text).
    Verified is true only if verifier satisfies strict completion contract AND
    repeats the same candidate commit hash.
    """
    verify_run_dir: Path = make_run_dir(paths, spec.spec_id)
    verify_prompt: str = build_verifier_prompt(
        spec=spec,
        paths=paths,
        config=config,
        spec_content=spec_content,
        candidate_commit=candidate.candidate_commit,
        plan_content=plan_content,
    )
    resume_session_id: str | None = get_resume_session_id(paths, spec.rel_from_specs, "verify")

    logger.log(
        "verify_start",
        spec=spec.rel_from_specs,
        candidate_commit=candidate.candidate_commit,
        attempt=attempt,
        run_dir=to_rel_posix(verify_run_dir, paths.ralph_home),
    )

    try:
        res = run_codex(
            codex_exe=config.codex_exe,
            codex_args=config.codex_args,
            prompt=verify_prompt,
            workspace_root=config.workspace_root,
            stream_to_console=config.stream_output,
            resume_session_id=resume_session_id,
        )
    except Exception:
        err = traceback.format_exc()
        write_run_log(verify_run_dir, "verify-exception.log", err)
        logger.log("verify_exception", spec=spec.rel_from_specs, attempt=attempt, error=err)
        return False, "[exception]\n" + err

    write_run_log(verify_run_dir, "verify.log", res.output_text)
    summary: dict[str, Any] = summarize_output(res.output_text)
    tokens_used: int | None = parse_tokens_used(res.output_text)
    session_id: str | None = parse_session_id(res.output_text)
    if session_id is not None:
        update_session_info(paths=paths, spec=spec, phase="verify", session_id=session_id)
    ok: bool
    commit: str | None
    ok, commit = completion_tuple(res.output_text, config.magic_phrase)
    commit_match: bool = ok and commit == candidate.candidate_commit
    logger.log(
        "verify_run_complete",
        spec=spec.rel_from_specs,
        attempt=attempt,
        exit_code=res.exit_code,
        completion_ok=ok,
        completion_commit=commit,
        commit_match=commit_match,
        session_id=session_id,
        resumed_from_session=resume_session_id,
        tokens_used=tokens_used,
        run_dir=to_rel_posix(verify_run_dir, paths.ralph_home),
        **summary,
    )

    # Handle usage limits
    if handle_usage_limit(
        output_text=res.output_text,
        completed=ok,
        phase="verify",
        spec_rel=spec.rel_from_specs,
        attempt=attempt,
        logger=logger,
        config=config,
    ):
        return False, res.output_text

    if res.exit_code != 0:
        logger.log("verify_nonzero_exit", spec=spec.rel_from_specs, attempt=attempt, exit_code=res.exit_code)
        return False, res.output_text

    if commit_match:
        # update candidate with verify run info
        updated = CandidateInfo(
            spec_rel=candidate.spec_rel,
            spec_id=candidate.spec_id,
            candidate_commit=candidate.candidate_commit,
            created_at_utc=candidate.created_at_utc,
            last_impl_run_dir=candidate.last_impl_run_dir,
            last_verify_run_dir=to_rel_posix(verify_run_dir, paths.ralph_home),
            status=CandidateStatus.VERIFIED,
        )
        save_candidate(paths, updated)

        verified_at = datetime.now(timezone.utc).isoformat()
        dpath = save_done_file(
            paths,
            spec=spec,
            candidate_commit=candidate.candidate_commit,
            verified_at_utc=verified_at,
            verify_run_dir_rel=to_rel_posix(verify_run_dir, paths.ralph_home),
            impl_run_dir_rel=candidate.last_impl_run_dir,
            verifier_output_tail=output_tail(res.output_text),
        )

        logger.log(
            "verify_pass",
            spec=spec.rel_from_specs,
            candidate_commit=candidate.candidate_commit,
            done_file=to_rel_posix(dpath, paths.ralph_home),
        )
        return True, res.output_text

    logger.log(
        "verify_fail",
        spec=spec.rel_from_specs,
        candidate_commit=candidate.candidate_commit,
        attempt=attempt,
        observed_commit=commit,
        reason="completion_contract_not_satisfied_or_commit_mismatch",
    )
    return False, res.output_text


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
    logger.log(
        "spec_start", spec=rel, forced=forced,
        already_done=rel in done_set, dry_run=config.dry_run,
    )

    if rel in done_set and not forced:
        print_status(
            "skip", f"already done: {rel}",
            color="gray", enabled=config.color_output,
        )
        logger.log("spec_skipped", spec=rel)
        return SpecResult.SKIPPED

    if config.dry_run:
        print_status(
            "dry-run", f"would run: {rel}",
            color="yellow", enabled=config.color_output,
        )
        logger.log("spec_dry_run", spec=rel)
        return SpecResult.DRY_RUN

    # Read spec content once — embedded in all prompts
    spec_content: str = spec.spec_path.read_text(encoding="utf-8")

    verifier_feedback: str | None = None
    candidate: CandidateInfo | None = load_candidate(paths, rel)

    attempt: int = 1
    while attempt <= config.max_attempts:
        # --- Phase 1: Ensure active plan exists ---
        plan_info: PlanInfo | None = load_plan_info(paths, rel)
        if plan_info is None or plan_info.status == PlanStatus.INVALIDATED:
            previous_plan: str | None = None
            invalidation_reason: str | None = None
            if plan_info and plan_info.status == PlanStatus.INVALIDATED:
                archive_name: str = (
                    Path(rel).stem
                    + f".attempt-{plan_info.attempt}"
                    + Path(rel).suffix
                )
                archive_path: Path = plan_path_for_spec(
                    paths, rel,
                ).with_name(archive_name)
                if archive_path.exists():
                    previous_plan = archive_path.read_text(encoding="utf-8")
                invalidation_reason = plan_info.invalidation_reason

            status_msg: str = (
                f"{rel} | planning attempt {attempt}/{config.max_attempts}"
            )
            if invalidation_reason:
                status_msg += f" (re-plan: {invalidation_reason})"
            print_status(
                "plan", status_msg,
                color="blue", enabled=config.color_output,
            )

            plan_ok: bool
            plan_output: str
            plan_ok, plan_output = run_planner(
                spec=spec,
                paths=paths,
                config=config,
                logger=logger,
                spec_content=spec_content,
                previous_plan=previous_plan,
                invalidation_reason=invalidation_reason,
                attempt=attempt,
            )

            if not plan_ok:
                delay: float = backoff_delay(attempt)
                logger.log(
                    "backoff_wait", phase="plan", spec=rel,
                    attempt=attempt, wait_seconds=delay,
                    reason="plan_failed",
                )
                print_status(
                    "retry",
                    f"planner failed; backing off {delay:.1f}s",
                    color="yellow", enabled=config.color_output,
                )
                time.sleep(delay)
                attempt += 1
                continue

            print_status(
                "planned", f"{rel} | plan ready",
                color="cyan", enabled=config.color_output,
            )
            # Fresh start for implementation after re-planning
            if invalidation_reason:
                candidate = None
                verifier_feedback = None

        # --- Load plan content for impl/verify ---
        plan_content: str | None = load_plan_content(paths, rel)

        # --- Phase 2: Verify existing candidate ---
        if candidate and not forced and candidate.status != CandidateStatus.VERIFIED:
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
                f"candidate exists for {rel} "
                f"@ {candidate.candidate_commit[:8]}... - verifying",
                color="cyan", enabled=config.color_output,
            )
            verified: bool
            vout: str
            verified, vout = verify_candidate(
                spec=spec,
                paths=paths,
                config=config,
                logger=logger,
                spec_content=spec_content,
                candidate=candidate,
                attempt=attempt,
                plan_content=plan_content,
            )
            if verified:
                done_set.add(rel)
                print_status(
                    "done",
                    f"{rel} (verified commit: "
                    f"{candidate.candidate_commit[:8]})",
                    color="green", enabled=config.color_output,
                )
                return SpecResult.COMPLETED

            # Check for plan invalidation
            if handle_plan_invalidation(
                verifier_output=vout,
                spec_rel=rel,
                attempt=attempt,
                paths=paths,
                logger=logger,
                config=config,
            ):
                candidate = None
                verifier_feedback = None
                attempt += 1
                continue

            verifier_feedback = output_tail(vout)
            candidate = None
            delay = backoff_delay(attempt)
            logger.log(
                "backoff_wait", phase="verify", spec=rel,
                attempt=attempt, wait_seconds=delay,
                reason="verify_failed",
            )
            print_status(
                "retry",
                f"verifier failed; backing off {delay:.1f}s "
                f"before implement attempt",
                color="yellow", enabled=config.color_output,
            )
            time.sleep(delay)
            attempt += 1
            continue

        # --- Phase 3: Implement ---
        print_status(
            "start",
            f"{rel} | implement attempt "
            f"{attempt}/{config.max_attempts}",
            color="blue", enabled=config.color_output,
        )
        logger.log("impl_start", spec=rel, attempt=attempt)

        impl_run_dir: Path = make_run_dir(paths, spec.spec_id)
        impl_prompt: str = build_implementer_prompt(
            spec=spec,
            paths=paths,
            config=config,
            spec_content=spec_content,
            verifier_feedback=verifier_feedback,
            plan_content=plan_content,
        )
        resume_session_id: str | None = get_resume_session_id(
            paths, rel, "impl",
        )

        try:
            res = run_codex(
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
            logger.log(
                "impl_exception", spec=rel,
                attempt=attempt, error=err,
            )
            delay = backoff_delay(attempt)
            logger.log(
                "backoff_wait", phase="impl", spec=rel,
                attempt=attempt, wait_seconds=delay,
                reason="exception",
            )
            print_status(
                "wait",
                f"backing off {delay:.1f}s before retry",
                color="yellow", enabled=config.color_output,
            )
            time.sleep(delay)
            attempt += 1
            continue

        write_run_log(
            impl_run_dir, f"impl-attempt-{attempt}.log", res.output_text,
        )
        summary: dict[str, Any] = summarize_output(res.output_text)
        tokens_used: int | None = parse_tokens_used(res.output_text)
        session_id: str | None = parse_session_id(res.output_text)
        if session_id is not None:
            update_session_info(
                paths=paths, spec=spec,
                phase="impl", session_id=session_id,
            )
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

        # Handle usage limits
        if handle_usage_limit(
            output_text=res.output_text,
            completed=ok,
            phase="impl",
            spec_rel=rel,
            attempt=attempt,
            logger=logger,
            config=config,
        ):
            attempt += 1
            continue

        if res.exit_code != 0:
            logger.log(
                "impl_nonzero_exit", spec=rel,
                attempt=attempt, exit_code=res.exit_code,
            )
            delay = backoff_delay(attempt)
            logger.log(
                "backoff_wait", phase="impl", spec=rel,
                attempt=attempt, wait_seconds=delay,
                reason="nonzero_exit",
            )
            print_status(
                "wait",
                f"codex exit {res.exit_code}; "
                f"backing off {delay:.1f}s",
                color="yellow", enabled=config.color_output,
            )
            time.sleep(delay)
            attempt += 1
            continue

        if not ok or commit is None:
            logger.log(
                "impl_no_completion", spec=rel, attempt=attempt,
            )
            delay = backoff_delay(attempt)
            logger.log(
                "backoff_wait", phase="impl", spec=rel,
                attempt=attempt, wait_seconds=delay,
                reason="no_completion",
            )
            print_status(
                "retry",
                f"impl completion contract not satisfied; "
                f"backing off {delay:.1f}s",
                color="yellow", enabled=config.color_output,
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
            status=CandidateStatus.CANDIDATE,
        )
        cpath = save_candidate(paths, c)
        logger.log(
            "candidate_written",
            spec=rel, attempt=attempt,
            candidate_commit=commit,
            candidate_file=to_rel_posix(cpath, paths.ralph_home),
        )
        print_status(
            "candidate",
            f"{rel} -> {commit[:8]} "
            f"(saved {to_rel_posix(cpath, paths.ralph_home)})",
            color="cyan", enabled=config.color_output,
        )

        # Verify candidate immediately
        verified, vout = verify_candidate(
            spec=spec,
            paths=paths,
            config=config,
            logger=logger,
            spec_content=spec_content,
            candidate=c,
            attempt=attempt,
            plan_content=plan_content,
        )
        if verified:
            done_set.add(rel)
            print_status(
                "done",
                f"{rel} (verified commit: {commit[:8]})",
                color="green", enabled=config.color_output,
            )
            return SpecResult.COMPLETED

        # Check plan invalidation
        if handle_plan_invalidation(
            verifier_output=vout,
            spec_rel=rel,
            attempt=attempt,
            paths=paths,
            logger=logger,
            config=config,
        ):
            candidate = None
            verifier_feedback = None
            attempt += 1
            continue

        verifier_feedback = output_tail(vout)
        candidate = None
        delay = backoff_delay(attempt)
        logger.log(
            "backoff_wait", phase="impl", spec=rel,
            attempt=attempt, wait_seconds=delay,
            reason="verify_failed",
        )
        print_status(
            "retry",
            f"verifier failed; backing off {delay:.1f}s "
            f"before next implement attempt",
            color="yellow", enabled=config.color_output,
        )
        time.sleep(delay)
        attempt += 1

    logger.log("spec_failed", spec=rel, error="max attempts exceeded")
    print_status(
        "failed",
        f"max attempts exceeded for {rel}",
        color="red", enabled=config.color_output,
    )
    return SpecResult.FAILED
