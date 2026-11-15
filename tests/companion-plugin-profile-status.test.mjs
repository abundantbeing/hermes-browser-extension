import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Hermes runs register() once per profile (ctx.profile_name). Each run's routes answer
// for that profile, from the row that run recorded; a request never creates a row.

function runPython(script) {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

const SCRIPT = `
import asyncio, importlib.util, json, pathlib, sys

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
except ImportError:
    print(json.dumps({"skipped": True}))
    raise SystemExit(0)

root = pathlib.Path.cwd() / "companion-plugin"
spec = importlib.util.spec_from_file_location(
    "probe_plugin", root / "__init__.py", submodule_search_locations=[str(root)])
module = importlib.util.module_from_spec(spec)
module.__package__ = "probe_plugin"
sys.modules["probe_plugin"] = module
spec.loader.exec_module(module)
registry = sys.modules["probe_plugin.profile_registry"]
status_route = sys.modules["probe_plugin.status_route"]

class Adapter:
    def _check_auth(self, request):
        if request.headers.get("Authorization") == "Bearer paired-token":
            return None
        return web.json_response({"error": {"code": "gateway_auth_failed"}}, status=401)

class Ctx:
    def __init__(self, name):
        self.profile_name = name
        self.factories = []
    def get_config(self, key, default=None):
        return default
    def register_tool(self, *a, **k): pass
    def register_hook(self, *a, **k): pass
    def register_skill(self, *a, **k): pass
    def register_platform_handler(self, platform, factory):
        self.factories.append((platform, factory))

STATUS = "/api/plugins/hermes-browser-extension/status"
HEADERS = {"Authorization": "Bearer paired-token"}

async def ask(app):
    async with TestClient(TestServer(app)) as client:
        response = await client.get(STATUS, headers=HEADERS)
        body = await response.json()
        return response.status, body

async def main():
    out = {}
    # One app per profile, as Hermes core serves each profile's own plugin routes.
    for name in ("default", "work"):
        ctx = Ctx(name)
        module.register(ctx)
        app = web.Application()
        ctx.factories[0][1](app, Adapter())
        status, body = await ask(app)
        out[name] = {"status": status, "profile": body.get("profile")}
    # A route bound to a profile whose register() never ran answers 503 and creates nothing.
    ghost = web.Application()
    ghost.router.add_get(STATUS, status_route.make_dynamic_status_handler(
        Adapter(), tools=(), hooks=(), routes=(STATUS,), version="test", profile="ghost"))
    status, body = await ask(ghost)
    out["ghost"] = {"status": status, "code": body.get("error", {}).get("code"),
                    "row_created": registry.get_listener_entry("ghost") is not None}
    print(json.dumps(out))

asyncio.run(main())
`;

test("each profile's status route names its own profile, and an unregistered profile is refused without creating one", () => {
  const data = runPython(SCRIPT);
  if (data.skipped) return;
  assert.deepEqual(data.default, { status: 200, profile: 'default' });
  assert.deepEqual(data.work, { status: 200, profile: 'work' });
  assert.equal(data.ghost.status, 503);
  assert.equal(data.ghost.code, 'companion_profile_unavailable');
  assert.equal(data.ghost.row_created, false);
});
