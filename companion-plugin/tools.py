"""Authorized tool handlers for the Hermes Browser Extension plugin.

``browser_get_context`` never consults the process-global store.  The trusted
``pre_tool_call`` hook atomically consumes a context capability and hands the
payload to this module through a short-lived, one-shot lease.

Hermes runs ``pre_tool_call`` callbacks on a bounded worker thread inside a
*copy* of the caller's :mod:`contextvars` context (``plugins.hook_callback_timeout``,
default 30 s).  A ``ContextVar`` set by the hook is therefore invisible to the
tool handler that Hermes dispatches afterwards.  The hook consequently grants
each lease twice: once in a ``ContextVar`` (same-context callers) and once in a
small lock-protected table keyed by the trusted runtime identity that Hermes
passes to the handler as ``session_id``/``task_id`` keyword arguments (never by
anything in the model-controlled tool arguments).
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
import json
import threading
from time import monotonic
from typing import Any

from .context_store import _trusted_identifier

from .schemas import (
    SCHEMA_CLEAR_CONTEXT,
    SCHEMA_CONTROL_STATUS,
    SCHEMA_EVENT_LOG,
    SCHEMA_GET_CONTEXT,
    SCHEMA_JOURNAL,
    SCHEMA_STATUS,
    SCHEMA_TEXT_UTILITY,
)
from .text_utilities import run_text_utility

_UNAVAILABLE = {"available": False, "reason": "Browser context unavailable."}
# Hermes may park an authorized call behind earlier tool calls' approvals (its
# concurrent start-order gate) before the handler runs, so the lease lives as long
# as the cached context record it was cut from.
_LEASE_TTL_SECONDS = 300.0
_MAX_PENDING_LEASES = 64


@dataclass(frozen=True)
class _AuthorizationLease:
    operation: str
    key: str
    result: dict[str, Any]
    expires_at: float


# Each execution context owns an immutable-by-convention map copy.  The map is
# keyed by opaque context ID for gets, so parallel capability calls cannot
# overwrite one another's payload lease.
_LEASES: ContextVar[dict[str, _AuthorizationLease]] = ContextVar("browser_companion_leases", default={})

# Cross-context lease table.  Key: (session_id, task_id, operation, parameter)
# where session_id/task_id are the trusted runtime identity.  Values are lists
# so two same-shaped parallel calls each receive exactly one lease; the newest
# grant is served first so an abandoned older grant can never shadow a fresh one.
_RUNTIME_LEASES: dict[tuple[str, str, str, str], list[_AuthorizationLease]] = {}
_RUNTIME_LEASES_LOCK = threading.Lock()
_TRACKED_LEASES: list[_AuthorizationLease] = []
_expiry_stop = threading.Event()
_expiry: threading.Thread | None = None


def _wipe_lease(lease: _AuthorizationLease) -> None:
    object.__setattr__(lease, "result", None)


def _ensure_expiry() -> None:
    global _expiry
    if _expiry is not None and _expiry.is_alive():
        return
    _expiry_stop.clear()
    _expiry = threading.Thread(target=_expire_loop, name="browser-lease-expiry", daemon=True)
    _expiry.start()


def _expire_loop() -> None:
    while not _expiry_stop.wait(0.05):
        now = monotonic()
        with _RUNTIME_LEASES_LOCK:
            _purge_runtime_leases_locked(now)
            for lease in list(_TRACKED_LEASES):
                if lease.expires_at <= now:
                    _wipe_lease(lease)
            _TRACKED_LEASES[:] = [
                lease for lease in _TRACKED_LEASES
                if lease.result is not None and lease.expires_at > now
            ]


def clear_leases() -> None:
    """Drop every pending lease payload and stop the idle worker."""
    _expiry_stop.set()
    worker = _expiry
    if worker is not None:
        worker.join(timeout=1)
    with _RUNTIME_LEASES_LOCK:
        for rows in _RUNTIME_LEASES.values():
            for lease in rows:
                _wipe_lease(lease)
        _RUNTIME_LEASES.clear()
        for lease in _TRACKED_LEASES:
            _wipe_lease(lease)
        _TRACKED_LEASES.clear()
    _LEASES.set({})


def set_store(_store: Any) -> None:
    """Retained registration seam; handlers intentionally do not read stores."""


def _lease_key(operation: str, context_id: str = "") -> str:
    return f"{operation}:{context_id}"


def runtime_identity(kwargs: dict[str, Any] | None) -> tuple[str, str] | None:
    """Return the trusted ``(session_id, task_id)`` Hermes passed to a handler.

    Hermes injects these keyword arguments itself when it dispatches a tool;
    they are never read from the model-controlled ``args`` mapping.  ``None``
    means the runtime did not supply an identity, in which case only the
    same-context lease can authorize the call.
    """
    values = kwargs if isinstance(kwargs, dict) else {}
    session_id = _trusted_identifier(values.get("session_id"))
    task_id = _trusted_identifier(values.get("task_id"))
    if not session_id or not task_id:
        return None
    return session_id, task_id


def _purge_runtime_leases_locked(now: float) -> None:
    for key in list(_RUNTIME_LEASES):
        live = [lease for lease in _RUNTIME_LEASES[key] if lease.expires_at >= now]
        if live:
            _RUNTIME_LEASES[key] = live
        else:
            del _RUNTIME_LEASES[key]
    pending = sum(len(rows) for rows in _RUNTIME_LEASES.values())
    while pending > _MAX_PENDING_LEASES and _RUNTIME_LEASES:
        oldest_key = min(_RUNTIME_LEASES, key=lambda item: _RUNTIME_LEASES[item][0].expires_at)
        _RUNTIME_LEASES[oldest_key].pop(0)
        if not _RUNTIME_LEASES[oldest_key]:
            del _RUNTIME_LEASES[oldest_key]
        pending -= 1


def grant_lease(
    operation: str,
    result: dict[str, Any],
    context_id: str = "",
    *,
    identity: tuple[str, str] | None = None,
    parameter: str = "",
) -> None:
    """Set a short-lived, one-shot lease from trusted hook code.

    ``identity`` is the trusted ``(session_id, task_id)`` of the call being
    authorized; ``parameter`` is the normalized argument the handler will
    recompute (for example the clamped ``limit``).
    """
    now = monotonic()
    key = _lease_key(operation, context_id)
    lease = _AuthorizationLease(
        operation=operation,
        key=key,
        result=result,
        expires_at=now + _LEASE_TTL_SECONDS,
    )
    leases = dict(_LEASES.get())
    leases[key] = lease
    _LEASES.set(leases)
    with _RUNTIME_LEASES_LOCK:
        _TRACKED_LEASES.append(lease)
    if identity is None:
        _ensure_expiry()
        return
    runtime_key = (identity[0], identity[1], operation, context_id or parameter)
    with _RUNTIME_LEASES_LOCK:
        _TRACKED_LEASES.append(lease)
        _RUNTIME_LEASES.setdefault(runtime_key, []).append(lease)
        _purge_runtime_leases_locked(now)
    _ensure_expiry()


def _take_context_lease(operation: str, context_id: str = "") -> dict[str, Any] | None:
    key = _lease_key(operation, context_id)
    leases = dict(_LEASES.get())
    lease = leases.pop(key, None)
    _LEASES.set(leases)
    if lease is None or lease.expires_at < monotonic() or lease.result is None:
        if lease is not None:
            _wipe_lease(lease)
        return None
    payload = lease.result
    _wipe_lease(lease)
    return payload


def _take_runtime_lease(
    identity: tuple[str, str], operation: str, parameter: str
) -> dict[str, Any] | None:
    now = monotonic()
    runtime_key = (identity[0], identity[1], operation, parameter)
    with _RUNTIME_LEASES_LOCK:
        _purge_runtime_leases_locked(now)
        rows = _RUNTIME_LEASES.get(runtime_key)
        if not rows:
            return None
        lease = rows.pop()
        if not rows:
            del _RUNTIME_LEASES[runtime_key]
    if lease is None or lease.expires_at < now or lease.result is None:
        if lease is not None:
            _wipe_lease(lease)
        return None
    payload = lease.result
    _wipe_lease(lease)
    return payload


def _take_lease(
    operation: str,
    context_id: str = "",
    *,
    identity: tuple[str, str] | None = None,
    parameter: str = "",
) -> dict[str, Any] | None:
    """Take one lease; both stores are drained so a grant is never reusable."""
    context_result = _take_context_lease(operation, context_id)
    runtime_result = (
        _take_runtime_lease(identity, operation, context_id or parameter)
        if identity is not None
        else None
    )
    return runtime_result if runtime_result is not None else context_result


def _context_id(args: dict[str, Any] | None) -> str:
    value = args.get("context_id") if isinstance(args, dict) else ""
    return value.lower() if isinstance(value, str) else ""


def _json(result: dict[str, Any] | None) -> str:
    return json.dumps(result if result is not None else _UNAVAILABLE, default=str)


# ── Handlers ──────────────────────────────────────────────────────────


def browser_context_status(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
    """Return current-owner metadata authorized by ``pre_tool_call``."""
    return _json(_take_lease("status", identity=runtime_identity(kwargs)))


def browser_get_context(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
    """Return only a pre-authorized, consume-once BCP payload lease."""
    return _json(_take_lease("get", _context_id(args), identity=runtime_identity(kwargs)))


def browser_clear_context(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
    """Return an exact-owner clear result authorized by ``pre_tool_call``."""
    return _json(_take_lease("clear", identity=runtime_identity(kwargs)))


def _event_log_limit(args: dict[str, Any] | None = None) -> int:
    value: Any = 20
    if isinstance(args, dict):
        value = args.get("limit", 20)
    try:
        limit = int(value)
    except (TypeError, ValueError):
        limit = 20
    return max(1, min(limit, 50))


def _journal_limit(args: dict[str, Any] | None = None) -> int:
    value: Any = 50
    if isinstance(args, dict):
        value = args.get("limit", 50)
    try:
        limit = int(value)
    except (TypeError, ValueError):
        limit = 50
    return max(1, min(limit, 500))


def browser_event_log(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
    """Return only a pre-authorized current-owner diagnostic event view."""
    return _json(
        _take_lease(
            "event_log",
            identity=runtime_identity(kwargs),
            parameter=str(_event_log_limit(args)),
        )
    )


def browser_control_status(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
    """Return only pre-authorized historical control-envelope metadata."""
    return _json(_take_lease("control_status", identity=runtime_identity(kwargs)))


def browser_context_journal(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
    """Return only pre-authorized owner-scoped journal metadata rows.

    The journal is metadata-only and never authorizes ``browser_get_context``;
    live context retrieval still requires a live in-memory record and the
    pre-tool ContextVar lease (see ``browser_get_context``).
    """
    return _json(
        _take_lease(
            "journal",
            identity=runtime_identity(kwargs),
            parameter=str(_journal_limit(args)),
        )
    )


def browser_text_utility(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
    """Run a bounded standard-library text operation without model inference."""
    values = args if isinstance(args, dict) else {}
    return _json(
        run_text_utility(
            values["action"] if "action" in values else None,
            values["text"] if "text" in values else None,
            compare_text=values["compare_text"] if "compare_text" in values else "",
        )
    )
