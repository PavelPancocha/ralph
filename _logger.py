"""Logger class for ralph runner events."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


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
