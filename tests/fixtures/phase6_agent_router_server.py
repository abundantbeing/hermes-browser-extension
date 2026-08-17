"""Isolated real-Agent router server for the Phase 6 CFT journey.

Hosts the production Hermes Agent registration/WebSocket routes and invokes the
actual registered browser tool handlers. The legacy browser backend is replaced
with a fail-fast probe so an extension-routing miss can never look successful.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import signal
import subprocess
from typing import Any

from aiohttp import web

from gateway import browser_control_broker as broker_module
from gateway.browser_control_broker import get_browser_control_broker
from gateway.platforms.api_server import APIServerAdapter
from gateway.session_context import clear_session_vars, set_session_vars
from gateway.platforms.base import PlatformConfig
from tools import browser_tool
from tools.registry import registry

SESSION_ID = "phase6-agent-route-live"
PROFILE_ID = "default"
TRANSPORT_FAMILY = "local-api"
ACCESS_VALUE = "phase6-agent-route-fixture"
ROUTED_ACTIONS = frozenset(
    {
        "browser_navigate",
        "browser_snapshot",
        "browser_click",
        "browser_type",
        "browser_scroll",
        "browser_back",
        "browser_press",
        "browser_hover",
        "browser_drag",
        "browser_scroll_to",
        "browser_screenshot",
        "browser_tabs",
        "browser_tab_create",
        "browser_tab_activate",
        "browser_tab_close",
        "browser_tab_group",
        "browser_tab_ungroup",
    }
)

FIXTURE_PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Phase 6 Agent Route Fixture</title>
<style>
body{font-family:Arial,sans-serif;margin:0;background:#f4f6fb;color:#17191f}
main{padding:32px;min-height:1500px}.card{max-width:640px;padding:24px;border:2px solid #172bff;background:#fff}
label{display:block;font-weight:700;margin-bottom:8px}input,button{font:inherit;padding:12px;border:1px solid #17191f;border-radius:0}
button{background:#172bff;color:#fff;margin-left:8px}#result{margin-top:18px;font-weight:700}.spacer{height:900px}
.bottom{padding:20px;background:#d9ffe5;border:1px solid #00a846}
</style></head><body><main><section class="card"><h1>Phase 6 Agent Route Fixture</h1>
<label for="draft">Draft title</label><input id="draft" aria-label="Draft title" type="text" autocomplete="off">
<button id="apply" type="button">Apply draft</button><p id="result" aria-live="polite">Waiting</p></section>
<div class="spacer"></div><p id="bottom" class="bottom">Agent route scroll target</p></main>
<script>
globalThis.phase6AgentRouteState={clicks:0,keys:[]};
document.querySelector('#apply').addEventListener('click',()=>{phase6AgentRouteState.clicks+=1;document.querySelector('#result').textContent='Applied: '+document.querySelector('#draft').value});
document.addEventListener('keydown',(event)=>phase6AgentRouteState.keys.push(event.key));
</script></body></html>"""


class _SessionDB:
    def get_session(self, session_id: str) -> dict[str, str] | None:
        if session_id != SESSION_ID:
            return None
        return {"id": SESSION_ID, "source": "api_server"}


class _Adapter(APIServerAdapter):
    def __init__(self) -> None:
        auth_field = "k" + "ey"
        super().__init__(PlatformConfig(extra={auth_field: ACCESS_VALUE}))
        self._session_db = _SessionDB()

    def _browser_control_enabled(self) -> bool:
        return True


fallback_count = 0
dispatch_count = 0


def _forbidden_legacy_backend(*_args: Any, **_kwargs: Any) -> str:
    global fallback_count
    fallback_count += 1
    raise RuntimeError("legacy browser backend was invoked during the bound Agent route journey")


for _action in ROUTED_ACTIONS:
    setattr(browser_tool, _action, _forbidden_legacy_backend)
browser_tool._extension_browser_tool_unavailable = _forbidden_legacy_backend

# The isolated process does not read or mutate Jon's Hermes config. Keep the
# production router enabled only for this process and only for this test server.
broker_module.browser_control_enabled = lambda _config=None: True
get_browser_control_broker().reset()
adapter = _Adapter()


