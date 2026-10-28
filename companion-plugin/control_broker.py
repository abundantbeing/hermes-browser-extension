"""Broker for Hermes Control: the agent driving the person's own browser.

The Hermes Browser extension registers as a *controller* for one Hermes session;
the plugin's tools are the *callers*. This module is the transport-neutral core
that binds them. It is the broker Hermes core used to carry for the extension,
kept here so control works on a Hermes whose core has no extension control.

Rules it keeps:

* A ticket is short-lived, single-use and bound to one exact controller scope.
* ``scope_for_session`` answers only when exactly one controller is attached for
  the profile and session; none or several fail closed, never a guess.
* A session is bound to one principal from its first attach. The binding survives a
  dropped transport, so another principal cannot slip in while the first is mid
  reconnect: it ends only on an explicit ``detach``, ``reset()``, or after
  ``SESSION_BINDING_GRACE_SECONDS`` without a live controller. While it holds,
  another principal is refused at register and again at attach
  (``principal_conflict``); its controller is never replaced. A same-principal
  controller may replace the bound one.
* ``select`` matches every stable identity field and the controller's *current*
  capability set, so a caller never reaches a capability the extension dropped.
* ``dispatch`` blocks for the controller's answer; ``complete`` resolves a command
  once. ``detach`` fails pending work closed (cancelled), ``disconnect`` only marks
  a transport offline so a reconnect keeps its pending work.
* State changes happen under one RLock. The send callback runs *outside* it, so a
  controller may ``complete`` from inside its own send.

Left out on purpose: artifact upload and download, raw CDP and page evaluation,
and any feature flag. The plugin being enabled for a profile is the switch.
"""

from __future__ import annotations

import logging
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)
_OWNER_UNSET = object()

#: Lifetime of a minted registration ticket, in clock seconds.
DEFAULT_TICKET_TTL = 30.0
#: Wall time a dispatch waits for the controller. The extension gives every command
#: 30 s (approval wait included), so its own deadline answer arrives first.
DEFAULT_COMMAND_TIMEOUT = 35.0
#: How long a session stays bound to its principal after its last live controller dropped
#: (a few of the extension's 60 s heartbeats and its reconnect backoff). An explicit
#: detach clears the binding at once.
SESSION_BINDING_GRACE_SECONDS = 180.0
#: Cancel frames kept while a same-identity controller is offline.
MAX_DEFERRED_CANCELS = 512
#: The wire protocol version; registration must carry exactly this int (bools are refused).
CONTROL_PROTOCOL_VERSION = 1

NOOP_CAPABILITY = "controller.noop"
#: Every browser action the plugin exposes as a tool. It equals the extension's
#: CONTROLLER_BROWSER_CAPABILITIES; a test keeps the two lists identical.
CONTROL_ACTIONS = (
    "browser_back",
    "browser_batch",
    "browser_click",
    "browser_drag",
    "browser_fill",
    "browser_hover",
    "browser_navigate",
    "browser_press",
    "browser_screenshot",
    "browser_scroll",
    "browser_scroll_to",
    "browser_select",
    "browser_snapshot",
    "browser_tab_activate",
    "browser_tab_close",
    "browser_tab_create",
    "browser_tab_group",
    "browser_tab_ungroup",
    "browser_tabs",
    "browser_type",
)
#: The exact capability allowlist; raw CDP and page evaluation are not on it.
CONTROL_CAPABILITIES = frozenset({NOOP_CAPABILITY, *CONTROL_ACTIONS})

#: Wire method names for the frames the broker sends; the extension answers with
#: ``browser.controller.result`` and may send ``cancel``, ``heartbeat`` or ``detach``.
FRAME_COMMAND = "browser.controller.command"
FRAME_CANCEL = "browser.controller.cancel"


def protocol_supported(value: Any) -> bool:
    """Whether ``value`` is exactly the supported wire version (``True`` is not ``1``)."""
    return type(value) is int and value == CONTROL_PROTOCOL_VERSION


def filter_capabilities(value: Any) -> frozenset:
    """The permitted subset of a capability list; anything but a list gives the empty set."""
    if not isinstance(value, list):
        return frozenset()
    return frozenset(item for item in value if isinstance(item, str) and item in CONTROL_CAPABILITIES)


class ControlError(Exception):
    """Base class for broker contract failures."""


class TicketInvalid(ControlError):
    """A registration ticket is unknown, already consumed, or expired."""


class PrincipalConflict(ControlError):
    """A session already has a live controller from a different principal."""


class ControllerUnavailable(ControlError):
    """No attached controller exactly matches the requested scope and capability."""


