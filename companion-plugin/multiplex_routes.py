"""Register companion plugin API routes under /p/{profile}/ for multiplex gateways.

Hermes mirrors native API paths on the default listener with
``/p/{profile}<path>``, then registers the profile catch-all
``/p/{profile}/{tail:.*}``, and only then calls ``register_platform_handler``
factories (v0.22.5 and v0.23.0). The shared listener router keeps multiplex routes that share an
index bucket in registration order, so plugin mirrors appended after the
catch-all lose to it. Register mirrors after wiring, then move them before the
catch-all in the router index.
"""
from __future__ import annotations

from typing import Any, Callable, Iterable

MULTIPLEX_PROFILE_PARAM = "/p/{profile}"
# The router normalizes ``{tail:.*}`` to ``{tail}`` in canonical paths.
PROFILE_CATCHALL_CANONICALS = frozenset({"/p/{profile}/{tail:.*}", "/p/{profile}/{tail}"})
PLUGIN_MULTIPLEX_PREFIX = "/p/{profile}/api/plugins/hermes-browser-extension"


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


def _resource_canonical(resource: Any) -> str:
    return str(getattr(resource, "canonical", "") or "")


def promote_multiplex_plugin_routes(router: Any) -> None:
    """Place plugin ``/p/{profile}/api/plugins/...`` resources before Hermes' catch-all.

    Idempotent: safe to call when no catch-all is present (single-profile gateways).
    """
    index = getattr(router, "_resource_index", None)
    if not isinstance(index, dict):
        return
    for resources in list(index.values()):
        if not resources:
            continue
        try:
            catch_pos = next(
                index
                for index, resource in enumerate(resources)
                if _resource_canonical(resource) in PROFILE_CATCHALL_CANONICALS
            )
        except StopIteration:
            continue
        catchall = resources[catch_pos]
        promoted = [
            resource
            for resource in resources
            if _resource_canonical(resource).startswith(PLUGIN_MULTIPLEX_PREFIX)
        ]
        if not promoted:
            continue
        promoted_set = set(promoted)
        before = [resource for resource in resources[:catch_pos] if resource not in promoted_set]
        after = [resource for resource in resources[catch_pos + 1 :] if resource not in promoted_set]
        resources[:] = before + promoted + [catchall] + after
