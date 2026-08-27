#!/usr/bin/env python3
"""bot_contract_diff.py - Browser Bot Mode contract vs captured upstream snapshots.

Plan spec: docs/plans/2026-08-22-master-plan-pack/2026-08-22-python-tooling-expansion-plan.md (§2b)
Vocabulary: docs/plans/2026-08-22-master-plan-pack/bot-mode/2026-08-24-hermes-browser-bot-mode-integrated-plan.md (B0)

Trigger : before any Bot Mode slice build; after any Hermes Agent update; in B0 pinning.
Input   : --expected contract fixture JSON and --live captured snapshot JSON.
          Both use: {"schema_version": N, "contracts": {
            "profiles_list": {...}, "canonical_session": {...},
            "group_projection": {"version": N, "caps": [...]},
            "message_agent": {"available": bool},
            "routine_cron": {"available": bool}}}
Output  : drift report - removed fields, suspected renames, added (additive) fields,
          value changes, capability-epoch regressions/increments, group-projection
          cap deltas, availability flips. Exit 1 on ANY breaking drift
          (removals/renames/value changes/epoch regressions/cap shrink/false-flips),
          exit 0 when drift is additive-only.
Deps    : stdlib only.

Example:
    python scripts/pytools/bot_contract_diff.py --expected expected.json --live snapshot.json

Suite  : python -m unittest discover -s tests/pytools -v
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

try:
    from _common import EXIT_OK, EXIT_USAGE, add_json_flag, emit, usage_error
except ImportError:  # direct execution from repo root
    from scripts.pytools._common import (  # type: ignore
        EXIT_OK,
        EXIT_USAGE,
        add_json_flag,
        emit,
        usage_error,
    )

KNOWN_CONTRACTS = [
    "profiles_list",
    "canonical_session",
    "group_projection",
    "message_agent",
    "routine_cron",
]
EPOCH_RE = re.compile(r"(^|_)(epoch|version|schema_version)(_|$)")


def load_doc(path: str, role: str) -> dict[str, Any]:
    p = Path(path)
    if not p.is_file():
        raise ValueError(f"{role} document not found: {path}")
    data = json.loads(p.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("contracts"), dict):
        raise ValueError(f"{role} document must be {{'schema_version': N, 'contracts': {{...}}}}")
    return data


def tokens(name: str) -> set[str]:
    return {t for t in re.split(r"[^a-zA-Z0-9]+", name.lower()) if t}


def is_epoch_key(key: str) -> bool:
    return bool(EPOCH_RE.search(key))


def flatten(mapping: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    flat: dict[str, Any] = {}
    for key, value in mapping.items():
        path = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            flat.update(flatten(value, path))
        else:
            flat[path] = value
    return flat


def leaf_paths(mapping: dict[str, Any]) -> dict[str, str]:
    """Map top-level-path prefix -> dotted leaf name sets aren't needed; keep leaves."""
    return flatten(mapping)


def diff_contract(name: str, expected: dict[str, Any], live: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "removed_fields": [],
        "added_fields": [],
        "suspected_renames": [],
        "changed_values": [],
        "epoch_regressions": [],
        "epoch_increments": [],
        "cap_deltas": {"added_caps": [], "removed_caps": []},
        "availability_flips": [],
    }
    exp_flat = flatten(expected)
    live_flat = flatten(live)

    for key, old_value in exp_flat.items():
        if key not in live_flat:
            # removal or rename candidate
            new_key = find_rename_candidate(key, set(live_flat) - set(exp_flat))
            if new_key:
                result["suspected_renames"].append({"from": key, "to": new_key})
                result["removed_fields"].append(key)
            else:
                result["removed_fields"].append(key)
            continue
        new_value = live_flat[key]

        # lists of capabilities get set-diff treatment
        if isinstance(old_value, list) and isinstance(new_value, list) and all(isinstance(x, str) for x in old_value + new_value):
            removed_caps = sorted(set(old_value) - set(new_value))
            added_caps = sorted(set(new_value) - set(old_value))
            if removed_caps:
                result["cap_deltas"]["removed_caps"].extend(f"{key}:{c}" for c in removed_caps)
            if added_caps:
                result["cap_deltas"]["added_caps"].extend(f"{key}:{c}" for c in added_caps)
            continue

        if old_value != new_value:
            entry = {"field": key, "expected": old_value, "live": new_value}
            if isinstance(old_value, (int, float)) and isinstance(new_value, (int, float)):
                if is_epoch_key(key):
                    (result["epoch_regressions"] if new_value < old_value else result["epoch_increments"]).append(entry)
                    continue
            if isinstance(old_value, bool) and key.endswith("available"):
                if old_value is True and new_value is False:
                    result["availability_flips"].append(entry)
                    continue
            result["changed_values"].append(entry)

    for key in sorted(set(live_flat) - set(exp_flat)):
        result["added_fields"].append(key)

    if name == "group_projection":
        # surface group projection version movement distinctly
        ev = expected.get("version")
        lv = live.get("version")
        if isinstance(ev, (int, float)) and isinstance(lv, (int, float)) and lv < ev:
            result["epoch_regressions"].append({"field": "group_projection.version", "expected": ev, "live": lv})

    breaking = (
        len(result["removed_fields"])
        + len(result["suspected_renames"])
        + len(result["changed_values"])
        + len(result["epoch_regressions"])
        + len(result["cap_deltas"]["removed_caps"])
        + len(result["availability_flips"])
    )
    result["breaking_count"] = breaking
    return result


