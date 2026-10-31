"""Hermes Control routes: how the extension attaches to the broker.

Two routes on the API server, wired by the same ``register_platform_handler``
factory as the readiness route (status_route.py)::

    POST /api/plugins/hermes-browser-extension/control/register
    GET  /api/plugins/hermes-browser-extension/control/ws

They carry the controller protocol Hermes core used to serve at
``/v1/browser-control/register`` and ``/v1/browser-control/ws``, so the extension
speaks one protocol to either.

* ``register`` is authenticated by the API server's own check (the paired loopback
  token or the API key). It validates the registration, keeps only allowlisted
  capabilities and mints a 30 second, single-use ticket bound to that exact scope.
  It refuses (503) when the session store cannot say the session exists, and (409)
  a session another credential has a live controller attached to.
  Identity is not taken from the body: the principal is a digest of the
  authenticated credential and the profile, and the transport family comes from
  the peer address.
* ``ws`` takes no credential of its own: the ticket is the credential. It rides in
  ``Sec-WebSocket-Protocol`` (never the query string, which lands in access logs)
  next to ``hermes-browser-control-v1``, and is exchanged once. A missing, wrong,
  consumed or expired ticket is refused with 401 before the upgrade.

Frames from the extension are ``result``, ``cancel``, ``heartbeat`` and ``detach``.
A socket's teardown only marks its own generation offline, so a newer socket for
the same controller is never detached by an older one closing.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import hashlib
import json
import logging
import time
from typing import Any, Callable, Optional

from .context_routes import _error, _read_bounded
from .control_broker import (
    CONTROL_PROTOCOL_VERSION,
    ControlBroker,
    ControllerScope,
    PrincipalConflict,
    TicketInvalid,
    filter_capabilities,
    protocol_supported,
)
from .status_route import BASE_PATH, authorize

logger = logging.getLogger(__name__)

CONTROL_REGISTER_PATH = f"{BASE_PATH}/control/register"
CONTROL_WS_PATH = f"{BASE_PATH}/control/ws"
ROUTE_PATHS = (CONTROL_REGISTER_PATH, CONTROL_WS_PATH)

WS_PROTOCOL = "hermes-browser-control-v1"
TICKET_PROTOCOL_PREFIX = "hermes-browser-control-ticket."
# A registration is a few hundred bytes; the cap only stops an absurd body.
MAX_REGISTER_BYTES = 64_000
# Same bound the plugin puts on every trusted identifier (context_store).
_MAX_IDENTIFIER_CHARS = 256
_SCOPE_KEYS = ("principal_id", "profile_id", "session_id", "controller_id", "browser_profile_id", "transport_family")


def _identifier(value: Any) -> str:
    """A registration id, bounded and printable; ``""`` when absent, too long or odd."""
    text = str(value or "").strip()
    if len(text) > _MAX_IDENTIFIER_CHARS or any(ord(char) < 32 or ord(char) == 127 for char in text):
        return ""
    return text


def derive_principal(profile: str, request: Any) -> str:
    """A non-reversible digest of the profile and the credential that passed authentication.

    A different key therefore yields a different principal, and a client cannot
    take over another controller's lane by echoing an id.
    """
    header = request.headers.get("Authorization", "")
    token = header[7:].strip() if header.startswith("Bearer ") else ""
    digest = hashlib.sha256(f"{profile}\x00{token}".encode()).hexdigest()
    return f"principal:{profile}:{digest[:32]}"


def transport_family(request: Any) -> str:
    """``local-api`` for a loopback peer, else ``remote-api``; the family is part of a controller's identity."""
    host = None
    try:
        transport = request.transport
        peer = transport.get_extra_info("peername") if transport is not None else None
        if isinstance(peer, tuple) and peer:
            host = peer[0]
        elif isinstance(peer, str):
            host = peer
    except Exception:
        host = None
    return "local-api" if host in ("127.0.0.1", "::1", "localhost") else "remote-api"


