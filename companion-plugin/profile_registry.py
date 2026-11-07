"""Per-profile HTTP listener state for a multiplexed Hermes gateway.

Hermes mirrors native api_server routes at ``/p/{profile}/…`` on one shared aiohttp
app. Plugin ``register_platform_handler`` factories run from the default profile's
plugin manager at connect time, but each served profile has its own
``PluginManager``, broker, and context store under ``HERMES_HOME`` (set by the
profile-prefix middleware before handlers run).

HTTP handlers resolve the named profile and materialize that profile's listener
row from the active scoped plugin manager — they do not require an earlier
``register()`` in the wiring profile alone.
"""
from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from typing import Any, Iterable, Optional, TYPE_CHECKING

from .context_store import BrowserContextStore

if TYPE_CHECKING:
    from .control_broker import ControlBroker, ControllerScope

_COMPANION_PLUGIN_ID = "hermes-browser-extension"
_SAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]+")
_PATH_PREFIX = re.compile(r"^/p/([^/]+)(?:/|$)")
_registry: dict[str, "ListenerProfile"] = {}
_lock = threading.RLock()
# Tests without Hermes may pin the served multiplex roster.
_TEST_SERVED_PROFILES: Optional[frozenset[str]] = None


def _label(value: Any, default: str) -> str:
    text = _SAFE_NAME.sub("", str(value or ""))[:64]
    return text or default


def normalize_profile(profile: str) -> str:
    return _label(profile, "default")


def set_multiplex_test_profiles(names: Optional[Iterable[str]]) -> None:
    """Pin served profile names for harnesses (not used in production)."""
    global _TEST_SERVED_PROFILES
    _TEST_SERVED_PROFILES = None if names is None else frozenset(_label(n, "") for n in names if str(n or "").strip())


@dataclass(frozen=True)
class ListenerProfile:
    profile: str
    store: Any
    broker: Any
    tools: tuple[str, ...]
    hooks: tuple[str, ...]
    version: str


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
    """Profile for the current agent turn (tool hooks, control tools)."""
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
    try:
        from hermes_cli.profiles import get_active_profile_name

        return _label(get_active_profile_name(), "default")
    except Exception:
        return "default"


def store_for_turn(**kwargs: Any) -> Optional[BrowserContextStore]:
    """The context store for this turn's profile."""
    name = resolve_turn_profile(kwargs)
    entry = get_listener_entry(name)
    if entry is None or entry.broker is None:
        entry = materialize_listener_profile(name)
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
    if request is None:
        return ""
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
    try:
        from hermes_cli.profiles import get_active_profile_name

        return _label(get_active_profile_name(), "default")
    except Exception:
        return "default"


def _profile_home_matches(name: str, request: Optional[Any]) -> bool:
    """True when the URL prefix or active ``HERMES_HOME`` is this profile."""
    if request is not None and _profile_from_request_path(request) == name:
        return True
    try:
        from hermes_cli.profiles import get_active_profile_name

        return _label(get_active_profile_name(), "default") == name
    except Exception:
        return name == "default"


def _profile_is_served(name: str) -> bool:
    if _TEST_SERVED_PROFILES is not None:
        return name in _TEST_SERVED_PROFILES
    try:
        from agent.secret_scope import is_multiplex_active
    except Exception:
        is_multiplex_active = lambda: False  # type: ignore[misc, assignment]
    try:
        if not is_multiplex_active():
            return name == "default"
        from hermes_cli.profiles import profiles_to_serve

        served = {n for n, _ in profiles_to_serve(multiplex=True)}
        return name in served
    except Exception:
        return name == "default"


def _companion_loaded_in_scope() -> bool:
    try:
        from hermes_cli.plugins import get_plugin_manager

        loaded = get_plugin_manager()._plugins.get(_COMPANION_PLUGIN_ID)  # noqa: SLF001
    except Exception:
        return False
    if loaded is None or getattr(loaded, "error", None):
        return False
    return getattr(loaded, "module", None) is not None


def materialize_listener_profile(profile: str, *, request: Optional[Any] = None) -> Optional[ListenerProfile]:
    """Build or refresh the listener row for ``profile`` under the active Hermes home."""
    name = _label(profile, "default")
    if not _profile_is_served(name):
        return None
    if not _profile_home_matches(name, request):
        return None

    with _lock:
        existing = _registry.get(name)
        if existing is not None and existing.broker is not None:
            return existing

    if not _companion_loaded_in_scope():
        try:
            from hermes_cli.plugins import discover_plugins

            discover_plugins()
        except Exception:
            pass
    if not _companion_loaded_in_scope():
        return None

    from .control_broker import get_control_broker
    from .status_route import plugin_version

    try:
        from . import HOOK_NAMES, TOOL_NAMES
    except Exception:
        return None

    broker = get_control_broker(name)
    store = ensure_context_store(name)
    register_listener_profile(
        profile=name,
        store=store,
        broker=broker,
        tools=TOOL_NAMES,
        hooks=HOOK_NAMES,
        version=plugin_version(),
    )
    with _lock:
        return _registry.get(name)


def lookup_listener_profile(request: Any) -> tuple[Optional[ListenerProfile], str]:
    name = resolve_request_profile(request)
    with _lock:
        entry = _registry.get(name)
    if entry is None or entry.broker is None:
        entry = materialize_listener_profile(name, request=request)
    return entry, name


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
