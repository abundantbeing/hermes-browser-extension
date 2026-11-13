"""Add the plugin's API-server routes to the listener router.

Routes are added once each, at their plain path, through the router's public
API. Named profiles on a multiplexed gateway reach a profile's own plugin routes
through Hermes core (``/p/<profile>/api/plugins/...``, NousResearch/hermes-agent
#147703); the plugin never adds /p/<profile> routes or reorders the router.
"""
from __future__ import annotations

from typing import Any, Callable


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


def _add_route(router: Any, method: str, path: str, handler: Any) -> None:
    adder: Callable[..., Any] | None = getattr(router, f"add_{method}", None)
    if not callable(adder) or path in _existing_canonical_paths(router):
        return
    adder(path, handler)


def add_get_route(router: Any, path: str, handler: Any) -> None:
    _add_route(router, "get", path, handler)


def add_post_route(router: Any, path: str, handler: Any) -> None:
    _add_route(router, "post", path, handler)