async def _session_known(adapter: Any, session_id: str) -> bool:
    """Whether the API server's session store holds ``session_id``.

    Fails closed: a store that is not offered, cannot be opened or raises when
    asked raises ``LookupError`` and the registration is refused, never allowed.
    """
    opener = getattr(adapter, "_ensure_session_db_async", None)
    if not callable(opener):
        raise LookupError("no session store")
    try:
        db = await opener()
        get_session = getattr(db, "get_session", None)
        if not callable(get_session):
            raise LookupError("session store has no lookup")
        return bool(await asyncio.to_thread(get_session, session_id))
    except LookupError:
        raise
    except Exception as exc:
        raise LookupError("session store unavailable") from exc


def make_register_handler(adapter: Any, broker: ControlBroker, *, profile: str) -> Callable[..., Any]:
    async def handler(request):
        from aiohttp import web

        denied = authorize(adapter, request)
        if denied is not None:
            return denied
        body = await _read_bounded(request, MAX_REGISTER_BYTES)
        if body is None:
            return _error(413, "registration_too_large", "The registration is too large.")
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            return _error(400, "invalid_json", "Request body must be valid JSON.")
        if not isinstance(payload, dict):
            return _error(400, "invalid_json", "Request body must be a JSON object.")
        if not protocol_supported(payload.get("protocol_version")):
            return _error(400, "browser_control_protocol_unsupported", "Unsupported browser-control protocol version.")
        controller_id = _identifier(payload.get("controller_id"))
        browser_profile_id = _identifier(payload.get("browser_profile_id"))
        session_id = _identifier(payload.get("session_id"))
        if not controller_id or not browser_profile_id or not session_id:
            return _error(
                400,
                "browser_control_invalid_registration",
                "controller_id, browser_profile_id, and session_id are required.",
            )
        try:
            known = await _session_known(adapter, session_id)
        except LookupError:
            return _error(503, "session_db_unavailable", "Session database unavailable.")
        if not known:
            return _error(
                403,
                "browser_control_session_forbidden",
                "Browser control may register only for an existing server session.",
            )
        capabilities = filter_capabilities(payload.get("capabilities"))
        if not capabilities:
            return _error(400, "browser_control_no_capabilities", "At least one permitted browser-control capability is required.")
        scope = ControllerScope(
            principal_id=derive_principal(profile, request),
            profile_id=profile,
            session_id=session_id,
            controller_id=controller_id,
            browser_profile_id=browser_profile_id,
            transport_family=transport_family(request),
            capabilities=capabilities,
        )
        if broker.principal_conflict(scope):
            return _error(
                409,
                "browser_control_session_owned",
                "Another credential already has a browser attached to this session.",
            )
        ticket = broker.mint_ticket(scope)
        ttl = broker.ticket_ttl_seconds
        return web.json_response(
            {
                "protocol_version": CONTROL_PROTOCOL_VERSION,
                "ticket": ticket.value,
                # Best-effort wall-clock projection; the broker enforces expiry on its
                # monotonic clock, so after a clock step trust the seconds.
                "ticket_expires_at": time.time() + ttl,
                "ticket_expires_in_seconds": ttl,
                "ws_path": CONTROL_WS_PATH,
                "scope": {**{key: getattr(scope, key) for key in _SCOPE_KEYS}, "capabilities": sorted(scope.capabilities)},
            },
            status=201,
            headers={"Cache-Control": "no-store"},
        )

    return handler


def _ws_sender(ws: Any, loop: Any, *, wait_timeout: float = 10.0) -> Callable[[dict], None]:
    """A broker send callback for one aiohttp controller socket.

    The broker calls it from an agent thread (or from the loop itself). A wait
    timeout means the write is still in flight, not rejected: the command stays
    pending and the broker's own deadline decides. A real send error propagates.
    """

    def send(frame: dict) -> None:
        if ws.closed:
            raise ConnectionError("browser-control websocket is closed")
        try:
            on_loop = asyncio.get_running_loop() is loop
        except RuntimeError:
            on_loop = False
        if on_loop:
            loop.create_task(ws.send_json(frame))
            return
        future = asyncio.run_coroutine_threadsafe(ws.send_json(frame), loop)
        try:
            future.result(timeout=wait_timeout)
        except concurrent.futures.TimeoutError:
            if future.done():
                raise

            def observe_late_send(completed):
                try:
                    completed.result()
                except Exception:
                    logger.exception("browser-controller websocket send failed after wait timeout")

            future.add_done_callback(observe_late_send)

    return send