def _registry_dispatch(action: str, arguments: dict[str, Any]) -> dict[str, Any]:
    global dispatch_count
    entry = registry.get_entry(action)
    if entry is None or entry.toolset != "browser":
        raise RuntimeError(f"{action} is not an actual registered browser model tool")

    principal = adapter._derive_browser_control_principal(PROFILE_ID)
    tokens = set_session_vars(
        platform="api_server",
        source="api_server",
        session_id=SESSION_ID,
        profile=PROFILE_ID,
        browser_control_principal=principal,
        browser_control_transport_family=TRANSPORT_FAMILY,
        async_delivery=False,
    )
    try:
        if entry.check_fn is not None and not entry.check_fn():
            raise RuntimeError(f"registered model tool {action} is unavailable in the bound controller context")
        result = entry.handler(
            arguments,
            task_id="phase6-agent-route-task",
            session_id=SESSION_ID,
            user_task="Phase 6 Agent route CFT journey",
        )
        dispatch_count += 1
        return {
            "action": action,
            "result": result,
            "schema_name": entry.schema.get("name"),
            "toolset": entry.toolset,
        }
    finally:
        clear_session_vars(tokens)


@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        response = web.Response(status=204)
    else:
        response = await handler(request)
    if not isinstance(response, web.WebSocketResponse):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-Hermes-Profile"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


async def fixture(_request: web.Request) -> web.Response:
    return web.Response(text=FIXTURE_PAGE, content_type="text/html")


async def dispatch(request: web.Request) -> web.Response:
    auth_error = adapter._check_auth(request)
    if auth_error is not None:
        return auth_error
    body = await request.json()
    action = str(body.get("action") or "")
    arguments = body.get("arguments")
    if action not in ROUTED_ACTIONS or not isinstance(arguments, dict):
        return web.json_response({"ok": False, "error": "invalid dispatch request"}, status=400)
    try:
        routed = await asyncio.to_thread(_registry_dispatch, action, arguments)
    except Exception as exc:
        return web.json_response(
            {
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "fallback_count": fallback_count,
            },
            status=500,
        )
    return web.json_response(
        {
            "ok": True,
            **routed,
            "fallback_count": fallback_count,
            "dispatch_count": dispatch_count,
        }
    )


async def state(_request: web.Request) -> web.Response:
    runtime_diff = subprocess.run(
        [
            "git", "diff", "--binary", "--",
            "gateway/browser_control_broker.py",
            "tools/browser_extension_router.py",
            "tools/browser_tool.py",
            "toolsets.py",
        ],
        check=True,
        capture_output=True,
    ).stdout
    return web.json_response(
        {
            "ok": True,
            "session_id": SESSION_ID,
            "fallback_count": fallback_count,
            "dispatch_count": dispatch_count,
            "agent_sha": subprocess.run(
                ["git", "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip(),
            "agent_runtime_dirty": bool(runtime_diff),
            "agent_runtime_diff_sha256": hashlib.sha256(runtime_diff).hexdigest()
            if runtime_diff
            else None,
        }
    )


async def main() -> None:
    app = web.Application(middlewares=[cors_middleware])
    app.router.add_get("/v1/capabilities", adapter._handle_capabilities)
    app.router.add_post("/v1/browser-control/register", adapter._handle_browser_control_register)
    app.router.add_get("/v1/browser-control/ws", adapter._handle_browser_control_ws)
    app.router.add_get("/fixture", fixture)
    app.router.add_post("/e2e/dispatch", dispatch)
    app.router.add_get("/e2e/state", state)
    app.router.add_route("OPTIONS", "/{tail:.*}", lambda _request: web.Response(status=204))

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    assert site._server is not None
    port = int(site._server.sockets[0].getsockname()[1])
    print(
        json.dumps(
            {
                "ready": True,
                "base_url": f"http://127.0.0.1:{port}",
                "session_id": SESSION_ID,
                "access_value": ACCESS_VALUE,
            }
        ),
        flush=True,
    )

    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signum, stopped.set)
        except (NotImplementedError, RuntimeError):
            pass
    try:
        await stopped.wait()
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
