"""Deterministic, standard-library text utilities for Hermes Browser.

These helpers intentionally do not call a model, network service, or browser API.
They are bounded so tool arguments cannot turn a convenience operation into an
uncontrolled memory or output allocation.
"""

from __future__ import annotations

from difflib import unified_diff
import math
import re
from typing import Any

MAX_TEXT_CHARACTERS = 50_000
MAX_DIFF_CHARACTERS = 20_000
SUPPORTED_ACTIONS = frozenset({"clean_formatting", "make_bullets", "text_stats", "diff"})


def _failure(error: str, detail: str) -> dict[str, Any]:
    return {"ok": False, "no_model": True, "error": error, "detail": detail}


def _validated_text(value: Any, field: str) -> tuple[str | None, dict[str, Any] | None]:
    if not isinstance(value, str):
        return None, _failure(f"invalid_{field}", f"{field} must be a string.")
    if len(value) > MAX_TEXT_CHARACTERS:
        return None, _failure(f"{field}_too_large", f"{field} exceeds {MAX_TEXT_CHARACTERS} characters.")
    return value, None


def _clean_formatting(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").replace("\u00a0", " ")
    lines = [re.sub(r"[\t\f\v ]+", " ", line).strip() for line in normalized.split("\n")]
    normalized = "\n".join(lines)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    return normalized.strip()


def _make_bullets(text: str) -> str:
    clean = _clean_formatting(text)
    parts = [part.strip() for part in re.findall(r"[^.!?\n]+[.!?]?", clean) if part.strip()]
    return "\n".join(f"• {part}" for part in parts)


def _text_stats(text: str) -> dict[str, int]:
    words = re.findall(r"\b[\w’'-]+\b", text, flags=re.UNICODE)
    sentence_marks = re.findall(r"[.!?]+(?:\s|$)", text)
    sentences = len(sentence_marks) if sentence_marks else (1 if text.strip() else 0)
    reading_seconds = math.ceil((len(words) / 200) * 60) if words else 0
    return {
        "characters": len(text),
        "characters_without_spaces": len(re.sub(r"\s", "", text)),
        "words": len(words),
        "sentences": sentences,
        "lines": len(text.splitlines()) if text else 0,
        "reading_time_seconds": reading_seconds,
    }


def _text_diff(original: str, revised: str) -> dict[str, Any]:
    rows = list(
        unified_diff(
            original.splitlines(),
            revised.splitlines(),
            fromfile="original",
            tofile="revised",
            lineterm="",
        )
    )
    additions = sum(1 for row in rows if row.startswith("+") and not row.startswith("+++"))
    deletions = sum(1 for row in rows if row.startswith("-") and not row.startswith("---"))
    rendered = "\n".join(rows)
    truncated = len(rendered) > MAX_DIFF_CHARACTERS
    return {
        "diff": rendered[:MAX_DIFF_CHARACTERS],
        "additions": additions,
        "deletions": deletions,
        "truncated": truncated,
    }


def run_text_utility(action: Any, text: Any, *, compare_text: Any = "") -> dict[str, Any]:
    """Run one bounded local text operation and return a JSON-ready result."""
    clean_action = str(action or "").strip().lower()
    if clean_action not in SUPPORTED_ACTIONS:
        return _failure("unsupported_action", f"Supported actions: {', '.join(sorted(SUPPORTED_ACTIONS))}.")

    source, failure = _validated_text(text, "text")
    if failure:
        return failure
    assert source is not None

    if clean_action == "text_stats":
        return {"ok": True, "no_model": True, "action": clean_action, **_text_stats(source)}

    if clean_action == "diff":
        revised, compare_failure = _validated_text(compare_text, "compare_text")
        if compare_failure:
            return compare_failure
        assert revised is not None
        return {"ok": True, "no_model": True, "action": clean_action, **_text_diff(source, revised)}

    output = _clean_formatting(source) if clean_action == "clean_formatting" else _make_bullets(source)
    return {
        "ok": True,
        "no_model": True,
        "action": clean_action,
        "changed": output != source,
        "text": output,
        **_text_stats(output),
    }
