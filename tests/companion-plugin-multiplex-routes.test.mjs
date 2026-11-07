import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function runPython(script) {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

const PRELUDE = `
import asyncio, importlib.util, json, pathlib, sys

root = pathlib.Path.cwd() / "companion-plugin"
spec = importlib.util.spec_from_file_location(
    "probe_plugin", root / "__init__.py", submodule_search_locations=[str(root)])
module = importlib.util.module_from_spec(spec)
module.__package__ = "probe_plugin"
sys.modules["probe_plugin"] = module
spec.loader.exec_module(module)
multiplex = sys.modules["probe_plugin.multiplex_routes"]

class Adapter:
    def _check_auth(self, request):
        from aiohttp import web
        if request.headers.get("Authorization") == "Bearer paired-token":
            return None
        return web.json_response({"error": {"code": "gateway_auth_failed"}}, status=401)

class PluginState:
    data_dir = None
    def get(self, key, default=None):
        return default

class Ctx:
    profile_name = "luxord"
    state = PluginState()
    def get_config(self, key, default=None):
        return default
    def register_tool(self, *a, **k): pass
    def register_hook(self, *a, **k): pass
    def register_skill(self, *a, **k): pass
    def register_platform_handler(self, platform, factory):
        self.factory = factory

ctx = Ctx()
module.register(ctx)

async def exercise(*, demote):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    app = web.Application()

    async def catchall(request):
        raise web.HTTPNotFound(text="Unknown or unconfigured profile")

    app.router.add_get("/p/{profile}/v1/models", lambda request: web.Response(text="models"))
    app.router.add_route("*", "/p/{profile}/{tail:.*}", catchall)
    ctx.factory(app, Adapter())
    if demote:
        for index in app.router._resource_index.values():
            catch = next(
                (
                    resource
                    for resource in index
                    if getattr(resource, "canonical", "") in multiplex.PROFILE_CATCHALL_CANONICALS
                ),
                None,
            )
            if catch is None:
                continue
            promoted = [
                resource
                for resource in index
                if str(getattr(resource, "canonical", "")).startswith(multiplex.PLUGIN_MULTIPLEX_PREFIX)
            ]
            if not promoted:
                continue
            pos = index.index(catch)
            for resource in promoted:
                index.remove(resource)
            index[pos + 1 : pos + 1] = promoted
            break

    status_plain = "/api/plugins/hermes-browser-extension/status"
    async with TestClient(TestServer(app)) as client:
        headers = {"Authorization": "Bearer paired-token"}
        pref = await client.get("/p/luxord" + status_plain, headers=headers)
        out = {
            "prefixed_status": pref.status,
            "pref_body": await pref.text() if pref.status != 200 else (await pref.json()).get("profile"),
        }
    return out

async def main():
    try:
        from aiohttp import web  # noqa: F401
    except ImportError:
        print(json.dumps({"skipped": True}))
        return
    fixed = await exercise(demote=False)
    broken = await exercise(demote=True)
    print(json.dumps({"fixed": fixed, "broken": broken}))

asyncio.run(main())
`;

test('multiplex mirrors win over the profile catch-all when promoted before it in the index', () => {
  const data = runPython(PRELUDE);
  if (data.skipped) return;
  assert.equal(data.fixed.prefixed_status, 200);
  assert.equal(data.fixed.pref_body, 'luxord');
  assert.equal(data.broken.prefixed_status, 404);
  assert.match(data.broken.pref_body, /Unknown or unconfigured profile/);
});
