"""One read-only readiness route for the Hermes Browser extension.

The extension needs to know whether this plugin is loaded for the profile that
serves its connection. Hermes does not advertise plugins in /v1/capabilities,
so the plugin answers for itself on the API server the extension already talks
to, through the documented ``ctx.register_platform_handler("api_server", ...)``
seam (the factory receives the listener's aiohttp ``web.Application`` before its
router freezes).

What it serves, and nothing else::

    GET /api/plugins/hermes-browser-companion/status
    {"object": "hermes.browser_companion.status", "plugin": "...",
     "version": "...", "profile": "...", "tools": [...], "hooks": [...],
     "routes": [...], "live": false}

Metadata only: names, a version and the profile. No context, no session or turn
id, no page data, no secret, no side effect. The route reuses the API server's
own request authentication (its paired loopback token or API key) through the
adapter the factory is handed; if that check is not available the route
refuses, it never answers unauthenticated.

Limits worth knowing: the factory runs in the gateway process at connect time,
so the route exists after the gateway restarts with the plugin enabled (a
plugin loaded later is wired too late for aiohttp's frozen router and is
logged, not fatal). Under ``plugins.isolation: host`` Hermes refuses
``register_platform_handler``; registration then skips the route and the tools
and hooks still load.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Callable, Iterable

logger = logging.getLogger(__name__)

PLUGIN_NAME = "hermes-browser-companion"
ROUTE_PATH = f"/api/plugins/{PLUGIN_NAME}/status"
STATUS_OBJECT = "hermes.browser_companion.status"
PLATFORM = "api_server"

_SAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]+")


def plugin_version(root: Path | None = None) -> str:
    """The ``version`` of the installed ``plugin.yaml`` (no YAML parser needed)."""
    base = root or Path(__file__).resolve().parent
    try:
        text = (base / "plugin.yaml").read_text(encoding="utf-8")
    except OSError:
        return "unknown"
    match = re.search(r"^version:\s*['\"]?([^\s'\"#]+)", text, re.MULTILINE)
    return match.group(1) if match else "unknown"


def _label(value: Any, default: str) -> str:
    text = _SAFE_NAME.sub("", str(value or ""))[:64]
    return text or default


def build_status(
    *,
    version: str,
    profile: str,
    tools: Iterable[str],
    hooks: Iterable[str],
) -> dict[str, Any]:
    """The whole response body. Everything in it is static for the process."""
    return {
        "object": STATUS_OBJECT,
        "plugin": PLUGIN_NAME,
        "version": _label(version, "unknown"),
        "profile": _label(profile, "default"),
        "tools": sorted({str(name) for name in tools}),
        "hooks": sorted({str(name) for name in hooks}),
        "routes": [ROUTE_PATH],
        "live": False,
    }


def make_handler(adapter: Any, payload: dict[str, Any]) -> Callable[..., Any]:
    """The aiohttp handler. Authenticates with the API server's own check."""

    async def handler(request):
        from aiohttp import web

        def refuse() -> Any:
            return web.json_response(
                {"error": {"message": "Not authorized", "type": "gateway_auth_error", "code": "gateway_auth_failed"}},
                status=401,
                headers={"Cache-Control": "no-store"},
            )

        check = getattr(adapter, "_check_auth", None)
        if not callable(check):
            return refuse()
        try:
            denied = check(request)
        except Exception:  # fail closed on any auth-check failure
            logger.debug("companion status route: auth check raised", exc_info=True)
            return refuse()
        if denied is not None:
            return denied
        return web.json_response(payload, headers={"Cache-Control": "no-store"})

    return handler


def register_status_route(
    ctx: Any,
    *,
    tools: Iterable[str],
    hooks: Iterable[str],
    version: str | None = None,
) -> bool:
    """Ask Hermes to wire the status route into the API server. Never raises.

    Returns True when the factory was queued. A context without the seam, or one
    that refuses it (plugin host isolation), leaves the plugin working without
    the route.
    """
    register = getattr(ctx, "register_platform_handler", None)
    if not callable(register):
        return False
    try:
        profile = getattr(ctx, "profile_name", "default")
    except Exception:
        profile = "default"
    payload = build_status(
        version=version or plugin_version(),
        profile=profile,
        tools=tools,
        hooks=hooks,
    )

    def wire(native, adapter) -> None:
        router = getattr(native, "router", None)
        add_get = getattr(router, "add_get", None)
        if not callable(add_get):
            return
        add_get(ROUTE_PATH, make_handler(adapter, payload))

    try:
        register(PLATFORM, wire)
    except Exception as exc:  # e.g. PluginHostUnsupported under plugins.isolation: host
        logger.info("%s: status route not registered (%s)", PLUGIN_NAME, exc)
        return False
    return True
