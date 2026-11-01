"""Read-only, API-key-authenticated bot roster for the browser extension.

This plugin route supplements (does not replace) the Hermes API's /v1/profiles.
It is registered only on the unprefixed listener: its credential identifies the
listener, and the roster is restricted to profiles that listener actually serves.
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from .status_route import BASE_PATH, authorize

logger = logging.getLogger(__name__)
ROSTER_PATH = f"{BASE_PATH}/profiles"
AVATAR_PATH = f"{ROSTER_PATH}/{{name}}/avatar"
ROUTE_PATHS = (ROSTER_PATH, AVATAR_PATH)
MAX_PROFILES = 1000
MAX_AVATAR = 2_000_000
MAX_METADATA = 65_536
AVATAR_TYPES = (("png", "image/png"), ("jpg", "image/jpeg"), ("webp", "image/webp"))


def _served_profiles(adapter):
    from hermes_cli.profiles import profiles_to_serve
    runner = getattr(adapter, "gateway_runner", None)
    multiplex = bool(getattr(getattr(runner, "config", None), "multiplex_profiles", False))
    return {name: Path(home) for name, home in profiles_to_serve(multiplex=multiplex)}


def _list_profiles():
    from hermes_cli.profiles import list_profiles
    return list_profiles(lazy_skill_count=True)


def _inside(home, path):
    try:
        return path.resolve().is_relative_to(home.resolve())
    except OSError:
        return False


def _avatar(home):
    for extension, mime in AVATAR_TYPES:
        path = home / "assets" / f"avatar.{extension}"
        if _inside(home, path) and path.is_file():
            return path, mime
    return None


def _bot_metadata(home):
    """Expose only the bot presentation fields, never arbitrary plugin metadata."""
    path = home / "profile.yaml"
    try:
        if not _inside(home, path) or not path.is_file() or path.stat().st_size > MAX_METADATA:
            return {}, {}
        import hermes_yaml as yaml
        data = yaml.safe_load(path.read_text(encoding="utf-8-sig")) or {}
        meta = data.get("ui_meta", {}) if isinstance(data, dict) else {}
        bot = meta.get("hermes-bots", {}) if isinstance(meta, dict) else {}
        bot = bot if isinstance(bot, dict) else {}
        clean = {key: value for key, value in bot.items()
                 if key in ("title", "shape", "color", "image") and isinstance(value, str)}
        if len(json.dumps(clean).encode("utf-8")) > MAX_METADATA:
            clean.pop("image", None)
        if len(json.dumps(clean).encode("utf-8")) > MAX_METADATA:
            clean = {}
        revisions = data.get("_ui_meta_revisions", {}) if isinstance(data, dict) else {}
        rev = revisions.get("hermes-bots") if isinstance(revisions, dict) else None
        return ({"hermes-bots": clean} if clean else {},
                {"hermes-bots": max(0, rev)} if type(rev) is int else {})
    except Exception:
        logger.debug("Cannot read bot presentation metadata", exc_info=True)
        return {}, {}


def _build_roster(adapter):
    served = _served_profiles(adapter)
    rows = []
    for info in _list_profiles():
        home = served.get(info.name)
        if home is None:
            continue
        meta, revisions = _bot_metadata(home)
        rows.append({
            "name": info.name, "is_default": bool(info.is_default),
            "model": info.model or "", "provider": info.provider or "",
            "description": info.description or "", "display_name": info.display_name or "",
            "skill_count": int(info.skill_count or 0), "has_avatar": _avatar(home) is not None,
            "ui_meta": meta, "ui_meta_revisions": revisions,
        })
        if len(rows) >= MAX_PROFILES:
            break
    return rows


def _denied(adapter, request):
    from aiohttp import web
    # A future Hermes may mirror plugin routes under /p/<profile>/. Never let a
    # profile key turn the listener-wide inventory into a cross-profile leak.
    path = request.path
    if path != ROSTER_PATH and not path.startswith(ROSTER_PATH + '/'):
        return web.json_response({"error": "Not found"}, status=404, headers={"Cache-Control": "no-store"})
    # The runtime's _check_auth can be a no-op without a configured key on test
    # or manually wired listeners. A roster must never use that permissive path.
    try:
        if not callable(getattr(adapter, "_expected_api_key", None)) or not adapter._expected_api_key():
            raise ValueError("No API listener key")
    except Exception:
        return web.json_response({"error": "Not authorized"}, status=401, headers={"Cache-Control": "no-store"})
    return authorize(adapter, request)


def make_wire_extra():
    def wire(router, adapter):
        from aiohttp import web

        async def profiles(request):
            denied = _denied(adapter, request)
            if denied is not None:
                return denied
            try:
                rows = await asyncio.to_thread(_build_roster, adapter)
            except Exception:
                logger.exception("Companion roster unavailable")
                return web.json_response({"error": "Profile roster unavailable"}, status=503, headers={"Cache-Control": "no-store"})
            return web.json_response({"profiles": rows}, headers={"Cache-Control": "no-store"})

        async def avatar(request):
            denied = _denied(adapter, request)
            if denied is not None:
                return denied
            def read_image():
                home = _served_profiles(adapter).get(request.match_info.get("name", ""))
                found = _avatar(home) if home is not None else None
                if not found:
                    return None
                path, mime = found
                with path.open("rb") as stream:
                    data = stream.read(MAX_AVATAR + 1)
                return (data, mime) if data and len(data) <= MAX_AVATAR else None
            try:
                found = await asyncio.to_thread(read_image)
            except Exception:
                found = None
            if not found:
                return web.json_response({"error": "Not found"}, status=404, headers={"Cache-Control": "no-store"})
            data, mime = found
            return web.Response(body=data, content_type=mime, headers={"Cache-Control": "no-store"})

        router.add_get(ROSTER_PATH, profiles)
        router.add_get(AVATAR_PATH, avatar)
    return wire
