"""Per-profile plugin state: the context store, control broker and listed tools.

Hermes runs ``register()`` once per profile (``ctx.profile_name``). Each run
records its profile's row here, and the routes it wires look up that row by the
same name. Rows are only ever created by ``register()``, never from a request.
"""
from __future__ import annotations

import hashlib
import re
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional, TYPE_CHECKING

from .context_store import BrowserContextStore

if TYPE_CHECKING:
    from .control_broker import ControlBroker, ControllerScope

_SAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]+")
_registry: dict[str, "ListenerProfile"] = {}
_lock = threading.RLock()


def _label(value: Any, default: str) -> str:
    text = _SAFE_NAME.sub("", str(value or ""))[:64]
    return text or default


def normalize_profile(profile: str) -> str:
    return _label(profile, "default")


def _listener_key(profile: str) -> str:
    """Registry row for this profile in the active Hermes home (multiplex names are unique)."""
    name = _label(profile, "default")
    try:
        from hermes_constants import get_hermes_home

        return f"{name}\x00{get_hermes_home().resolve()}"
    except Exception:
        return name


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
    key = _listener_key(name)
    with _lock:
        _registry[key] = ListenerProfile(
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
        return _registry.get(_listener_key(_label(name, "default")))


def ensure_context_store(profile: str) -> BrowserContextStore:
    """Return the per-profile store, creating the registry row before ``register()`` finishes if needed."""
    name = _label(profile, "default")
    key = _listener_key(name)
    with _lock:
        existing = _registry.get(key)
        if existing is not None:
            return existing.store
        store = BrowserContextStore()
        _registry[key] = ListenerProfile(
            profile=name,
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
    """The context store for this turn's profile under the active Hermes scope."""
    entry = get_listener_entry(resolve_turn_profile(kwargs))
    return entry.store if entry is not None else None


def lookup_listener_profile(profile: str) -> tuple[Optional[ListenerProfile], str]:
    """The registered row for the profile whose ``register()`` wired the calling route."""
    name = _label(profile, "default")
    with _lock:
        entry = _registry.get(_listener_key(name))
    if entry is None or entry.broker is None:
        return None, name
    return entry, name


def consume_control_ticket(value: str) -> tuple["ControlBroker", "ControllerScope"]:
    """Find the profile broker that minted this ticket and consume it once there."""
    from .control_broker import TicketInvalid, iter_control_brokers

    for broker in iter_control_brokers():
        try:
            scope = broker.consume_ticket(value)
            return broker, scope
        except TicketInvalid:
            continue
    raise TicketInvalid("unknown ticket")


# Directory-plugin reloads must not split the listener registry across module copies.
def _plugin_home_scope() -> str:
    """The Hermes-home slice of this load's plugin package name."""
    package = __package__ or ""
    if package.startswith("hermes_plugins."):
        slug = package.split(".", 1)[1]
    else:
        slug = package or __name__.rpartition(".")[0] or "default"
    if "__home_" in slug:
        return slug
    if "__profile_" in slug:
        return slug.split("__profile_", 1)[0]
    return slug


_SHARED_MODULE_KEY = f"_hermes_browser_extension_shared_profile_registry.{_plugin_home_scope()}"
_SOURCE_DIGEST = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()

_shared_mod = sys.modules.get(_SHARED_MODULE_KEY)
if _shared_mod is not None and getattr(_shared_mod, "_SOURCE_DIGEST", None) == _SOURCE_DIGEST:
    globals().update({name: value for name, value in vars(_shared_mod).items() if not name.startswith("__")})
else:
    sys.modules[_SHARED_MODULE_KEY] = sys.modules[__name__]
del _shared_mod
