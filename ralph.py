# Copyright (C) 2025-2026 Zemtu OG

#!/usr/bin/env python3
"""

ralph.py - Ralph Driven Development (RDD) runner (Codex-oriented)

State model per spec:
- Not started: no candidate file, no done file
- Candidate: specs/candidates/<rel_spec>.json exists (contains candidate commit hash)
- Verified done: specs/done/<rel_spec>.md exists (contains candidate commit hash)

Directory layout (relative to this script dir, i.e. ralph/):
  ralph/
    ralph.py
    SCRATCHPAD.md
    runs/
      <spec_id>/<utcstamp>/impl-attempt-1.log
      <spec_id>/<utcstamp>/verify-attempt-1.log
      ...
    specs/
      0001-foo.md
      area/0002-bar.md
      candidates/
        0001-foo.json
        area/0002-bar.json
      done/
        0001-foo.md
        area/0002-bar.md

Workspace root:
- Default: parent directory of ralph/ (so repos can be siblings of ralph/)
- Override with --workspace-root

Completion contract (strict) for both implementer and verifier runs:
- Second-to-last non-empty line: 40-char git commit hash (lowercase hex)
- Last non-empty line: magic phrase (default: I AM HYPER SURE I AM DONE!)

Important:
- The runner does NOT run your tests itself.
- Verification is done by a separate Codex run ("verifier") before marking done.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import traceback
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Final, Iterable


# -----------------------------
# Defaults
# -----------------------------

DEFAULT_MAGIC_PHRASE: Final[str] = "I AM HYPER SURE I AM DONE!"
DEFAULT_MAX_ATTEMPTS: Final[int] = 10
DEFAULT_USAGE_LIMIT_WAIT_SECONDS: Final[int] = 5

# YOLO + skip git check by default
DEFAULT_CODEX_ARGS = (
    "exec "
    "--dangerously-bypass-approvals-and-sandbox "
    "--skip-git-repo-check"
)


# -----------------------------
# Types
# -----------------------------

class SpecResult(Enum):
    COMPLETED = "completed"
    SKIPPED = "skipped"
    FAILED = "failed"
    DRY_RUN = "dry_run"


@dataclass(frozen=True)
class Paths:
    ralph_home: Path
    scratchpad: Path
    runs_root: Path

    specs_root: Path
    candidates_root: Path
    done_root: Path

    runner_log: Path


@dataclass(frozen=True)
class Config:
    workspace_root: Path
    codex_exe: str
    codex_args: list[str]
    magic_phrase: str
    max_attempts: int
    dry_run: bool
    stream_output: bool
    json_logs: bool
    skip_validation: bool
    force_specs: set[str]  # rel path from specs_root (e.g. "area/0002-bar.md")
    color_output: bool


@dataclass(frozen=True)
class SpecInfo:
    spec_path: Path
    rel_from_specs: str        # e.g. "area/0002-bar.md"
    rel_from_workspace: str    # e.g. "ralph/specs/area/0002-bar.md" (depends on workspace)
    spec_id: str               # e.g. "0002-bar"


@dataclass(frozen=True)
class CandidateInfo:
    spec_rel: str
    spec_id: str
    candidate_commit: str
    created_at_utc: str
    last_impl_run_dir: str | None
    last_verify_run_dir: str | None
    status: str  # "candidate" | "verified"


# -----------------------------
# Logging
# -----------------------------

class Logger:
    def __init__(self, log_path: Path, json_mode: bool):
        self.log_path = log_path
        self.json_mode = json_mode
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

    def log(self, event: str, **fields: Any) -> None:
        ts = datetime.now(timezone.utc).isoformat()
        if self.json_mode:
            rec = {"timestamp": ts, "event": event, **{k: v for k, v in fields.items() if v is not None}}
            line = json.dumps(rec, ensure_ascii=False)
        else:
            parts = [f"=== {ts} | {event}"]
            for k, v in fields.items():
                if v is not None:
                    parts.append(f"{k}={v}")
            line = " | ".join(parts) + " ==="
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")


# -----------------------------
# Helpers
# -----------------------------

SPEC_NAME_RE = re.compile(r"^\d{4}-.*\.md$")
HEADING_RE = re.compile(r"^#{1,6}\s+\S", re.MULTILINE)

USAGE_LIMIT_PATTERNS = (
    "usage_limit_reached",
    "You've hit your usage limit",
    "You have hit your usage limit",
    "Too Many Requests",
    "rate_limit_exceeded",
    "RateLimitError",
)
RESET_SECONDS_RE = re.compile(r'resets_in_seconds\\?"\s*:\s*(\d+)')
RESET_AT_RE = re.compile(r'resets_at\\?"\s*:\s*(\d+)')

COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%SZ")


def ralph_home_from_this_file() -> Path:
    return Path(__file__).resolve().parent


def default_workspace_root(ralph_home: Path) -> Path:
    return ralph_home.parent.resolve()


def ensure_file(path: Path, initial: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(initial, encoding="utf-8")


def to_rel_posix(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except Exception:
        return path.as_posix()


def looks_like_usage_limit(output_text: str) -> bool:
    lower = output_text.lower()
    return any(p.lower() in lower for p in USAGE_LIMIT_PATTERNS)


def parse_reset_seconds(output_text: str) -> int | None:
    m = RESET_SECONDS_RE.search(output_text)
    if m:
        try:
            return int(m.group(1))
        except Exception:
            return None

    m = RESET_AT_RE.search(output_text)
    if not m:
        return None
    try:
        reset_at = int(m.group(1))
    except Exception:
        return None
    wait = reset_at - int(time.time())
    return max(wait, 1)


def completion_tuple(output_text: str, phrase: str) -> tuple[bool, str | None]:
    """
    Strict completion:
      - last non-empty line == phrase
      - second-to-last non-empty line == 40-hex commit hash
    """
    lines = [ln.strip() for ln in output_text.splitlines() if ln.strip()]
    if len(lines) < 2:
        return False, None
    if lines[-1] != phrase:
        return False, None
    commit = lines[-2]
    if COMMIT_RE.fullmatch(commit):
        return True, commit
    return False, None


def has_any_flag(args: list[str], flags: Iterable[str]) -> bool:
    s = set(args)
    return any(f in s for f in flags)


def backoff_delay(attempt: int, base: float = 2.0, max_delay: float = 60.0) -> float:
    return min(base ** attempt, max_delay)


def _parse_bool_flag(value: str | None) -> bool:
    if value is None:
        return True
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


ANSI_RESET = "\x1b[0m"
ANSI_COLORS = {
    "red": "\x1b[31m",
    "green": "\x1b[32m",
    "yellow": "\x1b[33m",
    "blue": "\x1b[34m",
    "cyan": "\x1b[36m",
    "gray": "\x1b[90m",
}


def should_use_color(no_color: bool) -> bool:
    if no_color:
        return False
    if os.environ.get("NO_COLOR") is not None:
        return False
    return sys.stdout.isatty()


def colorize(text: str, color: str | None, enabled: bool) -> str:
    if not enabled or not color:
        return text
    code = ANSI_COLORS.get(color)
    if not code:
        return text
    return f"{code}{text}{ANSI_RESET}"


def print_status(label: str, message: str, *, color: str | None, enabled: bool) -> None:
    prefix = colorize(f"[{label}]", color, enabled)
    print(f"{prefix} {message}")


def _supports_flag(codex_exe: str, flag: str, *, subcommand: str | None = None) -> bool:
    cmd = [codex_exe]
    if subcommand:
        cmd.append(subcommand)
    cmd.append("--help")
    try:
        res = subprocess.run(cmd, check=False, capture_output=True, text=True)
    except Exception:
        return False
    output = (res.stdout + "\n" + res.stderr).lower()
    return flag.lower() in output


def normalize_codex_args(
    codex_args: list[str],
    *,
    supports_search: bool,
    supports_config: bool,
) -> list[str]:
    search_enabled: bool | None = None
    normalized: list[str] = []
    i = 0
    while i < len(codex_args):
        arg = codex_args[i]
        if arg == "--search":
            value = None
            if i + 1 < len(codex_args) and not codex_args[i + 1].startswith("-"):
                value = codex_args[i + 1]
                i += 1
            search_enabled = _parse_bool_flag(value)
        elif arg.startswith("--search="):
            search_enabled = _parse_bool_flag(arg.split("=", 1)[1])
        else:
            normalized.append(arg)
        i += 1

    if search_enabled is None:
        return normalized

    if supports_search:
        if search_enabled:
            normalized.append("--search")
        else:
            normalized.append("--search=false")
        return normalized

    if supports_config:
        val = "true" if search_enabled else "false"
        normalized += ["-c", f"features.web_search={val}"]
        print("[warn] --search not supported by codex exec; using -c features.web_search instead.", file=sys.stderr)
        return normalized

    print("[warn] --search not supported by codex exec; ignoring.", file=sys.stderr)
    return normalized


# -----------------------------
# Paths / State files
# -----------------------------


def build_paths(ralph_home: Path) -> Paths:
    specs_root = ralph_home / "specs"
    return Paths(
        ralph_home=ralph_home,
        scratchpad=ralph_home / "SCRATCHPAD.md",
        runs_root=ralph_home / "runs",
        specs_root=specs_root,
        candidates_root=specs_root / "candidates",
        done_root=specs_root / "done",
        runner_log=ralph_home / "ralph.log",
    )


def candidate_path_for_spec(paths: Paths, rel_from_specs: str) -> Path:
    # mirror spec path, but .json
    return (paths.candidates_root / rel_from_specs).with_suffix(".json")


def done_path_for_spec(paths: Paths, rel_from_specs: str) -> Path:
    # mirror spec path, keep .md
    return paths.done_root / rel_from_specs


def is_under_dir(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except Exception:
        return False


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
        if is_under_dir(p, paths.candidates_root) or is_under_dir(p, paths.done_root):
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


def load_candidate(paths: Paths, rel_from_specs: str) -> CandidateInfo | None:
    cpath = candidate_path_for_spec(paths, rel_from_specs)
    if not cpath.exists():
        return None
    try:
        raw = json.loads(cpath.read_text(encoding="utf-8"))
        return CandidateInfo(
            spec_rel=raw["spec_rel"],
            spec_id=raw["spec_id"],
            candidate_commit=raw["candidate_commit"],
            created_at_utc=raw["created_at_utc"],
            last_impl_run_dir=raw.get("last_impl_run_dir"),
            last_verify_run_dir=raw.get("last_verify_run_dir"),
            status=raw.get("status", "candidate"),
        )
    except Exception:
        # Corrupt candidate file: treat as absent (but keep file for inspection)
        return None


def save_candidate(paths: Paths, c: CandidateInfo) -> Path:
    cpath = candidate_path_for_spec(paths, c.spec_rel)
    cpath.parent.mkdir(parents=True, exist_ok=True)
    payload = {
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

# Prompting

# -----------------------------


def build_implementer_prompt(
    *,
    spec: SpecInfo,
    paths: Paths,
    config: Config,
    verifier_feedback: str | None,
) -> str:
    feedback_block = ""
    if verifier_feedback:
        feedback_block = (
            "\n"
            "Verifier feedback from the last verification attempt (fix these issues):\n"
            "\n"
            f"{verifier_feedback.rstrip()}\n"
            "\n"
        )

    return f"""You are an autonomous coding agent running under a Ralph Driven Development (RDD) loop.

