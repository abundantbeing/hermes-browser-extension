import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// The companion plugin's browser-context side channel: context status, context
// upload and the declarative actions list, wired into the API server through
// ctx.register_platform_handler("api_server", ...). These tests drive the real
// plugin code and the real aiohttp router (skipped when aiohttp is missing).
// They never start a gateway or open a socket to one.

function runPython(script, env = {}) {
  const result = spawnSync(process.env.PYTHON || 'python', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
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
hooks = sys.modules["probe_plugin.hooks"]
tools = sys.modules["probe_plugin.tools"]
routes = sys.modules["probe_plugin.context_routes"]
actions = sys.modules["probe_plugin.actions"]
store_module = sys.modules["probe_plugin.context_store"]

PAGE = "PAGE_TEXT_SENTINEL_DO_NOT_LEAK"
TOKEN = "Bearer paired-token"
BASE = "/api/plugins/hermes-browser-companion"

class Ctx:
    profile_name = "luxord"
    def __init__(self):
        self.tools, self.hooks, self.skills, self.factories = [], [], [], []
    def get_config(self, key, default=None):
        return default
    def register_tool(self, name, *args, **kwargs):
        self.tools.append(name)
    def register_hook(self, name, callback):
        self.hooks.append(name)
    def register_skill(self, name, path):
        self.skills.append(name)
    def register_platform_handler(self, platform, factory):
        self.factories.append((platform, factory))

def full_turn(page=PAGE, context_hash="a1b2c3d4e5f60789", delivery="full", text="Summarize this page."):
    browser_context = {"delivery": "full", "payload": {
        "protocol": "hermes.browser.context.v1",
        "contextScope": {"mode": "follow-active"},
        "settings": {"contextDepth": "normal", "includeTabs": False, "includePageText": True, "includeSelectedText": True, "maxTabs": 12},
        "activeTab": {"id": 1, "active": True, "title": "Docs", "url": "https://example.com/docs?token=SECRETQUERY", "favIconUrl": ""},
        "tabs": [], "selectedTabs": [],
        "pageContext": {"restricted": False, "reason": "", "selectedText": "", "text": page, "youtubeTranscript": "", "extraction": None, "siteAdapter": None, "meta": {"description": "", "language": "", "headings": []}, "pickedElement": None},
    }}
    if delivery == "reference":
        browser_context = {"delivery": "reference", "context_hash": context_hash}
    if delivery == "none":
        browser_context = {"delivery": "none", "mode": "chat-only"}
    return json.dumps({
        "protocol": "hermes.browser.turn.v2",
        "human_input": {"source": "composer", "text": text},
        "browser_context": browser_context,
        "attachment_context": {"items": []},
        "source_receipt": {"protocol": "hermes.browser.turn.v2", "version": 2, "context_hash": context_hash if delivery != "none" else "", "delivery": delivery},
    })

def ids(session="sess-A", turn="turn-1", task="task-1"):
    return {"session_id": session, "turn_id": turn, "task_id": task}

class Adapter:
    def _check_auth(self, request):
        from aiohttp import web
        if request.headers.get("Authorization") == TOKEN:
            return None
        return web.json_response({"error": {"code": "gateway_auth_failed"}}, status=401)

async def served(adapter=None):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    ctx = Ctx()
    module.register(ctx)
    app = web.Application()
    ctx.factories[0][1](app, adapter or Adapter())
    return TestClient(TestServer(app)), ctx

AUTH = {"Authorization": TOKEN}
`;

function aiohttpMissing(data) {
  return data && data.skipped === true;
}

const SKIP_GUARD = `
try:
    import aiohttp  # noqa: F401
except ImportError:
    print(json.dumps({"skipped": True}))
    raise SystemExit(0)
`;

test('one factory wires the three routes, each refuses without the API server auth, and the status route lists them', () => {
  const out = runPython(`${PRELUDE}${SKIP_GUARD}
class Raising:
    def _check_auth(self, request):
        raise RuntimeError("boom")
class NoCheck:
    pass

async def main():
    seen = {}
    client, ctx = await served()
    seen["factories"] = [platform for platform, _ in ctx.factories]
    async with client:
        for name, method, path in (("status", "get", BASE + "/context/status"), ("upload", "post", BASE + "/context"), ("actions", "get", BASE + "/actions")):
            anonymous = await getattr(client, method)(path, headers={"X-Hermes-Session-Id": "sess-A"})
            wrong = await getattr(client, method)(path, headers={"Authorization": "Bearer nope", "X-Hermes-Session-Id": "sess-A"})
            seen[name] = [anonymous.status, wrong.status]
        listing = await client.get(BASE + "/status", headers=AUTH)
        seen["listed"] = (await listing.json())["routes"]
    for label, adapter in (("raising", Raising()), ("nocheck", NoCheck())):
        client, _ = await served(adapter)
        async with client:
            seen[label] = [
                (await client.get(BASE + "/context/status", headers={**AUTH, "X-Hermes-Session-Id": "s"})).status,
                (await client.post(BASE + "/context", headers={**AUTH, "X-Hermes-Session-Id": "s"}, data=full_turn())).status,
                (await client.get(BASE + "/actions", headers=AUTH)).status,
            ]
    return seen

print(json.dumps(asyncio.run(main())))
`);
  const data = JSON.parse(out);
  if (aiohttpMissing(data)) return;
  assert.deepEqual(data.factories, ['api_server']);
  for (const name of ['status', 'upload', 'actions']) assert.deepEqual(data[name], [401, 401], name);
  assert.deepEqual(data.raising, [401, 401, 401]);
  assert.deepEqual(data.nocheck, [401, 401, 401]);
  assert.deepEqual(data.listed, [
    '/api/plugins/hermes-browser-companion/actions',
    '/api/plugins/hermes-browser-companion/context',
    '/api/plugins/hermes-browser-companion/context/status',
    '/api/plugins/hermes-browser-companion/status',
  ]);
});

test('an upload is validated by the hook parser, parked for its session, and answered with metadata only', () => {
  const out = runPython(`${PRELUDE}${SKIP_GUARD}
async def main():
    seen = {}
    client, ctx = await served()
    async with client:
        h = {**AUTH, "X-Hermes-Session-Id": "sess-A"}
        empty = await client.get(BASE + "/context/status", headers=h)
        seen["empty"] = await empty.json()
        nosession = await client.get(BASE + "/context/status", headers=AUTH)
        seen["nosession"] = nosession.status
        up = await client.post(BASE + "/context", headers=h, data=full_turn())
        seen["upload_status"] = up.status
        seen["upload_text"] = await up.text()
        seen["upload"] = json.loads(seen["upload_text"])
        seen["cache"] = up.headers.get("Cache-Control")
        mine = await client.get(BASE + "/context/status", headers=h)
        seen["status_text"] = await mine.text()
        seen["status"] = json.loads(seen["status_text"])
        other = await client.get(BASE + "/context/status", headers={**AUTH, "X-Hermes-Session-Id": "sess-B"})
        seen["other"] = await other.json()
        query = await client.get(BASE + "/context/status?session_id=sess-A", headers=AUTH)
        seen["query_pending"] = (await query.json())["pending_upload"]["present"]
        # refused shapes
        bad = {}
        bad["not_json"] = (await client.post(BASE + "/context", headers=h, data="not json")).status
        bad["reference"] = (await client.post(BASE + "/context", headers=h, data=full_turn(delivery="reference"))).status
        bad["chat_only"] = (await client.post(BASE + "/context", headers=h, data=full_turn(delivery="none"))).status
        bad["no_hash"] = (await client.post(BASE + "/context", headers=h, data=full_turn(context_hash=""))).status
        bad["huge"] = (await client.post(BASE + "/context", headers=h, data=full_turn(page="x" * 300_000))).status
        bad["bad_utf8"] = (await client.post(BASE + "/context", headers=h, data=b"\\xff\\xfe")).status
        bad["no_session"] = (await client.post(BASE + "/context", headers=AUTH, data=full_turn())).status
        bad["ctl_session"] = (await client.post(BASE + "/context", headers={**AUTH, "X-Hermes-Session-Id": "a\\x01b"}, data=full_turn())).status
        bad["get_on_post"] = (await client.get(BASE + "/context", headers=h)).status
        seen["bad"] = bad
        # the refused uploads did not replace the good one
        after = await client.get(BASE + "/context/status", headers=h)
        seen["after"] = await after.json()
    return seen

print(json.dumps(asyncio.run(main())))
`);
  const data = JSON.parse(out);
  if (aiohttpMissing(data)) return;
  assert.equal(data.empty.object, 'hermes.browser_companion.context_status');
  assert.equal(data.empty.held, 0);
  assert.equal(data.empty.pending_upload.present, false);
  assert.equal(data.empty.live, false);
  assert.equal(data.nosession, 400);
  assert.equal(data.upload_status, 200);
  assert.equal(data.cache, 'no-store');
  assert.equal(data.upload.object, 'hermes.browser_companion.context_upload');
  assert.equal(data.upload.stored, true);
  assert.equal(data.upload.payload_hash, 'a1b2c3d4e5f60789');
  assert.equal(data.upload.scope, 'follow-active');
  assert.equal(data.upload.adopts, 'reference-turn');
  assert.equal(data.upload.live, false);
  assert.deepEqual(Object.keys(data.upload).sort(), ['adopts', 'expires_in_ms', 'live', 'object', 'payload_hash', 'plugin', 'protocol', 'scope', 'stored']);
  assert.equal(data.status.held, 0, 'a parked upload is not a held record until a turn adopts it');
  assert.equal(data.status.pending_upload.present, true);
  assert.equal(data.status.pending_upload.payload_hash, 'a1b2c3d4e5f60789');
  assert.equal(data.other.pending_upload.present, false, 'another session sees nothing of it');
  assert.equal(data.query_pending, true);
  assert.deepEqual(data.bad, {
    not_json: 422, reference: 422, chat_only: 422, no_hash: 422, huge: 413, bad_utf8: 400, no_session: 400, ctl_session: 400, get_on_post: 405,
  });
  assert.equal(data.after.pending_upload.payload_hash, 'a1b2c3d4e5f60789');
  // Metadata only: nothing of the page, URL, title or session id leaves.
  for (const text of [data.upload_text, data.status_text]) {
    assert.doesNotMatch(text, /PAGE_TEXT_SENTINEL|SECRETQUERY|example\.com|Docs|sess-A|Summarize/);
  }
});

test('a reference turn that names the uploaded hash adopts it for its own owner, once, under the existing owner and lease rules', () => {
  const out = runPython(`${PRELUDE}
ctx = Ctx()
module.register(ctx)
store = module.STORE
import re

def notice_id(result):
    return re.search(r"context_id=([0-9a-f]{32})", result["context"]).group(1)

def get(context_id, **owner):
    args = {"context_id": context_id}
    blocked = hooks.pre_tool_call(tool_name="browser_get_context", args=args, **ids(**owner))
    if blocked is not None:
        return None
    return json.loads(tools.browser_get_context(args, session_id=owner.get("session", "sess-A"), task_id=owner.get("task", "task-1")))

seen = {}
parked = store.put_session_upload("sess-A", full_turn())
seen["parked"] = sorted(parked)
ref = full_turn(delivery="reference")

# Wrong session, wrong hash, chat-only and a full turn do not adopt.
seen["other_session"] = hooks.pre_llm_call(user_message=ref, **ids(session="sess-B"))
seen["other_hash"] = hooks.pre_llm_call(user_message=full_turn(delivery="reference", context_hash="ffffffffffffffff"), **ids())
seen["chat_only"] = hooks.pre_llm_call(user_message=full_turn(delivery="none"), **ids())
seen["plain_text"] = hooks.pre_llm_call(user_message="hello", **ids())
seen["still_pending"] = store.session_status("sess-A")["pending_upload"]["present"]

# No trusted owner: nothing is bound.
seen["no_owner"] = hooks.pre_llm_call(user_message=ref, session_id="sess-A", turn_id="", task_id="task-1")
seen["still_pending_2"] = store.session_status("sess-A")["pending_upload"]["present"]

notice = hooks.pre_llm_call(user_message=ref, **ids())
seen["adopted"] = notice is not None
context_id = notice_id(notice)
seen["pending_after"] = store.session_status("sess-A")["pending_upload"]["present"]
status = store.session_status("sess-A")
seen["held"] = status["held"]
seen["hash"] = status["payload_hash"]
seen["live"] = status["live"]

# A second reference turn finds nothing: one upload, one adoption.
seen["second"] = hooks.pre_llm_call(user_message=ref, **ids(turn="turn-2", task="task-2"))

# The owner rules are unchanged: another turn or session cannot consume this record.
seen["wrong_turn"] = get(context_id, turn="turn-9")
seen["wrong_session"] = get(context_id, session="sess-B")
got = get(context_id)
seen["got_hash"] = got["payload_hash"]
seen["got_text"] = got["payload"]["pageContext"]["text"]
seen["again"] = get(context_id)
print(json.dumps(seen))
`);
  const data = JSON.parse(out);
  assert.deepEqual(data.parked, ['available', 'created_at', 'expires_at', 'payload_hash', 'protocol', 'scope']);
  assert.equal(data.other_session, null);
  assert.equal(data.other_hash, null);
  assert.equal(data.chat_only, null);
  assert.equal(data.plain_text, null);
  assert.equal(data.still_pending, true);
  assert.equal(data.no_owner, null);
  assert.equal(data.still_pending_2, true);
  assert.equal(data.adopted, true);
  assert.equal(data.pending_after, false);
  assert.equal(data.held, 1);
  assert.equal(data.hash, 'a1b2c3d4e5f60789');
  assert.equal(data.live, false);
  assert.equal(data.second, null);
  assert.equal(data.wrong_turn, null);
  assert.equal(data.wrong_session, null);
  assert.equal(data.got_hash, 'a1b2c3d4e5f60789');
  assert.equal(data.got_text, 'PAGE_TEXT_SENTINEL_DO_NOT_LEAK');
  assert.equal(data.again, null);
});

test('a waiting upload expires with the stored-record lifetime and one session holds one slot', () => {
  const out = runPython(`${PRELUDE}
clock = [1000.0]
store = store_module.BrowserContextStore(clock=lambda: clock[0], max_upload_sessions=2)
owner = store_module.ContextOwner("session:s1", "s1", "t1", "k1")
seen = {}
store.put_session_upload("s1", full_turn(context_hash="1111111111111111"))
store.put_session_upload("s1", full_turn(context_hash="2222222222222222"))  # replaces, never stacks
seen["replaced"] = store.session_status("s1")["pending_upload"]["payload_hash"]
store.put_session_upload("s2", full_turn())
store.put_session_upload("s3", full_turn())  # the oldest session's slot is dropped
seen["evicted"] = store.session_status("s1")["pending_upload"]["present"]
seen["kept"] = store.session_status("s3")["pending_upload"]["present"]
clock[0] += 299
seen["alive"] = store.session_status("s3")["pending_upload"]["present"]
clock[0] += 2
seen["expired"] = store.session_status("s3")["pending_upload"]["present"]
seen["adopt_expired"] = store.adopt_upload_for_owner(full_turn(delivery="reference"), store_module.ContextOwner("session:s3", "s3", "t", "k"))["available"]
# held records: counts and ages, newest hash, never the payload
store.put_bcp_v2(full_turn(context_hash="3333333333333333"), owner)
clock[0] += 10
store.put_bcp_v2(full_turn(context_hash="4444444444444444"), owner)
clock[0] += 5
status = store.session_status("s1")
seen["status"] = status
seen["blank_session"] = store.session_status("")["held"]
print(json.dumps(seen))
`);
  const data = JSON.parse(out);
  assert.equal(data.replaced, '2222222222222222');
  assert.equal(data.evicted, false);
  assert.equal(data.kept, true);
  assert.equal(data.alive, true);
  assert.equal(data.expired, false);
  assert.equal(data.adopt_expired, false);
  assert.equal(data.status.held, 2);
  assert.equal(data.status.payload_hash, '4444444444444444');
  assert.equal(data.status.newest_age_ms, 5000);
  assert.equal(data.status.oldest_age_ms, 15000);
  assert.equal(data.status.live, false);
  assert.equal(data.blank_session, 0);
  assert.doesNotMatch(JSON.stringify(data.status), /PAGE_TEXT_SENTINEL|example\.com/);
});

test('the actions route lists safe actions as declarative descriptors and runs nothing', () => {
  const out = runPython(`${PRELUDE}${SKIP_GUARD}
async def main():
    client, ctx = await served()
    async with client:
        listed = await client.get(BASE + "/actions", headers=AUTH)
        body = await listed.json()
        runs = {}
        for method in ("post", "put", "patch", "delete"):
            runs[method] = (await getattr(client, method)(BASE + "/actions", headers=AUTH, data=json.dumps({"action": "browser_text_utility", "text": "x"}))).status
        sub = (await client.post(BASE + "/actions/browser_text_utility", headers=AUTH, data="{}")).status
    return {"body": body, "runs": runs, "sub": sub, "tools": ctx.tools, "schema": tools.SCHEMA_TEXT_UTILITY["parameters"], "safe": list(actions.SAFE_ACTION_NAMES)}

print(json.dumps(asyncio.run(main())))
`);
  const data = JSON.parse(out);
  if (aiohttpMissing(data)) return;
  assert.equal(data.body.object, 'hermes.browser_companion.actions');
  assert.equal(data.body.execution, 'none');
  assert.deepEqual(data.body.actions.map((row) => row.name), ['browser_text_utility']);
  assert.deepEqual(data.safe, ['browser_text_utility']);
  for (const row of data.body.actions) {
    assert.ok(data.tools.includes(row.name), 'every listed action is a registered tool');
    assert.equal(row.kind, 'agent-tool');
    assert.equal(row.safe, true);
    assert.equal(row.uses_model, false);
    assert.equal(row.uses_network, false);
    assert.equal(row.needs_browser_context, false);
    assert.deepEqual(row.parameters, data.schema);
  }
  // No verb runs an action, and there is no per-action route.
  assert.deepEqual(data.runs, { post: 405, put: 405, patch: 405, delete: 405 });
  assert.equal(data.sub, 404);
});

test('the owner-gated context tools are never listed as actions', () => {
  const out = runPython(`${PRELUDE}
listed = [row["name"] for row in actions.descriptors()]
print(json.dumps({"listed": listed, "tools": list(module.TOOL_NAMES)}))
`);
  const data = JSON.parse(out);
  for (const gated of ['browser_context_status', 'browser_get_context', 'browser_clear_context', 'browser_event_log', 'browser_control_status', 'browser_context_journal']) {
    assert.ok(data.tools.includes(gated));
    assert.ok(!data.listed.includes(gated), gated);
  }
});

test('the side channel never moves page data out: status and upload answers carry only metadata keys', () => {
  const source = readFileSync('companion-plugin/context_routes.py', 'utf8');
  const code = source.replace(/"""[\s\S]*?"""/g, '').replace(/#.*$/gm, '');
  // No route returns a stored payload or reads a tool lease.
  assert.doesNotMatch(code, /consume_for_owner|grant_lease|\.payload\b|\["payload"\]|environ|getenv|secret|subprocess/i);
  assert.match(code, /put_session_upload/);
  assert.match(code, /session_status/);
});

test('the extension\'s own full and reference serializations interoperate: same hash, accepted by the plugin, adopted once', async () => {
  const { serializeBrowserTurnEnvelope, browserContextPayloadHash } = await import('../extension/lib/browser-context-protocol.mjs');
  const settings = { contextDepth: 'normal', includeTabs: true, includePageText: true, includeSelectedText: true, maxTabs: 12 };
  const activeTab = { id: 7, active: true, title: 'Docs', url: 'https://example.com/docs', favIconUrl: '' };
  const pageContext = { restricted: false, reason: '', selectedText: '', text: 'PAGE_TEXT_SENTINEL_DO_NOT_LEAK body', youtubeTranscript: '', extraction: null, siteAdapter: null, meta: { description: '', language: 'en', headings: [] }, pickedElement: null };
  const contextHash = browserContextPayloadHash({ activeTab, selectedTabs: [activeTab], pageContext, settings });
  const common = { activeTab, tabs: [activeTab], selectedTabs: [activeTab], pageContext, contextScope: { mode: 'follow-active' }, settings, contextHash, attachments: [], browserControl: {}, responseStyle: null };
  // What the panel uploads (no human text, full delivery) and what the turn then carries (reference).
  const upload = serializeBrowserTurnEnvelope({ ...common, humanInput: '', contextDelivery: 'full' });
  const turn = serializeBrowserTurnEnvelope({ ...common, humanInput: 'and now the second question', contextDelivery: 'reference' });
  assert.ok(upload.length < 64_000);
  const out = runPython(`${PRELUDE}
import os
upload = os.environ["UPLOAD_ENVELOPE"]
turn = os.environ["REFERENCE_TURN"]
store = module.STORE
module.register(Ctx())
parked = store.put_session_upload("sess-A", upload)
other = hooks.pre_llm_call(user_message=turn, **ids(session="sess-B"))
notice = hooks.pre_llm_call(user_message=turn, **ids())
again = hooks.pre_llm_call(user_message=turn, **ids(turn="turn-2", task="task-2"))
print(json.dumps({"parked": parked["available"], "hash": parked["payload_hash"], "other": other, "adopted": notice is not None, "again": again, "status": store.session_status("sess-A")}))
`, { UPLOAD_ENVELOPE: upload, REFERENCE_TURN: turn });
  const data = JSON.parse(out);
  assert.equal(data.parked, true, 'the plugin accepts the extension\'s real full envelope');
  assert.equal(data.hash, contextHash, 'the uploaded hash is the one the reference turn names');
  assert.equal(data.other, null);
  assert.equal(data.adopted, true);
  assert.equal(data.again, null);
  assert.equal(data.status.held, 1);
  assert.equal(data.status.payload_hash, contextHash);
  assert.equal(data.status.pending_upload.present, false);
});
