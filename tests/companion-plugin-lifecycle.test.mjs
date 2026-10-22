import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Lifecycle and identity contract for the companion plugin, exercised the way
// the installed Hermes plugin runtime drives it: hooks receive trusted runtime
// kwargs (session_id, turn_id, task_id) and run on a bounded worker thread in a
// copied contextvars context, tool handlers receive session_id/task_id as
// runtime-injected kwargs next to the model-controlled args mapping.

function runPluginPython(script) {
  const result = spawnSync(process.env.PYTHON || 'python', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
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

# A grant that no handler claims expires; two grants are served first-in first-out once each.
hooks.pre_llm_call(user_message=json.dumps(envelope()), **capture())
assert run_like_hermes_bounded_hook(hooks.pre_tool_call, tool_name="browser_context_status", args={}, **ids()) is None
assert run_like_hermes_bounded_hook(hooks.pre_tool_call, tool_name="browser_context_status", args={}, **ids()) is None
assert json.loads(tools.browser_context_status({}, **runtime_kwargs()))["available"] is True
assert json.loads(tools.browser_context_status({}, **runtime_kwargs()))["available"] is True
assert json.loads(tools.browser_context_status({}, **runtime_kwargs())) == UNAVAILABLE

# Expired leases are never served.
real_monotonic = tools.monotonic
try:
    assert run_like_hermes_bounded_hook(hooks.pre_tool_call, tool_name="browser_context_status", args={}, **ids()) is None
    base = real_monotonic()
    tools.monotonic = lambda: base + tools._LEASE_TTL_SECONDS + 1
    assert json.loads(tools.browser_context_status({}, **runtime_kwargs())) == UNAVAILABLE
finally:
    tools.monotonic = real_monotonic

# Unclaimed grants cannot accumulate without bound.
for index in range(tools._MAX_PENDING_LEASES * 3):
    tools.grant_lease("status", {"available": False}, identity=("s", f"t-{index}"))
assert sum(len(rows) for rows in tools._RUNTIME_LEASES.values()) <= tools._MAX_PENDING_LEASES
`;
  runPluginPython(script);
});
