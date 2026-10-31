import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// The companion plugin's one HTTP surface: a read-only metadata route wired into
// the API server through ctx.register_platform_handler("api_server", ...). These
// tests drive the real plugin code, and the real aiohttp router when aiohttp is
// installed. They never start a gateway or open a socket to one.

const manifest = readFileSync('companion-plugin/plugin.yaml', 'utf8');
const manifestTools = [...manifest.matchAll(/^ {2}- ((?:browser|tab)_\w+)$/gm)].map((match) => match[1]);

function runPython(script) {
  const result = spawnSync(process.env.PYTHON || 'python', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim().split('\n').pop();
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
route = sys.modules["probe_plugin.status_route"]

class Ctx:
    profile_name = "luxord"
    def __init__(self, platform_handler="queue"):
        self.tools, self.hooks, self.skills, self.factories = [], [], [], []
        self._mode = platform_handler
    def get_config(self, key, default=None):
        return default
    def register_tool(self, name, *args, **kwargs):
        self.tools.append(name)
    def register_hook(self, name, callback):
        self.hooks.append(name)
    def register_skill(self, name, path):
        self.skills.append(name)
    def __getattr__(self, name):
        if name == "register_platform_handler" and self._mode != "absent":
            def register_platform_handler(platform, factory):
                if self._mode == "refuse":
                    raise RuntimeError("ctx.register_platform_handler() cannot run in the plugin host")
                self.factories.append((platform, factory))
            return register_platform_handler
        raise AttributeError(name)
`;

test('register queues exactly one api_server factory and the payload names what register() installs', () => {
  const out = runPython(`${PRELUDE}
ctx = Ctx()
module.register(ctx)
assert [platform for platform, _ in ctx.factories] == ["api_server"], ctx.factories
payload = route.build_status(version=route.plugin_version(), profile="luxord", tools=module.TOOL_NAMES, hooks=module.HOOK_NAMES, routes=route.ROUTE_PATHS)
print(json.dumps({"tools": ctx.tools, "hooks": ctx.hooks, "skills": ctx.skills, "payload": payload,
                  "constants": [list(module.TOOL_NAMES), list(module.HOOK_NAMES)]}))
`);
  const data = JSON.parse(out);
  assert.deepEqual([...data.tools].sort(), [...manifestTools].sort());
  assert.deepEqual([...data.constants[0]].sort(), [...data.tools].sort());
  assert.deepEqual([...data.constants[1]].sort(), [...data.hooks].sort());
  assert.deepEqual(data.skills, ['hermes-browser-extension']);
  assert.deepEqual(Object.keys(data.payload).sort(), ['hooks', 'live', 'object', 'plugin', 'profile', 'routes', 'tools', 'version']);
  assert.equal(data.payload.object, 'hermes.browser_companion.status');
  assert.equal(data.payload.plugin, 'hermes-browser-extension');
  assert.equal(data.payload.live, false);
  assert.equal(data.payload.version, manifest.match(/^version:\s*(\S+)/m)[1]);
  assert.deepEqual(data.payload.routes, [
    '/api/plugins/hermes-browser-extension/actions',
    '/api/plugins/hermes-browser-extension/context',
    '/api/plugins/hermes-browser-extension/context/status',
    '/api/plugins/hermes-browser-extension/status',
  ]);
  assert.deepEqual(data.payload.tools, [...manifestTools].sort());
});

test('the route is authenticated by the API server check, read-only, and carries metadata only', () => {
  const out = runPython(`${PRELUDE}
try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
except ImportError:
    print(json.dumps({"skipped": True}))
    raise SystemExit(0)

# Real context in the store: nothing of it may reach the route.
module.STORE  # the shared store exists; the route never reads it

class Adapter:
    def _check_auth(self, request):
        if request.headers.get("Authorization") == "Bearer paired-token":
            return None
        return web.json_response({"error": {"code": "gateway_auth_failed"}}, status=401)

class RaisingAdapter:
    def _check_auth(self, request):
        raise RuntimeError("boom")

class NoCheckAdapter:
    pass

async def exercise(adapter):
    ctx = Ctx()
    module.register(ctx)
    app = web.Application()
    ctx.factories[0][1](app, adapter)
    path = "/api/plugins/hermes-browser-extension/status"
    seen = {}
    async with TestClient(TestServer(app)) as client:
        denied = await client.get(path)
        seen["anonymous"] = denied.status
        wrong = await client.get(path, headers={"Authorization": "Bearer nope"})
        seen["wrong"] = wrong.status
        ok = await client.get(path, headers={"Authorization": "Bearer paired-token"})
        seen["ok"] = ok.status
        seen["cache"] = ok.headers.get("Cache-Control")
        seen["body"] = await ok.json() if ok.status == 200 else None
        for method in ("post", "put", "patch", "delete"):
            response = await getattr(client, method)(path, headers={"Authorization": "Bearer paired-token"})
            seen[method] = response.status
        other = await client.get("/api/plugins/hermes-browser-extension/unknown", headers={"Authorization": "Bearer paired-token"})
        seen["other"] = other.status
        routes = sorted((r.method, r.resource.canonical) for r in app.router.routes())
        seen["routes"] = routes
    return seen

good = asyncio.run(exercise(Adapter()))
raising = asyncio.run(exercise(RaisingAdapter()))
nocheck = asyncio.run(exercise(NoCheckAdapter()))
print(json.dumps({"good": good, "raising": [raising["ok"], raising["anonymous"]], "nocheck": [nocheck["ok"], nocheck["anonymous"]]}))
`);
  const data = JSON.parse(out);
  if (data.skipped) return;
  assert.equal(data.good.anonymous, 401);
  assert.equal(data.good.wrong, 401);
  assert.equal(data.good.ok, 200);
  assert.equal(data.good.cache, 'no-store');
  for (const method of ['post', 'put', 'patch', 'delete']) assert.equal(data.good[method], 405, method);
  assert.equal(data.good.other, 404);
  assert.deepEqual(data.good.routes.filter(([, resource]) => resource.includes('hermes-browser-extension')).sort(), [
    ['GET', '/api/plugins/hermes-browser-extension/actions'],
    ['GET', '/api/plugins/hermes-browser-extension/context/status'],
    ['GET', '/api/plugins/hermes-browser-extension/control/ws'],
    ['GET', '/api/plugins/hermes-browser-extension/status'],
    ['HEAD', '/api/plugins/hermes-browser-extension/actions'],
    ['HEAD', '/api/plugins/hermes-browser-extension/context/status'],
    ['HEAD', '/api/plugins/hermes-browser-extension/control/ws'],
    ['HEAD', '/api/plugins/hermes-browser-extension/status'],
    ['POST', '/api/plugins/hermes-browser-extension/context'],
    ['POST', '/api/plugins/hermes-browser-extension/control/register'],
  ]); // aiohttp's add_get also answers HEAD, through the same authenticated handler
  assert.equal(data.good.body.profile, 'luxord');
  assert.equal(data.good.body.live, false);
  assert.deepEqual(Object.keys(data.good.body).sort(), ['hooks', 'live', 'object', 'plugin', 'profile', 'routes', 'tools', 'version']);
  // An auth check that raises, or an adapter without one, fails closed.
  assert.deepEqual(data.raising, [401, 401]);
  assert.deepEqual(data.nocheck, [401, 401]);
});

test('the route never reads the context store, a session, a turn or a secret', () => {
  const source = readFileSync('companion-plugin/status_route.py', 'utf8');
  const code = source.replace(/"""[\s\S]*?"""/g, '').replace(/#.*$/gm, '');
  assert.doesNotMatch(code, /context_store|journal|session_id|turn_id|task_id|environ|getenv|secret/i);
  // The context store's STORE constant, by case: the "no-store" cache header is fine.
  assert.doesNotMatch(code, /\bSTORE\b/);
  // The only file it reads is its own manifest.
  assert.equal([...code.matchAll(/read_text\(/g)].length, 1);
  assert.match(code, /plugin\.yaml/);
});

test('a runtime that refuses the seam (plugin host isolation) still loads every tool, hook and skill', () => {
  const out = runPython(`${PRELUDE}
ctx = Ctx(platform_handler="refuse")
module.register(ctx)
print(json.dumps({"tools": len(ctx.tools), "hooks": ctx.hooks, "skills": ctx.skills, "factories": len(ctx.factories)}))
`);
  const data = JSON.parse(out);
  assert.equal(data.tools, 27);
  assert.deepEqual(data.hooks, ['pre_llm_call', 'pre_tool_call', 'post_tool_call']);
  assert.deepEqual(data.skills, ['hermes-browser-extension']);
  assert.equal(data.factories, 0);
});

test('a context without the seam, or a listener without a router, registers nothing and raises nothing', () => {
  const out = runPython(`${PRELUDE}
ctx = Ctx(platform_handler="absent")
module.register(ctx)
assert route.register_status_route(ctx, tools=[], hooks=[]) is False

queued = Ctx()
module.register(queued)
wire = queued.factories[0][1]
wire(None, object())            # no native app (another platform's shape)
wire(object(), object())        # a native without a router
print(json.dumps({"tools": len(ctx.tools)}))
`);
  assert.equal(JSON.parse(out).tools, 27);
});

test('profile and version labels are bounded to a safe alphabet', () => {
  const out = runPython(`${PRELUDE}
bad = route.build_status(version="1.2.3 <script>", profile="../../etc passwd\\n" + "x" * 200, tools=["b", "a", "a"], hooks=[])
print(json.dumps(bad))
`);
  const data = JSON.parse(out);
  assert.match(data.profile, /^[A-Za-z0-9_.-]{1,64}$/);
  assert.match(data.version, /^[A-Za-z0-9_.-]{1,64}$/);
  assert.deepEqual(data.tools, ['a', 'b']);
});