def find_rename_candidate(removed_key: str, added_keys: set[str]) -> str | None:
    removed_tokens = tokens(removed_key.split(".")[-1])
    best, best_score = None, 0.0
    for candidate in added_keys:
        candidate_tokens = tokens(candidate.split(".")[-1])
        if not removed_tokens or not candidate_tokens:
            continue
        overlap = len(removed_tokens & candidate_tokens) / max(len(removed_tokens), len(candidate_tokens))
        if overlap > best_score:
            best, best_score = candidate, overlap
    return best if best_score >= 0.5 else None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="bot_contract_diff.py",
        description="Diff pinned Browser Bot Mode expectations against a live/captured snapshot.",
        epilog=(
            "Fixture format: {'schema_version': N, 'contracts': {'profiles_list': {...}, "
            "'canonical_session': {...}, 'group_projection': {'version': N, 'caps': [...]}, "
            "'message_agent': {'available': true}, 'routine_cron': {'available': true}}}"
        ),
    )
    parser.add_argument("--expected", required=True, help="pinned expected-contract fixture JSON")
    parser.add_argument("--live", required=True, help="captured live-snapshot JSON to validate against")
    add_json_flag(parser)
    args = parser.parse_args(argv)

    try:
        expected_doc = load_doc(args.expected, "expected")
        live_doc = load_doc(args.live, "live")
    except (ValueError, OSError, json.JSONDecodeError) as error:
        return usage_error(str(error))

    per_contract: dict[str, Any] = {}
    total_breaking = 0
    expected_contracts = expected_doc["contracts"]
    live_contracts = live_doc["contracts"]

    for name in KNOWN_CONTRACTS:
        if name not in expected_contracts:
            continue  # not pinned; nothing to enforce
        if name not in live_contracts:
            per_contract[name] = {
                "summary": "MISSING ENTIRELY in live snapshot",
                "removed_fields": ["<entire contract>"],
                "breaking_count": 1,
            }
            total_breaking += 1
            continue
        result = diff_contract(name, expected_contracts[name], live_contracts[name])
        per_contract[name] = result
        total_breaking += result.get("breaking_count", 0)

    unknown_live = sorted(set(live_contracts) - set(KNOWN_CONTRACTS))
    if unknown_live:
        per_contract["_unknown_live_sections"] = unknown_live

    schema_note = ""
    if expected_doc.get("schema_version") != live_doc.get("schema_version"):
        schema_note = (
            f"fixture schema_version differs: expected={expected_doc.get('schema_version')} "
            f"live={live_doc.get('schema_version')}"
        )

    report = {
        "summary": (
            f"{total_breaking} breaking drift item(s) across {len(per_contract)} contract section(s)"
            + (f"; {schema_note}" if schema_note else "")
        ),
        "schema_note": schema_note,
        "verdict": "BREAKING DRIFT" if total_breaking else "additive-only",
        "contracts": per_contract,
    }
    return emit(report, total_breaking, args.json)


if __name__ == "__main__":
    raise SystemExit(main())
