#!/usr/bin/env python3
"""ralph.py - Ralph Driven Development (RDD) runner (Codex-oriented).

Pipeline: spec -> plan -> implement -> verify -> done

Usage: python ralph/ralph.py [options]
See: python ralph/ralph.py --help
"""
from __future__ import annotations

from _cli import main

if __name__ == "__main__":
    raise SystemExit(main())