class ControllerCancelled(ControlError):
    """A pending command was cancelled, explicitly or by a detach."""


class ControllerTimeout(ControlError):
    """The controller did not complete the command before the timeout."""


class ControllerRejected(ControlError):
    """The controller completed the command with ``ok=False``; ``detail`` is its error."""

    def __init__(self, message: str, detail: Any = None) -> None:
        super().__init__(message)
        self.detail = detail


@dataclass(frozen=True)
class ControllerScope:
    """Exact controller identity plus capability set; equality is over every field."""

    principal_id: Optional[str] = None
    profile_id: Optional[str] = None
    session_id: Optional[str] = None
    controller_id: Optional[str] = None
    browser_profile_id: Optional[str] = None
    transport_family: Optional[str] = None
    capabilities: frozenset = frozenset()


#: Stable identity fields. The negotiated ``capabilities`` are deliberately not one.
_IDENTITY_FIELDS = ("principal_id", "profile_id", "session_id", "controller_id", "browser_profile_id", "transport_family")


def _same_scope_identity(first: ControllerScope, second: ControllerScope) -> bool:
    return all(getattr(first, name) == getattr(second, name) for name in _IDENTITY_FIELDS)


@dataclass(frozen=True)
class Ticket:
    """Opaque, single-use registration credential."""

    value: str
    expires_at: float


@dataclass
class _TicketRecord:
    scope: ControllerScope
    expires_at: float
    consumed: bool = False


@dataclass
class _Binding:
    principal_id: Optional[str]
    # ``None`` while a controller of that principal is live; else the clock time the grace ends.
    expires_at: Optional[float] = None


@dataclass
class _Controller:
    scope: ControllerScope
    send: Callable[[dict], None]
    owner: Any = None
    connected: bool = True
    deferred_cancels: list[dict] = field(default_factory=list)
    # Serializes command and cancel writes with a detach or replacement; never held
    # together with the broker lock.
    send_lock: threading.Lock = field(default_factory=threading.Lock)


@dataclass
class _PendingCommand:
    scope: ControllerScope
    command_id: str
    tool_call_id: Optional[str]
    event: threading.Event = field(default_factory=threading.Event)
    done: bool = False
    cancelled: bool = False
    ok: bool = False
    result: Any = None


def _cancel_frame(pending: _PendingCommand) -> dict:
    return {"method": FRAME_CANCEL, "params": {"command_id": pending.command_id, "tool_call_id": pending.tool_call_id}}


