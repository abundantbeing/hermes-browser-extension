"""Register companion plugin API routes under /p/{profile}/ for multiplex gateways.

Hermes mirrors native API paths on the default listener with
``/p/{profile}<path>``, but ``register_platform_handler`` factories add only the
plain path. Named-profile HTTP paths that miss those mirrors fall through to
``dispatch_profile_ingress`` and answer 404. Duplicate each multiplex-eligible
route on the listener app unless that path is already registered (for a future
Hermes that mirrors plugin routes itself).
"""
from __future__ import annotations

from typing import Any, Callable, Iterable

MULTIPLEX_PROFILE_PARAM = "/p/{profile}"


def multiplex_path(path: str) -> str:
    normalized = path if path.startswith("/") else f"/{path}"
    return f"{MULTIPLEX_PROFILE_PARAM}{normalized}"


def _should_mirror(path: str) -> bool:
    # Listener-scoped bot roster and avatars stay on the unprefixed path only.
    marker = "/api/plugins/hermes-browser-extension/profiles"
    return not (path == marker or path.startswith(marker + "/"))


def documented_listener_paths(paths: Iterable[str]) -> list[str]:
    seen: dict[str, None] = {}
    for path in paths:
        seen[str(path)] = None
        if _should_mirror(path):
            seen[multiplex_path(str(path))] = None
    return sorted(seen)


def _existing_canonical_paths(router: Any) -> set[str]:
    paths: set[str] = set()
    try:
        for route in router.routes():
            resource = getattr(route, "resource", None)
            canonical = getattr(resource, "canonical", None) if resource is not None else None
            if canonical:
                paths.add(str(canonical))
    except Exception:
        return paths
    return paths


def _add_route(router: Any, path: str, adder: Callable[..., Any], handler: Any) -> None:
    if path in _existing_canonical_paths(router):
        return
    adder(path, handler)


def add_get_listener_routes(router: Any, path: str, handler: Any) -> None:
    add_get = getattr(router, "add_get", None)
    if not callable(add_get):
        return
    _add_route(router, path, add_get, handler)
    if _should_mirror(path):
        _add_route(router, multiplex_path(path), add_get, handler)


def add_post_listener_routes(router: Any, path: str, handler: Any) -> None:
    add_post = getattr(router, "add_post", None)
    if not callable(add_post):
        return
    _add_route(router, path, add_post, handler)
    if _should_mirror(path):
        _add_route(router, multiplex_path(path), add_post, handler)
