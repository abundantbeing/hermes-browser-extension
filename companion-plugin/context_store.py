"""In-memory browser context cache for the Hermes Browser companion plugin.

Stores sanitized Browser Context Protocol metadata received from the
Hermes Browser Extension, along with a bounded event log for diagnostics.
The store is deliberately process-local — it does not persist across
Hermes restarts.
"""

from __future__ import annotations

from typing import Any

import hashlib
import json
import re
from dataclasses import dataclass, field
from time import time
from typing import Any
from urllib.parse import urlparse

from .protocol import BrowserContextEnvelope

# Regex to match the browser context block embedded in extension prompts.
_CONTEXT_BLOCK_RE = re.compile(
    r"UNTRUSTED_BROWSER_CONTEXT_START\s*\n"
    r"(?P<body>.*?)"
    r"\nUNTRUSTED_BROWSER_CONTEXT_END",
    re.DOTALL,
)

# Parse key-value lines inside the context block.
_KV_RE = re.compile(r"^(?P<key>[A-Za-z /]+?):\s*(?P<value>.+)$", re.MULTILINE)
_CONTEXT_HASH_RE = re.compile(r"^[a-fA-F0-9]{8,64}$")
_REDACTION_RE = re.compile(r"\[REDACTED_[A-Z_]+\]")
_SECRET_VALUE_RE = re.compile(
    r"(?i)(bearer\s+[a-z0-9._~+/=-]{8,}|sk_(?:live|test)_[a-z0-9_]{8,}|gh[pousr]_[a-z0-9_]{16,}|api[_-]?key\s*[:=]\s*[^\s]+|token\s*[:=]\s*[^\s]+)"
)
_PLACEHOLDER_VALUES = {
    "",
    "(none)",
    "(no readable page text captured)",
    "(tabs omitted by setting)",
}
_SENSITIVE_EVENT_KEYS = {
    "authorization",
    "api_key",
    "apikey",
    "access_token",
    "refresh_token",
    "token",
    "password",
    "secret",
}
_MAX_CONTEXT_BLOCK_CHARS = 200_000
_MAX_EVENT_STRING_CHARS = 500


def _section_key(label: str) -> str:
    return label.strip().lower().replace(" ", "_").replace("/", "_")


def _meaningful_text_from_content_list(parts: list[Any]) -> str:
    """Flatten a content array (OpenAI format) into a single string.

    A content array looks like:
        [{"type": "text", "text": "Hello"}, {"type": "image_url", ...}]
    Returns the concatenated text parts for browser-context scanning.
    """
    chunks: list[str] = []
    for part in parts:
        if isinstance(part, dict) and part.get("type") == "text":
            text = part.get("text", "")
            if isinstance(text, str) and text.strip():
                chunks.append(text)
    return "\n".join(chunks)


def _meaningful_section_text(lines: list[str] | None) -> str:
    if not lines:
        return ""
    text = "\n".join(str(line).strip() for line in lines if str(line).strip()).strip()
    if text.lower() in _PLACEHOLDER_VALUES:
        return ""
    return text


def _origin_of(url: str) -> str:
    raw = str(url or "").strip()
    if not raw or raw.lower() == "(unknown)":
        return ""
    try:
        parsed = urlparse(raw)
    except ValueError:
        return ""
    if parsed.scheme and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}"
    return ""