NON-INTERACTIVE RULE: Do not ask the user questions. Make reasonable assumptions and record them in SCRATCHPAD.md.

Paths:

* Workspace root (repos live here): {config.workspace_root.as_posix()}
* Ralph home (tooling dir): {paths.ralph_home.as_posix()}
* Spec file (relative to workspace root): {spec.rel_from_workspace}
* Spec file (relative to specs root): {spec.rel_from_specs}
* Scratchpad: {paths.scratchpad.as_posix()}

State dirs (DO NOT modify these manually unless the spec explicitly says so):

* Candidates: {paths.candidates_root.as_posix()}
* Done:       {paths.done_root.as_posix()}
* Runs:       {paths.runs_root.as_posix()}

Mission:

* Implement the spec precisely.
* The spec defines the target repo; you MUST cd into it before editing or running git.
* You may use tools like gh, docker, curl, etc. (YOLO mode).
* Decide what verification to run (fast-first; avoid full suite unless necessary).
* Update SCRATCHPAD.md with:

  * target repo and why
  * key decisions
  * commands you ran (verification included)
  * any risks or follow-ups

Commit rules:

* Commit when complete, in the correct repo.
* Commit message must include the spec id: "{spec.spec_id}: ..."

Output contract (STRICT):

1. Print a short DONE REPORT (changed files, verification commands, key notes).
2. Print the resulting git commit hash (40 lowercase hex chars) on its own line.
3. Print ONLY this exact magic phrase on its own line as the FINAL non-empty line:
   {config.magic_phrase}

