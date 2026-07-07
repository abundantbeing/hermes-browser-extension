"""Tool handlers for the Hermes Browser companion plugin.

All tools are fail-soft: when the context store is empty they return
*available: false* with a descriptive reason instead of raising.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from .schemas import SCHEMA_CLEAR_CONTEXT, SCHEMA_EVENT_LOG, SCHEMA_GET_CONTEXT, SCHEMA_STATUS

if TYPE_CHECKING:
    from .context_store import BrowserContextStore

# Module-level store reference — set by register() in __init__.py.
_STORE: BrowserContextStore | None = None


def set_store(store: BrowserContextStore) -> None:
    """Inject the shared store instance. Called at plugin registration time."""
    global _STORE
    _STORE = store


def _ensure_store() -> BrowserContextStore:
    if _STORE is None:
        msg = "BrowserContextStore not initialized — plugin register() may have failed."
        raise RuntimeError(msg)
    return _STORE


# ── Handlers ──────────────────────────────────────────────────────────


def browser_context_status(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
    """Check whether browser context is currently cached and available."""
    store = _ensure_store()
    result = store.status()
    return json.dumps(result, default=str)


def browser_get_context(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
    """Retrieve the current cached browser context envelope."""
    store = _ensure_store()
    result = store.get()
    return json.dumps(result, default=str)


def browser_clear_context(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
    """Clear the cached browser context."""
    store = _ensure_store()
    result = store.clear()
    return json.dumps(result, default=str)


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
    """Return recent browser companion events for diagnostics."""
    store = _ensure_store()
    limit = _event_log_limit(args)
    events = store.events[-limit:] if store.events else []
    result = {"available": bool(events), "events": events}
    return json.dumps(result, default=str)
