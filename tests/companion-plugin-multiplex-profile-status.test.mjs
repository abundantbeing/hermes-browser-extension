import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Regression for #159 round 2: mirrored plugin status must name the /p/<profile>/
// listener profile, not the first profile that wired the shared factory (00f38685).

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

root = pathlib.Path.cwd() / "companion-plugin"
spec = importlib.util.spec_from_file_location(
    "probe_plugin", root / "__init__.py", submodule_search_locations=[str(root)])
module = importlib.util.module_from_spec(spec)
module.__package__ = "probe_plugin"
sys.modules["probe_plugin"] = module
spec.loader.exec_module(module)
registry = sys.modules["probe_plugin.profile_registry"]
broker_mod = sys.modules["probe_plugin.control_broker"]

class Adapter:
    def _check_auth(self, request):
        from aiohttp import web
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

wired = None
for name in ("default", "work"):
    ctx = Ctx(name)
    module.register(ctx)
    wired = ctx

async def main():
    try:
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer
    except ImportError:
        print(json.dumps({"skipped": True}))
        return
    app = web.Application()
    wired.factories[0][1](app, Adapter())
    status = "/api/plugins/hermes-browser-extension/status"
    headers = {"Authorization": "Bearer paired-token"}
    async with TestClient(TestServer(app)) as client:
        work = await client.get("/p/work" + status, headers=headers)
        ghost = await client.get("/p/ghost" + status, headers=headers)
        out = {
            "work_status": work.status,
            "work_profile": (await work.json()).get("profile") if work.status == 200 else None,
            "ghost_status": ghost.status,
            "ghost_code": (await ghost.json()).get("error", {}).get("code") if ghost.status != 200 else None,
        }
    print(json.dumps(out))

asyncio.run(main())
`;

test('multiplex status names the requested profile and refuses unknown profiles', () => {
  const data = runPython(SCRIPT);
  if (data.skipped) return;
  assert.equal(data.work_status, 200);
  assert.equal(data.work_profile, 'work');
  assert.equal(data.ghost_status, 503);
  assert.equal(data.ghost_code, 'companion_profile_unavailable');
});