class ControlBroker:
    """Thread-safe broker core; ``clock`` is injectable (default ``time.monotonic``)."""

    def __init__(
        self,
        *,
        ticket_ttl: float = DEFAULT_TICKET_TTL,
        command_timeout: float = DEFAULT_COMMAND_TIMEOUT,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        self._ticket_ttl = ticket_ttl
        self._command_timeout = command_timeout
        self._clock = clock if clock is not None else time.monotonic
        self._lock = threading.RLock()
        self._tickets: dict[str, _TicketRecord] = {}
        self._controllers: dict[ControllerScope, _Controller] = {}
        self._pending: dict[str, _PendingCommand] = {}
        self._bindings: dict[tuple, _Binding] = {}

    # -- tickets ------------------------------------------------------------

    def mint_ticket(self, scope: ControllerScope) -> Ticket:
        """Mint a short-lived, single-use ticket bound to ``scope``."""
        now = self._clock()
        with self._lock:
            self._tickets = {value: record for value, record in self._tickets.items() if record.expires_at > now}
            value = secrets.token_urlsafe(32)
            self._tickets[value] = record = _TicketRecord(scope=scope, expires_at=now + self._ticket_ttl)
        return Ticket(value=value, expires_at=record.expires_at)

    def consume_ticket(self, value: str) -> ControllerScope:
        """Exchange a ticket for its scope exactly once; unknown, consumed or expired raises ``TicketInvalid``."""
        now = self._clock()
        with self._lock:
            record = self._tickets.get(value)
            if record is None:
                raise TicketInvalid("unknown ticket")
            if record.consumed:
                raise TicketInvalid("ticket already consumed")
            if now > record.expires_at:
                raise TicketInvalid("ticket expired")
            record.consumed = True
            return record.scope

    # -- controllers --------------------------------------------------------

    def _controller_for_identity_locked(self, scope: ControllerScope) -> Optional[_Controller]:
        """The attached controller sharing ``scope``'s stable identity (any capabilities)."""
        return next((c for c in self._controllers.values() if _same_scope_identity(c.scope, scope)), None)

    def _live_controller(self, scope: ControllerScope) -> Optional[_Controller]:
        with self._lock:
            controller = self._controller_for_identity_locked(scope)
        return controller if controller is not None and controller.connected else None

    def _reconcile_binding_locked(self, key: tuple) -> None:
        """Make a binding say what its controllers say: no controller of the principal left deletes it, none live
        starts the grace, one live clears it. Run whenever a controller is removed or goes offline."""
        binding = self._bindings.get(key)
        if binding is None:
            return
        mine = [c for scope, c in self._controllers.items() if (scope.profile_id, scope.session_id) == key and scope.principal_id == binding.principal_id]
        if not mine:
            del self._bindings[key]
        elif any(controller.connected for controller in mine):
            binding.expires_at = None
        elif binding.expires_at is None:
            binding.expires_at = self._clock() + SESSION_BINDING_GRACE_SECONDS

    def _purge_bindings_locked(self) -> None:
        """Drop the bindings whose grace ended, with the offline controllers they kept. A binding no live
        controller backs is always on the clock, so none can outlive its principal's controllers."""
        now = self._clock()
        for key in list(self._bindings):
            self._reconcile_binding_locked(key)
            binding = self._bindings.get(key)
            if binding is None or binding.expires_at is None or binding.expires_at > now:
                continue
            del self._bindings[key]
            for scope, controller in list(self._controllers.items()):
                if (scope.profile_id, scope.session_id) == key and not controller.connected:
                    del self._controllers[scope]
                    for pending in self._pending_for_scope_locked(scope):
                        self._resolve_pending(pending, cancelled=True)

    def principal_conflict(self, scope: ControllerScope) -> bool:
        """Whether the scope's profile and session are bound to a different principal, live or not."""
        with self._lock:
            self._purge_bindings_locked()
            binding = self._bindings.get((scope.profile_id, scope.session_id))
            return binding is not None and binding.principal_id != scope.principal_id

    def _bind_locked(self, scope: ControllerScope) -> None:
        self._bindings[(scope.profile_id, scope.session_id)] = _Binding(principal_id=scope.principal_id)

    def attach(self, scope: ControllerScope, send: Callable[[dict], None], *, owner: Any = None) -> None:
        """Attach or refresh the controller for one stable identity.

        A same-identity reconnect refreshes the send callback and capabilities
        without cancelling pending work. A different controller or browser
        profile in the same authenticated session lane replaces it outright.
        """
        while True:
            with self._lock:
                if self.principal_conflict(scope):
                    raise PrincipalConflict("the session is held by another principal")
                existing = self._controller_for_identity_locked(scope)
                lane_scopes = [
                    other
                    for other in self._controllers
                    if not _same_scope_identity(other, scope)
                    and (other.principal_id, other.profile_id, other.session_id, other.transport_family)
                    == (scope.principal_id, scope.profile_id, scope.session_id, scope.transport_family)
                ]
                if existing is None and not lane_scopes:
                    self._controllers[scope] = _Controller(scope=scope, send=send, owner=owner)
                    self._bind_locked(scope)
                    return

            # A hard replacement, not a recoverable reconnect: terminalize the
            # lane siblings before inserting, so a session lookup stays unique.
            if lane_scopes:
                for lane_scope in lane_scopes:
                    self.detach(lane_scope, notify_controller=False, keep_binding=True)
                continue

            with existing.send_lock:
                with self._lock:
                    if self._controllers.get(existing.scope) is not existing:
                        continue
                    self._controllers.pop(existing.scope, None)
                    existing.scope, existing.send, existing.owner, existing.connected = scope, send, owner, False
                    for pending in self._pending_for_scope_locked(scope):
                        pending.scope = scope
                    deferred, existing.deferred_cancels = existing.deferred_cancels, []
                    self._controllers[scope] = existing

                for index, frame in enumerate(deferred):
                    try:
                        send(frame)
                        continue
                    except Exception:
                        logger.exception("failed to flush deferred browser-controller cancel")
                    with self._lock:
                        if self._controllers.get(scope) is existing:
                            existing.deferred_cancels = deferred[index:][-MAX_DEFERRED_CANCELS:]
                    raise ConnectionError("browser controller reconnect could not flush deferred cancels")
                with self._lock:
                    if self._controllers.get(scope) is existing:
                        existing.connected = True
                        self._bind_locked(scope)
                return

    def select(self, scope: ControllerScope, capability: str) -> Optional[_Controller]:
        """The connected controller matching identity whose *current* negotiated set holds ``capability``.

        The caller's own copy of the set is not authoritative.
        """
        controller = self._live_controller(scope)
        return controller if controller is not None and capability in controller.scope.capabilities else None

    def is_owner(self, scope: ControllerScope, owner: Any) -> bool:
        """Whether ``owner`` is the exact live transport for ``scope`` (capability-independent)."""
        controller = self._live_controller(scope)
        return controller is not None and controller.owner is owner

    def disconnect(self, scope: ControllerScope, *, owner: Any = _OWNER_UNSET) -> bool:
        """Mark one exact controller transport offline without cancelling its work."""
        with self._lock:
            controller = self._controller_for_identity_locked(scope)
        if controller is None:
            return False
        with controller.send_lock:
            with self._lock:
                owned = owner is _OWNER_UNSET or controller.owner is owner
                if self._controllers.get(controller.scope) is not controller or not owned:
                    return False
                controller.connected, controller.owner = False, None
                self._reconcile_binding_locked((controller.scope.profile_id, controller.scope.session_id))
        return True

    def detach(
        self,
        scope: ControllerScope,
        *,
        owner: Any = _OWNER_UNSET,
        notify_controller: bool = True,
        keep_binding: bool = False,
    ) -> None:
        """Remove the controller for ``scope`` and fail its pending work closed (``ControllerCancelled``).

        ``keep_binding`` is for a replacement by the same principal, which re-binds as it inserts."""
        with self._lock:
            controller = self._controllers.get(scope)
        if controller is None or (owner is not _OWNER_UNSET and controller.owner != owner):
            return
        with controller.send_lock:
            with self._lock:
                if self._controllers.get(scope) is not controller or (owner is not _OWNER_UNSET and controller.owner != owner):
                    return
                self._controllers.pop(scope, None)
                pendings = self._pending_for_scope_locked(scope)
                for pending in pendings:
                    self._resolve_pending(pending, cancelled=True)
                # A removed controller may have been the binding's last: delete it, or start its grace.
                if not keep_binding:
                    self._reconcile_binding_locked((scope.profile_id, scope.session_id))
            # Hold the old generation's send lock through cancellation, so a
            # command frame can never overtake its terminal cancel frame.
            if notify_controller:
                self._emit_cancel_frames(controller, pendings)

    # -- commands -----------------------------------------------------------

    def dispatch(
        self,
        scope: ControllerScope,
        *,
        action: str,
        arguments: Optional[dict] = None,
        tool_call_id: Optional[str] = None,
    ) -> Any:
        """Send one command and block for its completion.

        Raises ``ControllerUnavailable``, ``ControllerCancelled``,
        ``ControllerTimeout`` or ``ControllerRejected``.
        """
        controller = self.select(scope, action)
        if controller is None:
            raise ControllerUnavailable(f"no controller for scope {scope!r} with capability {action!r}")
        arguments = dict(arguments or {})
        command_id = secrets.token_hex(16)
        frame = {
            "method": FRAME_COMMAND,
            "params": {
                "command_id": command_id,
                "action": action,
                "arguments": arguments,
                "controller_id": scope.controller_id,
                "browser_profile_id": scope.browser_profile_id,
                "tool_call_id": tool_call_id,
            },
        }
        pending = _PendingCommand(scope=controller.scope, command_id=command_id, tool_call_id=tool_call_id)
        with controller.send_lock:
            with self._lock:
                # select() ran outside the send lock: revalidate the live
                # controller, so a disconnect or replacement cannot strand a command.
                if self._controller_for_identity_locked(scope) is not controller or not controller.connected:
                    raise ControllerUnavailable(f"controller for scope {scope!r} detached before dispatch")
                pending.scope = controller.scope
                self._pending[command_id] = pending
            try:
                controller.send(frame)
            except Exception:
                # It never left: release the id and surface the error.
                with self._lock:
                    self._pending.pop(command_id, None)
                raise

        if not pending.event.wait(timeout=self._command_timeout):
            with self._lock:
                # wait() can return False at the exact boundary where a completion
                # already won and removed the pending command.
                timed_out = not pending.done and self._pending.get(command_id) is pending
                if timed_out:
                    pending.done = True
                    del self._pending[command_id]
            if timed_out:
                with controller.send_lock:
                    with self._lock:
                        active = self._controller_for_identity_locked(scope) or controller
                        if not active.connected:
                            self._defer_cancel_locked(active, pending)
                            active = None
                    if active is not None:
                        self._emit_cancel_frames(active, [pending])
                raise ControllerTimeout(f"controller did not complete command {command_id!r} within {self._command_timeout}s")
        if pending.cancelled:
            raise ControllerCancelled(f"command {command_id!r} was cancelled")
        if not pending.ok:
            raise ControllerRejected(f"controller rejected command {command_id!r}", pending.result)
        return pending.result

    def complete(self, command_id: str, *, scope: Optional[ControllerScope] = None, ok: bool, result: Any = None) -> bool:
        """Resolve a pending command by id; ``False`` when none is pending. Safe inside the send callback."""
        with self._lock:
            pending = self._pending.get(command_id)
            if pending is None or pending.done or (scope is not None and pending.scope != scope):
                return False
            pending.done, pending.ok, pending.result = True, ok is True, result
            del self._pending[command_id]
            pending.event.set()
        return True

    def cancel(self, scope: ControllerScope, *, tool_call_id: Optional[str]) -> bool:
        """Cancel the pending command matching ``scope`` and ``tool_call_id`` (one cancel frame); ``False`` if none."""
        controller = self._live_controller(scope)
        if controller is None:
            return False
        with controller.send_lock:
            with self._lock:
                if self._controller_for_identity_locked(scope) is not controller or not controller.connected:
                    return False
                target = next(
                    (p for p in self._pending_for_scope_locked(scope) if p.tool_call_id == tool_call_id and not p.done),
                    None,
                )
                if target is None:
                    return False
                self._resolve_pending(target, cancelled=True)
            self._emit_cancel_frames(controller, [target])
            return True

    def _resolve_pending(self, pending: _PendingCommand, *, cancelled: bool) -> None:
        pending.cancelled, pending.done = cancelled, True
        del self._pending[pending.command_id]
        pending.event.set()

    def _defer_cancel_locked(self, controller: _Controller, pending: _PendingCommand) -> None:
        controller.deferred_cancels.append(_cancel_frame(pending))
        if len(controller.deferred_cancels) > MAX_DEFERRED_CANCELS:
            del controller.deferred_cancels[:-MAX_DEFERRED_CANCELS]

    def _pending_for_scope_locked(self, scope: ControllerScope) -> list[_PendingCommand]:
        return [p for p in list(self._pending.values()) if _same_scope_identity(p.scope, scope)]

    def _emit_cancel_frames(self, controller: _Controller, pendings: list[_PendingCommand]) -> None:
        """Send cancel frames; the caller holds ``send_lock``, never the broker lock."""
        for pending in pendings:
            try:
                controller.send(_cancel_frame(pending))
            except Exception:
                logger.exception("failed to emit cancel frame for command %r", pending.command_id)

    # -- lookup -------------------------------------------------------------

    def lane_scopes(self, *, profile_id: Optional[str], session_id: Optional[str]) -> list[ControllerScope]:
        """Attached scopes (online or not) registered for one profile and session."""
        key = tuple(str(value or "").strip() for value in (profile_id, session_id))
        if not all(key):
            return []
        with self._lock:
            return [scope for scope in self._controllers if (scope.profile_id, scope.session_id) == key]

    def scope_for_session(self, *, profile_id: Optional[str], session_id: Optional[str]) -> Optional[ControllerScope]:
        """The one attached scope for a session, or ``None`` when there is none or more than one."""
        matches = self.lane_scopes(profile_id=profile_id, session_id=session_id)
        return matches[0] if len(matches) == 1 else None

    def any_connected(self) -> bool:
        """Whether any controller has a live transport, for the tools' availability check."""
        with self._lock:
            return any(controller.connected for controller in self._controllers.values())

    def disconnect_owner(self, owner: Any) -> int:
        """Mark every controller owned by one lost transport offline."""
        with self._lock:
            scopes = [scope for scope, controller in self._controllers.items() if controller.owner is owner]
        return sum(int(self.disconnect(scope, owner=owner)) for scope in scopes)

    def reset(self) -> None:
        """Fail all live work closed and clear tickets (tests and shutdown)."""
        with self._lock:
            scopes = list(self._controllers)
        for scope in scopes:
            self.detach(scope)
        with self._lock:
            self._tickets.clear()
            self._bindings.clear()
            # Pending entries whose controller a concurrent teardown removed.
            for pending in list(self._pending.values()):
                self._resolve_pending(pending, cancelled=True)

    @property
    def ticket_ttl_seconds(self) -> float:
        """The configured lifetime of newly minted one-shot tickets."""
        return self._ticket_ttl

    @property
    def pending_count(self) -> int:
        """Commands awaiting completion (diagnostics and tests)."""
        with self._lock:
            return len(self._pending)


# One broker per process, shared by the routes (the gateway's event loop) and the
# tools (agent worker threads): ordinary turns run in the gateway process.
_BROKER = ControlBroker()


def get_control_broker() -> ControlBroker:
    """The process-local broker."""
    return _BROKER
