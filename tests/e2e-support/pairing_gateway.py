"""A throwaway gateway that serves only the pairing routes, using the real
hermes-agent handlers, middleware and approval page.

usage: python -I pairing_gateway.py <hermes-agent checkout> [cors origin ...]

It listens on a free 127.0.0.1 port (never 8642), keeps its pairing state in a
temporary HERMES_HOME, and prints one JSON line, {"port": N}, once it is up.
Used by tests/e2e-pairing-in-panel.mjs when HERMES_AGENT_CHECKOUT is set, so the
screenshots show the gateway's own page and the headers it really sends.
"""
import asyncio
import json
import os
import sys
import tempfile


async def main(checkout: str, cors_origins: list[str]) -> None:
    sys.path.insert(0, checkout)
    os.environ["HERMES_HOME"] = tempfile.mkdtemp(prefix="hbe-pairing-gateway-")
    from aiohttp import web

    from gateway.config import PlatformConfig
    from gateway.platforms.api_server import (
        APIServerAdapter,
        cors_middleware,
        security_headers_middleware,
    )

    adapter = APIServerAdapter(PlatformConfig(enabled=True))
    adapter._cors_origins = tuple(cors_origins)
    app = web.Application(middlewares=[cors_middleware, security_headers_middleware])
    app["api_server_adapter"] = adapter
    base = "/api/browser-extension/pair"
    app.router.add_post(f"{base}/start", adapter._handle_browser_pair_start)
    app.router.add_get(f"{base}/approve/{{pairing_id}}", adapter._handle_browser_pair_approve)
    app.router.add_post(f"{base}/grant/{{pairing_id}}", adapter._handle_browser_pair_grant)
    app.router.add_post(f"{base}/deny/{{pairing_id}}", adapter._handle_browser_pair_deny)
    app.router.add_get(f"{base}/status/{{pairing_id}}", adapter._handle_browser_pair_status)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    print(json.dumps({"port": port}), flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2:]))
