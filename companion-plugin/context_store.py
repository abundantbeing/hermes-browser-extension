"""Owner-scoped, consume-on-read Browser Context Protocol storage.

The companion plugin receives Browser Context Protocol (BCP) v2 turn
messages as untrusted user content.  A record is therefore bound to the
trusted Hermes execution owner before it can be observed or consumed by a
tool.  The process-local store is TTL- and LRU-bounded and deliberately has
no unscoped "latest context" accessor.
"""

from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
from dataclasses import dataclass, field
import hashlib
import json
import secrets
import threading
from time import time
from typing import Any, Callable

BCP_TURN_PROTOCOL_ID = "hermes.browser.turn.v2"
BCP_CONTEXT_PROTOCOL_ID = "hermes.browser.context.v1"
DEFAULT_TTL_SECONDS = 300.0
DEFAULT_MAX_ENTRIES = 100
DEFAULT_MAX_ENTRIES_PER_PRINCIPAL = 10
DEFAULT_MAX_EVENTS = 200
_MAX_BCP_TURN_CHARS = 64_000
_MAX_IDENTIFIER_CHARS = 256

_UNAVAILABLE = {"available": False, "reason": "Browser context unavailable."}


@dataclass(frozen=True)
class ContextOwner:
    """Trusted Hermes execution identity for a browser context record."""

    principal_id: str
    session_id: str
    turn_id: str
    task_id: str


def _trusted_identifier(value: Any) -> str:
    """Normalize one trusted hook value without consulting model/tool input."""
    if value is None:
        return ""
    value = str(value).strip()
    return value[:_MAX_IDENTIFIER_CHARS]


def owner_from_hook_kwargs(kwargs: dict[str, Any]) -> ContextOwner | None:
    """Build an owner only from trusted Hermes hook kwargs.

    Tool arguments and browser-provided BCP data are intentionally ignored.
    An owner must name a platform, Hermes session, and Hermes turn; task IDs
    may be empty when Hermes has not assigned one.
    """
    platform = _trusted_identifier(kwargs.get("platform"))
    sender_id = _trusted_identifier(kwargs.get("sender_id"))
    session_id = _trusted_identifier(kwargs.get("session_id"))
    turn_id = _trusted_identifier(kwargs.get("turn_id"))
    task_id = _trusted_identifier(kwargs.get("task_id"))
    if not platform or not session_id or not turn_id:
        return None
    principal_id = f"{platform}:{sender_id}" if sender_id else f"{platform}:session:{session_id}"
    return ContextOwner(
        principal_id=principal_id,
        session_id=session_id,
        turn_id=turn_id,
        task_id=task_id,
    )


def _is_plain_dict(value: Any) -> bool:
    return isinstance(value, dict)


def _is_string_list(value: Any) -> bool:
    return isinstance(value, list)


