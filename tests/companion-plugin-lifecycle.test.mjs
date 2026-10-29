import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  browserContextPayloadHash,
  serializeBrowserTurnEnvelope,
} from '../extension/lib/browser-context-protocol.mjs';

// Lifecycle and identity contract for the companion plugin, exercised the way
// the installed Hermes plugin runtime drives it: hooks receive trusted runtime
// kwargs (session_id, turn_id, task_id) and run on a bounded worker thread in a
// copied contextvars context, tool handlers receive session_id/task_id as
// runtime-injected kwargs next to the model-controlled args mapping.

function runPluginPython(script, env = {}) {
  const result = spawnSync(process.env.PYTHON || 'python', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

const harness = `
import concurrent.futures
import contextvars
import importlib.util
import json
import pathlib
import re
import sys
import threading
import types

PLUGIN_ROOT = pathlib.Path.cwd() / "companion-plugin"

def load_plugin(name="companion_plugin"):
    """Load the plugin as one Hermes home scope would: its own module namespace."""
    parent_name = name.rpartition(".")[0]
    if parent_name and parent_name not in sys.modules:
        namespace = types.ModuleType(parent_name)
        namespace.__path__ = []
        sys.modules[parent_name] = namespace
    spec = importlib.util.spec_from_file_location(
        name, PLUGIN_ROOT / "__init__.py", submodule_search_locations=[str(PLUGIN_ROOT)]
    )
    module = importlib.util.module_from_spec(spec)
    module.__package__ = name
    sys.modules[name] = module
    spec.loader.exec_module(module)
    hooks = sys.modules[name + ".hooks"]
    tools = sys.modules[name + ".tools"]
    store_module = sys.modules[name + ".context_store"]
    return module, hooks, tools, store_module

PAGE = "LIFECYCLE_PAGE_TEXT_SENTINEL"
SELECTED = "LIFECYCLE_SELECTED_TEXT_SENTINEL"

def envelope(page_text=PAGE, delivery="full", context_hash="a1b2c3d4e5f60789", control=None):
    browser_context = {"delivery": delivery}
    if delivery == "full":
        browser_context["payload"] = {
            "protocol": "hermes.browser.context.v1",
            "contextScope": {"mode": "follow-active"},
            "settings": {"contextDepth": "normal", "includeTabs": False, "includePageText": True, "includeSelectedText": True, "maxTabs": 12},
            "activeTab": {"id": 1, "active": True, "title": "Docs", "url": "https://example.com/docs?token=URLSECRET", "favIconUrl": ""},
            "tabs": [],
            "selectedTabs": [],
            "pageContext": {"restricted": False, "reason": "", "selectedText": SELECTED, "text": page_text, "youtubeTranscript": "", "extraction": None, "siteAdapter": None, "meta": {"description": "", "language": "", "headings": []}, "pickedElement": None},
        }
    else:
        browser_context["context_hash"] = context_hash
    value = {
        "protocol": "hermes.browser.turn.v2",
        "human_input": {"source": "composer", "text": "Summarize this page."},
        "browser_context": browser_context,
        "attachment_context": {"items": []},
        "source_receipt": {"protocol": "hermes.browser.turn.v2", "version": 2, "context_hash": context_hash, "delivery": delivery},
    }
    if control is not None:
        value["browser_control"] = control
    return value

def ids(**overrides):
    values = {"session_id": "session-1", "turn_id": "turn-1", "task_id": "task-1"}
    values.update(overrides)
    return values

def capture(**overrides):
    return {"platform": "api_server", "sender_id": "sender-1", **ids(**overrides)}

def context_id_from(notice):
    match = re.search(r"context_id=([a-f0-9]{32})", notice["context"])
    assert match, notice
    return match.group(1)

def run_like_hermes_bounded_hook(callback, **kwargs):
    """Mirror PluginManager._run_hook_callback_bounded: worker thread + copied context."""
    context = contextvars.copy_context()
    outcome = {}
    def runner():
        outcome["value"] = context.run(callback, **kwargs)
    worker = threading.Thread(target=runner, daemon=True)
    worker.start()
    worker.join(10)
    assert not worker.is_alive()
    return outcome.get("value")

def runtime_kwargs(**overrides):
    """What registry.dispatch passes to a handler: trusted ids, never model args."""
    values = {"task_id": "task-1", "session_id": "session-1", "user_task": None}
    values.update(overrides)
    return values

UNAVAILABLE = {"available": False, "reason": "Browser context unavailable."}
`;

test('tool handlers receive the lease even though Hermes runs pre_tool_call on a bounded worker thread', () => {
  const script = `${harness}
module, hooks, tools, _store_module = load_plugin()
module.STORE.configure_journal(None)
hooks.set_store(module.STORE)

notice = hooks.pre_llm_call(user_message=json.dumps(envelope()), **capture())
context_id = context_id_from(notice)

# Status: the hook runs in a copied context; the handler runs in the caller's.
assert run_like_hermes_bounded_hook(hooks.pre_tool_call, tool_name="browser_context_status", args={}, **ids()) is None
status = json.loads(tools.browser_context_status({}, **runtime_kwargs()))
assert status["available"] is True and status["context_id"] == context_id

# Get: the payload crosses the thread boundary exactly once.
assert run_like_hermes_bounded_hook(hooks.pre_tool_call, tool_name="browser_get_context", args={"context_id": context_id}, **ids()) is None
claimed = json.loads(tools.browser_get_context({"context_id": context_id}, **runtime_kwargs()))
assert claimed["available"] is True
assert claimed["payload"]["pageContext"]["text"] == PAGE
assert json.loads(tools.browser_get_context({"context_id": context_id}, **runtime_kwargs())) == UNAVAILABLE

# Limit-parameterized diagnostics are delivered with the limit the hook authorized.
assert run_like_hermes_bounded_hook(hooks.pre_tool_call, tool_name="browser_event_log", args={"limit": 2}, **ids()) is None
events = json.loads(tools.browser_event_log({"limit": 2}, **runtime_kwargs()))
assert events["available"] is True and len(events["events"]) <= 2
assert run_like_hermes_bounded_hook(hooks.pre_tool_call, tool_name="browser_context_journal", args={"limit": 5}, **ids()) is None
journal = json.loads(tools.browser_context_journal({"limit": 5}, **runtime_kwargs()))
assert journal["available"] is True and journal["rows"][0]["context_id"] == context_id
assert run_like_hermes_bounded_hook(hooks.pre_tool_call, tool_name="browser_control_status", args={}, **ids()) is None
# The context was consumed above, so there is no live record left to describe.
assert json.loads(tools.browser_control_status({}, **runtime_kwargs())) == UNAVAILABLE
assert run_like_hermes_bounded_hook(hooks.pre_tool_call, tool_name="browser_clear_context", args={}, **ids()) is None
assert json.loads(tools.browser_clear_context({}, **runtime_kwargs())) == UNAVAILABLE
`;
  runPluginPython(script);
});

test('a lease granted for one runtime identity cannot be taken by another, or by model-supplied ids', () => {
  const script = `${harness}
module, hooks, tools, _store_module = load_plugin()
hooks.set_store(module.STORE)

notice = hooks.pre_llm_call(user_message=json.dumps(envelope()), **capture())
context_id = context_id_from(notice)
assert run_like_hermes_bounded_hook(hooks.pre_tool_call, tool_name="browser_get_context", args={"context_id": context_id}, **ids()) is None

# Another session/task running the handler cannot take it, and the model cannot
# smuggle an owner through the args mapping: only runtime kwargs identify a caller.
forged_args = {"context_id": context_id, "session_id": "session-1", "task_id": "task-1", "turn_id": "turn-1", "sender_id": "sender-1"}
assert json.loads(tools.browser_get_context(forged_args, **runtime_kwargs(session_id="session-2"))) == UNAVAILABLE
assert json.loads(tools.browser_get_context(forged_args, **runtime_kwargs(task_id="task-sibling"))) == UNAVAILABLE
assert json.loads(tools.browser_get_context(forged_args, task_id="", session_id="")) == UNAVAILABLE
assert json.loads(tools.browser_get_context(forged_args)) == UNAVAILABLE

# The legitimate caller still gets it once afterwards.
claimed = json.loads(tools.browser_get_context({"context_id": context_id}, **runtime_kwargs()))
assert claimed["available"] is True and claimed["payload"]["pageContext"]["text"] == PAGE
`;
  runPluginPython(script);
});

test('leases are one-shot, short-lived, and bounded', () => {
  const script = `${harness}
module, hooks, tools, _store_module = load_plugin()
hooks.set_store(module.STORE)

# Two grants are served once each; an abandoned older grant never shadows a fresh one.
hooks.pre_llm_call(user_message=json.dumps(envelope()), **capture())
assert run_like_hermes_bounded_hook(hooks.pre_tool_call, tool_name="browser_context_status", args={}, **ids()) is None
assert run_like_hermes_bounded_hook(hooks.pre_tool_call, tool_name="browser_context_status", args={}, **ids()) is None
assert json.loads(tools.browser_context_status({}, **runtime_kwargs()))["available"] is True
assert json.loads(tools.browser_context_status({}, **runtime_kwargs()))["available"] is True
assert json.loads(tools.browser_context_status({}, **runtime_kwargs())) == UNAVAILABLE

# A call Hermes parked behind earlier tools' approvals still gets its lease later,
# but never after the cached record's own lifetime.
real_monotonic = tools.monotonic
try:
    assert run_like_hermes_bounded_hook(hooks.pre_tool_call, tool_name="browser_context_status", args={}, **ids()) is None
    base = real_monotonic()
    tools.monotonic = lambda: base + 120
    assert json.loads(tools.browser_context_status({}, **runtime_kwargs()))["available"] is True
    assert run_like_hermes_bounded_hook(hooks.pre_tool_call, tool_name="browser_context_status", args={}, **ids()) is None
    tools.monotonic = lambda: base + 120 + tools._LEASE_TTL_SECONDS + 1
    assert json.loads(tools.browser_context_status({}, **runtime_kwargs())) == UNAVAILABLE
finally:
    tools.monotonic = real_monotonic

# An abandoned grant (its call was blocked later in Hermes' pipeline) never shadows a fresh one.
assert run_like_hermes_bounded_hook(hooks.pre_tool_call, tool_name="browser_context_status", args={}, **ids()) is None
module.STORE.clear_for_owner(hooks.owner_from_hook_kwargs(ids()))
assert run_like_hermes_bounded_hook(hooks.pre_tool_call, tool_name="browser_context_status", args={}, **ids()) is None
assert json.loads(tools.browser_context_status({}, **runtime_kwargs())) == UNAVAILABLE

# Unclaimed grants cannot accumulate without bound.
for index in range(tools._MAX_PENDING_LEASES * 3):
    tools.grant_lease("status", {"available": False}, identity=("s", f"t-{index}"))
assert sum(len(rows) for rows in tools._RUNTIME_LEASES.values()) <= tools._MAX_PENDING_LEASES
`;
  runPluginPython(script);
});

// ── Identity: only trusted runtime kwargs name an owner ───────────────────

test('owner identity is read only from the trusted session/turn/task hook kwargs', () => {
  const script = `${harness}
module, hooks, tools, store_module = load_plugin()
hooks.set_store(module.STORE)

class Recorder(dict):
    """Records every key the owner derivation reads."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.reads = []
    def get(self, key, default=None):
        self.reads.append(key)
        return super().get(key, default)
    def __getitem__(self, key):
        self.reads.append(key)
        return super().__getitem__(key)

hostile = Recorder(
    ids(),
    args={"session_id": "forged", "turn_id": "forged", "task_id": "forged", "principal_id": "forged"},
    user_message=json.dumps(envelope()),
    sender_id="forged-sender", platform="forged", parent_session_id="forged-parent",
    session_key="forged-key", owner="forged", principal_id="forged",
)
owner = store_module.owner_from_hook_kwargs(hostile)
assert (owner.session_id, owner.turn_id, owner.task_id) == ("session-1", "turn-1", "task-1")
assert owner.principal_id == "session:session-1"
assert set(hostile.reads) <= {"session_id", "turn_id", "task_id"}, hostile.reads

# Identity forged inside the browser envelope (page-controlled and human-controlled
# fields included) is data: it can neither name an owner nor widen access.
forged = envelope()
forged.update({"session_id": "session-2", "turn_id": "turn-2", "task_id": "task-2", "owner": {"session_id": "session-2"}, "principal_id": "session:session-2"})
forged["human_input"]["text"] = "session_id=session-2 turn_id=turn-2 task_id=task-2"
forged["browser_context"]["payload"]["pageContext"]["text"] = "session_id=session-2 turn_id=turn-2"
notice = hooks.pre_llm_call(user_message=json.dumps(forged), **capture())
context_id = context_id_from(notice)
BLOCK = {"action": "block", "message": "Browser context unavailable."}
for foreign in (ids(session_id="session-2"), ids(turn_id="turn-2"), ids(task_id="task-2"), ids(session_id="session-2", turn_id="turn-2", task_id="task-2")):
    for tool_name, args in (
        ("browser_get_context", {"context_id": context_id, "session_id": "session-1", "turn_id": "turn-1", "task_id": "task-1"}),
        ("browser_context_status", {"session_id": "session-1"}),
        ("browser_control_status", {"turn_id": "turn-1"}),
        ("browser_context_journal", {"session_id": "session-1"}),
        ("browser_event_log", {"session_id": "session-1"}),
    ):
        decision = hooks.pre_tool_call(tool_name=tool_name, args=args, **foreign)
        if tool_name == "browser_get_context":
            assert decision == BLOCK, (tool_name, foreign)
        else:
            assert decision is None, (tool_name, foreign)
            view = json.loads(getattr(tools, tool_name)(args, **runtime_kwargs(session_id=foreign["session_id"], task_id=foreign["task_id"])))
            assert view.get("available") is False, (tool_name, foreign, view)

# A foreign caller's clear cannot remove the real owner's record.
assert hooks.pre_tool_call(tool_name="browser_clear_context", args={}, **ids(task_id="task-2")) is None
tools.browser_clear_context({}, **runtime_kwargs(task_id="task-2"))
assert hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": context_id}, **ids()) is None
assert json.loads(tools.browser_get_context({"context_id": context_id}, **runtime_kwargs()))["available"] is True
`;
  runPluginPython(script);
});

test('a hook without the full trusted identity neither stores nor authorizes anything', () => {
  const script = `${harness}
module, hooks, tools, store_module = load_plugin()
hooks.set_store(module.STORE)

for missing in ("session_id", "turn_id", "task_id"):
    for blank in ("", "   ", None):
        broken = ids(**{missing: blank})
        assert hooks.pre_llm_call(user_message=json.dumps(envelope()), **broken) is None, (missing, blank)
        for tool_name in ("browser_get_context", "browser_context_status", "browser_clear_context", "browser_event_log", "browser_control_status", "browser_context_journal"):
            decision = hooks.pre_tool_call(tool_name=tool_name, args={"context_id": "0" * 32}, **broken)
            assert decision == {"action": "block", "message": "Browser context unavailable."}, (tool_name, missing, blank)
        assert hooks.post_tool_call(tool_name="browser_context_status", duration_ms=1, status="ok", **broken) == {"ok": True, "available": False}

assert module.STORE._records == {}
assert module.STORE._events == []
# A tool-call hook with no tool_name or an unrelated tool is not a companion decision.
assert hooks.pre_tool_call(tool_name="terminal", args={}, **ids()) is None
assert hooks.pre_tool_call(args={}, **ids()) is None
`;
  runPluginPython(script);
});

// ── Delivery lifecycle: full, reference, miss, expiry, session, task, profile ─

test('a full payload followed by a hash reference never lets the reference turn read the earlier owner record', () => {
  const script = `${harness}
module, hooks, tools, _store_module = load_plugin()
hooks.set_store(module.STORE)
BLOCK = {"action": "block", "message": "Browser context unavailable."}

full = hooks.pre_llm_call(user_message=json.dumps(envelope()), **capture(turn_id="turn-1"))
full_id = context_id_from(full)

# The next turn of the same conversation delivers only the unchanged hash.
reference = json.dumps(envelope(delivery="reference"))
assert hooks.pre_llm_call(user_message=reference, **capture(turn_id="turn-2")) is None

# Fail safely, not open: the reference turn has no record of its own and cannot
# borrow the previous turn's capability, whether by id or by asking for status.
turn2 = ids(turn_id="turn-2")
assert hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": full_id}, **turn2) == BLOCK
for tool_name in ("browser_context_status", "browser_control_status", "browser_context_journal"):
    assert hooks.pre_tool_call(tool_name=tool_name, args={}, **turn2) is None
    assert json.loads(getattr(tools, tool_name)({}, **runtime_kwargs()))["available"] is False, tool_name

# The failed borrow neither consumed nor altered the real owner's record.
assert hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": full_id}, **ids(turn_id="turn-1")) is None
assert json.loads(tools.browser_get_context({"context_id": full_id}, **runtime_kwargs()))["payload"]["pageContext"]["text"] == PAGE

# A reference with no earlier payload at all (new session, cleared, expired) stores nothing.
before = len(module.STORE._records)
assert hooks.pre_llm_call(user_message=reference, **capture(session_id="session-new", turn_id="turn-9")) is None
assert len(module.STORE._records) == before
assert hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": full_id}, **ids(session_id="session-new", turn_id="turn-9")) == BLOCK
`;
  runPluginPython(script);
});

test('cache miss, malformed ids, expiry and a new session all fail closed without raising', () => {
  const script = `${harness}
module, hooks, tools, _store_module = load_plugin()
store = module.STORE
hooks.set_store(store)
now = [1000.0]
store.clock = lambda: now[0]

BLOCK = {"action": "block", "message": "Browser context unavailable."}
notice = hooks.pre_llm_call(user_message=json.dumps(envelope()), **capture())
context_id = context_id_from(notice)

# Cache miss and malformed capability ids.
for bad in ("0" * 32, context_id.upper(), context_id[:-1], context_id + "0", "", None, 7, [context_id], {"id": context_id}):
    assert hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": bad}, **ids()) == BLOCK, bad
assert hooks.pre_tool_call(tool_name="browser_get_context", args={}, **ids()) == BLOCK
assert hooks.pre_tool_call(tool_name="browser_get_context", args="not-a-dict", **ids()) == BLOCK

# Expiry: the record disappears with its TTL, so the (still well-formed) id is a miss.
now[0] += store.ttl_seconds + 1
assert hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": context_id}, **ids()) == BLOCK
assert hooks.pre_tool_call(tool_name="browser_context_status", args={}, **ids()) is None
assert json.loads(tools.browser_context_status({}, **runtime_kwargs())) == UNAVAILABLE
assert store._records == {}

# New session: a fresh conversation starts empty and cannot reach the old session's record.
first = hooks.pre_llm_call(user_message=json.dumps(envelope("first")), **capture(session_id="session-A", turn_id="a-1", task_id="a-task"))
first_id = context_id_from(first)
second = hooks.pre_llm_call(user_message=json.dumps(envelope("second")), **capture(session_id="session-B", turn_id="b-1", task_id="b-task"))
second_id = context_id_from(second)
assert first_id != second_id
assert hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": first_id}, **ids(session_id="session-B", turn_id="b-1", task_id="b-task")) == BLOCK
assert hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": second_id}, **ids(session_id="session-B", turn_id="b-1", task_id="b-task")) is None
assert json.loads(tools.browser_get_context({"context_id": second_id}, **runtime_kwargs(session_id="session-B", task_id="b-task")))["payload"]["pageContext"]["text"] == "second"
`;
  runPluginPython(script);
});

test('task and subagent boundaries: siblings, children and parents each see only their own context', () => {
  const script = `${harness}
module, hooks, tools, _store_module = load_plugin()
hooks.set_store(module.STORE)
BLOCK = {"action": "block", "message": "Browser context unavailable."}

parent = ids(session_id="parent-session", turn_id="parent-turn", task_id="parent-task")
parent_notice = hooks.pre_llm_call(user_message=json.dumps(envelope("PARENT_PAGE")), **capture(session_id="parent-session", turn_id="parent-turn", task_id="parent-task"))
parent_id = context_id_from(parent_notice)

# A delegated child has its own session, turn and task; Hermes also tells hooks its parent.
child = ids(session_id="child-session", turn_id="child-turn", task_id="child-task")
sibling_task = ids(session_id="parent-session", turn_id="parent-turn", task_id="sibling-task")
for caller in (child, sibling_task):
    assert hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": parent_id}, parent_session_id="parent-session", **caller) == BLOCK
    for tool_name in ("browser_context_status", "browser_control_status", "browser_context_journal", "browser_event_log"):
        assert hooks.pre_tool_call(tool_name=tool_name, args={}, parent_session_id="parent-session", **caller) is None
        view = json.loads(getattr(tools, tool_name)({}, **runtime_kwargs(session_id=caller["session_id"], task_id=caller["task_id"])))
        assert view["available"] is False, (tool_name, caller)
        assert "PARENT_PAGE" not in json.dumps(view)
    # Child activity is not written into the parent's diagnostics.
    hooks.post_tool_call(tool_name="terminal", duration_ms=1, status="ok", **caller)
    assert hooks.pre_tool_call(tool_name="browser_clear_context", args={}, **caller) is None
    tools.browser_clear_context({}, **runtime_kwargs(session_id=caller["session_id"], task_id=caller["task_id"]))

assert hooks.pre_tool_call(tool_name="browser_event_log", args={"limit": 50}, **parent) is None
parent_events = json.loads(tools.browser_event_log({"limit": 50}, **runtime_kwargs(session_id="parent-session", task_id="parent-task")))
assert [event["name"] for event in parent_events["events"]] == ["browser.context.updated"]

# The child's own context is its own capability, unreadable by the parent.
child_notice = hooks.pre_llm_call(user_message=json.dumps(envelope("CHILD_PAGE")), parent_session_id="parent-session", **capture(session_id="child-session", turn_id="child-turn", task_id="child-task"))
child_id = context_id_from(child_notice)
assert hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": child_id}, **parent) == BLOCK
assert hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": parent_id}, **parent) is None
assert json.loads(tools.browser_get_context({"context_id": parent_id}, **runtime_kwargs(session_id="parent-session", task_id="parent-task")))["payload"]["pageContext"]["text"] == "PARENT_PAGE"
assert hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": child_id}, **child) is None
assert json.loads(tools.browser_get_context({"context_id": child_id}, **runtime_kwargs(session_id="child-session", task_id="child-task")))["payload"]["pageContext"]["text"] == "CHILD_PAGE"
`;
  runPluginPython(script);
});

test('a profile switch is a separate plugin instance: same ids in another Hermes home reach nothing', () => {
  const script = `${harness}
import tempfile

class FakeState:
    def __init__(self, data_dir):
        self.data_dir = pathlib.Path(data_dir)
        self.values = {}
    def get(self, key, default=None):
        return self.values.get(key, default)
    def set(self, key, value):
        self.values[key] = value

class FakeCtx:
    def __init__(self, data_dir):
        self.state = FakeState(data_dir)
        self.tools = []
        self.hooks = []
    def get_config(self, key, default=None):
        return default
    def register_tool(self, **kwargs):
        self.tools.append(kwargs)
    def register_hook(self, name, callback):
        self.hooks.append((name, callback))
    def register_skill(self, name, path):
        pass

BLOCK = {"action": "block", "message": "Browser context unavailable."}
with tempfile.TemporaryDirectory() as home_a, tempfile.TemporaryDirectory() as home_b:
    # Hermes imports a directory plugin once per Hermes-home scope under its own module name.
    module_a, hooks_a, tools_a, _ = load_plugin("hermes_plugins.hermes_browser_companion")
    module_b, hooks_b, tools_b, _ = load_plugin("hermes_plugins.hermes_browser_companion__home_0123456789ab")
    ctx_a, ctx_b = FakeCtx(home_a), FakeCtx(home_b)
    module_a.register(ctx_a)
    module_b.register(ctx_b)

    assert module_a.STORE is not module_b.STORE
    assert hooks_a._STORE is module_a.STORE and hooks_b._STORE is module_b.STORE
    assert tools_a._RUNTIME_LEASES is not tools_b._RUNTIME_LEASES and tools_a._LEASES is not tools_b._LEASES

    # The same session/turn/task strings in both homes (hooks carry no profile field).
    notice_a = hooks_a.pre_llm_call(user_message=json.dumps(envelope("PROFILE_A_PAGE")), **capture())
    context_a = context_id_from(notice_a)
    assert hooks_b.pre_tool_call(tool_name="browser_get_context", args={"context_id": context_a}, **ids()) == BLOCK
    assert hooks_b.pre_tool_call(tool_name="browser_context_status", args={}, **ids()) is None
    assert json.loads(tools_b.browser_context_status({}, **runtime_kwargs())) == UNAVAILABLE

    # Journal and durable receipts live under each home's own data dir.
    hooks_a.post_tool_call(tool_name="terminal", duration_ms=3, status="ok", **ids())
    assert (pathlib.Path(home_a) / "journal.jsonl").exists()
    assert not (pathlib.Path(home_b) / "journal.jsonl").exists()
    assert ctx_a.state.values.get("receipts_v1") and not ctx_b.state.values.get("receipts_v1")
    assert hooks_b.pre_tool_call(tool_name="browser_context_journal", args={}, **ids()) is None
    assert json.loads(tools_b.browser_context_journal({}, **runtime_kwargs()))["available"] is False

    # Profile A's own caller still gets A's context.
    assert hooks_a.pre_tool_call(tool_name="browser_get_context", args={"context_id": context_a}, **ids()) is None
    assert json.loads(tools_a.browser_get_context({"context_id": context_a}, **runtime_kwargs()))["payload"]["pageContext"]["text"] == "PROFILE_A_PAGE"
`;
  runPluginPython(script);
});

// ── Cross-language contract: what the extension really sends ──────────────

function realExtensionTurns() {
  const tab = { id: 7, active: true, title: 'Docs', url: 'https://example.com/docs' };
  const settings = { contextDepth: 'normal', includeTabs: true, includePageText: true, includeSelectedText: true, maxTabs: 12 };
  const pageContext = {
    text: 'REAL_EXTENSION_PAGE_BODY',
    selectedText: 'REAL_EXTENSION_SELECTED_TEXT',
    meta: { description: '', language: 'en', headings: [] },
  };
  const contextHash = browserContextPayloadHash({ activeTab: tab, selectedTabs: [tab], pageContext, settings });
  const common = {
    humanInput: 'Summarize this page',
    activeTab: tab,
    tabs: [tab],
    selectedTabs: [tab],
    pageContext,
    contextScope: { mode: 'follow-active' },
    settings,
    contextHash,
  };
  const controllerId = randomUUID();
  const browserProfileId = randomUUID();
  const control = {
    availability: 'available',
    controllerId,
    browserProfileId,
    tabId: 7,
    frameId: 0,
    documentGeneration: 3,
    url: tab.url,
    leaseOwned: true,
    controlSnapshot: { text: 'REAL_CONTROL_SNAPSHOT_BODY', elementCount: 4 },
  };
  return {
    contextHash,
    controllerId,
    browserProfileId,
    full: serializeBrowserTurnEnvelope({ ...common, contextDelivery: 'full', browserControl: control }),
    reference: serializeBrowserTurnEnvelope({ ...common, contextDelivery: 'reference', browserControl: control }),
    chatOnly: serializeBrowserTurnEnvelope({ ...common, contextScope: { mode: 'chat-only' }, browserControl: { availability: 'not_requested' } }),
    notRequested: serializeBrowserTurnEnvelope({ ...common, contextDelivery: 'full', browserControl: { availability: 'not_requested' } }),
    unavailable: serializeBrowserTurnEnvelope({ ...common, contextDelivery: 'full', browserControl: { availability: 'unavailable', reason: 'no_controller', message: 'No controller.' } }),
  };
}

test('the plugin accepts the extension\'s real BCP v2 turns and ignores its reference and chat-only turns', () => {
  const turns = realExtensionTurns();
  const script = `${harness}
import os
module, hooks, tools, store_module = load_plugin()
hooks.set_store(module.STORE)
turns = json.loads(os.environ["BCP_TURNS"])
BLOCK = {"action": "block", "message": "Browser context unavailable."}

# Full delivery with an attached controller: cached, with historical control metadata only.
notice = hooks.pre_llm_call(user_message=turns["full"], **capture())
assert notice is not None
context_id = context_id_from(notice)
assert "hash=" + turns["contextHash"] in notice["context"]
assert hooks.pre_tool_call(tool_name="browser_control_status", args={}, **ids()) is None
control = json.loads(tools.browser_control_status({}, **runtime_kwargs()))
assert control["live"] is False
assert control["control"] == {
    "availability": "available", "lease_owned": True,
    "controller_id": turns["controllerId"], "browser_profile_id": turns["browserProfileId"],
    "tab_id": 7, "frame_id": 0, "document_generation": 3,
}
assert "REAL_CONTROL_SNAPSHOT_BODY" not in json.dumps(control)
assert hooks.pre_tool_call(tool_name="browser_get_context", args={"context_id": context_id}, **ids()) is None
claimed = json.loads(tools.browser_get_context({"context_id": context_id}, **runtime_kwargs()))
assert claimed["payload"]["pageContext"]["text"] == "REAL_EXTENSION_PAGE_BODY"
assert claimed["payload_hash"] == turns["contextHash"] and claimed["scope"] == "follow-active"
# The control snapshot is turn text for the model, not part of the stored context payload.
assert "REAL_CONTROL_SNAPSHOT_BODY" not in json.dumps(claimed)

# Reference and chat-only turns carry no payload to cache.
assert hooks.pre_llm_call(user_message=turns["reference"], **capture(turn_id="turn-ref")) is None
assert hooks.pre_llm_call(user_message=turns["chatOnly"], **capture(turn_id="turn-chat")) is None

# "Control off" and "control unavailable" stay distinct from "unknown" in the historical record.
for name, expected in (("notRequested", "not_requested"), ("unavailable", "unavailable")):
    turn = ids(turn_id="turn-" + name)
    assert hooks.pre_llm_call(user_message=turns[name], **capture(turn_id="turn-" + name)) is not None
    assert hooks.pre_tool_call(tool_name="browser_control_status", args={}, **turn) is None
    view = json.loads(tools.browser_control_status({}, **runtime_kwargs()))
    assert view["control"]["availability"] == expected and view["live"] is False, (name, view)
    assert view["control"]["controller_id"] == ""
`;
  runPluginPython(script, { BCP_TURNS: JSON.stringify(turns) });
});

// ── Exports: no page bodies, secrets or private session ids leave the plugin ─

test('every export surface is free of page bodies, URLs, secrets and private session identifiers', () => {
  const script = `${harness}
import hashlib
import tempfile

class FakeState:
    def __init__(self, data_dir):
        self.data_dir = pathlib.Path(data_dir)
        self.values = {}
    def get(self, key, default=None):
        return self.values.get(key, default)
    def set(self, key, value):
        self.values[key] = value

class FakeCtx:
    def __init__(self, data_dir):
        self.state = FakeState(data_dir)
    def get_config(self, key, default=None):
        return default
    def register_tool(self, **kwargs):
        pass
    def register_hook(self, name, callback):
        pass
    def register_skill(self, name, path):
        pass

SESSION = "20261022_161530_PRIVATE_SESSION_ID"
TURN = "turn-PRIVATE_TURN_ID"
TASK = "task-PRIVATE_TASK_ID"
SENDER = "SENDER_PRIVATE_ID"
SECRET = "sk-ant-api03-SECRETSECRETSECRETSECRET"
BEARER = "Bearer abc.def.ghi"
URLTOKEN = "https://example.com/docs?token=URLSECRET"
FORBIDDEN = [PAGE, SELECTED, "URLSECRET", "example.com", SESSION, TURN, TASK, SENDER, SECRET, "abc.def.ghi", "PRIVATE_"]

BLOCK = {"action": "block", "message": "Browser context unavailable."}
with tempfile.TemporaryDirectory() as home:
    module, hooks, tools, _ = load_plugin()
    ctx = FakeCtx(home)
    module.register(ctx)
    trusted = {"session_id": SESSION, "turn_id": TURN, "task_id": TASK}
    runtime = {"session_id": SESSION, "task_id": TASK}

    control = {
        "route": "extension-controller", "availability": "available", "isolated_fallback": "forbidden",
        "controller_id": SECRET, "browser_profile_id": BEARER, "tab_id": 4, "frame_id": 0,
        "document_generation": 1, "lease_owned": True,
    }
    hostile = envelope(context_hash=SECRET, control=control)
    hostile["browser_context"]["payload"]["contextScope"] = {"mode": "pinned " + BEARER}
    notice = hooks.pre_llm_call(user_message=json.dumps(hostile), platform="api_server", sender_id=SENDER, **trusted)
    assert notice is not None
    outputs = [notice["context"]]
    context_id = context_id_from(notice)

    for tool_name, args in (
        ("browser_context_status", {}),
        ("browser_control_status", {}),
        ("browser_context_journal", {"limit": 500}),
        ("browser_event_log", {"limit": 50}),
    ):
        assert hooks.pre_tool_call(tool_name=tool_name, args=args, **trusted) is None
        outputs.append(getattr(tools, tool_name)(args, **runtime))
    for tool_name in ("browser_context_status", "browser_event_log", "browser_control_status", "browser_context_journal", "browser_get_context"):
        hooks.post_tool_call(tool_name=tool_name, args={"context_id": context_id, "leak": SECRET}, result={"page": PAGE, "url": URLTOKEN}, duration_ms=2, status="ok", **trusted)
    assert hooks.pre_tool_call(tool_name="browser_event_log", args={"limit": 50}, **trusted) is None
    outputs.append(tools.browser_event_log({"limit": 50}, **runtime))

    # Durable artifacts: receipt state and the journal file.
    outputs.append(json.dumps(ctx.state.values))
    outputs.append((pathlib.Path(home) / "journal.jsonl").read_text(encoding="utf-8"))
    outputs.append(json.dumps(module.STORE.receipts_for_owner(hooks.owner_from_hook_kwargs(trusted))))
    outputs.append(json.dumps(module.STORE.journal_for_owner(hooks.owner_from_hook_kwargs(trusted), 500)))

    blob = "\\n".join(outputs)
    for needle in FORBIDDEN:
        assert needle not in blob, needle

    # Browser-supplied identifiers that are not opaque tokens are dropped, not persisted.
    assert module.STORE.journal_for_owner(hooks.owner_from_hook_kwargs(trusted), 5)["rows"][0]["controller_id"] == ""
    status = json.loads(outputs[1])
    assert status["scope"] == "unknown" and status["payload_hash"] == ""

    # The owner correlation shown to the agent is not an unsalted digest of the session id.
    events = json.loads(outputs[4])["events"]
    assert events
    unsalted = hashlib.sha256(("session:" + SESSION).encode("utf-8")).hexdigest()[:16]
    assert all(event["owner"] != unsalted and len(event["owner"]) == 16 for event in events)
    assert len({event["owner"] for event in events}) == 1
`;
  runPluginPython(script);
});

// ── Docs, manifest and code agree ─────────────────────────────────────────

const CONTEXT_TOOLS = [
  'browser_context_status',
  'browser_get_context',
  'browser_clear_context',
  'browser_event_log',
  'browser_control_status',
  'browser_context_journal',
  'browser_text_utility',
];
// Registered in the broker's (wire action) order under their tab_* names.
const CONTROL_TOOLS = [
  'tab_back', 'tab_batch', 'tab_click', 'tab_drag', 'tab_fill',
  'tab_hover', 'tab_navigate', 'tab_press', 'tab_screenshot', 'tab_scroll',
  'tab_scroll_to', 'tab_select', 'tab_snapshot', 'tab_activate', 'tab_close',
  'tab_create', 'tab_group', 'tab_ungroup', 'tab_list', 'tab_type',
];
const COMPANION_TOOLS = [...CONTEXT_TOOLS, ...CONTROL_TOOLS];

function manifestList(manifest, key) {
  const block = manifest.split(/\r?\n/);
  const start = block.findIndex((line) => line.startsWith(`${key}:`));
  assert.ok(start >= 0, `${key} missing`);
  const items = [];
  for (const line of block.slice(start + 1)) {
    const match = /^\s+-\s+(\S+)\s*$/.exec(line);
    if (!match) break;
    items.push(match[1]);
  }
  return items;
}

test('plugin.yaml, register(), the bundled skill and install.md all list the same tools', () => {
  const manifest = readFileSync('companion-plugin/plugin.yaml', 'utf8');
  assert.deepEqual(manifestList(manifest, 'provides_tools'), COMPANION_TOOLS);
  assert.deepEqual(manifestList(manifest, 'provides_hooks'), ['pre_llm_call', 'pre_tool_call', 'post_tool_call']);

  const registered = JSON.parse(runPluginPython(`${harness}
module, _hooks, _tools, _store = load_plugin()
class State:
    data_dir = None
    def get(self, key, default=None): return default
    def set(self, key, value): pass
class Ctx:
    state = State()
    def __init__(self): self.tools = []; self.hooks = []
    def get_config(self, key, default=None): return default
    def register_tool(self, **kwargs): self.tools.append(kwargs["name"])
    def register_hook(self, name, callback): self.hooks.append(name)
    def register_skill(self, name, path): pass
ctx = Ctx()
module.register(ctx)
print(json.dumps({"tools": ctx.tools, "hooks": ctx.hooks}))
`));
  assert.deepEqual(registered.tools, COMPANION_TOOLS);
  assert.deepEqual(registered.hooks, ['pre_llm_call', 'pre_tool_call', 'post_tool_call']);

  const skill = readFileSync('companion-plugin/skills/hermes-browser-extension/SKILL.md', 'utf8');
  const install = readFileSync('companion-plugin/install.md', 'utf8');
  for (const name of COMPANION_TOOLS) {
    assert.ok(skill.includes(`\`${name}\``), `SKILL.md lists ${name}`);
    assert.ok(install.includes(`\`${name}\``), `install.md lists ${name}`);
  }
  assert.match(skill, /\bseven context tools\b/);
  assert.match(install, /\bseven context tools\b/);
  assert.match(skill, /\btwenty Hermes Control tools\b/);
  assert.match(install, /\btwenty Hermes Control tools\b/);
  assert.doesNotMatch(`${skill}\n${install}`, /\b(six|four|five|6|4|5) (companion )?tools\b/i);
});

test('plugin.yaml version is a release version and matches the extension package version', () => {
  const manifest = readFileSync('companion-plugin/plugin.yaml', 'utf8');
  const version = /^version:\s*(\S+)\s*$/m.exec(manifest)?.[1];
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(version, pkg.version, 'bump companion-plugin/plugin.yaml together with package.json');
  const install = readFileSync('companion-plugin/install.md', 'utf8');
  assert.doesNotMatch(install, /\bv?\d+\.\d+\.\d+\s+—|\*\*v\d+\.\d+\.\d+\*\*/, 'install.md must not pin a stale plugin version');
});

test('tool status fields are exactly what the documentation promises', () => {
  const script = `${harness}
module, hooks, tools, _store = load_plugin()
hooks.set_store(module.STORE)
module.STORE.configure_journal(None)
notice = hooks.pre_llm_call(user_message=json.dumps(envelope(control={"route": "extension-controller", "availability": "available", "isolated_fallback": "forbidden", "controller_id": "controller-a", "browser_profile_id": "profile-a", "tab_id": 3, "frame_id": 0, "document_generation": 2, "lease_owned": False})), **capture())
context_id = context_id_from(notice)
def call(name, args=None):
    assert hooks.pre_tool_call(tool_name=name, args=args or {}, **ids()) is None
    return json.loads(getattr(tools, name)(args or {}, **runtime_kwargs()))

assert set(call("browser_context_status")) == {"available", "context_id", "protocol", "payload_hash", "scope", "created_at", "expires_at"}
control = call("browser_control_status")
assert set(control) == {"context_id", "observed_at", "age_ms", "live", "control"} and control["live"] is False
assert set(control["control"]) == {"availability", "lease_owned", "controller_id", "browser_profile_id", "tab_id", "frame_id", "document_generation"}
journal = call("browser_context_journal")
assert set(journal) == {"available", "rows"}
assert set(journal["rows"][0]) == {"ts", "context_id", "payload_hash", "scope", "controller_id", "browser_profile_id", "tab_id", "lease_owned", "delivery"}
events = call("browser_event_log")
assert set(events) == {"available", "events"} and set(events["events"][0]) == {"name", "data", "ts", "owner"}
got = call("browser_get_context", {"context_id": context_id})
assert set(got) == {"available", "context_id", "protocol", "payload_hash", "scope", "created_at", "expires_at", "payload", "provenance"}
assert call("browser_clear_context") == UNAVAILABLE
`;
  runPluginPython(script);
});

test('the plugin claims a closed set of routes, and control only through Hermes Control, never action execution by a route', () => {
  const claims = ['companion-plugin/install.md', 'companion-plugin/skills/hermes-browser-extension/SKILL.md', 'companion-plugin/plugin.yaml', 'DATA-FLOW.md']
    .map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(claims, /\/v1\/browser|\/api\/browser|browser_context_upload|browser_context_provider|plugin_actions/);
  assert.doesNotMatch(claims, /\/api\/plugins\/hermes-browser-extension\/(?!status|context|actions|control\/(?:register|ws)\b)/);
  const install = readFileSync('companion-plugin/install.md', 'utf8');
  assert.match(install, /context tools do \*\*not\*\* control the browser/);
  assert.match(install, /\/api\/plugins\/hermes-browser-extension\/control\/register/);
  assert.match(install, /\/api\/plugins\/hermes-browser-extension\/control\/ws/);
  assert.match(install, /\/api\/plugins\/hermes-browser-extension\/status/);
  assert.match(install, /read-only/);
  assert.match(install, /\/api\/plugins\/hermes-browser-extension\/context\/status/);
  assert.match(install, /\/api\/plugins\/hermes-browser-extension\/actions/);
  assert.match(install, /never execution|descriptors, never execution/i);
  const skill = readFileSync('companion-plugin/skills/hermes-browser-extension/SKILL.md', 'utf8');
  assert.match(skill, /Never claim browser control unless a Hermes Control tool actually ran/);
  assert.match(skill, /always `live: false`/);
  const policy = readFileSync('companion-plugin/policy.py', 'utf8');
  assert.match(policy, /ALLOW_API_SERVER_ROUTES\s*=\s*False/);
  assert.match(policy, /STATUS_ROUTE_ENABLED\s*=\s*True/);
  assert.match(policy, /ACTION_ROUTES_EXECUTE\s*=\s*False/);
});
