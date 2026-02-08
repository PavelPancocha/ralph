"""Declarative types, constants, enums, dataclasses, and regex patterns."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum, StrEnum
from pathlib import Path
from typing import Final, Literal, TypeAlias


# -----------------------------
# Defaults
# -----------------------------

DEFAULT_MAGIC_PHRASE: Final[str] = "I AM HYPER SURE I AM DONE!"
DEFAULT_MAX_ATTEMPTS: Final[int] = 10
DEFAULT_USAGE_LIMIT_WAIT_SECONDS: Final[int] = 5

# YOLO + skip git check by default
DEFAULT_CODEX_ARGS: Final[str] = (
    "exec "
    "--dangerously-bypass-approvals-and-sandbox "
    "--skip-git-repo-check"
)


class CandidateStatus(StrEnum):
    CANDIDATE = "candidate"
    VERIFIED = "verified"


class PlanStatus(StrEnum):
    ACTIVE = "active"
    INVALIDATED = "invalidated"


# -----------------------------
# Types
# -----------------------------

class SpecResult(Enum):
    COMPLETED = "completed"
    SKIPPED = "skipped"
    FAILED = "failed"
    DRY_RUN = "dry_run"


SessionPhase: TypeAlias = Literal["plan", "impl", "verify"]


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
    status: CandidateStatus


@dataclass(frozen=True)
class SessionInfo:
    spec_rel: str
    spec_id: str
    plan_session_id: str | None
    impl_session_id: str | None
    verify_session_id: str | None
    updated_at_utc: str


@dataclass(frozen=True)
class PlanInfo:
    spec_rel: str
    spec_id: str
    status: PlanStatus
    created_at_utc: str
    invalidated_at_utc: str | None
    invalidation_reason: str | None
    attempt: int


@dataclass(frozen=True)
class CodexRunResult:
    exit_code: int
    output_text: str


# -----------------------------
# Regex patterns and string constants
# -----------------------------

SPEC_NAME_RE: Final[re.Pattern[str]] = re.compile(r"^\d{4}-.*\.md$")
HEADING_RE: Final[re.Pattern[str]] = re.compile(r"^#{1,6}\s+\S", re.MULTILINE)

USAGE_LIMIT_PATTERNS: Final[tuple[str, ...]] = (
    "usage_limit_reached",
    "You've hit your usage limit",
    "You have hit your usage limit",
    "Too Many Requests",
    "rate_limit_exceeded",
    "RateLimitError",
)
USAGE_LIMIT_TAIL_LINES: Final[int] = 200
RESET_SECONDS_RE: Final[re.Pattern[str]] = re.compile(r'resets_in_seconds\\?"\s*:\s*(\d+)')
RESET_AT_RE: Final[re.Pattern[str]] = re.compile(r'resets_at\\?"\s*:\s*(\d+)')
SESSION_ID_RE: Final[re.Pattern[str]] = re.compile(
    r"^session id:\s*([0-9a-f-]{36})$",
    re.IGNORECASE | re.MULTILINE,
)
TOKENS_USED_MARKER: Final[str] = "tokens used"

COMMIT_RE: Final[re.Pattern[str]] = re.compile(r"^[0-9a-f]{40}$")
PLAN_INVALIDATION_RE: Final[re.Pattern[str]] = re.compile(
    r"^PLAN_INVALIDATION:\s*(.+)$",
    re.MULTILINE,
)
COMPACT_PROMPT_PREFIX: Final[str] = (
    "Before starting, compact the conversation into a concise internal summary. "
    "Do not output the summary. Then proceed with the task.\n\n"
)