def parse_bcp_v2_turn(text: str) -> dict[str, Any] | None:
    """Return a normalized BCP v2 browser payload, or ``None`` fail-closed.

    The current user message must be one JSON BCP v2 turn envelope.  Legacy
    prose blocks, reference-only turns, malformed JSON, and arbitrary JSON
    objects are deliberately not cached.
    """
    raw = str(text or "")
    if not raw or len(raw) > _MAX_BCP_TURN_CHARS:
        return None
    try:
        envelope = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not _is_plain_dict(envelope) or envelope.get("protocol") != BCP_TURN_PROTOCOL_ID:
        return None

    human_input = envelope.get("human_input")
    browser_context = envelope.get("browser_context")
    attachment_context = envelope.get("attachment_context")
    receipt = envelope.get("source_receipt")
    if not all(_is_plain_dict(value) for value in (human_input, browser_context, attachment_context, receipt)):
        return None
    if human_input.get("source") != "composer" or not isinstance(human_input.get("text"), str):
        return None
    if not _is_string_list(attachment_context.get("items")):
        return None
    if receipt.get("protocol") != BCP_TURN_PROTOCOL_ID or receipt.get("version") != 2:
        return None
    if browser_context.get("delivery") != "full" or receipt.get("delivery") != "full":
        return None

    payload = browser_context.get("payload")
    if not _is_plain_dict(payload) or payload.get("protocol") != BCP_CONTEXT_PROTOCOL_ID:
        return None
    if not all(_is_plain_dict(payload.get(key)) for key in ("contextScope", "settings", "activeTab", "pageContext")):
        return None
    if not _is_string_list(payload.get("tabs")) or not _is_string_list(payload.get("selectedTabs")):
        return None

    context_hash = receipt.get("context_hash", "")
    if not isinstance(context_hash, str):
        return None
    scope = payload["contextScope"].get("mode", "unknown")
    if not isinstance(scope, str):
        return None

    # json.loads already created only JSON-safe values. Deep-copy so a caller
    # cannot mutate a cached payload after this function returns.
    return {
        "payload": deepcopy(payload),
        "provenance": {
            "protocol": BCP_TURN_PROTOCOL_ID,
            "delivery": "full",
            "context_hash": context_hash[:80],
        },
        "payload_hash": context_hash[:80],
        "scope": scope[:80] or "unknown",
    }


def _principal_fingerprint(owner: ContextOwner) -> str:
    """Return a diagnostic-safe owner correlation value, never a raw ID."""
    return hashlib.sha256(owner.principal_id.encode("utf-8")).hexdigest()[:16]


@dataclass
class BrowserContextRecord:
    """One opaque capability bound to one trusted Hermes owner tuple."""

    context_id: str
    owner: ContextOwner
    payload: dict[str, Any] | None
    provenance: dict[str, Any]
    payload_hash: str
    scope: str
    created_at: float
    expires_at: float
    consumed_at: float | None = None

    @property
    def consumed(self) -> bool:
        return self.consumed_at is not None


@dataclass
class _StoredEvent:
    name: str
    data: dict[str, Any]
    owner: ContextOwner
    ts: float


