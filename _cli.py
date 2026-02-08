"""CLI: argument parsing and main entry point."""

from __future__ import annotations

import argparse
import shlex
import shutil
import sys
from pathlib import Path

from _types import (
    DEFAULT_CODEX_ARGS,
    DEFAULT_MAGIC_PHRASE,
    DEFAULT_MAX_ATTEMPTS,
    Config,
    SpecResult,
)
from _util import (
    default_workspace_root,
    ensure_file,
    ralph_home_from_this_file,
    should_use_color,
)
from _logger import Logger
from _paths import build_paths
from _state import build_spec_info, discover_specs, load_done_set
from _codex import _supports_flag, normalize_codex_args
from _pipeline import run_spec_pipeline


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Ralph Driven Development runner (candidate -> verify -> done).")

    p.add_argument("--magic-phrase", default=DEFAULT_MAGIC_PHRASE)
    p.add_argument("--max-attempts-per-spec", type=int, default=DEFAULT_MAX_ATTEMPTS)

    p.add_argument("--codex-exe", default="codex")
    p.add_argument("--codex-args", default=DEFAULT_CODEX_ARGS, help="Single string parsed with shlex.")

    p.add_argument(
        "--workspace-root",
        default="__DEFAULT__",
        help="Workspace root where repos live. Default: parent of ralph/ directory.",
    )

    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--stream-agent-output", action="store_true")
    p.add_argument("--json-logs", action="store_true")
    p.add_argument("--skip-validation", action="store_true")
    p.add_argument("--no-color", action="store_true", help="Disable ANSI colors in console output.")

    p.add_argument(
        "--force",
        nargs="+",
        metavar="SPEC",
        help="Force re-run of specific specs (paths relative to specs root, e.g. area/0002-bar.md).",
    )

    return p.parse_args()


def main() -> int:
    args = parse_args()

    ralph_home = ralph_home_from_this_file().resolve()
    paths = build_paths(ralph_home)

    # Ensure dirs/files exist
    paths.specs_root.mkdir(parents=True, exist_ok=True)
    paths.candidates_root.mkdir(parents=True, exist_ok=True)
    paths.done_root.mkdir(parents=True, exist_ok=True)
    paths.sessions_root.mkdir(parents=True, exist_ok=True)
    paths.plans_root.mkdir(parents=True, exist_ok=True)
    paths.runs_root.mkdir(parents=True, exist_ok=True)

    ensure_file(
        paths.scratchpad,
        "# SCRATCHPAD\n\n"
        "- Shared memory / handover for RDD agent runs.\n"
        "- Keep concise; prefer bullets.\n",
    )

    # Workspace root
    if args.workspace_root == "__DEFAULT__":
        workspace_root = default_workspace_root(ralph_home)
    else:
        wr = Path(args.workspace_root)
        workspace_root = (wr if wr.is_absolute() else (ralph_home / wr)).resolve()

    if not shutil.which(args.codex_exe):
        print(f"Error: codex executable not found on PATH: {args.codex_exe}", file=sys.stderr)
        return 1

    logger = Logger(paths.runner_log, json_mode=args.json_logs)
    color_output = should_use_color(args.no_color)

    force_specs: set[str] = set()
    if args.force:
        for item in args.force:
            # Treat item as specs-root-relative path (recommended)
            rel = item.replace("\\", "/").lstrip("/")
            force_specs.add(rel)

    config = Config(
        workspace_root=workspace_root,
        codex_exe=args.codex_exe,
        codex_args=normalize_codex_args(
            shlex.split(args.codex_args),
            supports_search=_supports_flag(args.codex_exe, "--search", subcommand="exec"),
            supports_config=_supports_flag(args.codex_exe, "--config", subcommand="exec"),
        ),
        magic_phrase=args.magic_phrase,
        max_attempts=args.max_attempts_per_spec,
        dry_run=args.dry_run,
        stream_output=args.stream_agent_output,
        json_logs=args.json_logs,
        skip_validation=args.skip_validation,
        force_specs=force_specs,
        color_output=color_output,
    )

    logger.log(
        "run_start",
        ralph_home=paths.ralph_home.as_posix(),
        workspace_root=workspace_root.as_posix(),
        specs_root=paths.specs_root.as_posix(),
        candidates_root=paths.candidates_root.as_posix(),
        done_root=paths.done_root.as_posix(),
        sessions_root=paths.sessions_root.as_posix(),
        plans_root=paths.plans_root.as_posix(),
        runs_root=paths.runs_root.as_posix(),
        scratchpad=paths.scratchpad.as_posix(),
        magic_phrase=config.magic_phrase,
        max_attempts=config.max_attempts,
        color_output=config.color_output,
        codex_exe=config.codex_exe,
        codex_args=" ".join(config.codex_args),
        force_specs=sorted(force_specs) if force_specs else None,
    )

    try:
        spec_paths = discover_specs(paths, validate=not config.skip_validation)
    except Exception as exc:
        logger.log("run_error", error=str(exc))
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    done_set = load_done_set(paths)

    results: dict[SpecResult, int] = {r: 0 for r in SpecResult}

    for i, sp in enumerate(spec_paths, start=1):
        spec = build_spec_info(sp, paths, workspace_root)
        logger.log("spec_queue", spec=spec.rel_from_specs, index=i, total=len(spec_paths))
        print(f"\n=== [{i}/{len(spec_paths)}] {spec.rel_from_specs} ===")

        res = run_spec_pipeline(
            spec=spec,
            paths=paths,
            config=config,
            logger=logger,
            done_set=done_set,
        )
        results[res] += 1
        logger.log("spec_result", spec=spec.rel_from_specs, result=res.value)

        if res == SpecResult.FAILED:
            logger.log("run_stopped", reason="spec_failed", failed_spec=spec.rel_from_specs)
            break

    print("\n=== Summary ===")
    print(f"Completed: {results[SpecResult.COMPLETED]}")
    print(f"Skipped:   {results[SpecResult.SKIPPED]}")
    print(f"Failed:    {results[SpecResult.FAILED]}")
    if results[SpecResult.DRY_RUN]:
        print(f"Dry run:   {results[SpecResult.DRY_RUN]}")

    logger.log(
        "run_complete",
        completed=results[SpecResult.COMPLETED],
        skipped=results[SpecResult.SKIPPED],
        failed=results[SpecResult.FAILED],
        dry_run=results[SpecResult.DRY_RUN],
    )

    return 1 if results[SpecResult.FAILED] > 0 else 0
