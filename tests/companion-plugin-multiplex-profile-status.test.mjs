import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Regression for #159: mirrored plugin status must name /p/<profile>/ using the
// profile scoped by Hermes middleware, not only the profile that wired routes.

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

# Real multiplex: only the default profile wires the shared api_server factory.
wired = None
ctx = Ctx("default")
module.register(ctx)
wired = ctx

registry.set_multiplex_test_profiles(["default", "work"])
registry._companion_loaded_in_scope = lambda: True

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

test('materialize_listener_profile keeps tools recorded by discovery instead of all TOOL_NAMES', () => {
  const script = `
import importlib.util, json, pathlib, sys, types

root = pathlib.Path.cwd() / "companion-plugin"
spec = importlib.util.spec_from_file_location(
    "probe_plugin", root / "__init__.py", submodule_search_locations=[str(root)])
module = importlib.util.module_from_spec(spec)
module.__package__ = "probe_plugin"
sys.modules["probe_plugin"] = module
spec.loader.exec_module(module)
registry = sys.modules["probe_plugin.profile_registry"]
broker_mod = sys.modules["probe_plugin.control_broker"]
tools = module.TOOL_NAMES

discovered_tools = tuple(name for name in tools if not name.startswith("tab_"))

registry.set_multiplex_test_profiles(["work"])
loaded = [False]
discovery_ran = [False]

hermes_cli = types.ModuleType("hermes_cli")
hermes_cli_plugins = types.ModuleType("hermes_cli.plugins")
sys.modules["hermes_cli"] = hermes_cli
sys.modules["hermes_cli.plugins"] = hermes_cli_plugins

def discover_plugins():
    discovery_ran[0] = True
    loaded[0] = True
    broker = broker_mod.get_control_broker("work")
    store = registry.ensure_context_store("work")
    registry.register_listener_profile(
        profile="work",
        store=store,
        broker=broker,
        tools=discovered_tools,
        hooks=module.HOOK_NAMES,
        version="discovered",
    )

hermes_cli_plugins.discover_plugins = discover_plugins

registry._companion_loaded_in_scope = lambda: loaded[0]

class Req:
    path = "/p/work/api/plugins/hermes-browser-extension/status"

row = registry.materialize_listener_profile("work", request=Req())
print(json.dumps({
    "discovery_ran": discovery_ran[0],
    "tool_count": len(row.tools) if row else None,
    "discovered_count": len(discovered_tools),
    "full_count": len(tools),
    "preserved": row.tools == discovered_tools if row else False,
}))
`;
  const data = runPython(script);
  assert.equal(data.discovery_ran, true);
  assert.ok(data.discovered_count < data.full_count);
  assert.equal(data.preserved, true);
  assert.equal(data.tool_count, data.discovered_count);
});
