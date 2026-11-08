import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Multiplex: route handlers and tab_* tools in different profile module copies must
// share one process-wide broker per profile (#158 + #159).

function runPython(script) {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

const SCRIPT = `
import importlib.util, json, pathlib, sys, types

root = pathlib.Path.cwd() / "companion-plugin"
if "hermes_plugins" not in sys.modules:
    ns = types.ModuleType("hermes_plugins")
    ns.__path__ = []
    sys.modules["hermes_plugins"] = ns

def evict(prefix):
    for name in list(sys.modules):
        if name == prefix or name.startswith(prefix + "."):
            sys.modules.pop(name, None)

def load_package(module_name):
    parent = module_name.rpartition(".")[0]
    if parent and parent not in sys.modules:
        namespace = types.ModuleType(parent)
        namespace.__path__ = []
        sys.modules[parent] = namespace
    spec = importlib.util.spec_from_file_location(
        module_name, root / "__init__.py", submodule_search_locations=[str(root)])
    mod = importlib.util.module_from_spec(spec)
    mod.__package__ = module_name
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    broker = sys.modules[f"{module_name}.control_broker"]
    routes = sys.modules[f"{module_name}.control_tools"]
    registry = sys.modules[f"{module_name}.profile_registry"]
    return mod, broker, routes, registry

HOME = "hermes_plugins.hermes_browser_extension"
MODULE_DEFAULT = HOME
MODULE_PROFILE_COPY = HOME + "__profile_work_copy"
OTHER_HOME = "hermes_plugins.hermes_browser_extension__home_0123456789ab"

mod_def, broker_def, tools_def, reg_def = load_package(MODULE_DEFAULT)
mod_work, broker_work, tools_work, reg_work = load_package(MODULE_PROFILE_COPY)
mod_other, broker_other, _, _ = load_package(OTHER_HOME)

registry_def = reg_def
registry_work = reg_work
registry_def.set_multiplex_test_profiles(["default", "work"])
registry_work.set_multiplex_test_profiles(["default", "work"])
registry_def.set_listener_test_profile("work")
registry_work.set_listener_test_profile("work")

route_broker = broker_def.get_control_broker("work")
scope = broker_def.ControllerScope(
    principal_id="p", profile_id="work", session_id="sess-A", controller_id="c",
    browser_profile_id="b", transport_family="local-api", capabilities=frozenset({"controller.noop", "browser_tabs"}))
route_broker.attach(scope, lambda frame: None, owner=object())
attached = len(route_broker.lane_scopes(profile_id="work", session_id="sess-A"))

default_broker = broker_def.get_control_broker("default")
tools_def.configure(broker=default_broker, profile="default", screenshot_dir=None)
tool_broker = tools_work._broker({"session_id": "sess-A", "profile_name": "work"})
tool_seen = len(tool_broker.lane_scopes(profile_id="work", session_id="sess-A"))

evict(MODULE_PROFILE_COPY)
_, broker_reload, tools_reload, _ = load_package(MODULE_PROFILE_COPY + "_reloaded")
reloaded_tool_broker = tools_reload._broker({"session_id": "sess-A", "profile_name": "work"})
reloaded_seen = len(reloaded_tool_broker.lane_scopes(profile_id="work", session_id="sess-A"))

other_home_broker = broker_other.get_control_broker("work")

print(json.dumps({
    "distinct_module_copies": broker_def is not broker_work and tools_def is not tools_work,
    "same_default_work_module_broker": route_broker is broker_work.get_control_broker("work"),
    "tool_sees_route": tool_seen == attached == 1,
    "reload_shares_broker": route_broker is reloaded_tool_broker,
    "reload_still_sees_controller": reloaded_seen == 1,
    "homes_isolated": route_broker is not other_home_broker,
}))
`;

test('two profile module copies and a reload share the work profile ControlBroker', () => {
  const data = runPython(SCRIPT);
  assert.equal(data.distinct_module_copies, true);
  assert.equal(data.same_default_work_module_broker, true);
  assert.equal(data.tool_sees_route, true);
  assert.equal(data.reload_shares_broker, true);
  assert.equal(data.reload_still_sees_controller, true);
  assert.equal(data.homes_isolated, true);
});

const DISPATCH_SCRIPT = `
import asyncio, importlib.util, json, pathlib, sys, types

root = pathlib.Path.cwd() / "companion-plugin"
spec = importlib.util.spec_from_file_location(
    "probe_plugin", root / "__init__.py", submodule_search_locations=[str(root)])
module = importlib.util.module_from_spec(spec)
module.__package__ = "probe_plugin"
sys.modules["probe_plugin"] = module
spec.loader.exec_module(module)
registry = sys.modules["probe_plugin.profile_registry"]
broker_mod = sys.modules["probe_plugin.control_broker"]
tools = sys.modules["probe_plugin.control_tools"]

registry.set_multiplex_test_profiles(["default", "work"])

default_broker = broker_mod.get_control_broker("default")
work_broker = broker_mod.get_control_broker("work")
tools.configure(broker=default_broker, profile="default", screenshot_dir=None)

scope = broker_mod.ControllerScope(
    principal_id="p", profile_id="work", session_id="sess-work", controller_id="c",
    browser_profile_id="b", transport_family="local-api",
    capabilities=frozenset({"controller.noop", "browser_snapshot"}))
work_broker.attach(scope, lambda frame: None, owner=object())

scope_default = broker_mod.ControllerScope(
    principal_id="p", profile_id="default", session_id="sess-default", controller_id="c2",
    browser_profile_id="b", transport_family="local-api",
    capabilities=frozenset({"controller.noop", "browser_snapshot"}))
default_broker.attach(scope_default, lambda frame: None, owner=object())

work_tool_broker = tools._broker({"profile_name": "work", "session_id": "sess-work"})
default_tool_broker = tools._broker({"profile_name": "default", "session_id": "sess-default"})

print(json.dumps({
    "work_broker": work_tool_broker is work_broker,
    "default_broker": default_tool_broker is default_broker,
    "work_scopes": len(work_tool_broker.lane_scopes(profile_id="work", session_id="sess-work")),
    "default_scopes": len(default_tool_broker.lane_scopes(profile_id="default", session_id="sess-default")),
}))
`;

test('configured default handler dispatches to the runtime profile broker', () => {
  const data = runPython(DISPATCH_SCRIPT);
  assert.equal(data.work_broker, true);
  assert.equal(data.default_broker, true);
  assert.equal(data.work_scopes, 1);
  assert.equal(data.default_scopes, 1);
});
