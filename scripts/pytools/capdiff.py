#!/usr/bin/env python3
"""capdiff.py - capability-manifest <-> live-gateway-route three-way diff.

Plan spec: docs/plans/2026-08-22-master-plan-pack/2026-08-22-python-tooling-expansion-plan.md (§2)

Trigger : before every release cut; after changes to extension/lib/capabilities.mjs
          or companion-plugin route registration; during Bot Mode B0 pinning.
Input   : (a) extension capability source (extension/lib/capabilities.mjs) or a
              JSON manifest {"advertised": [...]} / {"flags": {...}};
          (b) live gateway route table: JSON {"routes": [...]}, bare JSON list,
              text file (one route per line, # comments ok), or a .py/.mjs/.js
              module whose string literals contain route tokens.
Output  : three-way report - advertised-but-unroutable, routable-but-unadvertised,
          matched. Exit 1 when advertised-but-unroutable is non-empty (--strict
          additionally exits 1 on routable-but-unadvertised).
Deps    : stdlib only.

Name matching is deliberately heuristic and DOCUMENTED: names are lowercased and
tokenized on non-alphanumerics (browser_context_upload ~ browser.context.upload ~
/v1/browser-context/upload); transport words v1/api are dropped and sets compared
by mutual superset. A human reviews anything ambiguous before acting on findings.

Drift watch (mechanism only): --write-baseline FILE stores today's classification;
--baseline FILE diffs against it and reports additions/removals per bucket.

Example:
    python scripts/pytools/capdiff.py --capabilities extension/lib/capabilities.mjs --routes routes.txt

Suite  : python -m unittest discover -s tests/pytools -v
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

try:
    from _common import EXIT_OK, EXIT_USAGE, add_json_flag, collect_files, emit, iter_lines, usage_error
except ImportError:  # direct execution from repo root
    from scripts.pytools._common import (  # type: ignore
        EXIT_OK,
        EXIT_USAGE,
        add_json_flag,
        collect_files,
        emit,
        iter_lines,
        usage_error,
    )

STOP_TOKENS = {"v1", "v2", "api"}
FREEZE_BLOCK_RE = re.compile(r"(?:const|var)\s+(\w+)\s*=\s*Object\.freeze\(\{", re.MULTILINE)
KEY_RE = re.compile(r"^\s{2}([A-Za-z][A-Za-z0-9_]*)\s*:")
STRING_RE = re.compile(r"""['"]([^'"\n]{3,120})['"]""")


def tokens(name: str) -> frozenset[str]:
    return frozenset(t for t in re.split(r"[^a-z0-9]+", name.lower()) if t and t not in STOP_TOKENS)


def names_match(advertised: str, routable: str) -> bool:
    a, b = tokens(advertised), tokens(routable)
    if not a or not b:
        return False
    return bool(a <= b or b <= a)


def extract_freeze_object_keys(source: str, const_name: str) -> dict[str, str]:
    """Extract {camelKey: snake_value} pairs from `const X = Object.freeze({...})`."""
    match = FREEZE_BLOCK_RE.search(source)
    # find the specific constant block
    for match in FREEZE_BLOCK_RE.finditer(source):
        if match.group(1) != const_name:
            continue
        depth, index = 1, match.end()
        while index < len(source) and depth:
            if source[index] == "{":
                depth += 1
            elif source[index] == "}":
                depth -= 1
            index += 1
        block = source[match.end():index]
        pairs: dict[str, str] = {}
        for line in block.splitlines():
            key_match = KEY_RE.match(line)
            if not key_match:
                continue
            value_match = re.search(r"""['"]([^'"]+)['"]""", line)
            pairs[key_match.group(1)] = value_match.group(1) if value_match else ""
        return pairs
    return {}


def load_advertised(spec: str) -> list[str]:
    path = Path(spec)
    text = "\n".join(iter_lines(path)) if path.is_file() else ""
    if text.strip().startswith("{") or text.strip().startswith("["):
        data = json.loads(text)
        if isinstance(data, list):
            return [str(x) for x in data]
        if isinstance(data.get("advertised"), list):
            return [str(x) for x in data["advertised"]]
        if isinstance(data.get("flags"), dict):
            return [str(v) for v in data["flags"].values()]
        raise ValueError("manifest JSON must be a list or {'advertised': [...]}/{'flags': {...}}")
    flags = extract_freeze_object_keys(text, "BROWSER_CAPABILITY_FLAGS")
    wired = [value for value in flags.values() if value]
    if not wired:
        raise ValueError(f"could not extract BROWSER_CAPABILITY_FLAGS from {spec}")
    return wired


def load_routes(spec: str) -> list[str]:
    files = collect_files(spec)
    if not files:
        raise ValueError(f"no readable route input at {spec!r}")
    routes: list[str] = []
    for path in files:
        suffix = path.suffix.lower()
        if suffix == ".json":
            data = json.loads("\n".join(iter_lines(path)))
            items = data.get("routes", []) if isinstance(data, dict) else data
            routes.extend(str(item) for item in items)
            continue
        for line in iter_lines(path):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith(("'", '"')) and suffix in (".py", ".mjs", ".js"):
                for literal in STRING_RE.findall(stripped):
                    if looks_like_route(literal):
                        routes.append(literal)
            elif looks_like_route(stripped):
                routes.append(stripped.rstrip(","))
    return sorted(set(routes))


def looks_like_route(token: str) -> bool:
    if token.startswith("/"):
        return bool(re.match(r"^/[\w][\w/{}.\-]*$", token))
    parts = token.split(".")
    return len(parts) >= 2 and all(p.isidentifier() for p in parts)


def three_way(advertised: list[str], routable: list[str]) -> dict[str, list[str]]:
    advertised_but_unroutable = []
    matched = []
    for name in advertised:
        if any(names_match(name, route) for route in routable):
            matched.append(name)
        else:
            advertised_but_unroutable.append(name)
    routable_but_unadvertised = [
        route for route in routable
        if not any(names_match(name, route) for name in advertised)
    ]
    return {
        "advertised_but_unroutable": sorted(advertised_but_unroutable),
        "matched": sorted(matched),
        "routable_but_unadvertised": sorted(routable_but_unadvertised),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="capdiff.py",
        description="Diff extension-advertised capabilities against known gateway routes.",
    )
    parser.add_argument("--capabilities", required=True, help="extension/lib/capabilities.mjs or JSON manifest")
    parser.add_argument("--routes", required=True, help="routes file/dir/module")
    parser.add_argument("--strict", action="store_true", help="also fail when routable-but-unadvertised is non-empty")
    parser.add_argument("--write-baseline", default="", help="store current classification as a baseline JSON file")
    parser.add_argument("--baseline", default="", help="compare against a stored baseline JSON file")
    add_json_flag(parser)
    args = parser.parse_args(argv)

    try:
        advertised = load_advertised(args.capabilities)
        routable = load_routes(args.routes)
    except (ValueError, OSError, json.JSONDecodeError) as error:
        return usage_error(str(error))

    buckets = three_way(advertised, routable)
    findings = len(buckets["advertised_but_unroutable"]) or (
        len(buckets["routable_but_unadvertised"]) if args.strict else 0
    )

    report: dict[str, Any] = {
        "summary": (
            f"{len(buckets['advertised_but_unroutable'])} advertised-but-unroutable, "
            f"{len(buckets['matched'])} matched, "
            f"{len(buckets['routable_but_unadvertised'])} routable-but-unadvertised"
        ),
        "counts": {key: len(value) for key, value in buckets.items()},
        **buckets,
    }

    if args.write_baseline:
        Path(args.write_baseline).write_text(json.dumps(buckets, indent=2), encoding="utf-8")
        report["baseline_written"] = args.write_baseline
    if args.baseline:
        baseline = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
        report["drift_vs_baseline"] = {
            bucket: {
                "added": sorted(set(buckets[bucket]) - set(baseline.get(bucket, []))),
                "removed": sorted(set(baseline.get(bucket, [])) - set(buckets[bucket])),
            }
            for bucket in buckets
        }

    return emit(report, findings, args.json)


if __name__ == "__main__":
    raise SystemExit(main())
