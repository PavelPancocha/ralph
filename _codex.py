"""Codex invocation, run logging, and codex args normalization."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Iterable

from _types import COMPACT_PROMPT_PREFIX, CodexRunResult, Paths
from _util import utc_stamp


# -----------------------------
# Codex arg helpers
# -----------------------------


def has_any_flag(args: list[str], flags: Iterable[str]) -> bool:
    s = set(args)
    return any(f in s for f in flags)


def _parse_bool_flag(value: str | None) -> bool:
    if value is None:
        return True
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


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
# Codex invocation
# -----------------------------


def maybe_compact_prompt(prompt: str, resume_session_id: str | None) -> str:
    if resume_session_id is None:
        return prompt
    return COMPACT_PROMPT_PREFIX + prompt


def build_codex_args(codex_args: list[str], resume_session_id: str | None) -> list[str]:
    if resume_session_id is None:
        return [*codex_args, "-"]
    if codex_args and codex_args[0] == "exec":
        return ["exec", "resume", resume_session_id, *codex_args[1:], "-"]
    return ["exec", "resume", resume_session_id, *codex_args, "-"]


def run_codex(
    *,
    codex_exe: str,
    codex_args: list[str],
    prompt: str,
    workspace_root: Path,
    stream_to_console: bool,
    resume_session_id: str | None,
) -> CodexRunResult:
    cmd: list[str] = [codex_exe]
    if not has_any_flag(codex_args, ["--cd", "-C"]):
        cmd += ["--cd", str(workspace_root)]
    cmd += build_codex_args(codex_args, resume_session_id)

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

    prepared_prompt: str = maybe_compact_prompt(prompt, resume_session_id)
    proc.stdin.write(prepared_prompt)
    proc.stdin.close()

    captured: list[str] = []
    for line in proc.stdout:
        captured.append(line)
        if stream_to_console:
            print(line, end="", flush=True)

    exit_code = proc.wait()
    return CodexRunResult(exit_code=exit_code, output_text="".join(captured))


# -----------------------------
# Run logs
# -----------------------------


def make_run_dir(paths: Paths, spec_id: str) -> Path:
    run_dir = paths.runs_root / spec_id / utc_stamp()
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir


def write_run_log(run_dir: Path, filename: str, text: str) -> Path:
    p = run_dir / filename
    p.write_text(text, encoding="utf-8")
    return p
