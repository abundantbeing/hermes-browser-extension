import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function runPython(script) {
  const result = spawnSync(process.env.PYTHON || 'python', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
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

class Adapter:
    def _check_auth(self, request):
        from aiohttp import web
        if request.headers.get("Authorization") == "Bearer paired-token":
            return None
        return web.json_response({"error": {"code": "gateway_auth_failed"}}, status=401)

async def wire_app():
    try:
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer
    except ImportError:
        return {"skipped": True}
    ctx = module.register.__globals__
    class Ctx:
        profile_name = "luxord"
        state = type("S", (), {"data_dir": None})()
        def get_config(self, key, default=None):
            return default
        def register_tool(self, *a, **k): pass
        def register_hook(self, *a, **k): pass
        def register_skill(self, *a, **k): pass
        def register_platform_handler(self, platform, factory):
            self.factory = factory
    c = Ctx()
    module.register(c)
    app = web.Application()
    c.factory(app, Adapter())
    canonical = sorted({
        r.resource.canonical for r in app.router.routes()
        if getattr(getattr(r, "resource", None), "canonical", None)
    })
    out = {"canonical": canonical}
    status_plain = "/api/plugins/hermes-browser-extension/status"
    status_prefixed = "/p/{profile}/api/plugins/hermes-browser-extension/status"
    roster_prefixed = "/p/{profile}/api/plugins/hermes-browser-extension/profiles"
    async with TestClient(TestServer(app)) as client:
        ok_plain = await client.get(status_plain, headers={"Authorization": "Bearer paired-token"})
        ok_pref = await client.get("/p/namine" + status_plain, headers={"Authorization": "Bearer paired-token"})
        denied_roster = await client.get("/p/namine/api/plugins/hermes-browser-extension/profiles",
                                         headers={"Authorization": "Bearer paired-token"})
        out["plain_status"] = ok_plain.status
        out["prefixed_status"] = ok_pref.status
        out["prefixed_roster"] = denied_roster.status
        out["pref_body_profile"] = (await ok_pref.json()).get("profile") if ok_pref.status == 200 else None
    out["has"] = {
        "status_mirror": status_prefixed in canonical,
        "roster_mirror": roster_prefixed in canonical,
    }
    return out

print(json.dumps(asyncio.run(wire_app())))
`;

test('multiplex mirrors plugin routes except the listener-scoped roster', () => {
  const data = JSON.parse(runPython(PRELUDE));
  if (data.skipped) return;
  assert.equal(data.plain_status, 200);
  assert.equal(data.prefixed_status, 200, 'named profile status must not fall through to shared ingress');
  assert.equal(data.prefixed_roster, 404, 'roster stays listener-only on the plain path');
  assert.equal(data.pref_body_profile, 'luxord');
  assert.equal(data.has.status_mirror, true);
  assert.equal(data.has.roster_mirror, false);
});
