import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

// Catalog rule 9: the plugin stays on public Hermes APIs. Each pattern is a private
// core surface the catalog review asked the plugin to stop using.
const FORBIDDEN = [
  [/_resource_index/, "the API server router's private route index"],
  [/promote_multiplex_plugin_routes|multiplex_routes/, 'reordering routes ahead of the /p/{profile} catch-all'],
  [/\._plugins\b/, "PluginManager's private plugin table"],
  [/_api_request_profile/, "the API server's private request-profile context variable"],
  [/\bdiscover_plugins\b/, 'plugin discovery from a request handler'],
  [/["'`]\/p\/\{profile\}/, 'plugin-added /p/{profile} routes'],
];

const pluginSources = readdirSync('companion-plugin')
  .filter((name) => name.endsWith('.py'))
  .map((name) => [name, readFileSync(`companion-plugin/${name}`, 'utf8')]);

test('the plugin uses no private Hermes route, plugin-manager or request-profile internals', () => {
  for (const [name, source] of pluginSources) {
    for (const [pattern, what] of FORBIDDEN) {
      assert.doesNotMatch(source, pattern, `${name} uses ${what}`);
    }
  }
});

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

class Adapter:
    def _check_auth(self, request):
        if request.headers.get("Authorization") == "Bearer paired-token":
            return None
        return web.json_response({"error": {"code": "gateway_auth_failed"}}, status=401)

class PluginState:
    data_dir = None
    def get(self, key, default=None):
        return default

class Ctx:
    state = PluginState()
    def __init__(self, profile):
        self.profile_name = profile
    def get_config(self, key, default=None):
        return default
    def register_tool(self, *a, **k): pass
    def register_hook(self, *a, **k): pass
    def register_skill(self, *a, **k): pass
    def register_platform_handler(self, platform, factory):
        self.factory = factory

def canonicals(app):
    return [str(getattr(route.resource, "canonical", "")) for route in app.router.routes()]

async def main():
    status = "/api/plugins/hermes-browser-extension/status"
    headers = {"Authorization": "Bearer paired-token"}
    out = {}
    for profile in ("default", "luxord"):
        ctx = Ctx(profile)
        module.register(ctx)
        # The listener as Hermes builds it: core routes, then the /p/{profile} catch-all, then plugin factories.
        app = web.Application()

        async def catchall(request):
            raise web.HTTPNotFound(text="Unknown or unconfigured profile")

        app.router.add_get("/p/{profile}/v1/models", lambda request: web.Response(text="models"))
        app.router.add_route("*", "/p/{profile}/{tail:.*}", catchall)
        before = canonicals(app)
        ctx.factory(app, Adapter())
        after = canonicals(app)
        async with TestClient(TestServer(app)) as client:
            plain = await client.get(status, headers=headers)
            prefixed = await client.get("/p/" + profile + status, headers=headers)
            out[profile] = {
                "core_order_kept": after[: len(before)] == before,
                "added": sorted(set(after[len(before):])),
                "plain": plain.status,
                "plain_profile": (await plain.json()).get("profile") if plain.status == 200 else None,
                "prefixed": prefixed.status,
            }
    print(json.dumps(out))

asyncio.run(main())
`;

test("each profile's routes are plain paths added after core's, and answer for the profile whose register() wired them", () => {
  const data = runPython(SCRIPT);
  if (data.skipped) return;
  for (const profile of ['default', 'luxord']) {
    const seen = data[profile];
    assert.equal(seen.core_order_kept, true, `${profile}: core routes keep their order`);
    assert.ok(seen.added.length > 0, `${profile}: routes were added`);
    for (const path of seen.added) assert.match(path, /^\/api\/plugins\/hermes-browser-extension\//, `${profile}: ${path}`);
    assert.equal(seen.plain, 200);
    assert.equal(seen.plain_profile, profile, 'the status route answers for its own profile');
    // A /p/<profile>/ request is core's to route (#147703); the plugin does not claim it.
    assert.equal(seen.prefixed, 404);
  }
});
