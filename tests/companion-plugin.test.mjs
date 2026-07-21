import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

function runPluginPython(script) {
  const result = spawnSync(process.env.PYTHON || 'python', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

const pluginImportHarness = `
import json
import pathlib
import sys
import types

plugin_root = pathlib.Path.cwd() / "companion-plugin"
pkg = types.ModuleType("companion_plugin")
pkg.__path__ = [str(plugin_root)]
sys.modules["companion_plugin"] = pkg
`;

const files = [
  'companion-plugin/plugin.yaml',
  'companion-plugin/__init__.py',
  'companion-plugin/schemas.py',
  'companion-plugin/protocol.py',
  'companion-plugin/context_store.py',
  'companion-plugin/events.py',
  'companion-plugin/policy.py',
  'companion-plugin/tools.py',
  'companion-plugin/text_utilities.py',
  'companion-plugin/hooks.py',
  'companion-plugin/install.md',
  'companion-plugin/skills/hermes-browser/SKILL.md',
];

test('companion plugin files exist', () => {
  for (const file of files) {
    assert.equal(existsSync(file), true, `${file} should exist`);
  }
});

test('plugin.yaml uses standard Hermes plugin format', () => {
  const manifest = readFileSync('companion-plugin/plugin.yaml', 'utf8');
  assert.match(manifest, /name:\s*hermes-browser-companion/);
  assert.match(manifest, /kind:\s*standalone/);
  assert.match(manifest, /provides_tools:/);
  assert.match(manifest, /provides_hooks:/);
  assert.match(manifest, /provides_skills:/);
  // Tools are listed
  assert.match(manifest, /browser_context_status/);
  assert.match(manifest, /browser_get_context/);
  assert.match(manifest, /browser_clear_context/);
  assert.match(manifest, /browser_event_log/);
  assert.match(manifest, /browser_text_utility/);
  // Hooks
  assert.match(manifest, /pre_llm_call/);
  assert.match(manifest, /post_tool_call/);
  // No dangerous capabilities
  assert.doesNotMatch(manifest, /api_server_route|browser_control|nativeMessaging|debugger/i);
});

test('__init__.py registers tools, hooks and bundled skill', () => {
  const init = readFileSync('companion-plugin/__init__.py', 'utf8');
  assert.match(init, /def register\(ctx\)/);
  assert.match(init, /register_tool\(/);
  assert.match(init, /register_hook\(/);
  assert.match(init, /register_skill\(/);
  // Every tool name appears in register_tool calls
  assert.ok(init.includes('browser_context_status'));
  assert.ok(init.includes('browser_get_context'));
  assert.ok(init.includes('browser_clear_context'));
  assert.ok(init.includes('browser_event_log'));
  assert.ok(init.includes('browser_text_utility'));
  // Hooks
  assert.ok(init.includes('pre_llm_call'));
  assert.ok(init.includes('post_tool_call'));
});

test('register() exposes full function schemas through the plugin context', () => {
  const script = `
import importlib.util
import sys
from pathlib import Path

root = Path.cwd() / "companion-plugin"
package_name = "hermes_browser_companion_under_test"
spec = importlib.util.spec_from_file_location(
    package_name,
    root / "__init__.py",
    submodule_search_locations=[str(root)],
)
module = importlib.util.module_from_spec(spec)
sys.modules[package_name] = module
spec.loader.exec_module(module)

class FakeCtx:
    def __init__(self):
        self.tools = []
        self.hooks = []
        self.skills = []
    def register_tool(self, **kwargs):
        self.tools.append(kwargs)
    def register_hook(self, name, callback):
        self.hooks.append((name, callback))
    def register_skill(self, name, path):
        self.skills.append((name, str(path)))

ctx = FakeCtx()
module.register(ctx)
assert [tool["name"] for tool in ctx.tools] == [
    "browser_context_status",
    "browser_get_context",
    "browser_clear_context",
    "browser_event_log",
    "browser_text_utility",
]
for tool in ctx.tools:
    schema = tool["schema"]
    assert schema["name"] == tool["name"]
    assert isinstance(schema.get("description"), str) and schema["description"]
    assert schema["parameters"]["type"] == "object"
assert [name for name, _callback in ctx.hooks] == ["pre_llm_call", "pre_tool_call", "post_tool_call"]
assert ctx.skills and ctx.skills[0][0] == "hermes-browser"
`;
  runPluginPython(script);
});

test('schemas.py defines valid Hermes/OpenAI function schemas', () => {
  const script = `${pluginImportHarness}
from companion_plugin import schemas

schema_map = {
    "browser_context_status": schemas.SCHEMA_STATUS,
    "browser_get_context": schemas.SCHEMA_GET_CONTEXT,
    "browser_clear_context": schemas.SCHEMA_CLEAR_CONTEXT,
    "browser_event_log": schemas.SCHEMA_EVENT_LOG,
    "browser_text_utility": schemas.SCHEMA_TEXT_UTILITY,
}
for name, schema in schema_map.items():
    assert schema["name"] == name
    assert isinstance(schema.get("description"), str) and schema["description"]
    assert schema["parameters"]["type"] == "object"
    assert schema["parameters"].get("additionalProperties") is False
limit = schemas.SCHEMA_EVENT_LOG["parameters"]["properties"]["limit"]
assert limit["default"] == 20
assert limit["minimum"] == 1
assert limit["maximum"] == 50
`;
  runPluginPython(script);
});

test('tools return JSON responses — status, get, clear, event_log', () => {
  const tools = readFileSync('companion-plugin/tools.py', 'utf8');
  assert.match(tools, /def browser_context_status/);
  assert.match(tools, /def browser_get_context/);
  assert.match(tools, /def browser_clear_context/);
  assert.match(tools, /def browser_event_log/);
  assert.match(tools, /def browser_text_utility/);
  // Handlers consume ContextVar leases; they may not query global/latest state.
  assert.match(tools, /ContextVar/);
  assert.match(tools, /grant_lease/);
  assert.match(tools, /_take_lease/);
  assert.match(tools, /return _json/);
  assert.doesNotMatch(tools, /(?:_STORE|store)\.get\(/);
  assert.match(tools, /set_store\(/);
  assert.match(tools, /_event_log_limit/);
  // Schemas imported
  assert.match(tools, /from \.schemas import/);
});

test('hooks handle real Hermes **kwargs safely', () => {
  const hooks = readFileSync('companion-plugin/hooks.py', 'utf8');
  assert.match(hooks, /def pre_llm_call\(\*\*kwargs/);
  assert.match(hooks, /def pre_tool_call\(\*\*kwargs/);
  assert.match(hooks, /def post_tool_call\(\*\*kwargs/);
  assert.match(hooks, /\{"context":/);
  assert.doesNotMatch(hooks, /def pre_llm_call\(context/);
  assert.doesNotMatch(hooks, /def post_tool_call\(event/);

  const script = `${pluginImportHarness}
from companion_plugin.context_store import owner_from_hook_kwargs

owner = owner_from_hook_kwargs({
    "platform": "telegram",
    "sender_id": "sender-1",
    "session_id": "session-1",
    "turn_id": "turn-1",
    "task_id": "task-1",
})
assert owner.principal_id == "telegram:sender-1"
assert owner_from_hook_kwargs({"platform": "telegram", "session_id": "session-1", "turn_id": "turn-1"}).principal_id == "telegram:session:session-1"
assert owner_from_hook_kwargs({"platform": "telegram", "session_id": "session-1"}) is None
`;
  runPluginPython(script);
});

test('hooks detect browser context inside structured message content', () => {
  const script = `${pluginImportHarness}
from companion_plugin import hooks

parts = [
    {"type": "text", "text": "Please summarize the attachment."},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,ignored"}},
    {"type": "text", "text": '{"protocol":"hermes.browser.turn.v2"}'},
    {"type": "text", "text": 42},
    None,
]
assert hooks._last_user_message(user_message=parts).startswith("Please summarize")
assert hooks._last_user_message(
    conversation_history=[
        {"role": "assistant", "content": "Earlier reply"},
        {"role": "user", "content": parts},
    ]
) == hooks._last_user_message(user_message=parts)
assert hooks._last_user_message(user_message=[{"type": "image_url"}, {"type": "text", "text": 42}]) == ""
`;
  runPluginPython(script);
});

test('context_store exposes BCP v2 ownership, TTL, LRU, and consume-once primitives', () => {
  const store = readFileSync('companion-plugin/context_store.py', 'utf8');
  assert.match(store, /parse_bcp_v2_turn/);
  assert.match(store, /ContextOwner/);
  assert.match(store, /OrderedDict/);
  assert.match(store, /threading\.RLock/);
  assert.match(store, /expires_at/);
  assert.match(store, /consumed_at/);
  assert.match(store, /hashlib\.sha256/);
  assert.doesNotMatch(store, /def get\(/);
  assert.doesNotMatch(store, /def status\(/);
});

test('context_store expires and evicts only scoped BCP v2 records', () => {
  const script = `${pluginImportHarness}
import json
from companion_plugin.context_store import BrowserContextStore, owner_from_hook_kwargs

def owner(turn):
    return owner_from_hook_kwargs({"platform": "telegram", "sender_id": "sender", "session_id": "session", "turn_id": turn, "task_id": "task"})

def message(label):
    return json.dumps({
        "protocol": "hermes.browser.turn.v2",
        "human_input": {"source": "composer", "text": "summarize"},
        "browser_context": {"delivery": "full", "payload": {
            "protocol": "hermes.browser.context.v1",
            "contextScope": {"mode": "follow-active"}, "settings": {}, "activeTab": {}, "tabs": [], "selectedTabs": [],
            "pageContext": {"text": label},
        }},
        "attachment_context": {"items": []},
        "source_receipt": {"protocol": "hermes.browser.turn.v2", "version": 2, "delivery": "full", "context_hash": "a1b2c3d4e5f60789"},
    })

now = [100.0]
store = BrowserContextStore(ttl_seconds=5, max_entries=1, max_entries_per_principal=1, clock=lambda: now[0])
first = store.put_bcp_v2(message("first"), owner("turn-1"))
assert first["available"] is True
assert "first" not in json.dumps(store.status_for_owner(owner("turn-1")))
now[0] = 106.0
assert store.consume_for_owner(first["context_id"], owner("turn-1")) is None

now[0] = 200.0
first = store.put_bcp_v2(message("first"), owner("turn-1"))
second = store.put_bcp_v2(message("second"), owner("turn-2"))
assert store.consume_for_owner(first["context_id"], owner("turn-1")) is None
assert store.consume_for_owner(second["context_id"], owner("turn-2"))["payload"]["pageContext"]["text"] == "second"
`;
  runPluginPython(script);
});

test('context_store rejects legacy, malformed, reference-only, and oversized BCP input', () => {
  const script = `${pluginImportHarness}
from companion_plugin.context_store import parse_bcp_v2_turn

assert parse_bcp_v2_turn("chat only") is None
assert parse_bcp_v2_turn("UNTRUSTED_BROWSER_CONTEXT_START\\nmissing end") is None
assert parse_bcp_v2_turn('{"protocol":"hermes.browser.turn.v2"}') is None
assert parse_bcp_v2_turn('{"protocol":"hermes.browser.turn.v2","browser_context":{"delivery":"reference"}}') is None
assert parse_bcp_v2_turn("x" * 64001) is None
`;
  runPluginPython(script);
});

test('browser_event_log clamps invalid limits without crashing', () => {
  const script = `${pluginImportHarness}
from companion_plugin import tools

cases = [
    ({"limit": "bad"}, 20),
    ({"limit": -10}, 1),
    ({"limit": 0}, 1),
    ({"limit": 999}, 50),
    (None, 20),
]
for args, expected in cases:
    assert tools._event_log_limit(args) == expected
`;
  runPluginPython(script);
});

test('events module defines canonical names', () => {
  const events = readFileSync('companion-plugin/events.py', 'utf8');
  assert.match(events, /BROWSER_CONTEXT_UPDATED/);
  assert.match(events, /BROWSER_CONTEXT_CLEARED/);
  assert.match(events, /normalize_event_name/);
});

test('policy prohibits browser control', () => {
  const policy = readFileSync('companion-plugin/policy.py', 'utf8');
  assert.match(policy, /BROWSER_CONTROL_ENABLED\s*=\s*False/);
  assert.match(policy, /CONTROL_ENABLED\s*=\s*False/);
  assert.match(policy, /context_caching.*True/);
  assert.doesNotMatch(policy, /browser_control.*True/);
});

test('companion skill preserves browser context trust boundaries', () => {
  const skill = readFileSync('companion-plugin/skills/hermes-browser/SKILL.md', 'utf8');
  assert.match(skill, /untrusted webpage data/i);
  assert.match(skill, /Chat only/i);
  assert.match(skill, /Never claim browser control/i);
  assert.match(skill, /browser_context_status/);
  assert.match(skill, /browser_get_context/);
  assert.match(skill, /browser_clear_context/);
  assert.match(skill, /browser_event_log/);
});

function listFilesRecursive(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = `${dir}/${entry}`;
    const stat = statSync(path);
    return stat.isDirectory() ? listFilesRecursive(path) : [path];
  });
}

test('no network, route, or browser-control capability in companion plugin files', () => {
  const pluginFiles = listFilesRecursive('companion-plugin')
    .filter((file) => /\.(py|yaml|md)$/.test(file));
  const combined = pluginFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(combined, /\brequests\b|urllib\.request|\bhttpx\b|\baiohttp\b|\bsocket\b|\bwebsocket\b|\bsubprocess\b/);
  assert.doesNotMatch(combined, /register_api_route|api_server_route\s*[:=]\s*true|ALLOW_API_SERVER_ROUTES\s*=\s*True|browser_control\s*[:=]\s*true|BROWSER_CONTROL_ENABLED\s*=\s*True|CONTROL_ENABLED\s*=\s*True|nativeMessaging\s*[:=]\s*true|chrome\.debugger/i);
});

test('install.md documents the plugin correctly', () => {
  const install = readFileSync('companion-plugin/install.md', 'utf8');
  assert.match(install, /hermes plugins enable hermes-browser-companion/);
  assert.match(install, /v0\.1\.10/);
  assert.match(install, /fail-soft/i);
  assert.ok(install.length > 400);
});

test('Gate V2 companion context is owned by trusted hook context and consumed exactly once', () => {
  const script = `${pluginImportHarness}
import concurrent.futures
import json
import re

from companion_plugin.context_store import BrowserContextStore
from companion_plugin import hooks, tools
from companion_plugin import schemas

PAGE_SENTINEL = "PAGE_TEXT_SENTINEL_DO_NOT_LEAK"

def envelope(page_text=PAGE_SENTINEL):
    return {
        "protocol": "hermes.browser.turn.v2",
        "human_input": {"source": "composer", "text": "Summarize this page."},
        "browser_context": {
            "delivery": "full",
            "payload": {
                "protocol": "hermes.browser.context.v1",
                "contextScope": {"mode": "follow-active"},
                "settings": {"contextDepth": "normal", "includeTabs": False, "includePageText": True, "includeSelectedText": True, "maxTabs": 12},
                "activeTab": {"id": 1, "active": True, "title": "Docs", "url": "https://example.com/docs", "favIconUrl": ""},
                "tabs": [],
                "selectedTabs": [],
                "pageContext": {"restricted": False, "reason": "", "selectedText": "", "text": page_text, "youtubeTranscript": "", "extraction": None, "siteAdapter": None, "meta": {"description": "", "language": "", "headings": []}, "pickedElement": None},
            },
        },
        "attachment_context": {"items": []},
        "source_receipt": {"protocol": "hermes.browser.turn.v2", "version": 2, "context_hash": "a1b2c3d4e5f60789", "delivery": "full"},
    }

def trusted(**overrides):
    values = {
        "platform": "telegram",
        "sender_id": "sender-1",
        "session_id": "session-1",
        "turn_id": "turn-1",
        "task_id": "task-1",
    }
    values.update(overrides)
    return values

def context_id_from(notice):
    match = re.search(r"context_id=([a-f0-9]{32})", notice["context"])
    assert match, notice
    return match.group(1)

store = BrowserContextStore()
hooks.set_store(store)
tools.set_store(store)

# Legacy prompt blocks and malformed turn envelopes cannot create a v2 record.
legacy = "UNTRUSTED_BROWSER_CONTEXT_START\\nPage text: " + PAGE_SENTINEL + "\\nUNTRUSTED_BROWSER_CONTEXT_END"
assert hooks.pre_llm_call(user_message=legacy, **trusted()) is None
assert hooks.pre_llm_call(user_message='{"protocol":"hermes.browser.turn.v2"}', **trusted()) is None

notice = hooks.pre_llm_call(user_message=json.dumps(envelope()), **trusted())
assert isinstance(notice, dict) and "context_id=" in notice["context"]
assert PAGE_SENTINEL not in notice["context"]
context_id = context_id_from(notice)

# The handler may not read the store unless the immediately preceding trusted
# pre-tool hook granted a ContextVar lease.
direct = json.loads(tools.browser_get_context({"context_id": context_id}))
assert direct == {"available": False, "reason": "Browser context unavailable."}

# Status is owner scoped and intentionally leaves the record available.
assert hooks.pre_tool_call(tool_name="browser_context_status", args={}, **trusted()) is None
status = json.loads(tools.browser_context_status({}))
assert status["available"] is True
assert status["context_id"] == context_id
assert PAGE_SENTINEL not in json.dumps(status)

# Tool-supplied ownership fields cannot influence authorization because schemas
# only expose the capability id and the hook reads runtime kwargs.
assert set(schemas.SCHEMA_GET_CONTEXT["parameters"]["properties"]) == {"context_id"}
for schema in (schemas.SCHEMA_STATUS, schemas.SCHEMA_GET_CONTEXT, schemas.SCHEMA_CLEAR_CONTEXT, schemas.SCHEMA_EVENT_LOG):
    assert "sender_id" not in json.dumps(schema)
    assert "session_id" not in json.dumps(schema)
    assert "turn_id" not in json.dumps(schema)
    assert "task_id" not in json.dumps(schema)

for wrong_owner in (
    trusted(sender_id="sender-2"),
    trusted(session_id="session-2"),
    trusted(turn_id="turn-2"),
    trusted(task_id="task-sibling"),
):
    blocked = hooks.pre_tool_call(
        tool_name="browser_get_context",
        args={"context_id": context_id, "sender_id": "forged", "session_id": "forged", "turn_id": "forged", "task_id": "forged"},
        **wrong_owner,
    )
    assert blocked == {"action": "block", "message": "Browser context unavailable."}
    assert PAGE_SENTINEL not in json.dumps(blocked)

assert hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": context_id}, **trusted()) is None
claimed = json.loads(tools.browser_get_context({"context_id": context_id}))
assert claimed["available"] is True
assert claimed["context_id"] == context_id
assert claimed["payload"]["pageContext"]["text"] == PAGE_SENTINEL

replay = hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": context_id}, **trusted())
assert replay == {"action": "block", "message": "Browser context unavailable."}

# Diagnostics are owner scoped and do not retain tool args/results, page text,
# or raw sender identifiers.
hooks.post_tool_call(tool_name="browser_get_context", args={"context_id": context_id}, result={"page": PAGE_SENTINEL}, duration_ms=1, **trusted())
assert hooks.pre_tool_call(tool_name="browser_event_log", args={"limit": 50}, **trusted()) is None
events = json.loads(tools.browser_event_log({"limit": 50}))
event_blob = json.dumps(events)
assert PAGE_SENTINEL not in event_blob
assert "sender-1" not in event_blob

# A concurrent pre-tool race can grant exactly one lease for one capability.
concurrent_notice = hooks.pre_llm_call(user_message=json.dumps(envelope("CONCURRENT_PAGE_SENTINEL")), **trusted(turn_id="turn-concurrent"))
concurrent_id = context_id_from(concurrent_notice)
def consume_once():
    decision = hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": concurrent_id}, **trusted(turn_id="turn-concurrent"))
    if decision is not None:
        return decision
    return json.loads(tools.browser_get_context({"context_id": concurrent_id}))

with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
    outcomes = list(executor.map(lambda _index: consume_once(), range(2)))
assert sum(item.get("available") is True for item in outcomes) == 1
assert sum(item.get("action") == "block" for item in outcomes) == 1
`;
  runPluginPython(script);
});
