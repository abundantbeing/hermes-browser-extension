"""Shared plumbing for HBE pytools scripts.

Conventions (per docs/plans/2026-08-22-master-plan-pack/2026-08-22-python-tooling-expansion-plan.md):
- Exit codes: 0 clean, 1 findings, 2 usage-or-environment error.
- Every script supports --json machine output plus human-readable default.
- Stdlib only; Windows-first paths.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable, Iterator

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_USAGE = 2


def add_json_flag(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON instead of human text.")


def emit(report: dict[str, Any], findings_count: int, as_json: bool) -> int:
    """Print a report dict either as pretty JSON or human text, return the process exit code."""
    if as_json:
        print(json.dumps(report, indent=2, default=str))
    else:
        summary = report.get("summary")
        if isinstance(summary, str):
            print(summary)
        for key, value in report.items():
            if key == "summary":
                continue
            print(f"{key}: {json.dumps(value, default=str) if not isinstance(value, str) else value}")
    if findings_count > 0:
        return EXIT_FINDINGS
    return EXIT_OK


def usage_error(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return EXIT_USAGE


def iter_lines(path: str | Path) -> Iterator[str]:
    """Yield stripped lines from a file, tolerating UTF-8 BOM and bad bytes."""
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            line = raw.lstrip("\ufeff").rstrip("\r\n")
            yield line


def iter_journal_records(path: str | Path) -> Iterator[dict[str, Any]]:
    """Yield dict records from a JSONL-ish log file.

    Lines that parse as JSON objects are yielded as-is. Non-JSON lines are
    yielded as {"_raw": "<line>", "_line": <n>} so callers can run regex
    classifiers over free-text log lines without losing position info.
    """
    for lineno, line in enumerate(iter_lines(path), start=1):
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            yield {"_raw": line, "_line": lineno}
            continue
        if isinstance(parsed, dict):
            parsed.setdefault("_line", lineno)
            yield parsed
        else:
            yield {"_raw": line, "_line": lineno}


def collect_files(target: str | Path) -> list[Path]:
    """Expand a file or directory target into a list of readable files."""
    p = Path(target)
    if p.is_dir():
        return sorted(child for child in p.iterdir() if child.is_file())
    if p.is_file():
        return [p]
    return []


def format_ts(value: Any) -> str:
    """Normalize assorted timestamp shapes to a sortable ISO string (best effort)."""
    text = str(value or "").strip()
    return text.replace("Z", "+00:00") if text else ""
