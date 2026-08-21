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
  'companion-plugin/journal.py',
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
  assert.doesNotMatch(manifest, /provides_skills:/);
  // Tools are listed
  assert.match(manifest, /browser_context_status/);
  assert.match(manifest, /browser_get_context/);
  assert.match(manifest, /browser_clear_context/);
  assert.match(manifest, /browser_event_log/);
  assert.match(manifest, /browser_control_status/);
  assert.match(manifest, /browser_text_utility/);
  // Hooks
  assert.match(manifest, /pre_llm_call/);
  assert.match(manifest, /post_tool_call/);
  // No dangerous capabilities
  assert.match(manifest, /manifest_version:\s*2/);
  assert.match(manifest, /config_schema:/);
  assert.doesNotMatch(manifest, /api_server_route|nativeMessaging|debugger/i);
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
  assert.ok(init.includes('browser_control_status'));
  assert.ok(init.includes('browser_text_utility'));
  assert.match(init, /ctx\.get_config\(/);
  assert.match(init, /ctx\.state/);
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
        self.config_reads = []
        self.state = FakeState()
    def get_config(self, key, default=None):
        self.config_reads.append((key, default))
        return default
    def register_tool(self, **kwargs):
        self.tools.append(kwargs)
    def register_hook(self, name, callback):
        self.hooks.append((name, callback))
    def register_skill(self, name, path):
        self.skills.append((name, str(path)))

class FakeState:
    def __init__(self):
        self.values = {}
    def get(self, key, default=None):
        return self.values.get(key, default)
    def set(self, key, value):
        self.values[key] = value

ctx = FakeCtx()
module.register(ctx)
assert [tool["name"] for tool in ctx.tools] == [
    "browser_context_status",
    "browser_get_context",
    "browser_clear_context",
    "browser_event_log",
    "browser_control_status",
    "browser_context_journal",
    "browser_text_utility",
]
for tool in ctx.tools:
    schema = tool["schema"]
    assert schema["name"] == tool["name"]
    assert isinstance(schema.get("description"), str) and schema["description"]
    assert schema["parameters"]["type"] == "object"
assert [name for name, _callback in ctx.hooks] == ["pre_llm_call", "pre_tool_call", "post_tool_call"]
assert ctx.skills and ctx.skills[0][0] == "hermes-browser"
assert ctx.config_reads == [("durable_receipts", True), ("receipt_limit", 8)]
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
    "browser_control_status": schemas.SCHEMA_CONTROL_STATUS,
    "browser_context_journal": schemas.SCHEMA_JOURNAL,
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
  assert.match(tools, /def browser_control_status/);
  assert.match(tools, /def browser_context_journal/);
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

shared = {"session_id": "session-1", "turn_id": "turn-1", "task_id": "task-1"}
capture_owner = owner_from_hook_kwargs({"platform": "telegram", "sender_id": "sender-1", **shared})
tool_owner = owner_from_hook_kwargs(shared)
assert capture_owner == tool_owner
assert capture_owner.principal_id == "session:session-1"
assert owner_from_hook_kwargs({"platform": "web", "sender_id": "sender-2", **shared}) == tool_owner
for missing in shared:
    assert owner_from_hook_kwargs({key: value for key, value in shared.items() if key != missing}) is None
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

test('Phase 6B companion preserves historical control truth and only durable redacted receipts', () => {
  const script = `${pluginImportHarness}
import json
from companion_plugin.context_store import BrowserContextStore, owner_from_hook_kwargs
from companion_plugin import hooks, tools

FORBIDDEN = "PAGE_TEXT_TYPED_SECRET_URL"

class FakeState:
    def __init__(self, values=None, error=None):
        self.values = dict(values or {})
        self.error = error
    def get(self, key, default=None):
        if self.error:
            raise RuntimeError(self.error)
        return self.values.get(key, default)
    def set(self, key, value):
        if self.error:
            raise RuntimeError(self.error)
        self.values[key] = value

def owner(session="session-a", turn="turn-a", task="task-a"):
    return owner_from_hook_kwargs({"session_id": session, "turn_id": turn, "task_id": task})

def envelope(control=None, *, include_control=True):
    value = {
        "protocol": "hermes.browser.turn.v2",
        "human_input": {"source": "composer", "text": "inspect this tab"},
        "browser_context": {"delivery": "full", "payload": {
            "protocol": "hermes.browser.context.v1",
            "contextScope": {"mode": "follow-active"}, "settings": {},
            "activeTab": {"id": 41, "url": "https://example.test/private"},
            "tabs": [], "selectedTabs": [],
            "pageContext": {"text": FORBIDDEN},
        }},
        "attachment_context": {"items": []},
        "source_receipt": {"protocol": "hermes.browser.turn.v2", "version": 2, "delivery": "full", "context_hash": "a1b2c3d4e5f60789"},
    }
    if include_control:
        value["browser_control"] = control if control is not None else {
            "route": "extension-controller",
            "availability": "available",
            "isolated_fallback": "forbidden",
            "controller_id": "controller-owner-a",
            "browser_profile_id": "profile-owner-a",
            "tab_id": 41,
            "frame_id": 0,
            "document_generation": 7,
            "lease_owned": True,
            "url": "https://example.test/private?secret=" + FORBIDDEN,
            "typed_value": FORBIDDEN,
            "arguments": {"text": FORBIDDEN},
        }
    return json.dumps(value)

now = [100.0]
state = FakeState()
store = BrowserContextStore(ttl_seconds=5, clock=lambda: now[0])
store.configure_durable_state(state, enabled=True, receipt_limit=8)
status = store.put_bcp_v2(envelope(), owner())
assert status["available"] is True
control = store.control_status_for_owner(owner())
assert control == {
    "context_id": status["context_id"],
    "observed_at": 100.0,
    "age_ms": 0,
    "live": False,
    "control": {
        "availability": "available",
        "lease_owned": True,
        "controller_id": "controller-owner-a",
        "browser_profile_id": "profile-owner-a",
        "tab_id": 41,
        "frame_id": 0,
        "document_generation": 7,
    },
}
assert FORBIDDEN not in json.dumps(control)
assert store.control_status_for_owner(owner(session="session-b"))["available"] is False

# Missing and malformed control metadata degrade to historical unknown, never authority.
missing = store.put_bcp_v2(envelope(include_control=False), owner(turn="turn-missing"))
assert store.control_status_for_owner(owner(turn="turn-missing"))["control"]["availability"] == "unknown"
malformed = store.put_bcp_v2(envelope({"availability": "available", "tab_id": "41", "controller_id": FORBIDDEN}), owner(turn="turn-malformed"))
assert store.control_status_for_owner(owner(turn="turn-malformed"))["control"]["availability"] == "unknown"

# The tool is owner-authorized and explicitly historical-only.
hooks.set_store(store)
tools.set_store(store)
assert hooks.pre_tool_call(tool_name="browser_control_status", args={}, session_id="session-a", turn_id="turn-a", task_id="task-a") is None
tool_status = json.loads(tools.browser_control_status({}))
assert tool_status["live"] is False
assert tool_status["control"]["controller_id"] == "controller-owner-a"
assert "broker" not in json.dumps(tool_status).lower()

# Post-tool persistence stores only the allowed metadata receipt tuple.
for index in range(10):
    now[0] = 100.0 + index
    store.record_tool_receipt(
        owner(),
        tool_name=f"tool-{index}",
        ok=index % 2 == 0,
        duration_ms=index,
        forbidden={"args": FORBIDDEN, "result": FORBIDDEN, "url": FORBIDDEN},
    )
rows = state.values["receipts_v1"]
assert len(rows) == 8
blob = json.dumps(rows)
assert FORBIDDEN not in blob
assert "args" not in blob and "result" not in blob and "url" not in blob
assert set(rows[-1]) == {"owner", "receipt"}
assert set(rows[-1]["receipt"]) == {"tool_name", "ok", "duration_ms", "controller_id", "tab_id", "document_generation", "observed_at"}

# A fresh process can read owner-scoped receipt metadata but never gains live context/control.
restarted = BrowserContextStore(clock=lambda: now[0])
restarted.configure_durable_state(state, enabled=True, receipt_limit=8)
assert restarted.control_status_for_owner(owner())["available"] is False
receipts = restarted.receipts_for_owner(owner(), 20)
assert len(receipts) == 8
assert receipts[-1]["tool_name"] == "tool-9"
assert restarted.receipts_for_owner(owner(session="session-b"), 20) == []

# Malformed durable state is visible and preserved instead of becoming fresh context.
bad_state = FakeState({"receipts_v1": {"controller_id": "forged"}})
try:
    BrowserContextStore().configure_durable_state(bad_state, enabled=True, receipt_limit=8)
except RuntimeError as error:
    assert "Malformed durable companion receipt state" in str(error)
else:
    raise AssertionError("malformed durable state must fail visibly")
assert bad_state.values == {"receipts_v1": {"controller_id": "forged"}}

now[0] = 106.0
assert store.control_status_for_owner(owner())["available"] is False
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

  const script = `${pluginImportHarness}
from companion_plugin.events import normalize_event_name
assert normalize_event_name("hermes.browser.control.available") == "browser.control.available"
assert normalize_event_name("hermes.browser.control.unavailable") == "browser.control.unavailable"
assert normalize_event_name("hermes.browser.control.approval_requested") == "browser.control.approval_requested"
assert normalize_event_name("hermes.browser.control.detached") == "browser.control.detached"
assert normalize_event_name("hermes.browser.control.future") == "runtime.unknown"
`;
  runPluginPython(script);
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
  assert.match(skill, /browser_control_status/);
  assert.match(skill, /browser_context_journal/);
  assert.match(skill, /historical/i);
  assert.match(skill, /side panel|broker supervision/i);
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
  assert.match(install, /v0\.3\.0/);
  assert.doesNotMatch(install, /v0\.1\.10/);
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

def tool_hook(**overrides):
    values = {
        "session_id": "session-1",
        "turn_id": "turn-1",
        "task_id": "task-1",
    }
    values.update(overrides)
    return values

def capture_hook(**overrides):
    values = {"platform": "telegram", "sender_id": "sender-1", **tool_hook()}
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
assert hooks.pre_llm_call(user_message=legacy, **capture_hook()) is None
assert hooks.pre_llm_call(user_message='{"protocol":"hermes.browser.turn.v2"}', **capture_hook()) is None

notice = hooks.pre_llm_call(user_message=json.dumps(envelope()), **capture_hook())
assert isinstance(notice, dict) and "context_id=" in notice["context"]
assert PAGE_SENTINEL not in notice["context"]
context_id = context_id_from(notice)

# The handler may not read the store unless the immediately preceding trusted
# pre-tool hook granted a ContextVar lease.
direct = json.loads(tools.browser_get_context({"context_id": context_id}))
assert direct == {"available": False, "reason": "Browser context unavailable."}

# Status is owner scoped and intentionally leaves the record available.
assert hooks.pre_tool_call(tool_name="browser_context_status", args={}, **tool_hook()) is None
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
    tool_hook(session_id="session-2"),
    tool_hook(turn_id="turn-2"),
    tool_hook(task_id="task-sibling"),
):
    blocked = hooks.pre_tool_call(
        tool_name="browser_get_context",
        args={"context_id": context_id, "sender_id": "forged", "session_id": "forged", "turn_id": "forged", "task_id": "forged"},
        **wrong_owner,
    )
    assert blocked == {"action": "block", "message": "Browser context unavailable."}
    assert PAGE_SENTINEL not in json.dumps(blocked)

assert hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": context_id}, **tool_hook()) is None
claimed = json.loads(tools.browser_get_context({"context_id": context_id}))
assert claimed["available"] is True
assert claimed["context_id"] == context_id
assert claimed["payload"]["pageContext"]["text"] == PAGE_SENTINEL

replay = hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": context_id}, **tool_hook())
assert replay == {"action": "block", "message": "Browser context unavailable."}

# Diagnostics are owner scoped and do not retain tool args/results, page text,
# or raw sender identifiers.
hooks.post_tool_call(tool_name="browser_get_context", args={"context_id": context_id}, result={"page": PAGE_SENTINEL}, duration_ms=1, **tool_hook())
assert hooks.pre_tool_call(tool_name="browser_event_log", args={"limit": 50}, **tool_hook()) is None
events = json.loads(tools.browser_event_log({"limit": 50}))
event_blob = json.dumps(events)
assert PAGE_SENTINEL not in event_blob
assert "sender-1" not in event_blob

# A concurrent pre-tool race can grant exactly one lease for one capability.
concurrent_notice = hooks.pre_llm_call(user_message=json.dumps(envelope("CONCURRENT_PAGE_SENTINEL")), **capture_hook(turn_id="turn-concurrent"))
concurrent_id = context_id_from(concurrent_notice)
def consume_once():
    decision = hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": concurrent_id}, **tool_hook(turn_id="turn-concurrent"))
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

test('Phase 8 journal is metadata-only, owner-scoped, bounded, and never authorizes context', () => {
  const script = `${pluginImportHarness}
import json
import os
import stat
import tempfile

from companion_plugin.context_store import BrowserContextStore
from companion_plugin.journal import (
    BrowserContextJournal,
    JOURNAL_FILE_MODE,
    JOURNAL_ROW_KEYS,
    MAX_JOURNAL_ROWS,
    validate_journal_row,
)
from companion_plugin import hooks, tools

PAGE_SENTINEL = "JOURNAL_PAGE_TEXT_SENTINEL_DO_NOT_LEAK"

def envelope(page_text=PAGE_SENTINEL, delivery="full"):
    return {
        "protocol": "hermes.browser.turn.v2",
        "human_input": {"source": "composer", "text": "Summarize this page."},
        "browser_context": {
            "delivery": delivery,
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
        "source_receipt": {"protocol": "hermes.browser.turn.v2", "version": 2, "context_hash": "j00000000000000000000000000000000000", "delivery": delivery},
    }

def owner(**overrides):
    class _Owner:
        principal_id = "session:session-j"
        session_id = "session-j"
        turn_id = "turn-j"
        task_id = "task-j"

    values = {field: getattr(_Owner, field) for field in ("principal_id", "session_id", "turn_id", "task_id")}
    values.update(overrides)
    return type("Owner", (), values)()

OWNER_OBJECT = owner()

# Exact row-key contract: no page/payload/URL field can ever enter a row.
assert set(JOURNAL_ROW_KEYS) == {
    "ts", "context_id", "payload_hash", "scope", "controller_id",
    "browser_profile_id", "tab_id", "lease_owned", "delivery",
}
try:
    validate_journal_row({"ts": 1, "page": PAGE_SENTINEL})
    raise AssertionError("row with page field must be refused")
except Exception:
    pass

# Memory-only journal: bounded, owner-scoped, deterministic rotation.
journal = BrowserContextJournal(max_rows=500)
for index in range(520):
    journal.record(
        owner(),
        {"ts": float(index), "context_id": f"ctx-{index}", "payload_hash": "h", "scope": "follow-active",
         "controller_id": "c", "browser_profile_id": "p", "tab_id": index, "lease_owned": True, "delivery": "full"},
    )
assert journal.row_count == 500
rows = journal.rows_for_owner(owner(), limit=500)
assert len(rows) == 500
assert rows[0]["context_id"] == "ctx-20"      # oldest dropped deterministically
assert rows[-1]["context_id"] == "ctx-519"     # newest retained
assert rows[-1]["ts"] == 519.0
assert PAGE_SENTINEL not in json.dumps(rows)
assert journal.rows_for_owner(owner(session_id="other"), limit=500) == []

# Durable journal: mode 0600 where supported and reload from disk.
with tempfile.TemporaryDirectory() as tmp:
    durable = BrowserContextJournal(max_rows=500, data_dir=tmp)
    durable.record(owner(), {"ts": 1.0, "context_id": "durable-1", "payload_hash": "h", "scope": "follow-active",
                             "controller_id": "c", "browser_profile_id": "p", "tab_id": 1, "lease_owned": False, "delivery": "full"})
    path = os.path.join(tmp, "journal.jsonl")
    assert os.path.exists(path)
    if os.name != "nt":
        assert stat.S_IMODE(os.stat(path).st_mode) == JOURNAL_FILE_MODE
    reloaded = BrowserContextJournal(max_rows=500, data_dir=tmp)
    assert len(reloaded.rows_for_owner(owner(), limit=500)) == 1

# Store wiring: journaling records metadata rows on put_bcp_v2 but the
# journal tool never authorizes browser_get_context.
store = BrowserContextStore()
store.configure_journal(None)
hooks.set_store(store)
tools.set_store(store)
hook_kwargs = {"session_id": "session-j", "turn_id": "turn-j", "task_id": "task-j"}
notice = hooks.pre_llm_call(user_message=json.dumps(envelope()), **hook_kwargs)
assert notice is not None
journal_view = store.journal_for_owner(owner(), limit=50)
assert journal_view["available"] is True
blob = json.dumps(journal_view)
assert PAGE_SENTINEL not in blob
assert "https://example.com" not in blob
assert "https://example.com/docs" not in blob

# The journal tool itself cannot retrieve page text: no lease, no payload.
direct = json.loads(tools.browser_context_journal({}))
assert direct == {"available": False, "reason": "Browser context unavailable."}
assert hooks.pre_tool_call(tool_name="browser_context_journal", args={"limit": 10}, **hook_kwargs) is None
view = json.loads(tools.browser_context_journal({"limit": 10}))
assert view["available"] is True
assert PAGE_SENTINEL not in json.dumps(view)

# Journaling never authorizes browser_get_context. A fresh store with the
# same durable journal loaded has journal rows but no live in-memory record,
# so the get handler must block even though the journal knows the id.
with tempfile.TemporaryDirectory() as tmp:
    source = BrowserContextStore()
    source.configure_journal(tmp)
    hooks.set_store(source)
    tools.set_store(source)
    assert hooks.pre_llm_call(user_message=json.dumps(envelope()), **hook_kwargs) is not None
    source_view = source.journal_for_owner(owner(), limit=10)
    journal_id = source_view["rows"][0]["context_id"]
    assert len(journal_id) == 32

    revived = BrowserContextStore()
    revived.configure_journal(tmp)
    hooks.set_store(revived)
    tools.set_store(revived)
    assert revived.journal_for_owner(owner(), limit=10)["available"] is True
    blocked = hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": journal_id}, **hook_kwargs)
    assert blocked == {"action": "block", "message": "Browser context unavailable."}
    assert json.loads(tools.browser_get_context({"context_id": journal_id}))["available"] is False
`;
  runPluginPython(script);
});