Do not print anything after the magic phrase.
{feedback_block}
Now implement the spec.
"""


def build_verifier_prompt(
    *,
    spec: SpecInfo,
    paths: Paths,
    config: Config,
    candidate_commit: str,
) -> str:
    return f"""You are an independent verifier agent in a Ralph Driven Development (RDD) pipeline.

Goal:

* Verify that the spec "{spec.rel_from_specs}" is truly completed at the candidate commit {candidate_commit}.
* Only if verified, you will print the completion contract lines (commit hash + magic phrase).
* If NOT verified, do NOT print the magic phrase. Instead produce a clear failure report with actionable fixes.

NON-INTERACTIVE RULE: Do not ask the user questions.

Constraints:

* Prefer fast, meaningful verification. Avoid full-suite runs unless truly necessary.
* Do NOT modify code and do NOT commit. (Verification-only.)
* If you find issues that require code changes, describe them precisely so the implementer can fix them next iteration.
* Update SCRATCHPAD.md with:

  * what you verified
  * commands you ran
  * whether you had to do any repo selection/checkout decisions

Paths:

* Workspace root: {config.workspace_root.as_posix()}
* Ralph home: {paths.ralph_home.as_posix()}
* Spec file (relative to workspace root): {spec.rel_from_workspace}
* Spec file (relative to specs root): {spec.rel_from_specs}
* Scratchpad: {paths.scratchpad.as_posix()}