def stable_context_hash(value: dict[str, Any]) -> str:
    """Return a deterministic short SHA-256 hash for sanitized context metadata."""
    hash_input = dict(value)
    hash_input.pop("contextHash", None)
    payload = json.dumps(hash_input, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _sanitize_context_hash(value: Any) -> str:
    context_hash = str(value or "").strip()
    if _CONTEXT_HASH_RE.fullmatch(context_hash):
        return context_hash.lower()
    return ""


def _safe_event_value(value: Any, key: str = "") -> Any:
    if key.lower() in _SENSITIVE_EVENT_KEYS:
        return "[REDACTED_SECRET]"
    if isinstance(value, str):
        redacted = _SECRET_VALUE_RE.sub("[REDACTED_SECRET]", value)
        return redacted[:_MAX_EVENT_STRING_CHARS]
    if isinstance(value, dict):
        return {str(k)[:80]: _safe_event_value(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_safe_event_value(item) for item in value[:20]]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return str(value)[:_MAX_EVENT_STRING_CHARS]


def parse_context_block(text: str) -> dict[str, Any] | None:
    """Extract sanitized browser context metadata from an extension prompt block.

    The parser intentionally does not store raw page text, selected text,
    transcript text, open-tab text, or full active-tab URLs. It stores only
    safe metadata, section availability flags, character counts, origins, and
    a context hash.
    """
    match = _CONTEXT_BLOCK_RE.search(str(text or ""))
    if not match:
        return None

    body = match.group("body")
    truncated = len(body) > _MAX_CONTEXT_BLOCK_CHARS
    parse_body = body[:_MAX_CONTEXT_BLOCK_CHARS]
    result: dict[str, Any] = {
        "activeTab": {},
        "sectionCounts": {},
        "truncated": truncated,
    }

    lines = parse_body.split("\n")
    header_done = False
    sections: dict[str, list[str]] = {}
    current_section = "_header"

    for line in lines:
        stripped = line.strip()
        if not header_done:
            if not stripped:
                header_done = True
                continue
            kv = _KV_RE.match(line)
            if kv:
                key = kv.group("key").strip().lower().replace(" ", "_")
                value = kv.group("value").strip()
                if key.startswith("active_tab_"):
                    sub_key = key.replace("active_tab_", "")
                    if sub_key == "url":
                        result["activeTab"]["origin"] = _origin_of(value)
                    else:
                        result["activeTab"][sub_key] = value
                elif key == "context_hash":
                    context_hash = _sanitize_context_hash(value)
                    if context_hash:
                        result["contextHash"] = context_hash
                elif key == "context_scope":
                    result["contextScope"] = value
                elif key == "open_tabs":
                    result["tabsSummary"] = value
                else:
                    result[key] = value
        else:
            if stripped and not stripped.startswith("-") and stripped.endswith(":"):
                current_section = _section_key(stripped[:-1])
                sections.setdefault(current_section, [])
            elif stripped:
                sections.setdefault(current_section, []).append(stripped)

    section_counts: dict[str, int] = {}
    for name, section_lines in sections.items():
        meaningful_text = _meaningful_section_text(section_lines)
        section_counts[name] = len(meaningful_text)

    result["sectionCounts"] = section_counts
    result["pageTextAvailable"] = section_counts.get("page_text", 0) > 0
    result["selectedTextAvailable"] = section_counts.get("selected_text", 0) > 0
    result["youtubeTranscript"] = section_counts.get("youtube_transcript", 0) > 0
    result["pageMetadataAvailable"] = section_counts.get("page_metadata", 0) > 0
    result["openTabsAvailable"] = section_counts.get("open_tabs", 0) > 0
    result["redactionCount"] = len(_REDACTION_RE.findall(parse_body))

    scope_raw = result.get("contextScope", "")
    result["contextScope"] = scope_raw if scope_raw else "follow-active-tab"

    return result


@dataclass
class BrowserContextStore:
    """Process-local, in-memory browser context cache.

    The store is populated automatically by the ``pre_llm_call`` hook when
    it detects an ``UNTRUSTED_BROWSER_CONTEXT_START`` block in a user
    message, or explicitly via :meth:`update`.
    """

    envelope: BrowserContextEnvelope | None = None
    parsed: dict[str, Any] | None = None
    updated_at: float = 0.0
    events: list[dict[str, Any]] = field(default_factory=list)

    # ── Public API ────────────────────────────────────────────────────

    def update(self, payload: dict[str, Any] | None, source: str = "extension") -> dict[str, Any]:
        """Replace the cached envelope with a new side-channel payload."""
        self.envelope = BrowserContextEnvelope.from_payload(payload)
        self.updated_at = time()
        self.record_event("browser.context.updated", {"source": source, **self.envelope.status()})
        return self.status()

    def update_from_text(self, text: str, source: str = "hook") -> dict[str, Any]:
        """Parse and cache sanitized browser context from a conversation message."""
        parsed = parse_context_block(text)
        if parsed is None:
            return {"available": False, "reason": "No browser context block found in text."}

        context_hash = parsed.get("contextHash") or stable_context_hash(parsed)
        active_tab = dict(parsed.get("activeTab") or {})
        summary = {
            "title": active_tab.get("title", ""),
            "origin": active_tab.get("origin", ""),
            "page_text_available": parsed.get("pageTextAvailable", False),
            "selected_text_available": parsed.get("selectedTextAvailable", False),
            "youtube_transcript": parsed.get("youtubeTranscript", False),
            "page_metadata_available": parsed.get("pageMetadataAvailable", False),
            "open_tabs_available": parsed.get("openTabsAvailable", False),
            "section_counts": dict(parsed.get("sectionCounts") or {}),
            "redaction_count": parsed.get("redactionCount", 0),
            "truncated": parsed.get("truncated", False),
        }

        self.parsed = parsed
        self.envelope = BrowserContextEnvelope(
            protocol="hermes.browser.context.v1",
            payload_hash=context_hash,
            scope=parsed.get("contextScope", "unknown"),
            active_tab=active_tab,
            summary=summary,
        )
        self.updated_at = time()
        self.record_event("browser.context.updated", {"source": source, "scope": self.envelope.scope})
        return self.status()

    def status(self) -> dict[str, Any]:
        """Return whether browser context is currently cached."""
        if not self.envelope:
            return {"available": False, "reason": "No browser context has been captured yet."}
        return {
            "available": True,
            "protocol": self.envelope.protocol,
            "payload_hash": str(self.envelope.payload_hash),
            "scope": self.envelope.scope,
            "updated_at": self.updated_at,
        }

    def get(self) -> dict[str, Any]:
        """Return sanitized cached context, or an unavailable response."""
        if not self.envelope:
            return {"available": False, "context": None, "reason": "No browser context has been captured yet."}
        return {
            "available": True,
            "context": {
                "protocol": self.envelope.protocol,
                "payload_hash": str(self.envelope.payload_hash),
                "scope": self.envelope.scope,
                "active_tab": self.envelope.active_tab,
                "summary": self.envelope.summary,
                "parsed": self.parsed,
            },
            "updated_at": self.updated_at,
        }

    def clear(self) -> dict[str, Any]:
        """Reset the cached context."""
        self.envelope = None
        self.parsed = None
        self.updated_at = 0.0
        self.record_event("browser.context.cleared", {})
        return self.status()

    def record_event(self, name: str, data: dict[str, Any] | None = None) -> None:
        """Append a timestamped event to the bounded log."""
        self.events.append({"name": str(name), "data": _safe_event_value(dict(data or {})), "ts": time()})
        # Keep at most 50 events.
        if len(self.events) > 50:
            self.events[:] = self.events[-50:]
