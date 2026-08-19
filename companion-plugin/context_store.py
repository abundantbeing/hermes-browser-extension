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
from typing import Any, Callable, Optional

from .journal import BrowserContextJournal

BCP_TURN_PROTOCOL_ID = "hermes.browser.turn.v2"
BCP_CONTEXT_PROTOCOL_ID = "hermes.browser.context.v1"
DEFAULT_TTL_SECONDS = 300.0
DEFAULT_MAX_ENTRIES = 100
DEFAULT_MAX_ENTRIES_PER_PRINCIPAL = 10
DEFAULT_MAX_EVENTS = 200
DEFAULT_RECEIPT_LIMIT = 8
_DURABLE_RECEIPTS_KEY = "receipts_v1"
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
    Session, turn, and task IDs are required because they are the trusted
    execution identifiers shared by pre-LLM, pre-tool, and post-tool hooks.
    """
    session_id = _trusted_identifier(kwargs.get("session_id"))
    turn_id = _trusted_identifier(kwargs.get("turn_id"))
    task_id = _trusted_identifier(kwargs.get("task_id"))
    if not session_id or not turn_id or not task_id:
        return None
    return ContextOwner(
        principal_id=f"session:{session_id}",
        session_id=session_id,
        turn_id=turn_id,
        task_id=task_id,
    )


def _is_plain_dict(value: Any) -> bool:
    return isinstance(value, dict)


def _is_string_list(value: Any) -> bool:
    return isinstance(value, list)


def _bounded_identifier(value: Any, limit: int = 160) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _unknown_control() -> dict[str, Any]:
    return {
        "availability": "unknown",
        "lease_owned": False,
        "controller_id": "",
        "browser_profile_id": "",
        "tab_id": 0,
        "frame_id": 0,
        "document_generation": 0,
    }


def _normalize_browser_control(value: Any) -> dict[str, Any]:
    """Retain only validated historical control metadata from an untrusted turn."""
    if not isinstance(value, dict):
        return _unknown_control()
    if value.get("route") != "extension-controller" or value.get("isolated_fallback") != "forbidden":
        return _unknown_control()
    availability = value.get("availability")
    if availability == "unavailable":
        return {**_unknown_control(), "availability": "unavailable"}
    if availability != "available":
        return _unknown_control()
    controller_id = _bounded_identifier(value.get("controller_id"))
    browser_profile_id = _bounded_identifier(value.get("browser_profile_id"))
    tab_id = value.get("tab_id")
    frame_id = value.get("frame_id")
    document_generation = value.get("document_generation")
    lease_owned = value.get("lease_owned")
    integer_values = (tab_id, frame_id, document_generation)
    if (
        not controller_id
        or not browser_profile_id
        or any(isinstance(item, bool) or not isinstance(item, int) for item in integer_values)
        or tab_id <= 0
        or frame_id < 0
        or document_generation <= 0
        or not isinstance(lease_owned, bool)
    ):
        return _unknown_control()
    return {
        "availability": "available",
        "lease_owned": lease_owned,
        "controller_id": controller_id,
        "browser_profile_id": browser_profile_id,
        "tab_id": tab_id,
        "frame_id": frame_id,
        "document_generation": document_generation,
    }


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
        "browser_control": _normalize_browser_control(envelope.get("browser_control")),
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


def _owner_fingerprint(owner: ContextOwner) -> str:
    """Bind durable diagnostics to the exact trusted execution owner tuple."""
    material = "\0".join((owner.principal_id, owner.session_id, owner.turn_id, owner.task_id))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


@dataclass
class BrowserContextRecord:
    """One opaque capability bound to one trusted Hermes owner tuple."""

    context_id: str
    owner: ContextOwner
    payload: dict[str, Any] | None
    provenance: dict[str, Any]
    payload_hash: str
    scope: str
    browser_control: dict[str, Any]
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
    _durable_state: Any = field(default=None, init=False, repr=False)
    _durable_receipts_enabled: bool = field(default=False, init=False, repr=False)
    _receipt_limit: int = field(default=DEFAULT_RECEIPT_LIMIT, init=False, repr=False)
    _journal: Optional[BrowserContextJournal] = field(default=None, init=False, repr=False)
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False, repr=False)

    def _now(self) -> float:
        return float(self.clock())

    @staticmethod
    def _normalize_receipt_limit(value: Any) -> int:
        try:
            return max(1, min(int(value), DEFAULT_RECEIPT_LIMIT))
        except (TypeError, ValueError):
            return DEFAULT_RECEIPT_LIMIT

    @staticmethod
    def _validate_durable_receipts(value: Any) -> list[dict[str, Any]]:
        if value is None:
            return []
        if not isinstance(value, list):
            raise RuntimeError("Malformed durable companion receipt state: root must be a list")
        rows: list[dict[str, Any]] = []
        receipt_keys = {
            "tool_name", "ok", "duration_ms", "controller_id",
            "tab_id", "document_generation", "observed_at",
        }
        for row in value:
            if not isinstance(row, dict) or set(row) != {"owner", "receipt"}:
                raise RuntimeError("Malformed durable companion receipt state: invalid row")
            owner = row.get("owner")
            receipt = row.get("receipt")
            if not isinstance(owner, str) or len(owner) != 64 or not isinstance(receipt, dict):
                raise RuntimeError("Malformed durable companion receipt state: invalid owner or receipt")
            if set(receipt) != receipt_keys:
                raise RuntimeError("Malformed durable companion receipt state: forbidden receipt field")
            if (
                not isinstance(receipt["tool_name"], str)
                or not isinstance(receipt["ok"], bool)
                or isinstance(receipt["duration_ms"], bool)
                or not isinstance(receipt["duration_ms"], int)
                or not isinstance(receipt["controller_id"], str)
                or isinstance(receipt["tab_id"], bool)
                or not isinstance(receipt["tab_id"], int)
                or isinstance(receipt["document_generation"], bool)
                or not isinstance(receipt["document_generation"], int)
                or isinstance(receipt["observed_at"], bool)
                or not isinstance(receipt["observed_at"], (int, float))
            ):
                raise RuntimeError("Malformed durable companion receipt state: invalid receipt type")
            rows.append(deepcopy(row))
        return rows

    def configure_durable_state(self, state: Any, *, enabled: bool, receipt_limit: Any = 8) -> None:
        """Attach Hermes-owned profile state after validating it without mutation."""
        rows = self._validate_durable_receipts(state.get(_DURABLE_RECEIPTS_KEY, default=[]))
        self._durable_state = state
        self._durable_receipts_enabled = enabled is True
        self._receipt_limit = self._normalize_receipt_limit(receipt_limit)
        if len(rows) > self._receipt_limit:
            state.set(_DURABLE_RECEIPTS_KEY, rows[-self._receipt_limit :])

    def configure_journal(self, data_dir: Any = None, *, max_rows: Any = 500) -> None:
        """Attach the metadata-only rotation journal (Phase 8 Task 31).

        ``data_dir`` may be a :class:`pathlib.Path`-compatible durable
        directory (mode 0600 on the journal file where supported) or
        ``None`` for a memory-only journal.  Journaling records metadata
        rows about stored context; it never authorizes ``browser_get_context``
        and never holds payload bytes.
        """
        try:
            bounded = max(1, min(int(max_rows), 500))
        except (TypeError, ValueError):
            bounded = 500
        journal = BrowserContextJournal(max_rows=bounded)
        if data_dir is not None:
            try:
                from pathlib import Path

                journal = BrowserContextJournal(
                    max_rows=bounded,
                    data_dir=Path(data_dir),
                )
            except Exception:
                journal = BrowserContextJournal(max_rows=bounded)
        with self._lock:
            self._journal = journal

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
            browser_control=normalized["browser_control"],
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
            self._record_journal_locked(record, owner, now)
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

    def _latest_record_for_owner_locked(self, owner: ContextOwner) -> BrowserContextRecord | None:
        for context_id in reversed(self._records):
            record = self._records[context_id]
            if record.owner == owner and not record.consumed and record.payload is not None:
                return record
        return None

    def control_status_for_owner(self, owner: ContextOwner) -> dict[str, Any]:
        """Return historical envelope truth only; never query or authorize control."""
        now = self._now()
        with self._lock:
            self._prune_expired_locked(now)
            record = self._latest_record_for_owner_locked(owner)
            if record is None:
                return dict(_UNAVAILABLE)
            return {
                "context_id": record.context_id,
                "observed_at": record.created_at,
                "age_ms": max(0, int((now - record.created_at) * 1000)),
                "live": False,
                "control": deepcopy(record.browser_control),
            }

    def record_tool_receipt(
        self,
        owner: ContextOwner,
        *,
        tool_name: Any,
        ok: Any,
        duration_ms: Any,
        forbidden: Any = None,
    ) -> dict[str, Any]:
        """Persist one bounded redacted receipt; ``forbidden`` is never inspected."""
        del forbidden
        now = self._now()
        with self._lock:
            self._prune_expired_locked(now)
            record = self._latest_record_for_owner_locked(owner)
            control = record.browser_control if record is not None else _unknown_control()
            try:
                duration = max(0, min(int(duration_ms), 3_600_000))
            except (TypeError, ValueError):
                duration = 0
            receipt = {
                "tool_name": str(tool_name or "unknown")[:120],
                "ok": ok is True,
                "duration_ms": duration,
                "controller_id": _bounded_identifier(control.get("controller_id")),
                "tab_id": int(control.get("tab_id") or 0),
                "document_generation": int(control.get("document_generation") or 0),
                "observed_at": now,
            }
            if self._durable_receipts_enabled and self._durable_state is not None:
                rows = self._validate_durable_receipts(
                    self._durable_state.get(_DURABLE_RECEIPTS_KEY, default=[])
                )
                rows.append({"owner": _owner_fingerprint(owner), "receipt": receipt})
                self._durable_state.set(_DURABLE_RECEIPTS_KEY, rows[-self._receipt_limit :])
            return deepcopy(receipt)

    def receipts_for_owner(self, owner: ContextOwner, limit: Any = 8) -> list[dict[str, Any]]:
        if not self._durable_receipts_enabled or self._durable_state is None:
            return []
        rows = self._validate_durable_receipts(
            self._durable_state.get(_DURABLE_RECEIPTS_KEY, default=[])
        )
        bounded = self._normalize_receipt_limit(limit)
        owner_key = _owner_fingerprint(owner)
        return [deepcopy(row["receipt"]) for row in rows if row["owner"] == owner_key][-bounded:]

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

    def _record_journal_locked(
        self,
        record: BrowserContextRecord,
        owner: ContextOwner,
        now: float,
    ) -> None:
        """Append one metadata-only journal row for a stored record.

        Only fields from the validated record metadata and its
        ``browser_control`` subset participate; page text, DOM, typed
        values, arguments, and results are structurally absent.  Journaling
        is best-effort: a failure never fails the store itself, and it
        never grants any context capability.
        """
        journal = self._journal
        if journal is None:
            return
        control = record.browser_control if isinstance(record.browser_control, dict) else {}
        try:
            journal.record(
                owner,
                {
                    "ts": now,
                    "context_id": record.context_id,
                    "payload_hash": record.payload_hash[:80],
                    "scope": record.scope[:80] or "unknown",
                    "controller_id": _bounded_identifier(control.get("controller_id")),
                    "browser_profile_id": _bounded_identifier(
                        control.get("browser_profile_id")
                    ),
                    "tab_id": int(control.get("tab_id") or 0),
                    "lease_owned": control.get("lease_owned") is True,
                    "delivery": record.provenance.get("delivery", "full")[:40],
                },
            )
        except Exception:
            # Diagnostics must never break the trusted store path.
            return

    def journal_for_owner(self, owner: ContextOwner, limit: Any = 50) -> dict[str, Any]:
        """Return bounded owner-scoped journal metadata rows.

        The returned envelope mirrors the other diagnostics accessors:
        ``{"available": bool, "rows": [...]}`` with rows deep-copied.  The
        journal is metadata-only and never authorizes ``browser_get_context``.
        """
        journal = self._journal
        if journal is None:
            return {"available": False, "rows": []}
        try:
            rows = journal.rows_for_owner(owner, limit=limit)
        except Exception:
            return {"available": False, "rows": []}
        return {"available": bool(rows), "rows": deepcopy(rows)}

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
