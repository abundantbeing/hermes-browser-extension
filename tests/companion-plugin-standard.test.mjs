import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The companion plugin as Hermes' plugin platform sees it: the manifest the
// catalog validator reads, and a register() that survives the validator's
// recording context (which has no `state`, unlike the live PluginContext).

const manifest = readFileSync('companion-plugin/plugin.yaml', 'utf8');

function runPython(script) {
  const result = spawnSync(process.env.PYTHON || 'python', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('register() runs against a context without durable state, as the catalog validator probes it', () => {
  const out = runPython(`
import importlib.util, json, pathlib, sys, types

root = pathlib.Path.cwd() / "companion-plugin"
spec = importlib.util.spec_from_file_location(
    "probe_plugin", root / "__init__.py", submodule_search_locations=[str(root)])
module = importlib.util.module_from_spec(spec)
module.__package__ = "probe_plugin"
sys.modules["probe_plugin"] = module
spec.loader.exec_module(module)

recorded = {"tools": [], "hooks": [], "skills": []}

class ProbeCtx:
    # Mirrors hermes_cli.plugin_validate's RecordingContext: \`state\` is a
    # cached_property on the real PluginContext, so the probe has no such name.
    def get_config(self, key, default=None):
        return default
    def register_tool(self, name, *args, **kwargs):
        recorded["tools"].append(name)
    def register_hook(self, name, callback):
        recorded["hooks"].append(name)
    def register_skill(self, name, path):
        recorded["skills"].append(name)
    def __getattr__(self, name):
        raise AttributeError(name)

module.register(ProbeCtx())
print(json.dumps(recorded))
`);
  const recorded = JSON.parse(out.trim().split('\n').pop());
  assert.equal(recorded.tools.length, 27);
  assert.deepEqual(recorded.hooks, ['pre_llm_call', 'pre_tool_call', 'post_tool_call']);
  assert.deepEqual(recorded.skills, ['hermes-browser']);
});

test('the manifest declares exactly the tools and hooks register() registers', () => {
  const declaredTools = [...manifest.matchAll(/^ {2}- (browser_\w+)$/gm)].map((match) => match[1]);
  const init = readFileSync('companion-plugin/__init__.py', 'utf8');
  const registeredTools = [...init.matchAll(/name="(browser_\w+)"/g)].map((match) => match[1]);
  // The Hermes Control tools are registered in a loop over the broker's actions.
  const controlTools = [...readFileSync('companion-plugin/control_broker.py', 'utf8').matchAll(/^ {4}"(browser_\w+)",$/gm)].map((match) => match[1]);
  assert.equal(controlTools.length, 20);
  registeredTools.push(...controlTools);
  assert.equal(declaredTools.length, 27);
  assert.deepEqual([...declaredTools].sort(), [...registeredTools].sort());
  for (const hook of ['pre_llm_call', 'pre_tool_call', 'post_tool_call']) {
    assert.match(manifest, new RegExp(`^ {2}- ${hook}$`, 'm'), hook);
    assert.match(init, new RegExp(`register_hook\\("${hook}"`), hook);
  }
});

test('the manifest carries the platform metadata and asks for no privileged capability', () => {
  assert.match(manifest, /^name: hermes-browser-companion$/m);
  assert.match(manifest, /^manifest_version: 2$/m);
  assert.match(manifest, /^license: MIT$/m);
  assert.match(manifest, /^homepage: https:\/\/github\.com\/abundantbeing\/hermes-browser-extension$/m);
  // A SemVer floor, never a CalVer date.
  assert.match(manifest, /^requires_hermes: ">=0\.\d+(\.\d+)?"$/m);
  assert.match(manifest, /^capabilities: \[\]$/m);
  // The tool names are all `browser_*`: nothing here can shadow a built-in tool,
  // so `tools.override` would be a declared capability the plugin never uses.
  assert.doesNotMatch(manifest, /tools\.override|llm\.|gateway\.platform_actions/);
  assert.doesNotMatch(manifest, /^requires_env:/m);
  assert.doesNotMatch(manifest, /^python_dependencies:/m);
});

test('a portable plugin.json is not shipped: plugin.yaml is the native manifest and always wins', () => {
  assert.equal(existsSync('companion-plugin/plugin.json'), false);
});

// Opt-in: runs Hermes' own `plugins doctor` and `plugins validate` against this
// plugin from a Hermes checkout, in a throwaway HERMES_HOME. Set
// HERMES_AGENT_CHECKOUT (and HERMES_AGENT_PYTHON for its interpreter).
const checkout = process.env.HERMES_AGENT_CHECKOUT || '';
test('Hermes plugin doctor and validate pass without warnings', { skip: !checkout }, () => {
  const python = process.env.HERMES_AGENT_PYTHON || 'python';
  const home = mkdtempSync(path.join(tmpdir(), 'hbe-doctor-'));
  try {
    const script = `
import sys
sys.path.insert(0, ${JSON.stringify(checkout)})
from hermes_cli.plugin_dev import doctor_plugin
from hermes_cli.plugin_validate import validate_plugin_dir
target = ${JSON.stringify(path.resolve('companion-plugin'))}
doctor = doctor_plugin(target)
print(doctor.format_text())
assert doctor.ok, "doctor reported an error"
report = validate_plugin_dir(target)
print("validate failures:", report.failures, "warnings:", report.warnings)
assert report.ok, report.failures
assert not report.warnings, report.warnings
`;
    const result = spawnSync(python, ['-I', '-c', script], {
      encoding: 'utf8',
      env: { ...process.env, HERMES_HOME: home },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
