import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  COMPANION_PLUGIN_NAME,
  buildActivationPlan,
  companionEnabledInConfig,
  defaultHermesRoot,
  discoverProfiles,
  findStagedCompanion,
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
  assert.deepEqual(parseArgs([]), { apply: false, profile: '', help: false, list: false, allowStale: false });
});

test('parseArgs reads an explicit apply plus profile', () => {
  assert.deepEqual(parseArgs(['--apply', '--profile', 'luxord']), { apply: true, profile: 'luxord', help: false, list: false, allowStale: false });
  assert.deepEqual(parseArgs(['--profile=luxord', '--apply']), { apply: true, profile: 'luxord', help: false, list: false, allowStale: false });
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
  // Hermes maps `default` to the root even when a stray profiles/default directory exists.
  assert.equal(resolveProfileHome({ root: ROOT, profile: 'default', exists: fakeFs([ROOT, path.join(ROOT, 'profiles', 'default')]) }), ROOT);
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
// ---------------------------------------------------------------------------
// One explicit profile per run; discovery is read-only
// ---------------------------------------------------------------------------

const PLUGIN_YAML = (version) => `name: ${COMPANION_PLUGIN_NAME}\nkind: standalone\nversion: ${version}\n`;

function fakeTree(files = {}, directories = []) {
  const normalized = Object.fromEntries(Object.entries(files).map(([file, text]) => [path.normalize(file), text]));
  const dirs = new Set(directories.map((dir) => path.normalize(dir)));
  for (const file of Object.keys(normalized)) {
    for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) dirs.add(dir);
  }
  for (const dir of [...dirs]) {
    for (let parent = path.dirname(dir); parent !== path.dirname(parent); parent = path.dirname(parent)) dirs.add(parent);
  }
  return {
    exists: (target) => path.normalize(target) in normalized || dirs.has(path.normalize(target)),
    readText: (target) => {
      const text = normalized[path.normalize(target)];
      if (text === undefined) throw new Error(`ENOENT ${target}`);
      return text;
    },
    readDir: (target) => {
      const base = path.normalize(target);
      const names = new Set();
      for (const entry of [...Object.keys(normalized), ...dirs]) {
        if (entry !== base && path.dirname(entry) === base) names.add(path.basename(entry));
      }
      if (!dirs.has(base)) throw new Error(`ENOTDIR ${target}`);
      return [...names].sort();
    },
    isDirectory: (target) => dirs.has(path.normalize(target)),
  };
}

const manifestAt = (home, ...segments) => path.join(home, 'plugins', ...segments, 'plugin.yaml');

test('parseArgs accepts one profile only and the discovery and stale flags', () => {
  assert.equal(parseArgs(['--list']).list, true);
  assert.equal(parseArgs(['--allow-stale', '--profile', 'a']).allowStale, true);
  assert.throws(() => parseArgs(['--profile', 'a', '--profile', 'b']), /Only one --profile/);
  assert.throws(() => parseArgs(['--profile', 'a', '-p', 'b']), /Only one --profile/);
  assert.throws(() => parseArgs(['--profile=a', '--profile=b']), /Only one --profile/);
});

test('lists, wildcards and "all" are refused before any filesystem access', () => {
  for (const profile of ['all', 'ALL', '*', 'a,b', 'a b', 'luxord*', '?']) {
    const plan = buildActivationPlan({ profile, root: ROOT, exists: () => assert.fail('must not inspect a multi-profile request') });
    assert.equal(plan.ok, false, profile);
    assert.equal(plan.reason, 'single-profile-only', profile);
  }
  const runs = [];
  const result = runActivation({
    argv: ['--apply', '--profile', 'all'],
    deps: { root: ROOT, exists: () => assert.fail('no fs access'), run: (command) => { runs.push(command); return { status: 0 }; }, errorLog: () => {} },
  });
  assert.equal(result.ok, false);
  assert.equal(runs.length, 0);
});

test('profile names are casefolded like Hermes does and bounded', () => {
  const home = path.join(ROOT, 'profiles', 'luxord');
  const tree = fakeTree({ [manifestAt(home, COMPANION_PLUGIN_NAME)]: PLUGIN_YAML('1.0.0') });
  assert.equal(buildActivationPlan({ profile: 'LuxOrd', root: ROOT, ...tree }).profile, 'luxord');
  assert.equal(buildActivationPlan({ profile: 'x'.repeat(65), root: ROOT, exists: () => false }).reason, 'invalid-profile');
});

test('a nested staged copy (plugins/<category>/<dir>) is found the way Hermes discovers it', () => {
  const home = path.join(ROOT, 'profiles', 'saix');
  const nested = manifestAt(home, 'hermes-browser-extension', 'companion-plugin');
  const tree = fakeTree({
    [nested]: PLUGIN_YAML('0.2.0'),
    [manifestAt(home, 'unrelated')]: 'name: something-else\nversion: 9.9.9\n',
  });
  const staged = findStagedCompanion({ profileHome: home, ...tree });
  assert.equal(staged.layout, 'nested');
  assert.equal(staged.version, '0.2.0');
  assert.equal(staged.manifestPath, nested);
  assert.equal(findStagedCompanion({ profileHome: home, ...fakeTree({ [manifestAt(home, 'unrelated')]: 'name: other\n' }) }), null);
  const plan = buildActivationPlan({ profile: 'saix', root: ROOT, ...tree, repoVersion: '0.2.0' });
  assert.equal(plan.ok, true);
  assert.equal(plan.layout, 'nested');
});

test('a stale staged copy is refused for apply unless explicitly allowed', () => {
  const home = path.join(ROOT, 'profiles', 'luxord');
  const tree = fakeTree({ [manifestAt(home, COMPANION_PLUGIN_NAME)]: PLUGIN_YAML('0.2.0') });
  const refused = buildActivationPlan({ profile: 'luxord', root: ROOT, ...tree, repoVersion: '0.3.4' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'plugin-stale');
  assert.equal(refused.stagedVersion, '0.2.0');
  assert.equal(refused.repoVersion, '0.3.4');
  const runs = [];
  const deps = { root: ROOT, ...tree, repoVersion: '0.3.4', run: (command) => { runs.push(command); return { status: 0 }; }, log: () => {}, errorLog: () => {} };
  assert.equal(runActivation({ argv: ['--apply', '--profile', 'luxord'], deps }).reason, 'plugin-stale');
  assert.equal(runs.length, 0);
  const allowed = runActivation({ argv: ['--apply', '--allow-stale', '--profile', 'luxord'], deps });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.stale, true);
  assert.equal(runs.length, 1);
});

test('apply runs exactly one enable command for the one named profile, even with many profiles present', () => {
  const homes = ['default', 'luxord', 'saix', 'namine', 'riku'].map((name) => (name === 'default' ? ROOT : path.join(ROOT, 'profiles', name)));
  const files = {};
  for (const home of homes) files[manifestAt(home, COMPANION_PLUGIN_NAME)] = PLUGIN_YAML('0.3.4');
  const tree = fakeTree(files);
  const runs = [];
  const result = runActivation({
    argv: ['--apply', '--profile', 'saix'],
    deps: { root: ROOT, ...tree, repoVersion: '0.3.4', run: (command) => { runs.push(command); return { status: 0 }; }, log: () => {} },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(runs, [{ command: 'hermes', args: ['plugins', 'enable', COMPANION_PLUGIN_NAME, '--profile', 'saix'] }]);
  assert.deepEqual(result.touches, [path.join(ROOT, 'profiles', 'saix', 'config.yaml')]);
});

test('--list discovers every profile read-only and reports staged version, staleness and enablement', () => {
  const luxord = path.join(ROOT, 'profiles', 'luxord');
  const namine = path.join(ROOT, 'profiles', 'namine');
  const saix = path.join(ROOT, 'profiles', 'saix');
  const tree = fakeTree({
    [manifestAt(ROOT, 'hermes-browser-extension', 'companion-plugin')]: PLUGIN_YAML('0.2.0'),
    [path.join(ROOT, 'config.yaml')]: 'plugins:\n  enabled:\n    - hermes-browser-companion\n',
    [manifestAt(luxord, COMPANION_PLUGIN_NAME)]: PLUGIN_YAML('0.3.4'),
    [path.join(luxord, 'config.yaml')]: 'plugins:\n  enabled:\n    - hermes-browser-companion\n',
    [manifestAt(saix, COMPANION_PLUGIN_NAME)]: PLUGIN_YAML('0.3.4'),
    [path.join(saix, 'config.yaml')]: 'model: x\n',
    [path.join(namine, 'config.yaml')]: 'plugins:\n  enabled:\n    - other\n',
  }, [path.join(ROOT, 'profiles', 'riku')]);
  const runs = [];
  const logged = [];
  const result = runActivation({
    argv: ['--list'],
    deps: { root: ROOT, ...tree, repoVersion: '0.3.4', run: (command) => { runs.push(command); return { status: 0 }; }, log: (line) => logged.push(line) },
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'list');
  assert.equal(runs.length, 0, 'discovery never shells out');
  const byName = Object.fromEntries(result.profiles.map((row) => [row.profile, row]));
  assert.deepEqual(Object.keys(byName).sort(), ['default', 'luxord', 'namine', 'riku', 'saix']);
  assert.equal(byName.default.state, 'stale');
  assert.equal(byName.default.staged.layout, 'nested');
  assert.equal(byName.default.enabled, 'yes');
  assert.equal(byName.luxord.state, 'enabled');
  assert.equal(byName.saix.state, 'staged');
  assert.equal(byName.saix.enabled, 'no');
  assert.equal(byName.namine.state, 'not-staged');
  assert.equal(byName.riku.state, 'not-staged');
  assert.equal(byName.riku.enabled, 'unknown');
  assert.equal(logged.length > 1, true);
  const refusal = runActivation({ argv: ['--list', '--apply'], deps: { root: ROOT, errorLog: () => {} } });
  assert.equal(refusal.ok, false);
});

test('companionEnabledInConfig reads the plugins.enabled allow-list without a YAML parser', () => {
  assert.equal(companionEnabledInConfig(null), 'unknown');
  assert.equal(companionEnabledInConfig('model: x\n'), 'no');
  assert.equal(companionEnabledInConfig('plugins:\n  enabled:\n    - a\n    - hermes-browser-companion  # on\ntools: 1\n'), 'yes');
  assert.equal(companionEnabledInConfig('plugins:\n  enabled:\n  - "hermes-browser-companion"\n'), 'yes');
  assert.equal(companionEnabledInConfig('plugins:\n  enabled: [a, hermes-browser-companion]\n'), 'yes');
  assert.equal(companionEnabledInConfig('plugins:\n  enabled: [a]\n'), 'no');
  assert.equal(companionEnabledInConfig('plugins:\n  disabled:\n    - hermes-browser-companion\n'), 'no');
  assert.equal(companionEnabledInConfig('other:\n  enabled:\n    - hermes-browser-companion\nplugins:\n  x: 1\n'), 'no');
});

test('HERMES_HOME may name the root or a profile directory', () => {
  const root = path.resolve(ROOT);
  assert.equal(defaultHermesRoot({ HERMES_HOME: root }), root);
  assert.equal(defaultHermesRoot({ HERMES_HOME: path.join(root, 'profiles', 'luxord') }), root);
});

function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = `${info.size}:${info.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

test('preview and discovery against a real temporary Hermes tree change nothing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hbe-companion-script-'));
  try {
    for (const name of ['luxord', 'namine']) mkdirSync(path.join(root, 'profiles', name, 'plugins', COMPANION_PLUGIN_NAME), { recursive: true });
    writeFileSync(path.join(root, 'profiles', 'luxord', 'plugins', COMPANION_PLUGIN_NAME, 'plugin.yaml'), PLUGIN_YAML('0.3.4'));
    writeFileSync(path.join(root, 'profiles', 'luxord', 'config.yaml'), 'model: m\n');
    writeFileSync(path.join(root, 'profiles', 'namine', 'config.yaml'), 'model: m\n');
    const before = snapshot(root);
    const runs = [];
    const deps = { root, repoVersion: '0.3.4', run: (command) => { runs.push(command); return { status: 0 }; }, log: () => {}, errorLog: () => {} };
    const listed = runActivation({ argv: ['--list'], deps });
    assert.equal(listed.profiles.find((row) => row.profile === 'luxord').state, 'staged');
    assert.equal(listed.profiles.find((row) => row.profile === 'namine').state, 'not-staged');
    const preview = runActivation({ argv: ['--profile', 'luxord'], deps });
    assert.equal(preview.dryRun, true);
    assert.equal(runActivation({ argv: ['--profile', 'namine'], deps }).reason, 'plugin-not-staged');
    assert.equal(runs.length, 0);
    assert.deepEqual(snapshot(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverProfiles ignores directory names Hermes would not accept as profiles', () => {
  const tree = fakeTree({}, [path.join(ROOT, 'profiles', 'good'), path.join(ROOT, 'profiles', 'Bad Name'), path.join(ROOT, 'profiles', '..hidden')]);
  const names = discoverProfiles({ root: ROOT, ...tree }).map((row) => row.profile);
  assert.deepEqual(names.sort(), ['default', 'good']);
});
