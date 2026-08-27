#!/usr/bin/env python3
"""release_consistency.py - release-art/version/changelog consistency gate.

Plan spec: docs/plans/2026-08-22-master-plan-pack/2026-08-22-python-tooling-expansion-plan.md (§3)

Trigger : immediately before tagging any release; after cherry-picks/backports.
Input   : repo root (--repo, default '.').
Output  : drift report - version mismatches across manifest.json / package.json /
          CHANGELOG.md latest heading, stale README version strings, missing
          current-version release-art filenames, changed-since-tag files lacking
          changelog coverage. Exit 1 on any mismatch. --fix-dates normalizes
          changelog heading format to `## [X.Y.Z] - YYYY-MM-DD`.
Deps    : stdlib; git via subprocess for since-last-tag diffs (optional, degrades
          gracefully when tags are absent).

Example:
    python scripts/pytools/release_consistency.py --repo . --tag v0.3.1

Suite  : python -m unittest discover -s tests/pytools -v
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
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

SEMVER = r"\d+\.\d+\.\d+"
CHANGELOG_HEADING_RE = re.compile(rf"^#+\s*\[?({SEMVER})\]?\s*[-–—~]\s*(\S+)", re.MULTILINE)
CANONICAL_HEADING = "## [{version}] - {date}"
VERSIONED_FILENAME_RE = re.compile(rf"(?:^|[^0-9])v?({SEMVER})(?:[^0-9]|$)", re.IGNORECASE)
ART_DIRS = ["assets", "art", "posters", "release-art", "artifacts"]


def read_json_version(path: Path, key: str = "version") -> str | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    value = data.get(key)
    return str(value) if value else None


def parse_changelog(path: Path) -> dict[str, Any]:
    """Return {'version', 'date', 'heading_raw', 'body', 'headings': [(raw, ver, date)]}."""
    if not path.is_file():
        return {"version": None, "date": None, "heading_raw": None, "body": "", "headings": []}
    text = path.read_text(encoding="utf-8")
    matches = CHANGELOG_HEADING_RE.findall(text)
    if not matches:
        return {"version": None, "date": None, "heading_raw": None, "body": text, "headings": []}
    latest_version, latest_date = matches[0]
    first_match = CHANGELOG_HEADING_RE.search(text)
    body_start = first_match.end() if first_match else 0
    next_match = CHANGELOG_HEADING_RE.search(text, body_start)
    body = text[body_start:next_match.start()] if next_match else text[body_start:]
    return {
        "version": latest_version,
        "date": latest_date,
        "heading_raw": first_match.group(0).strip() if first_match else None,
        "body": body,
        "headings": [(m.group(0).strip(), m.group(1), m.group(2)) for m in [first_match]],
    }


def normalize_changelog_dates(path: Path) -> list[str]:
    """Rewrite changelog headings into canonical `## [X.Y.Z] - YYYY-MM-DD` form."""
    if not path.is_file():
        return []
    text = path.read_text(encoding="utf-8")
    normalized: list[str] = []

    def fix(match: re.Match[str]) -> str:
        hashes, bracket_open, version, sep, date = (
            match.group(1),
            match.group(2) or "",
            match.group(3),
            match.group(4),
            match.group(5),
        )
        clean_date = str(date).replace("/", "-").replace(".", "-")
        canonical = f"{hashes} [{'[' if not bracket_open else ''}{version}{']' if not bracket_open else ''}] - {clean_date}"
        if match.group(0).strip() != canonical.strip():
            normalized.append(f"{match.group(0).strip()} -> {canonical}")
        return canonical

    pattern = re.compile(
        rf"^(#+)(\s*)\[?(?:\[)?({SEMVER})\]?\s*([-–—~]|-)\s*(\d{{4}}[-/.]\d{{2}}[-/.]\d{{2}})",
        re.MULTILINE,
    )
    new_text = pattern.sub(fix, text)
    if normalized:
        path.write_text(new_text, encoding="utf-8")
    return normalized


def last_tag(repo: Path, tag_override: str) -> tuple[str | None, str]:
    if tag_override:
        return tag_override, "--tag override"
    try:
        result = subprocess.run(
            ["git", "describe", "--tags", "--abbrev=0"],
            cwd=repo, capture_output=True, text=True, timeout=15,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip(), "git describe"
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None, "no git tags available"


def changed_since_tag(repo: Path, base_ref: str) -> list[str]:
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", f"{base_ref}..HEAD"],
            cwd=repo, capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            return [line.strip() for line in result.stdout.splitlines() if line.strip()]
    except (OSError, subprocess.TimeoutExpired):
        pass
    return []


def coverage_gaps(changed_files: list[str], changelog_body: str) -> list[str]:
    gaps = []
    for filepath in changed_files:
        if not re.search(r"\.(js|mjs|py|json|html|css)$", filepath):
            continue
        stem = Path(filepath).stem.lower()
        if stem and stem not in changelog_body.lower():
            gaps.append(filepath)
    return sorted(set(gaps))


def release_art_status(repo: Path, version: str) -> dict[str, Any]:
    found_current: list[str] = []
    scanned_dirs: list[str] = []
    for dirname in ART_DIRS:
        art_dir = repo / dirname
        if not art_dir.is_dir():
            continue
        scanned_dirs.append(dirname)
        for artifact in art_dir.rglob("*"):
            if artifact.is_file():
                match = VERSIONED_FILENAME_RE.search(artifact.name)
                if match and match.group(1) == version:
                    found_current.append(str(artifact.relative_to(repo)))
    note = (
        f"current-version art found in {len(found_current)} file(s)"
        if found_current
        else ("no release-art directories found (skipped cleanly)" if not scanned_dirs else "NO art filenames carry the current version")
    )
    return {"scanned_dirs": scanned_dirs, "current_version_artifacts": found_current[:10], "note": note}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="release_consistency.py",
        description="Cross-check release versions, changelog, and release-art consistency.",
    )
    parser.add_argument("--repo", default=".", help="repository root (default: current directory)")
    parser.add_argument("--tag", default="", help="treat this tag as the release baseline (e.g. v0.3.0)")
    parser.add_argument("--fix-dates", action="store_true", help="normalize changelog heading date formats in place")
    add_json_flag(parser)
    args = parser.parse_args(argv)

    repo = Path(args.repo).resolve()
    if not repo.is_dir():
        return usage_error(f"--repo does not exist: {args.repo!r}")

    changelog_path = repo / "CHANGELOG.md"
    manifest_version = read_json_version(repo / "manifest.json")
    package_version = read_json_version(repo / "package.json")
    changelog = parse_changelog(changelog_path)

    fix_results: list[str] = []
    if args.fix_dates:
        fix_results = normalize_changelog_dates(changelog_path)
        changelog = parse_changelog(changelog_path)

    mismatches: list[str] = []
    versions = {
        "manifest.json": manifest_version,
        "package.json": package_version,
        "CHANGELOG.md (latest)": changelog["version"],
    }
    present = {k: v for k, v in versions.items() if v}
    reference = package_version or manifest_version or changelog["version"]
    if len(set(present.values())) > 1:
        mismatches.append(f"version mismatch across files: {present}")
    if manifest_version is None:
        mismatches.append("manifest.json missing or has no version")
    if package_version is None:
        mismatches.append("package.json missing or has no version")
    if changelog["version"] is None:
        mismatches.append("CHANGELOG.md has no parseable version heading")

    readme = repo / "README.md"
    if readme.is_file() and reference:
        readme_text = readme.read_text(encoding="utf-8", errors="replace")
        stale = sorted({
            other for other in re.findall(rf"\b(?:v)?({SEMVER})\b", readme_text)
            if other != reference
        })
        if stale:
            mismatches.append(f"README.md references non-current version(s) {stale} (current {reference})")

    tag, tag_source = last_tag(repo, args.tag)
    uncovered: list[str] = []
    coverage_note = "coverage check skipped"
    if tag:
        changed = changed_since_tag(repo, tag.lstrip("v"))
        uncovered = coverage_gaps(changed, changelog["body"])
        coverage_note = f"{len(changed)} files changed since {tag}; {len(uncovered)} lack changelog mention"
        if uncovered:
            mismatches.append(f"{len(uncovered)} changed files not mentioned in latest changelog section")
    elif changelog["date"]:
        coverage_note = f"no tags; degraded to changelog-date heuristic (latest entry dated {changelog['date']})"

    art = release_art_status(repo, reference) if reference else {"note": "no reference version"}
    if reference and art.get("current_version_artifacts") == [] and "skipped cleanly" not in art["note"]:
        mismatches.append(f"release-art: {art['note']}")

    report = {
        "summary": (
            f"{len(mismatches)} mismatch(es); versions={present}; "
            f"baseline tag={tag or 'none'} ({tag_source})"
            + (f"; fixed {len(fix_results)} heading(s)" if fix_results else "")
        ),
        "versions": present,
        "changelog_latest": {"version": changelog["version"], "date": changelog["date"], "heading": changelog["heading_raw"]},
        "fix_dates_applied": fix_results,
        "coverage": {"baseline_tag": tag, "source": tag_source, "note": coverage_note, "uncovered_files": uncovered[:20]},
        "release_art": art,
        "mismatches": mismatches,
    }
    return emit(report, len(mismatches), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
