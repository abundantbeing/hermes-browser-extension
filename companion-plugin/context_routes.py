"""Browser-context side channel for the Hermes Browser extension.

Three routes on the API server, wired by the same ``register_platform_handler``
factory as the readiness route (status_route.py) and authenticated by the API
server's own request check, exactly like it::

    GET  /api/plugins/hermes-browser-companion/context/status
    POST /api/plugins/hermes-browser-companion/context
    GET  /api/plugins/hermes-browser-companion/actions

Context status and upload name the caller's session with the ``X-Hermes-Session-Id``
header (or ``?session_id=``), the same session id the API server uses for a chat.

* ``context/status`` answers what this plugin holds for that session: counts,
  ages, the newest context hash, whether an upload is waiting, and ``live:
  false`` (a stored context is history, never live browser authority). It never
  contains page text, URLs, titles, tab data or any identifier of a turn.
* ``context`` takes the extension's browser-context envelope, the same
  ``hermes.browser.turn.v2`` full-context turn the ``pre_llm_call`` hook accepts,
  validated by the same parser, and parks it for that session. It binds to an
  execution owner only when a trusted hook sees a reference turn for that
  session that names the same context hash; the tools, the opaque context id and
  the one-shot lease are unchanged. The answer is metadata only.
* ``actions`` lists the plugin's safe actions as declarative descriptors
  (actions.py). Nothing in this module runs an action.

No other route is added, and no route here moves anything but that one envelope.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Iterable

from . import actions as action_catalog
from .protocol import BrowserContextEnvelope
from .status_route import (
    ACTIONS_PATH,
    CONTEXT_STATUS_PATH,
    CONTEXT_UPLOAD_PATH,
    PLUGIN_NAME,
    authorize,
)

logger = logging.getLogger(__name__)

SESSION_HEADER = "X-Hermes-Session-Id"
CONTEXT_STATUS_OBJECT = "hermes.browser_companion.context_status"
CONTEXT_UPLOAD_OBJECT = "hermes.browser_companion.context_upload"
ACTIONS_OBJECT = "hermes.browser_companion.actions"

# The context parser refuses a turn longer than this (context_store), so a
# longer body cannot be valid; refuse it before reading it all.
MAX_UPLOAD_BYTES = 4 * 64_000
_MAX_SESSION_ID_CHARS = 256
_NO_STORE = {"Cache-Control": "no-store"}


def _error(status: int, code: str, message: str) -> Any:
    from aiohttp import web

    return web.json_response(
        {"error": {"message": message, "type": "companion_error", "code": code}},
        status=status,
        headers=_NO_STORE,
    )


def _session_id(request: Any) -> str:
    """The session the caller names, bounded and printable; ``""`` when unusable."""
    raw = request.headers.get(SESSION_HEADER) or request.query.get("session_id") or ""
    value = str(raw).strip()
    if not value or len(value) > _MAX_SESSION_ID_CHARS:
        return ""
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        return ""
    return value


def _ms(seconds: float) -> int:
    return max(0, int(seconds * 1000))


def make_status_handler(adapter: Any, store: Any) -> Callable[..., Any]:
    async def handler(request):
        from aiohttp import web

        denied = authorize(adapter, request)
        if denied is not None:
            return denied
        session = _session_id(request)
        if not session:
            return _error(400, "session_required", f"Send the session id in the {SESSION_HEADER} header.")
        body = {"object": CONTEXT_STATUS_OBJECT, "plugin": PLUGIN_NAME, **store.session_status(session)}
        return web.json_response(body, headers=_NO_STORE)

    return handler


async def _read_bounded(request: Any, limit: int) -> bytes | None:
    """The request body, or ``None`` when it is longer than ``limit`` bytes."""
    declared = request.content_length
    if declared is not None and declared > limit:
        return None
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.content.iter_chunked(16_384):
        total += len(chunk)
        if total > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def make_upload_handler(adapter: Any, store: Any) -> Callable[..., Any]:
    async def handler(request):
        from aiohttp import web

        denied = authorize(adapter, request)
        if denied is not None:
            return denied
        session = _session_id(request)
        if not session:
            return _error(400, "session_required", f"Send the session id in the {SESSION_HEADER} header.")
        body = await _read_bounded(request, MAX_UPLOAD_BYTES)
        if body is None:
            return _error(413, "envelope_too_large", "The browser-context envelope is too large.")
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError:
            return _error(400, "invalid_envelope", "The body must be UTF-8 JSON.")
        stored = store.put_session_upload(session, text)
        if not stored.get("available"):
            return _error(
                422,
                "invalid_envelope",
                "The body is not a full hermes.browser.turn.v2 browser-context envelope.",
            )
        summary = BrowserContextEnvelope(
            payload_hash=str(stored.get("payload_hash") or ""),
            scope=str(stored.get("scope") or "unknown"),
        ).status()
        return web.json_response(
            {
                "object": CONTEXT_UPLOAD_OBJECT,
                "plugin": PLUGIN_NAME,
                "stored": True,
                "protocol": stored.get("protocol"),
                "payload_hash": summary["payload_hash"],
                "scope": summary["scope"],
                # Bound to an execution owner by the session's next reference turn
                # that names this hash; until then it only waits.
                "adopts": "reference-turn",
                "expires_in_ms": _ms(float(stored["expires_at"]) - float(stored["created_at"])),
                "live": False,
            },
            headers=_NO_STORE,
        )

    return handler


def make_actions_handler(adapter: Any, payload: dict[str, Any]) -> Callable[..., Any]:
    async def handler(request):
        from aiohttp import web

        denied = authorize(adapter, request)
        if denied is not None:
            return denied
        return web.json_response(payload, headers=_NO_STORE)

    return handler


def build_actions_payload(*, version: str) -> dict[str, Any]:
    return {
        "object": ACTIONS_OBJECT,
        "plugin": PLUGIN_NAME,
        "version": version,
        # Descriptors only: no route of this plugin runs an action. The agent calls
        # a listed tool inside a turn, under Hermes' own tool approval.
        "execution": "none",
        "actions": action_catalog.descriptors(),
    }


def make_wire_extra(store: Any, *, version: str) -> Callable[[Any, Any], None]:
    """The ``wire_extra`` hook for status_route.register_status_route()."""
    actions_payload = build_actions_payload(version=version)

    def wire_extra(router: Any, adapter: Any) -> None:
        add_get = getattr(router, "add_get", None)
        add_post = getattr(router, "add_post", None)
        if callable(add_get):
            add_get(CONTEXT_STATUS_PATH, make_status_handler(adapter, store))
            add_get(ACTIONS_PATH, make_actions_handler(adapter, actions_payload))
        if callable(add_post):
            add_post(CONTEXT_UPLOAD_PATH, make_upload_handler(adapter, store))

    return wire_extra


def route_paths() -> Iterable[str]:
    return (CONTEXT_STATUS_PATH, CONTEXT_UPLOAD_PATH, ACTIONS_PATH)
