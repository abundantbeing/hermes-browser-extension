"""Authorized tool handlers for the Hermes Browser companion plugin.

``browser_get_context`` never consults the process-global store.  The trusted
``pre_tool_call`` hook atomically consumes a context capability and hands the
payload to this module through a short-lived :class:`contextvars.ContextVar`
lease keyed by the opaque context ID.
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
import json
from time import monotonic
from typing import Any

from .schemas import SCHEMA_CLEAR_CONTEXT, SCHEMA_EVENT_LOG, SCHEMA_GET_CONTEXT, SCHEMA_STATUS, SCHEMA_TEXT_UTILITY
from .text_utilities import run_text_utility

_UNAVAILABLE = {"available": False, "reason": "Browser context unavailable."}
_LEASE_TTL_SECONDS = 5.0


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


def set_store(_store: Any) -> None:
    """Retained registration seam; handlers intentionally do not read stores."""


def _lease_key(operation: str, context_id: str = "") -> str:
    return f"{operation}:{context_id}"


def grant_lease(operation: str, result: dict[str, Any], context_id: str = "") -> None:
    """Set a short-lived, execution-local lease from trusted hook code."""
    key = _lease_key(operation, context_id)
    leases = dict(_LEASES.get())
    leases[key] = _AuthorizationLease(
        operation=operation,
        key=key,
        result=result,
        expires_at=monotonic() + _LEASE_TTL_SECONDS,
    )
    _LEASES.set(leases)


def _take_lease(operation: str, context_id: str = "") -> dict[str, Any] | None:
    key = _lease_key(operation, context_id)
    leases = dict(_LEASES.get())
    lease = leases.pop(key, None)
    _LEASES.set(leases)
    if lease is None or lease.expires_at < monotonic():
        return None
    return lease.result


def _context_id(args: dict[str, Any] | None) -> str:
    value = args.get("context_id") if isinstance(args, dict) else ""
    return value.lower() if isinstance(value, str) else ""


def _json(result: dict[str, Any] | None) -> str:
    return json.dumps(result if result is not None else _UNAVAILABLE, default=str)


# ── Handlers ──────────────────────────────────────────────────────────


def browser_context_status(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
    """Return current-owner metadata authorized by ``pre_tool_call``."""
    return _json(_take_lease("status"))


def browser_get_context(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
    """Return only a pre-authorized, consume-once BCP payload lease."""
    return _json(_take_lease("get", _context_id(args)))


def browser_clear_context(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
    """Return an exact-owner clear result authorized by ``pre_tool_call``."""
    return _json(_take_lease("clear"))


def _event_log_limit(args: dict[str, Any] | None = None) -> int:
    value: Any = 20
    if isinstance(args, dict):
        value = args.get("limit", 20)
    try:
        limit = int(value)
    except (TypeError, ValueError):
        limit = 20
    return max(1, min(limit, 50))


def browser_event_log(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
    """Return only a pre-authorized current-owner diagnostic event view."""
    return _json(_take_lease("event_log"))


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
