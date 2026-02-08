"""Pure utility functions: time, path, ANSI, backoff. Zero internal imports."""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Final


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


def backoff_delay(attempt: int, base: float = 2.0, max_delay: float = 60.0) -> float:
    return min(base ** attempt, max_delay)


# -----------------------------
# ANSI colors
# -----------------------------

ANSI_RESET: Final[str] = "\x1b[0m"
ANSI_COLORS: Final[dict[str, str]] = {
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
