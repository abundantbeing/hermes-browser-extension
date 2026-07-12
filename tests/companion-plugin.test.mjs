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
]
for tool in ctx.tools:
    schema = tool["schema"]
    assert schema["name"] == tool["name"]
    assert isinstance(schema.get("description"), str) and schema["description"]
    assert schema["parameters"]["type"] == "object"
assert [name for name, _callback in ctx.hooks] == ["pre_llm_call", "post_tool_call"]
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
  // Every handler returns json.dumps
  const handlerLines = tools.split('\n').filter(l => l.includes('return json.dumps'));
  assert.equal(handlerLines.length, 4, 'All four handlers should return json.dumps');
  // No hardcoded available:False
  assert.doesNotMatch(tools, /available.*False/);
  // Store integration
  assert.match(tools, /_ensure_store\(\)/);
  assert.match(tools, /set_store\(/);
  assert.match(tools, /_event_log_limit/);
  // Schemas imported
  assert.match(tools, /from \.schemas import/);
});

test('hooks handle real Hermes **kwargs safely', () => {
  const hooks = readFileSync('companion-plugin/hooks.py', 'utf8');
  assert.match(hooks, /def pre_llm_call\(\*\*kwargs/);
  assert.match(hooks, /def post_tool_call\(\*\*kwargs/);
  assert.match(hooks, /\{"context":/);
  assert.doesNotMatch(hooks, /def pre_llm_call\(context/);
  assert.doesNotMatch(hooks, /def post_tool_call\(event/);

  const script = `${pluginImportHarness}
from companion_plugin.context_store import BrowserContextStore
from companion_plugin import hooks

prompt = """UNTRUSTED_BROWSER_CONTEXT_START
Context hash: abcdef1234567890
Active tab title: Docs
Active tab URL: https://example.com/docs?debug=SENSITIVE_SAMPLE
Context scope: selected tab

Page text:
Hello world
UNTRUSTED_BROWSER_CONTEXT_END"""
store = BrowserContextStore()
hooks.set_store(store)
pre = hooks.pre_llm_call(
    user_message=prompt,
    conversation_history=[{"role": "user", "content": prompt}],
    session_id="session-1",
    turn_id="turn-1",
)
assert isinstance(pre, dict)
assert "context" in pre
assert "untrusted browser context" in pre["context"]
assert store.status()["available"] is True
post = hooks.post_tool_call(
    tool_name="browser_get_context",
    args={"limit": 1},
    result={"authorization": "AUTH_HEADER_SAMPLE_SHOULD_NOT_APPEAR"},
    status="ok",
    duration_ms=12,
)
assert post["ok"] is True
assert store.events[-1]["data"]["result"]["authorization"] == "[REDACTED_SECRET]"
`;
  runPluginPython(script);
});

test('hooks detect browser context inside structured message content', () => {
  const script = `${pluginImportHarness}
from companion_plugin.context_store import BrowserContextStore
from companion_plugin import hooks

prompt = """UNTRUSTED_BROWSER_CONTEXT_START
Context hash: abcdef1234567890
Active tab title: Attachment docs
Active tab URL: https://example.com/docs
Context scope: selected tab

Page text:
Attachment-aware context
UNTRUSTED_BROWSER_CONTEXT_END"""

parts = [
    {"type": "text", "text": "Please summarize the attachment."},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,ignored"}},
    {"type": "text", "text": prompt},
    {"type": "text", "text": 42},
    None,
]

store = BrowserContextStore()
hooks.set_store(store)
result = hooks.pre_llm_call(user_message=parts)
assert isinstance(result, dict)
assert store.status()["available"] is True

store.clear()
result = hooks.pre_llm_call(
    conversation_history=[
        {"role": "assistant", "content": "Earlier reply"},
        {"role": "user", "content": parts},
    ]
)
assert isinstance(result, dict)
assert store.status()["available"] is True
assert hooks._last_user_message(user_message=[{"type": "image_url"}, {"type": "text", "text": 42}]) == ""
`;
  runPluginPython(script);
});

test('context_store parses browser context blocks from prompts', () => {
  const store = readFileSync('companion-plugin/context_store.py', 'utf8');
  assert.match(store, /parse_context_block/);
  assert.match(store, /UNTRUSTED_BROWSER_CONTEXT_START/);
  assert.match(store, /update_from_text/);
  assert.match(store, /BrowserContextEnvelope/);
  assert.match(store, /stable_context_hash/);
  assert.match(store, /hashlib\.sha256/);
  assert.doesNotMatch(store, /hash\(str\(/);
  assert.doesNotMatch(store, /body\[:2000\]/);
  assert.doesNotMatch(store, /"raw"\s*:/);
});

test('context_store executable behavior keeps only sanitized metadata', () => {
  const script = `${pluginImportHarness}
from companion_plugin.context_store import BrowserContextStore

prompt = """
USER_REQUEST_START
Summarize this page
USER_REQUEST_END

UNTRUSTED_BROWSER_CONTEXT_START
Context hash: a1b2c3d4e5f60789
Active tab title: Secret Console
Active tab URL: https://example.com/private/path?debug=extension-origin-query
Context scope: pinned tab — Secret Console

Open tabs:
- Secret Console — https://example.com/private/path?debug=SENSITIVE_SAMPLE

Selected text:
SENSITIVE_SELECTION_SAMPLE_6789

Page metadata:
Description: [REDACTED_API_KEY]

YouTube transcript:
(none)

Page text:
AUTH_HEADER_SAMPLE_SHOULD_NOT_APPEAR appears here
UNTRUSTED_BROWSER_CONTEXT_END
"""

store = BrowserContextStore()
status = store.update_from_text(prompt)
payload = store.get()
blob = json.dumps(payload, sort_keys=True)
assert status["available"] is True
assert status["payload_hash"] == "a1b2c3d4e5f60789"
assert payload["context"]["active_tab"]["origin"] == "https://example.com"
assert payload["context"]["summary"]["selected_text_available"] is True
assert payload["context"]["summary"]["page_text_available"] is True
assert payload["context"]["summary"]["redaction_count"] == 1
for forbidden in ["SENSITIVE_SAMPLE", "AUTH_HEADER_SAMPLE", "SENSITIVE_SELECTION", "extension-origin-query", "/private/path", "?debug"]:
    assert forbidden not in blob, forbidden
`;
  runPluginPython(script);
});

test('context_store handles missing, malformed, and oversized context blocks', () => {
  const script = `${pluginImportHarness}
from companion_plugin.context_store import BrowserContextStore, parse_context_block, stable_context_hash

assert parse_context_block("chat only") is None
assert parse_context_block("UNTRUSTED_BROWSER_CONTEXT_START\\nmissing end") is None

huge_text = "x" * 250000
prompt = "UNTRUSTED_BROWSER_CONTEXT_START\\nActive tab title: Big\\nActive tab URL: https://example.com/a?debug=nope\\n\\nPage text:\\n" + huge_text + "\\nUNTRUSTED_BROWSER_CONTEXT_END"
parsed = parse_context_block(prompt)
assert parsed is not None
assert parsed["truncated"] is True
assert parsed["pageTextAvailable"] is True
assert parsed["activeTab"]["origin"] == "https://example.com"
assert stable_context_hash(parsed) == stable_context_hash(parsed)

store = BrowserContextStore()
status = store.update_from_text("hello")
assert status["available"] is False
`;
  runPluginPython(script);
});

test('browser_event_log clamps invalid limits without crashing', () => {
  const script = `${pluginImportHarness}
import json
from companion_plugin.context_store import BrowserContextStore
from companion_plugin import tools

store = BrowserContextStore()
tools.set_store(store)
for index in range(60):
    store.record_event("tool.finished", {"index": index, "authorization": "AUTH_HEADER_SAMPLE_SHOULD_NOT_APPEAR"})

cases = [
    ({"limit": "bad"}, 20),
    ({"limit": -10}, 1),
    ({"limit": 0}, 1),
    ({"limit": 999}, 50),
    (None, 20),
]
for args, expected in cases:
    result = json.loads(tools.browser_event_log(args))
    assert result["available"] is True
    assert len(result["events"]) == expected, (args, len(result["events"]), expected)
    assert "AUTH_HEADER_SAMPLE" not in json.dumps(result)
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
