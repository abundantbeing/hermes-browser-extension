#!/usr/bin/env python3
"""controller_trace_report.py - controller timeline reconstruction from journals.

Plan spec: docs/plans/2026-08-22-master-plan-pack/2026-08-22-python-tooling-expansion-plan.md (§2c)

Trigger : safety incidents, demos, phase LIVE-proof assembly.
Input   : companion-plugin journal file(s)/dir (+ optional second path with
          controller event logs).
Output  : ordered timeline reconstructing the controller lifecycle:
          register -> lease -> command -> approval -> action -> stop -> detach,
          artifact receipts attached when records reference them, unobserved
          stages flagged. Exit 0 when every lifecycle stage was observed;
          exit 1 when the trace is partial or empty (incident forensics should
          notice an incomplete story loudly). --json for piping.
Deps    : stdlib only; journal parsing shared with _common.iter_journal_records.

Example:
    python scripts/pytools/controller_trace_report.py tmp/e2e-runs/<run>/companion.journal --json

Suite  : python -m unittest discover -s tests/pytools -v
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

try:
    from _common import (
        EXIT_OK,
        EXIT_USAGE,
        add_json_flag,
        collect_files,
        emit,
        format_ts,
        iter_journal_records,
        usage_error,
    )
except ImportError:  # direct execution from repo root
    from scripts.pytools._common import (  # type: ignore
        EXIT_OK,
        EXIT_USAGE,
        add_json_flag,
        collect_files,
        emit,
        format_ts,
        iter_journal_records,
        usage_error,
    )

LIFECYCLE_STAGES = ["register", "lease", "command", "approval", "action", "stop", "detach"]

STAGE_PATTERNS = {
    # order matters: each record is classified to its FIRST matching stage below.
    "stop": ("stop", "interrupt", "abort", "cancel", "halt"),
    "detach": ("detach", "unregister", "disconnect", "close_control"),
    "register": ("register", "registration", "handshake", "controller.register"),
    "lease": ("lease", "acquire", "lease_acquired", "owner"),
    "command": ("command", "dispatch", "invoke", "execute_request"),
    "approval": ("approval", "approve", "confirm", "permission_granted"),
    "action": ("action", "result", "performed", "completed", "artifact"),
}


def record_timestamp(record: dict[str, Any]) -> str:
    for key in ("ts", "timestamp", "time", "@timestamp", "datetime"):
        value = record.get(key)
        if value:
            return format_ts(value)
    raw = str(record.get("_raw", ""))
    digits = "".join(ch for ch in raw[:32] if ch.isdigit() or ch in ".-T: ")
    return format_ts(digits) if digits else ""


def record_blob(record: dict[str, Any]) -> str:
    parts = []
    if "_raw" in record:
        parts.append(str(record["_raw"]))
    for key in ("event", "type", "message", "detail", "method", "path", "kind"):
        value = record.get(key)
        if isinstance(value, str):
            parts.append(f"{key}={value}")
    return " ".join(parts).lower()


def classify_stage(record: dict[str, Any]) -> str | None:
    blob = record_blob(record)
    if not blob:
        return None
    explicit = record.get("type") or record.get("event")
    if isinstance(explicit, str):
        lowered = explicit.lower()
        for stage, tokens_ in STAGE_PATTERNS.items():
            if any(token in lowered for token in tokens_):
                return stage
    for stage, tokens_ in STAGE_PATTERNS.items():
        if any(token in blob for token in tokens_):
            return stage
    return None


def attach_receipt(record: dict[str, Any]) -> dict[str, Any] | None:
    receipt = record.get("receipt")
    if isinstance(receipt, dict):
        return receipt
    receipts = record.get("receipts")
    if isinstance(receipts, list) and receipts and isinstance(receipts[-1], dict):
        return receipts[-1]
    return None


def build_timeline(files: list[Path], extra_files: list[Path]) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    scanned_records = 0
    for path in [*files, *extra_files]:
        source = str(path)
        for record in iter_journal_records(path):
            scanned_records += 1
            stage = classify_stage(record)
            if not stage:
                continue
            entry: dict[str, Any] = {
                "stage": stage,
                "ts": record_timestamp(record),
                "source": source,
                "line": record.get("_line"),
                "detail": (str(record.get("_raw")) if "_raw" in record else None)
                or str(record.get("message") or record.get("detail") or "")[:200],
            }
            receipt = attach_receipt(record)
            if receipt:
                entry["receipt"] = {
                    key: receipt.get(key)
                    for key in ("tool_name", "ok", "duration_ms", "controller_id", "tab_id")
                    if key in receipt
                }
            entries.append(entry)

    sortable = [e for e in entries if e["ts"]]
    unsortable = [e for e in entries if not e["ts"]]
    sortable.sort(key=lambda e: e["ts"])
    timeline = sortable + unsortable

    observed_stages = {entry["stage"] for entry in timeline}
    missing = [stage for stage in LIFECYCLE_STAGES if stage not in observed_stages]

    report = {
        "summary": (
            f"{len(timeline)} lifecycle events across {len(files) + len(extra_files)} file(s), "
            f"{scanned_records} records scanned"
            + (f"; MISSING STAGES: {', '.join(missing)}" if missing else "; full lifecycle observed")
        ),
        "records_scanned": scanned_records,
        "stages_observed": sorted(observed_stages),
        "missing_stages": missing,
        "timeline": timeline,
    }
    findings = len(missing) if len(files) or len(extra_files) else 1
    return report, findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="controller_trace_report.py",
        description="Reconstruct the ordered controller lifecycle timeline from journal logs.",
    )
    parser.add_argument("target", help="companion journal file or directory")
    parser.add_argument("--extra", default="", help="optional second log file/dir (controller event logs)")
    add_json_flag(parser)
    args = parser.parse_args(argv)

    files = collect_files(args.target)
    extra_files = collect_files(args.extra) if args.extra else []
    if not files and not extra_files:
        return usage_error(f"no readable files at {args.target!r}")
    report, findings = build_timeline(files, extra_files)
    return emit(report, findings, args.json)


if __name__ == "__main__":
    raise SystemExit(main())
