#!/usr/bin/env python3
"""gwlog_forensics.py - gateway log forensics / connect-failure attribution.

Plan spec: docs/plans/2026-08-22-master-plan-pack/2026-08-22-python-tooling-expansion-plan.md (§1)

Trigger : any "extension can't connect" report (issue triage, ghost-loop postmortems).
Input   : gateway log dir or single JSONL/text journal file(s) + optional time window.
Output  : attribution table classifying failed connect attempts:
          401-unauthorized | 404-route-missing | zero-attempts | timeout/reset
          plus counts, first/last timestamps, offending origins/session ids.
Deps    : stdlib only.

Example:
    python scripts/pytools/gwlog_forensics.py logs/gateway.jsonl --json

Suite  : python -m unittest discover -s tests/pytools -v
"""

from __future__ import annotations

import argparse
import re
from collections import Counter
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

TS_RE = re.compile(r"\d{4}-\d{2}-\d{2}[T ][0-9:.]+")
ORIGIN_RE = re.compile(r"https?://[^\s\"']+")
SESSION_RE = re.compile(r"\b(?:session[_ ]?id|sid)[\"':=\s]+([A-Za-z0-9_-]{6,64})", re.IGNORECASE)

CATEGORY_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("401-unauthorized", re.compile(r"\b401\b|unauthorized|authentication_error|invalid[_ ]api[_ ]key", re.IGNORECASE)),
    ("404-route-missing", re.compile(r"\b404\b|not found|no route|route missing|unknown endpoint", re.IGNORECASE)),
    ("timeout/reset", re.compile(r"\btimeout\b|\btimed?\s*out\b|connection\s*reset|ECONNRESET|ETIMEDOUT|ECONNREFUSED", re.IGNORECASE)),
]


def classify_record(record: dict[str, Any]) -> str | None:
    """Return a failure category for the record, or None if not a connect failure."""
    blob_parts = []
    if "_raw" in record:
        blob_parts.append(str(record["_raw"]))
    for key in ("message", "error", "detail", "reason", "event", "msg", "path", "url"):
        value = record.get(key)
        if isinstance(value, str):
            blob_parts.append(value)
    status = record.get("status") or record.get("code") or record.get("status_code")
    if isinstance(status, int):
        blob_parts.append(f" status {status}")
    if isinstance(status, str) and status.isdigit():
        blob_parts.append(f" status {status}")
    blob = " ".join(blob_parts)
    # A healthy/normal line with no failure vocabulary is not an incident.
    if not blob:
        return None
    lowered = blob.lower()
    looks_failure = (
        any(token in lowered for token in ("error", "fail", "denied", "reject"))
        or bool(re.search(r"\b(401|404)\b", blob))
        or any(pattern.search(blob) for _, pattern in CATEGORY_PATTERNS[2:])
    )
    if not looks_failure:
        return None
    for category, pattern in CATEGORY_PATTERNS:
        if pattern.search(blob):
            return category
    return None


def record_timestamp(record: dict[str, Any]) -> str:
    for key in ("ts", "timestamp", "time", "@timestamp", "datetime"):
        value = record.get(key)
        if value:
            return format_ts(value)
    raw = record.get("_raw", "")
    match = TS_RE.search(raw)
    return format_ts(match.group(0)) if match else ""


def within_window(ts: str, since: str, until: str) -> bool:
    if since and ts and ts < format_ts(since):
        return False
    if until and ts and ts > format_ts(until):
        return False
    return True


def analyze(files: list, since: str, until: str, origin_filter: str) -> tuple[dict[str, Any], int]:
    counts: Counter[str] = Counter()
    first_ts: dict[str, str] = {}
    last_ts: dict[str, str] = {}
    origins: Counter[str] = Counter()
    sessions: Counter[str] = Counter()
    scanned = 0
    attempts_seen = False
    for path in files:
        for record in iter_journal_records(path):
            scanned += 1
            blob = str(record.get("_raw", "")) or " ".join(
                str(record.get(k, "")) for k in ("message", "error", "detail", "path")
            )
            attemptish = any(token in blob.lower() for token in ("connect", "request", "register", "/v1/", "/api/", "gateway"))
            origin_hits = ORIGIN_RE.findall(blob)
            session_hits = SESSION_RE.findall(blob)
            if attemptish:
                attempts_seen = True
            if origin_filter and origin_filter not in blob:
                continue
            category = classify_record(record)
            if not category:
                continue
            ts = record_timestamp(record)
            if not within_window(ts, since, until):
                continue
            counts[category] += 1
            if category not in first_ts or (ts and (not first_ts[category] or ts < first_ts[category])):
                first_ts[category] = ts
            if category not in last_ts or (ts and ts > last_ts[category]):
                last_ts[category] = ts
            for origin in origin_hits:
                origins[origin.rstrip('.,;:)]}\'"')] += 1
            for sid in session_hits:
                sessions[sid] += 1
    total_failures = sum(counts.values())
    if not attempts_seen:
        counts["zero-attempts"] += 1
    report = {
        "summary": (
            f"{total_failures} classified connect failures across {scanned} records"
            + (" | NO connection attempts found (zero-attempts)" if not attempts_seen else "")
        ),
        "files_scanned": len(files),
        "records_scanned": scanned,
        "total_classified_failures": total_failures,
        "categories": {
            name: {
                "count": counts.get(name, 0),
                "first_ts": first_ts.get(name, ""),
                "last_ts": last_ts.get(name, ""),
            }
            for name in [c for c, _ in CATEGORY_PATTERNS] + ["zero-attempts"]
        },
        "offending_origins": dict(origins.most_common(10)),
        "offending_session_ids": dict(sessions.most_common(10)),
    }
    return report, total_failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="gwlog_forensics.py",
        description="Classify gateway connect-failure attempts in journal/log files.",
    )
    parser.add_argument("target", help="log file or directory of logs")
    parser.add_argument("--since", default="", help="ISO timestamp lower bound (inclusive)")
    parser.add_argument("--until", default="", help="ISO timestamp upper bound (inclusive)")
    parser.add_argument("--origin", default="", help="only consider records containing this origin substring")
    add_json_flag(parser)
    args = parser.parse_args(argv)

    files = collect_files(args.target)
    if not files:
        return usage_error(f"no readable files at {args.target!r}")
    report, findings = analyze(files, args.since, args.until, args.origin)
    return emit(report, findings, args.json)


if __name__ == "__main__":
    raise SystemExit(main())
