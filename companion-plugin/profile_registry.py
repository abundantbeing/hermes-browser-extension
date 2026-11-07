"""Per-profile HTTP listener state for a multiplexed Hermes gateway.

Hermes loads one plugin instance per profile home but wires
``register_platform_handler`` factories only once on the shared api_server app.
Those routes must dispatch to the profile named in ``/p/<profile>/``, using that
profile's broker, context store and tool list — not the first profile that wired.
"""
from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from typing import Any, Iterable, Optional, TYPE_CHECKING

from .context_store import BrowserContextStore

if TYPE_CHECKING:
    from .control_broker import ControlBroker, ControllerScope

_SAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]+")


def _label(value: Any, default: str) -> str:
    text = _SAFE_NAME.sub("", str(value or ""))[:64]
    return text or default


def normalize_profile(profile: str) -> str:
    return _label(profile, "default")


_PATH_PREFIX = re.compile(r"^/p/([^/]+)(?:/|$)")
_wiring_profile = "default"
_registry: dict[str, "ListenerProfile"] = {}
_lock = threading.RLock()


@dataclass(frozen=True)
class ListenerProfile:
    profile: str
    store: Any
    broker: Any
    tools: tuple[str, ...]
    hooks: tuple[str, ...]
    version: str


def set_wiring_profile(profile: str) -> None:
    global _wiring_profile
    with _lock:
        _wiring_profile = _label(profile, "default")


def register_listener_profile(
    *,
    profile: str,
    store: Any,
    broker: Any,
    tools: Iterable[str],
    hooks: Iterable[str],
    version: str,
) -> None:
    name = _label(profile, "default")
    with _lock:
        existing = _registry.get(name)
        if existing is not None:
            store = existing.store
        _registry[name] = ListenerProfile(
            profile=name,
            store=store,
            broker=broker,
            tools=tuple(str(t) for t in tools),
            hooks=tuple(str(h) for h in hooks),
            version=_label(version, "unknown"),
        )


def listener_profile_names() -> frozenset[str]:
    with _lock:
        return frozenset(_registry)


def get_listener_entry(name: str) -> Optional[ListenerProfile]:
    with _lock:
        return _registry.get(_label(name, "default"))


def ensure_context_store(profile: str) -> BrowserContextStore:
    """Return the per-profile store, creating the registry row before ``register()`` finishes if needed."""
    key = _label(profile, "default")
    with _lock:
        existing = _registry.get(key)
        if existing is not None:
            return existing.store
        store = BrowserContextStore()
        _registry[key] = ListenerProfile(
            profile=key,
            store=store,
            broker=None,
            tools=(),
            hooks=(),
            version="unknown",
        )
        return store


def resolve_turn_profile(kwargs: Any) -> str:
    """Profile for the current agent turn (tool hooks, control tools).

    Prefer an explicit ``profile_name`` when Hermes passes it; otherwise use
    ``hermes_cli.profiles.current_profile_name()`` (HERMES_HOME override / env pin).
    """
    if isinstance(kwargs, dict):
        explicit = kwargs.get("profile_name")
        if isinstance(explicit, str) and explicit.strip():
            return _label(explicit.strip(), "default")
    try:
        from hermes_cli.profiles import current_profile_name

        found = current_profile_name()
        if isinstance(found, str) and found.strip():
            return _label(found.strip(), "default")
    except Exception:
        pass
    with _lock:
        return _wiring_profile


def store_for_turn(**kwargs: Any) -> Optional[BrowserContextStore]:
    """The context store for this turn's profile, or ``None`` if the companion did not register there."""
    name = resolve_turn_profile(kwargs)
    with _lock:
        entry = _registry.get(name)
        if entry is not None:
            return entry.store
    return None


def _profile_from_api_context() -> Optional[str]:
    try:
        from gateway.platforms.api_server import _api_request_profile
    except Exception:
        return None
    try:
        active = _api_request_profile.get()
    except LookupError:
        return None
    if not active:
        return None
    return _label(active, "")


def _profile_from_request_path(request: Any) -> str:
    match_info = getattr(request, "match_info", None)
    if match_info is not None:
        try:
            from_url = match_info.get("profile")
        except Exception:
            from_url = None
        if from_url:
            return _label(from_url, "")
    path = str(getattr(getattr(request, "rel_url", None), "path", "") or getattr(request, "path", "") or "")
    matched = _PATH_PREFIX.match(path)
    if matched:
        return _label(matched.group(1), "")
    return ""


def resolve_request_profile(request: Any) -> str:
    """Profile the HTTP listener attributes to this request."""
    for candidate in (_profile_from_api_context(), _profile_from_request_path(request)):
        if candidate:
            return candidate
    with _lock:
        return _wiring_profile


def lookup_listener_profile(request: Any) -> tuple[Optional[ListenerProfile], str]:
    name = resolve_request_profile(request)
    with _lock:
        return _registry.get(name), name


def consume_control_ticket(value: str) -> tuple["ControlBroker", "ControllerScope"]:
    """Find the profile broker that minted this ticket and consume it once there."""
    from .control_broker import TicketInvalid

    with _lock:
        entries = list(_registry.values())
    for entry in entries:
        broker = entry.broker
        if broker is None:
            continue
        try:
            scope = broker.consume_ticket(value)
            return broker, scope
        except TicketInvalid:
            continue
    raise TicketInvalid("unknown ticket")