@dataclass
class BrowserContextStore:
    """Thread-safe owner-scoped cache for BCP v2 browser context records."""

    ttl_seconds: float = DEFAULT_TTL_SECONDS
    max_entries: int = DEFAULT_MAX_ENTRIES
    max_entries_per_principal: int = DEFAULT_MAX_ENTRIES_PER_PRINCIPAL
    max_events: int = DEFAULT_MAX_EVENTS
    clock: Callable[[], float] = time
    _records: OrderedDict[str, BrowserContextRecord] = field(default_factory=OrderedDict, init=False, repr=False)
    _events: list[_StoredEvent] = field(default_factory=list, init=False, repr=False)
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False, repr=False)

    def _now(self) -> float:
        return float(self.clock())

    def _prune_expired_locked(self, now: float) -> None:
        for context_id, record in list(self._records.items()):
            if record.expires_at <= now:
                record.payload = None
                del self._records[context_id]

    def _evict_locked(self) -> None:
        max_entries = max(1, int(self.max_entries))
        max_per_principal = max(1, int(self.max_entries_per_principal))
        while len(self._records) > max_entries:
            _context_id, record = self._records.popitem(last=False)
            record.payload = None

        principals = {record.owner.principal_id for record in self._records.values()}
        for principal_id in principals:
            while sum(record.owner.principal_id == principal_id for record in self._records.values()) > max_per_principal:
                for context_id, record in self._records.items():
                    if record.owner.principal_id == principal_id:
                        record.payload = None
                        del self._records[context_id]
                        break

    @staticmethod
    def _metadata(record: BrowserContextRecord) -> dict[str, Any]:
        return {
            "available": True,
            "context_id": record.context_id,
            "protocol": record.provenance["protocol"],
            "payload_hash": record.payload_hash,
            "scope": record.scope,
            "created_at": record.created_at,
            "expires_at": record.expires_at,
        }

    def put_bcp_v2(self, text: str, owner: ContextOwner) -> dict[str, Any]:
        """Validate and store one BCP v2 full-context turn for ``owner``."""
        normalized = parse_bcp_v2_turn(text)
        if normalized is None:
            return dict(_UNAVAILABLE)
        now = self._now()
        ttl = max(0.0, float(self.ttl_seconds))
        record = BrowserContextRecord(
            context_id=secrets.token_hex(16),
            owner=owner,
            payload=normalized["payload"],
            provenance=normalized["provenance"],
            payload_hash=normalized["payload_hash"],
            scope=normalized["scope"],
            created_at=now,
            expires_at=now + ttl,
        )
        with self._lock:
            self._prune_expired_locked(now)
            self._records[record.context_id] = record
            self._evict_locked()
            self._record_event_locked(
                "browser.context.updated",
                {"protocol": record.provenance["protocol"], "scope": record.scope},
                owner,
                now,
            )
            return self._metadata(record)

    def status_for_owner(self, owner: ContextOwner) -> dict[str, Any]:
        """Return current-owner metadata only; this never consumes payload."""
        now = self._now()
        with self._lock:
            self._prune_expired_locked(now)
            for context_id in reversed(self._records):
                record = self._records[context_id]
                if record.owner == owner and not record.consumed and record.payload is not None:
                    self._records.move_to_end(context_id)
                    return self._metadata(record)
        return dict(_UNAVAILABLE)

    def consume_for_owner(self, context_id: str, owner: ContextOwner) -> dict[str, Any] | None:
        """Atomically consume ``context_id`` only for its exact trusted owner."""
        if not isinstance(context_id, str) or len(context_id) != 32:
            return None
        now = self._now()
        with self._lock:
            self._prune_expired_locked(now)
            record = self._records.get(context_id)
            if record is None or record.owner != owner or record.consumed or record.payload is None:
                return None
            payload = record.payload
            record.payload = None
            record.consumed_at = now
            self._records.move_to_end(context_id)
            self._record_event_locked("browser.context.consumed", {}, owner, now)
            return {
                **self._metadata(record),
                "payload": payload,
                "provenance": deepcopy(record.provenance),
            }

    def clear_for_owner(self, owner: ContextOwner) -> dict[str, Any]:
        """Remove only records owned by the exact current execution tuple."""
        now = self._now()
        with self._lock:
            self._prune_expired_locked(now)
            for context_id, record in list(self._records.items()):
                if record.owner == owner:
                    record.payload = None
                    del self._records[context_id]
            self._record_event_locked("browser.context.cleared", {}, owner, now)
        return dict(_UNAVAILABLE)

    def _record_event_locked(self, name: str, data: dict[str, Any], owner: ContextOwner, now: float) -> None:
        self._events.append(_StoredEvent(name=name, data=deepcopy(data), owner=owner, ts=now))
        if len(self._events) > max(1, int(self.max_events)):
            del self._events[: len(self._events) - max(1, int(self.max_events))]

    def record_event(self, name: str, data: dict[str, Any] | None, owner: ContextOwner) -> None:
        """Record a pre-redacted diagnostic event for one exact owner tuple."""
        now = self._now()
        with self._lock:
            self._prune_expired_locked(now)
            self._record_event_locked(str(name)[:120], dict(data or {}), owner, now)

    def event_log_for_owner(self, owner: ContextOwner, limit: int) -> dict[str, Any]:
        """Return bounded, owner-scoped redacted diagnostics."""
        bounded_limit = max(1, min(int(limit), 50))
        now = self._now()
        with self._lock:
            self._prune_expired_locked(now)
            rows = [event for event in self._events if event.owner == owner][-bounded_limit:]
            events = [
                {
                    "name": event.name,
                    "data": deepcopy(event.data),
                    "ts": event.ts,
                    "owner": _principal_fingerprint(event.owner),
                }
                for event in rows
            ]
        return {"available": bool(events), "events": events}