Verification steps you MUST do:

1. Read the spec fully and restate acceptance criteria.
2. Determine the target repo per spec and cd into it.
3. Ensure the candidate commit exists in that repo (e.g., git cat-file -t {candidate_commit}).
4. Ensure HEAD is at the candidate commit (checkout if needed) WITHOUT making changes.
5. Run minimal verification you deem necessary (fast-first).
6. Decide VERIFIED vs NOT VERIFIED.

If VERIFIED, output contract (STRICT):

* Print a short VERIFICATION REPORT.
* Print the candidate commit hash (exactly {candidate_commit}) on its own line.
* Print ONLY this exact magic phrase on its own line as the FINAL non-empty line:
  {config.magic_phrase}

If NOT VERIFIED:

* Print a failure report with specific fixes.
* Do NOT print the magic phrase anywhere.
"""


# -----------------------------

# Codex invocation

# -----------------------------


@dataclass(frozen=True)
class CodexRunResult:
    exit_code: int
    output_text: str


def run_codex(
    *,
    codex_exe: str,
    codex_args: list[str],
    prompt: str,
    workspace_root: Path,
    stream_to_console: bool,
) -> CodexRunResult:
    cmd: list[str] = [codex_exe]
    if not has_any_flag(codex_args, ["--cd", "-C"]):
        cmd += ["--cd", str(workspace_root)]
    cmd += [*codex_args, "-"]

    proc = subprocess.Popen(
        cmd,
        cwd=str(workspace_root),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    assert proc.stdin is not None
    assert proc.stdout is not None

    proc.stdin.write(prompt)
    proc.stdin.close()

    captured: list[str] = []
    for line in proc.stdout:
        captured.append(line)
        if stream_to_console:
            print(line, end="", flush=True)

    exit_code = proc.wait()
    return CodexRunResult(exit_code=exit_code, output_text="".join(captured))


# -----------------------------

# Runs logs

# -----------------------------


def make_run_dir(paths: Paths, spec_id: str) -> Path:
    run_dir = paths.runs_root / spec_id / utc_stamp()
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir


def write_run_log(run_dir: Path, filename: str, text: str) -> Path:
    p = run_dir / filename
    p.write_text(text, encoding="utf-8")
    return p


def output_tail(text: str, max_lines: int = 200) -> str:
    lines = text.splitlines()
    if len(lines) <= max_lines:
        return text
    return "\n".join(lines[-max_lines:])


def summarize_output(output_text: str, max_last_len: int = 160) -> dict[str, Any]:
    lines = output_text.splitlines()
    non_empty = [ln.strip() for ln in lines if ln.strip()]
    last_non_empty = non_empty[-1] if non_empty else None
    if last_non_empty and len(last_non_empty) > max_last_len:
        last_non_empty = last_non_empty[:max_last_len] + "..."
    return {
        "output_lines": len(lines),
        "output_chars": len(output_text),
        "output_nonempty_lines": len(non_empty),
        "output_last_nonempty": last_non_empty,
    }


# -----------------------------

# Core pipeline: candidate -> verify -> done

# -----------------------------


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


def verify_candidate(
    *,
    spec: SpecInfo,
    paths: Paths,
    config: Config,
    logger: Logger,
    candidate: CandidateInfo,
    attempt: int,
) -> tuple[bool, str]:
    """
    Returns (verified, verifier_output_text).
    Verified is true only if verifier satisfies strict completion contract AND
    repeats the same candidate commit hash.
    """
    verify_run_dir = make_run_dir(paths, spec.spec_id)
    verify_prompt = build_verifier_prompt(
        spec=spec,
        paths=paths,
        config=config,
        candidate_commit=candidate.candidate_commit,
    )

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
        )
    except Exception:
        err = traceback.format_exc()
        write_run_log(verify_run_dir, "verify-exception.log", err)
        logger.log("verify_exception", spec=spec.rel_from_specs, attempt=attempt, error=err)
        return False, "[exception]\n" + err

    write_run_log(verify_run_dir, "verify.log", res.output_text)
    summary = summarize_output(res.output_text)
    ok, commit = completion_tuple(res.output_text, config.magic_phrase)
    commit_match = ok and commit == candidate.candidate_commit
    logger.log(
        "verify_run_complete",
        spec=spec.rel_from_specs,
        attempt=attempt,
        exit_code=res.exit_code,
        completion_ok=ok,
        completion_commit=commit,
        commit_match=commit_match,
        run_dir=to_rel_posix(verify_run_dir, paths.ralph_home),
        **summary,
    )

    if looks_like_usage_limit(res.output_text):
        reset = parse_reset_seconds(res.output_text)
        if reset is not None:
            wait_s = reset + 30
            reason = "reset_seconds"
            msg = f"usage limit reached during verify; sleeping {wait_s}s before retry"
        else:
            wait_s = DEFAULT_USAGE_LIMIT_WAIT_SECONDS
            reason = "unknown_reset"
            msg = f"usage limit reached during verify; sleeping {wait_s}s before retry (no reset info)"
        logger.log(
            "usage_limit_wait",
            phase="verify",
            spec=spec.rel_from_specs,
            attempt=attempt,
            wait_seconds=wait_s,
            reset_seconds=reset,
            reason=reason,
        )
        print_status("wait", msg, color="yellow", enabled=config.color_output)
        time.sleep(wait_s)
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
            status="verified",
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
    - If candidate exists and not forced: verify it; if verified mark done; else implement fixes
    - Otherwise: implement -> candidate -> verify -> done
    """
    rel = spec.rel_from_specs
    forced = rel in config.force_specs
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

    # If there is a candidate already (e.g. from previous interrupted run), try verify first.
    candidate = load_candidate(paths, rel)

    attempt = 1
    while attempt <= config.max_attempts:
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
            verified, vout = verify_candidate(
                spec=spec,
                paths=paths,
                config=config,
                logger=logger,
                candidate=candidate,
                attempt=attempt,
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
            verifier_feedback = output_tail(vout)
            candidate = None
            delay = backoff_delay(attempt)
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

        print_status(
            "start",
            f"{rel} | implement attempt {attempt}/{config.max_attempts}",
            color="blue",
            enabled=config.color_output,
        )
        logger.log("impl_start", spec=rel, attempt=attempt)

        impl_run_dir = make_run_dir(paths, spec.spec_id)
        impl_prompt = build_implementer_prompt(
            spec=spec,
            paths=paths,
            config=config,
            verifier_feedback=verifier_feedback,
        )

        try:
            res = run_codex(
                codex_exe=config.codex_exe,
                codex_args=config.codex_args,
                prompt=impl_prompt,
                workspace_root=config.workspace_root,
                stream_to_console=config.stream_output,
            )
        except Exception:
            err = traceback.format_exc()
            write_run_log(impl_run_dir, "impl-exception.log", err)
            logger.log("impl_exception", spec=rel, attempt=attempt, error=err)
            delay = backoff_delay(attempt)
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
        summary = summarize_output(res.output_text)
        ok, commit = completion_tuple(res.output_text, config.magic_phrase)
        logger.log(
            "impl_run_complete",
            spec=rel,
            attempt=attempt,
            exit_code=res.exit_code,
            completion_ok=ok,
            completion_commit=commit,
            run_dir=to_rel_posix(impl_run_dir, paths.ralph_home),
            **summary,
        )

        if looks_like_usage_limit(res.output_text):
            reset = parse_reset_seconds(res.output_text)
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
            delay = backoff_delay(attempt)
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
            delay = backoff_delay(attempt)
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

        # Save/overwrite candidate
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
        verified, vout = verify_candidate(
            spec=spec,
            paths=paths,
            config=config,
            logger=logger,
            candidate=c,
            attempt=attempt,
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

        # Not verified: use verifier output tail as feedback for next impl attempt
        verifier_feedback = output_tail(vout)
        candidate = None
        delay = backoff_delay(attempt)
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


# -----------------------------

# CLI / Main

# -----------------------------


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


if __name__ == "__main__":
    raise SystemExit(main())
