"""State persistence (candidates, sessions, plans, done) and spec discovery."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from _types import (
    HEADING_RE,
    SPEC_NAME_RE,
    CandidateInfo,
    CandidateStatus,
    Paths,
    PlanInfo,
    PlanStatus,
    SessionInfo,
    SessionPhase,
    SpecInfo,
)
from _paths import (
    candidate_path_for_spec,
    done_path_for_spec,
    is_under_dir,
    plan_meta_path_for_spec,
    plan_path_for_spec,
    session_path_for_spec,
)
from _util import to_rel_posix


# -----------------------------
# Spec discovery / validation
# -----------------------------


def validate_spec(spec_path: Path) -> str | None:
    if not spec_path.exists():
        return "file does not exist"
    try:
        content = spec_path.read_text(encoding="utf-8")
    except Exception as exc:
        return f"failed to read: {exc}"
    if not content.strip():
        return "file is empty"
    if not HEADING_RE.search(content):
        return "no markdown heading found (expected at least one # heading)"
    return None


def discover_specs(paths: Paths, validate: bool) -> list[Path]:
    if not paths.specs_root.exists():
        raise FileNotFoundError(f"Specs directory not found: {paths.specs_root}")

    specs: list[Path] = []
    for p in sorted(paths.specs_root.rglob("*.md")):
        # Exclude state dirs under specs/
        if (
            is_under_dir(p, paths.candidates_root)
            or is_under_dir(p, paths.done_root)
            or is_under_dir(p, paths.sessions_root)
            or is_under_dir(p, paths.plans_root)
        ):
            continue
        if p.name in {"README.md", "done.md"}:
            continue
        if SPEC_NAME_RE.match(p.name):
            specs.append(p)

    if not specs:
        raise ValueError(f"No specs found under {paths.specs_root} (expected 0001-*.md files)")

    if validate:
        errors: list[str] = []
        for s in specs:
            err = validate_spec(s)
            if err:
                errors.append(f"- {to_rel_posix(s, paths.specs_root)}: {err}")
        if errors:
            raise ValueError("Spec validation failed:\n" + "\n".join(errors))

    return specs


# -----------------------------
# Done set
# -----------------------------


def load_done_set(paths: Paths) -> set[str]:
    """
    Done is represented by presence of specs/done/<rel_spec>.md mirror files.
    Return rel_from_specs set.
    """
    done: set[str] = set()
    if not paths.done_root.exists():
        return done
    for p in paths.done_root.rglob("*.md"):
        try:
            rel = p.relative_to(paths.done_root).as_posix()
        except Exception:
            continue
        done.add(rel)
    return done


# -----------------------------
# Candidate state
# -----------------------------


def load_candidate(paths: Paths, rel_from_specs: str) -> CandidateInfo | None:
    cpath = candidate_path_for_spec(paths, rel_from_specs)
    if not cpath.exists():
        return None
    try:
        raw: dict[str, Any] = json.loads(cpath.read_text(encoding="utf-8"))
        return CandidateInfo(
            spec_rel=raw["spec_rel"],
            spec_id=raw["spec_id"],
            candidate_commit=raw["candidate_commit"],
            created_at_utc=raw["created_at_utc"],
            last_impl_run_dir=raw.get("last_impl_run_dir"),
            last_verify_run_dir=raw.get("last_verify_run_dir"),
            status=CandidateStatus(raw.get("status", CandidateStatus.CANDIDATE)),
        )
    except Exception:
        # Corrupt candidate file: treat as absent (but keep file for inspection)
        return None


def save_candidate(paths: Paths, c: CandidateInfo) -> Path:
    cpath = candidate_path_for_spec(paths, c.spec_rel)
    cpath.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {
        "spec_rel": c.spec_rel,
        "spec_id": c.spec_id,
        "candidate_commit": c.candidate_commit,
        "created_at_utc": c.created_at_utc,
        "last_impl_run_dir": c.last_impl_run_dir,
        "last_verify_run_dir": c.last_verify_run_dir,
        "status": c.status,
    }
    cpath.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return cpath


# -----------------------------
# Session state
# -----------------------------


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
        # Corrupt session file: treat as absent (but keep file for inspection)
        return None


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


def get_resume_session_id(paths: Paths, rel_from_specs: str, phase: SessionPhase) -> str | None:
    info: SessionInfo | None = load_session_info(paths, rel_from_specs)
    if not info:
        return None
    if phase == "plan":
        return info.plan_session_id
    if phase == "impl":
        return info.impl_session_id
    return info.verify_session_id


# -----------------------------
# Done file
# -----------------------------


def save_done_file(
    paths: Paths,
    *,
    spec: SpecInfo,
    candidate_commit: str,
    verified_at_utc: str,
    verify_run_dir_rel: str,
    impl_run_dir_rel: str | None,
    verifier_output_tail: str,
) -> Path:
    dpath = done_path_for_spec(paths, spec.rel_from_specs)
    dpath.parent.mkdir(parents=True, exist_ok=True)

    content = (
        f"DONE: {spec.rel_from_specs}\n"
        f"Candidate commit: {candidate_commit}\n"
        f"Verified at (UTC): {verified_at_utc}\n"
        f"Spec id: {spec.spec_id}\n"
        f"Verify run logs: {verify_run_dir_rel}\n"
        f"Impl run logs: {impl_run_dir_rel or 'n/a'}\n"
        "\n"
        "Verifier output (tail):\n"
        f"{verifier_output_tail.rstrip()}\n"
    )
    dpath.write_text(content, encoding="utf-8")
    return dpath


# -----------------------------
# Plan state
# -----------------------------


def load_plan_info(paths: Paths, rel_from_specs: str) -> PlanInfo | None:
    mpath: Path = plan_meta_path_for_spec(paths, rel_from_specs)
    ppath: Path = plan_path_for_spec(paths, rel_from_specs)
    if mpath.exists():
        try:
            raw: dict[str, Any] = json.loads(mpath.read_text(encoding="utf-8"))
            status: PlanStatus = PlanStatus(raw.get("status", PlanStatus.ACTIVE))
            # If marked active but plan file is missing/empty, needs re-planning
            if status == PlanStatus.ACTIVE and (
                not ppath.exists() or not ppath.read_text(encoding="utf-8").strip()
            ):
                status = PlanStatus.INVALIDATED
            return PlanInfo(
                spec_rel=raw["spec_rel"],
                spec_id=raw["spec_id"],
                status=status,
                created_at_utc=raw["created_at_utc"],
                invalidated_at_utc=raw.get("invalidated_at_utc"),
                invalidation_reason=raw.get("invalidation_reason", "plan file missing"),
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
            status=PlanStatus.ACTIVE,
            created_at_utc=now_utc,
            invalidated_at_utc=None,
            invalidation_reason=None,
            attempt=1,
        )
        save_plan_info(paths, info)
        return info
    return None


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


def load_plan_content(paths: Paths, rel_from_specs: str) -> str | None:
    ppath: Path = plan_path_for_spec(paths, rel_from_specs)
    if not ppath.exists():
        return None
    content: str = ppath.read_text(encoding="utf-8")
    if not content.strip():
        return None
    return content


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
        status=PlanStatus.INVALIDATED,
        created_at_utc=created_at,
        invalidated_at_utc=now_utc,
        invalidation_reason=reason,
        attempt=current_attempt,
    )
    save_plan_info(paths, updated)
    return updated


def build_spec_info(spec_path: Path, paths: Paths, workspace_root: Path) -> SpecInfo:
    rel_from_specs = to_rel_posix(spec_path, paths.specs_root)
    spec_id = spec_path.stem
    rel_from_workspace = to_rel_posix(spec_path, workspace_root)
    return SpecInfo(
        spec_path=spec_path,
        rel_from_specs=rel_from_specs,
        rel_from_workspace=rel_from_workspace,
        spec_id=spec_id,
    )
