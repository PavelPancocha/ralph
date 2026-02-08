"""Path builder functions for ralph directory structure."""

from __future__ import annotations

from pathlib import Path

from _types import Paths


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


def candidate_path_for_spec(paths: Paths, rel_from_specs: str) -> Path:
    # mirror spec path, but .json
    return (paths.candidates_root / rel_from_specs).with_suffix(".json")


def done_path_for_spec(paths: Paths, rel_from_specs: str) -> Path:
    # mirror spec path, keep .md
    return paths.done_root / rel_from_specs


def session_path_for_spec(paths: Paths, rel_from_specs: str) -> Path:
    # mirror spec path, but .json
    return (paths.sessions_root / rel_from_specs).with_suffix(".json")


def plan_path_for_spec(paths: Paths, rel_from_specs: str) -> Path:
    return (paths.plans_root / rel_from_specs).with_suffix(".md")


def plan_meta_path_for_spec(paths: Paths, rel_from_specs: str) -> Path:
    return (paths.plans_root / rel_from_specs).with_suffix(".json")


def is_under_dir(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except Exception:
        return False
