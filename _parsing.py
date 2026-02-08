"""Codex output parsing: completion detection, usage limits, session ids, etc."""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any

from _types import (
    COMMIT_RE,
    PLAN_INVALIDATION_RE,
    RESET_AT_RE,
    RESET_SECONDS_RE,
    SESSION_ID_RE,
    TOKENS_USED_MARKER,
    USAGE_LIMIT_PATTERNS,
    USAGE_LIMIT_TAIL_LINES,
)


def looks_like_usage_limit(output_text: str) -> bool:
    lower = output_text.lower()
    return any(p.lower() in lower for p in USAGE_LIMIT_PATTERNS)


def parse_reset_seconds(output_text: str) -> int | None:
    m: re.Match[str] | None = RESET_SECONDS_RE.search(output_text)
    if m:
        try:
            return int(m.group(1))
        except Exception:
            return None

    m = RESET_AT_RE.search(output_text)
    if not m:
        return None
    try:
        reset_at: int = int(m.group(1))
    except Exception:
        return None
    wait: int = reset_at - int(time.time())
    return max(wait, 1)


def parse_session_id(output_text: str) -> str | None:
    match: re.Match[str] | None = SESSION_ID_RE.search(output_text)
    if not match:
        return None
    return match.group(1)


def parse_tokens_used(output_text: str) -> int | None:
    lines: list[str] = output_text.splitlines()
    for idx, line in enumerate(lines):
        if line.strip().lower() != TOKENS_USED_MARKER:
            continue
        next_idx: int = idx + 1
        while next_idx < len(lines) and not lines[next_idx].strip():
            next_idx += 1
        if next_idx >= len(lines):
            return None
        candidate: str = lines[next_idx].strip()
        digits: str = re.sub(r"\D", "", candidate)
        if digits:
            try:
                return int(digits)
            except Exception:
                return None
    for line in lines:
        lowered: str = line.lower()
        if TOKENS_USED_MARKER not in lowered:
            continue
        digits: str = re.sub(r"\D", "", line)
        if digits:
            try:
                return int(digits)
            except Exception:
                return None
    return None


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


def planner_completed(output_text: str, plan_path: Path, phrase: str) -> bool:
    if not plan_path.exists():
        return False
    content: str = plan_path.read_text(encoding="utf-8")
    if not content.strip():
        return False
    lines: list[str] = [ln.strip() for ln in output_text.splitlines() if ln.strip()]
    return bool(lines) and lines[-1] == phrase


def parse_plan_invalidation(output_text: str) -> str | None:
    match: re.Match[str] | None = PLAN_INVALIDATION_RE.search(output_text)
    if not match:
        return None
    return match.group(1).strip()


def output_tail(text: str, max_lines: int = USAGE_LIMIT_TAIL_LINES) -> str:
    lines: list[str] = text.splitlines()
    if len(lines) <= max_lines:
        return text
    return "\n".join(lines[-max_lines:])


def summarize_output(output_text: str, max_last_len: int = 160) -> dict[str, Any]:
    lines: list[str] = output_text.splitlines()
    non_empty: list[str] = [ln.strip() for ln in lines if ln.strip()]
    last_non_empty: str | None = non_empty[-1] if non_empty else None
    if last_non_empty and len(last_non_empty) > max_last_len:
        last_non_empty = last_non_empty[:max_last_len] + "..."
    return {
        "output_lines": len(lines),
        "output_chars": len(output_text),
        "output_nonempty_lines": len(non_empty),
        "output_last_nonempty": last_non_empty,
    }
