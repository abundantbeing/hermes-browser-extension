import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import {
  COMPANION_PLUGIN_NAME,
  buildActivationPlan,
  parseArgs,
  resolveProfileHome,
  runActivation,
} from '../scripts/enable-bot-companion-tools.mjs';

const ROOT = path.join('C:', 'hermes');

function fakeFs(present = []) {
  const set = new Set(present.map((value) => path.normalize(value)));
  return (target) => set.has(path.normalize(target));
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs defaults to a dry run with no profile', () => {
  assert.deepEqual(parseArgs([]), { apply: false, profile: '', help: false });
});

test('parseArgs reads an explicit apply plus profile', () => {
  assert.deepEqual(parseArgs(['--apply', '--profile', 'luxord']), { apply: true, profile: 'luxord', help: false });
  assert.deepEqual(parseArgs(['--profile=luxord', '--apply']), { apply: true, profile: 'luxord', help: false });
});

test('parseArgs rejects unknown arguments', () => {
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
});

// ---------------------------------------------------------------------------
// resolveProfileHome / buildActivationPlan
// ---------------------------------------------------------------------------

test('resolveProfileHome prefers the named profile directory and falls back to the root for default', () => {
  const named = path.join(ROOT, 'profiles', 'luxord');
  assert.equal(resolveProfileHome({ root: ROOT, profile: 'luxord', exists: fakeFs([named]) }), named);
  assert.equal(resolveProfileHome({ root: ROOT, profile: 'default', exists: fakeFs([ROOT]) }), ROOT);
  assert.equal(resolveProfileHome({ root: ROOT, profile: 'ghost', exists: fakeFs([]) }), '');
});

test('buildActivationPlan requires an explicit profile', () => {
  const plan = buildActivationPlan({ profile: '', root: ROOT, exists: fakeFs([]) });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'profile-required');
});

test('buildActivationPlan reports a missing profile home', () => {
  const plan = buildActivationPlan({ profile: 'luxord', root: ROOT, exists: fakeFs([]) });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'profile-missing');
});

test('buildActivationPlan refuses when the companion plugin is not staged in the profile', () => {
  const home = path.join(ROOT, 'profiles', 'luxord');
  const plan = buildActivationPlan({ profile: 'luxord', root: ROOT, exists: fakeFs([home]) });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'plugin-not-staged');
  assert.equal(plan.pluginDir, path.join(home, 'plugins', COMPANION_PLUGIN_NAME));
});

test('buildActivationPlan uses the documented plugins enable convention when the manifest is staged', () => {
  const home = path.join(ROOT, 'profiles', 'luxord');
  const manifest = path.join(home, 'plugins', COMPANION_PLUGIN_NAME, 'plugin.yaml');
  const plan = buildActivationPlan({ profile: 'luxord', root: ROOT, exists: fakeFs([home, manifest]) });
  assert.equal(plan.ok, true);
  assert.equal(plan.profileHome, home);
  assert.equal(plan.manifestPath, manifest);
  assert.deepEqual(plan.command, {
    command: 'hermes',
    args: ['plugins', 'enable', COMPANION_PLUGIN_NAME, '--profile', 'luxord'],
  });
});

// ---------------------------------------------------------------------------
// runActivation: dry-run by default, apply only with an explicit profile
// ---------------------------------------------------------------------------

test('runActivation is a dry run by default and never shells out', () => {
  const home = path.join(ROOT, 'profiles', 'luxord');
  const manifest = path.join(home, 'plugins', COMPANION_PLUGIN_NAME, 'plugin.yaml');
  const runs = [];
  const logged = [];
  const result = runActivation({
    argv: ['--profile', 'luxord'],
    deps: {
      root: ROOT,
      exists: fakeFs([home, manifest]),
      run: (command) => { runs.push(command); return { status: 0 }; },
      log: (line) => logged.push(line),
    },
  });
  assert.equal(result.dryRun, true);
  assert.equal(runs.length, 0, 'dry run shells out to nothing');
  assert.equal(logged.join('\n').includes('hermes plugins enable'), true, 'the planned command is reported');
});

test('runActivation refuses to apply without an explicit profile', () => {
  const runs = [];
  const result = runActivation({
    argv: ['--apply'],
    deps: { root: ROOT, exists: fakeFs([]), run: (command) => { runs.push(command); return { status: 0 }; }, errorLog: () => {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'profile-required');
  assert.equal(runs.length, 0, 'nothing runs without a profile');
});

test('runActivation applies the exact CLI command for the given profile', () => {
  const home = path.join(ROOT, 'profiles', 'luxord');
  const manifest = path.join(home, 'plugins', COMPANION_PLUGIN_NAME, 'plugin.yaml');
  const runs = [];
  const result = runActivation({
    argv: ['--apply', '--profile', 'luxord'],
    deps: { root: ROOT, exists: fakeFs([home, manifest]), run: (command) => { runs.push(command); return { status: 0 }; }, log: () => {} },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'enabled');
  assert.deepEqual(runs, [{ command: 'hermes', args: ['plugins', 'enable', COMPANION_PLUGIN_NAME, '--profile', 'luxord'] }]);
});

test('runActivation surfaces a failed enable without pretending success', () => {
  const home = path.join(ROOT, 'profiles', 'luxord');
  const manifest = path.join(home, 'plugins', COMPANION_PLUGIN_NAME, 'plugin.yaml');
  const result = runActivation({
    argv: ['--apply', '--profile', 'luxord'],
    deps: { root: ROOT, exists: fakeFs([home, manifest]), run: () => ({ status: 3 }), log: () => {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 3);
});

// ---------------------------------------------------------------------------
// Safety: the script never hand-edits YAML and never hardcodes personal names
// ---------------------------------------------------------------------------

test('activation rejects profile paths before filesystem access', () => {
  for (const profile of ['../outside', '..', 'nested/profile', 'nested\\profile', '--help']) {
    const plan = buildActivationPlan({ profile, root: ROOT, exists: () => assert.fail('must not inspect an invalid profile') });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'invalid-profile');
  }
});

test('a failed CLI spawn cannot be reported as successful activation', () => {
  const home = path.join(ROOT, 'profiles', 'demo');
  const manifest = path.join(home, 'plugins', COMPANION_PLUGIN_NAME, 'plugin.yaml');
  const result = runActivation({
    argv: ['--apply', '--profile', 'demo'],
    deps: { root: ROOT, exists: fakeFs([home, manifest]), run: () => ({ status: null, error: new Error('Command unavailable') }), log: () => {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
});

test('the activation script never hand-writes config YAML and never hardcodes a personal profile', () => {
  const source = readFileSync(new URL('../scripts/enable-bot-companion-tools.mjs', import.meta.url), 'utf8');
  assert.equal(/writeFileSync|appendFileSync|save_config/.test(source), false, 'no YAML is written by hand');
  for (const name of ['roxas', 'luxord', 'namine', 'riku', 'saix']) {
    assert.equal(source.toLowerCase().includes(name), false, `no personal profile "${name}" is hardcoded`);
  }
});