def handle_frame(broker: ControlBroker, scope: ControllerScope, frame: dict, *, owner: Any = None) -> Optional[dict]:
    """Apply one controller-to-broker frame with exact-scope checks; the reply, if any."""
    method = frame.get("method")
    params = frame.get("params")
    if not isinstance(params, dict) or owner is None or not broker.is_owner(scope, owner):
        return None
    if method == "browser.controller.heartbeat":
        nonce = str(params.get("nonce") or "").strip()
        if not nonce or len(nonce) > 128:
            return None
        # Echoing the opaque nonce proves the socket is live without granting anything.
        return {"method": "browser.controller.heartbeat", "params": {"nonce": nonce, "ok": True}}
    if method == "browser.controller.detach":
        broker.detach(scope, owner=owner, notify_controller=False)
        return {"method": "browser.controller.detach", "params": {"ok": True}}
    if method == "browser.controller.result":
        command_id = params.get("command_id")
        if isinstance(command_id, str) and command_id:
            # The broker resolves only a pending command with this socket's exact scope.
            ok = params.get("ok") is True
            broker.complete(command_id, scope=scope, ok=ok, result=params.get("result") if ok else params.get("error"))
    elif method == "browser.controller.cancel":
        tool_call_id = params.get("tool_call_id")
        if isinstance(tool_call_id, str) and tool_call_id:
            broker.cancel(scope, tool_call_id=tool_call_id)
    return None


def make_ws_handler(broker: ControlBroker) -> Callable[..., Any]:
    async def handler(request):
        from aiohttp import web

        if request.query.get("ticket"):
            raise web.HTTPUnauthorized()
        requested = [value.strip() for value in request.headers.get("Sec-WebSocket-Protocol", "").split(",") if value.strip()]
        tickets = [value for value in requested if value.startswith(TICKET_PROTOCOL_PREFIX)]
        if WS_PROTOCOL not in requested or len(tickets) != 1:
            raise web.HTTPUnauthorized()
        ticket = tickets[0][len(TICKET_PROTOCOL_PREFIX):]
        if not ticket:
            raise web.HTTPUnauthorized()
        try:
            scope = broker.consume_ticket(ticket)
        except TicketInvalid:
            raise web.HTTPUnauthorized() from None
        except Exception:
            logger.exception("browser-control socket ticket consumption failed")
            raise web.HTTPUnauthorized() from None
        if broker.principal_conflict(scope):
            raise web.HTTPConflict()
        ws = web.WebSocketResponse(heartbeat=30.0, protocols=(WS_PROTOCOL,))
        await ws.prepare(request)
        send = _ws_sender(ws, asyncio.get_running_loop())

        # attach and disconnect take the controller's send lock, which a worker
        # thread's dispatch may hold while it waits on THIS loop: run them off the
        # loop, so a race parks a worker thread, not the loop.
        try:
            await asyncio.to_thread(broker.attach, scope, send, owner=ws)
        except PrincipalConflict:
            await ws.close(code=4409, message=b"session held by another principal")
            return ws
        try:
            async for message in ws:
                if message.type == web.WSMsgType.TEXT:
                    try:
                        frame = message.json()
                    except Exception:
                        continue
                    if isinstance(frame, dict):
                        reply = await asyncio.to_thread(handle_frame, broker, scope, frame, owner=ws)
                        if isinstance(reply, dict):
                            await ws.send_json(reply)
                elif message.type in (web.WSMsgType.CLOSE, web.WSMsgType.ERROR):
                    break
        finally:
            await asyncio.to_thread(broker.disconnect, scope, owner=ws)
        return ws

    return handler


def make_wire_extra(broker: ControlBroker, *, profile: str) -> Callable[[Any, Any], None]:
    """The ``wire_extra`` hook for status_route.register_status_route()."""

    def wire_extra(router: Any, adapter: Any) -> None:
        add_get = getattr(router, "add_get", None)
        add_post = getattr(router, "add_post", None)
        if callable(add_post):
            add_post(CONTROL_REGISTER_PATH, make_register_handler(adapter, broker, profile=profile))
        if callable(add_get):
            add_get(CONTROL_WS_PATH, make_ws_handler(broker))

    return wire_extra
