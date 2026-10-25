import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  COMPANION_INSTALL_SOURCE,
  COMPANION_PLUGIN_NAME,
  buildActivationPlan,
  buildPluginInstallCommand,
  companionEnabledInConfig,
  defaultHermesRoot,
  discoverProfiles,
  findStagedCompanion,
  parseArgs,
  repoPluginVersion,
  resolveProfileHome,
  runActivation,
} from '../scripts/enable-bot-companion-tools.mjs';

const ROOT = path.join('C:', 'hermes');
const SHA = 'a'.repeat(40);

function fakeFs(present = []) {
  const set = new Set(present.map((value) => path.normalize(value)));
  return (target) => set.has(path.normalize(target));
}

const PLUGIN_YAML = (version) => `name: ${COMPANION_PLUGIN_NAME}\nkind: standalone\nversion: ${version}\n`;
const ENABLED_CONFIG = 'plugins:\n  enabled:\n    - hermes-browser-companion\n';

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
const homeOf = (name) => (name === 'default' ? ROOT : path.join(ROOT, 'profiles', name));

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs defaults to a dry run with no profile', () => {
  assert.deepEqual(parseArgs([]), { apply: false, profile: '', help: false, list: false, replace: false, source: '', ref: '' });
});

test('parseArgs reads an explicit apply plus profile, source, ref and replace', () => {
  assert.equal(parseArgs(['--apply', '--profile', 'luxord']).apply, true);
  assert.equal(parseArgs(['--profile=luxord', '--apply']).profile, 'luxord');
  const full = parseArgs(['--profile', 'a', '--replace', '--source', 'file:///x/repo#companion-plugin', '--ref', SHA]);
  assert.equal(full.replace, true);
  assert.equal(full.source, 'file:///x/repo#companion-plugin');
  assert.equal(full.ref, SHA);
  assert.equal(parseArgs([`--source=owner/repo/companion-plugin`]).source, 'owner/repo/companion-plugin');
});

test('parseArgs rejects unknown arguments, a retired flag and anything but a full commit SHA for --ref', () => {
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
  assert.throws(() => parseArgs(['--allow-stale']), /Unknown argument/);
  for (const ref of ['main', 'v1.0.0', 'abc1234', 'z'.repeat(40), '']) {
    assert.throws(() => parseArgs(['--ref', ref]), /40-character commit SHA|needs a value/, ref);
  }
});

test('parseArgs accepts one profile only and the discovery flag', () => {
  assert.equal(parseArgs(['--list']).list, true);
  assert.throws(() => parseArgs(['--profile', 'a', '--profile', 'b']), /Only one --profile/);
  assert.throws(() => parseArgs(['--profile', 'a', '-p', 'b']), /Only one --profile/);
  assert.throws(() => parseArgs(['--profile=a', '--profile=b']), /Only one --profile/);
});

// ---------------------------------------------------------------------------
// resolveProfileHome and the official commands
// ---------------------------------------------------------------------------

test('resolveProfileHome prefers the named profile directory and falls back to the root for default', () => {
  const named = path.join(ROOT, 'profiles', 'luxord');
  assert.equal(resolveProfileHome({ root: ROOT, profile: 'luxord', exists: fakeFs([named]) }), named);
  assert.equal(resolveProfileHome({ root: ROOT, profile: 'default', exists: fakeFs([ROOT]) }), ROOT);
  assert.equal(resolveProfileHome({ root: ROOT, profile: 'ghost', exists: fakeFs([]) }), '');
  // Hermes maps `default` to the root even when a stray profiles/default directory exists.
  assert.equal(resolveProfileHome({ root: ROOT, profile: 'default', exists: fakeFs([ROOT, path.join(ROOT, 'profiles', 'default')]) }), ROOT);
});

test('the install command is the official one: install, enable, optional pin, optional force, one profile', () => {
  assert.deepEqual(buildPluginInstallCommand({ profile: 'luxord' }), {
    command: 'hermes',
    args: ['plugins', 'install', COMPANION_INSTALL_SOURCE, '--enable', '--profile', 'luxord'],
  });
  assert.deepEqual(buildPluginInstallCommand({ profile: 'luxord', source: 'owner/repo/companion-plugin', ref: SHA, force: true }).args, [
    'plugins', 'install', 'owner/repo/companion-plugin', '--enable', '--ref', SHA, '--force', '--profile', 'luxord',
  ]);
  assert.equal(COMPANION_INSTALL_SOURCE, 'https://github.com/abundantbeing/hermes-browser-extension.git#companion-plugin');
});

// ---------------------------------------------------------------------------
// buildActivationPlan
// ---------------------------------------------------------------------------

test('buildActivationPlan requires an explicit, existing profile', () => {
  assert.equal(buildActivationPlan({ profile: '', root: ROOT, exists: fakeFs([]) }).reason, 'profile-required');
  assert.equal(buildActivationPlan({ profile: 'luxord', root: ROOT, exists: fakeFs([]) }).reason, 'profile-missing');
});

test('a profile with no copy gets the official install command', () => {
  const home = homeOf('luxord');
  const plan = buildActivationPlan({ profile: 'luxord', root: ROOT, exists: fakeFs([home]), repoVersion: '0.3.4' });
  assert.equal(plan.ok, true);
  assert.equal(plan.action, 'install');
  assert.deepEqual(plan.command, buildPluginInstallCommand({ profile: 'luxord' }));
  assert.deepEqual(plan.touches, [path.join(home, 'config.yaml')]);
});

test('--source and --ref reach the command; the default profile maps to the root', () => {
  const plan = buildActivationPlan({ profile: 'default', root: ROOT, exists: fakeFs([ROOT]), source: 'file:///tmp/clone#companion-plugin', ref: SHA });
  assert.equal(plan.profileHome, ROOT);
  assert.deepEqual(plan.command.args, ['plugins', 'install', 'file:///tmp/clone#companion-plugin', '--enable', '--ref', SHA, '--profile', 'default']);
});

test('the current flat copy that is already enabled is left alone', () => {
  const home = homeOf('luxord');
  const tree = fakeTree({ [manifestAt(home, COMPANION_PLUGIN_NAME)]: PLUGIN_YAML('0.3.4'), [path.join(home, 'config.yaml')]: ENABLED_CONFIG });
  const plan = buildActivationPlan({ profile: 'luxord', root: ROOT, ...tree, repoVersion: '0.3.4' });
  assert.equal(plan.ok, true);
  assert.equal(plan.noop, true);
  assert.equal(plan.command, null);
});

test('the current flat copy that is not enabled gets the official enable command', () => {
  const home = homeOf('saix');
  const tree = fakeTree({ [manifestAt(home, COMPANION_PLUGIN_NAME)]: PLUGIN_YAML('0.3.4'), [path.join(home, 'config.yaml')]: 'model: x\n' });
  const plan = buildActivationPlan({ profile: 'saix', root: ROOT, ...tree, repoVersion: '0.3.4' });
  assert.equal(plan.action, 'enable');
  assert.deepEqual(plan.command, { command: 'hermes', args: ['plugins', 'enable', COMPANION_PLUGIN_NAME, '--profile', 'saix'] });
});

test('a flat copy of another version, or one whose version cannot be read, needs --replace and then runs install --force', () => {
  const home = homeOf('luxord');
  for (const yaml of [PLUGIN_YAML('0.2.0'), 'name: hermes-browser-companion\n']) {
    const tree = fakeTree({ [manifestAt(home, COMPANION_PLUGIN_NAME)]: yaml });
    const refused = buildActivationPlan({ profile: 'luxord', root: ROOT, ...tree, repoVersion: '0.3.4' });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'plugin-stale');
    const replaced = buildActivationPlan({ profile: 'luxord', root: ROOT, ...tree, repoVersion: '0.3.4', replace: true });
    assert.equal(replaced.ok, true);
    assert.equal(replaced.action, 'replace');
    assert.deepEqual(replaced.command.args, ['plugins', 'install', COMPANION_INSTALL_SOURCE, '--enable', '--force', '--profile', 'luxord']);
  }
});

test('a nested older copy blocks everything, even with --replace, because both copies would load', () => {
  const home = homeOf('default');
  const tree = fakeTree({
    [manifestAt(home, 'hermes-browser-extension', 'companion-plugin')]: PLUGIN_YAML('0.2.0'),
    [manifestAt(home, 'unrelated')]: 'name: something-else\nversion: 9.9.9\n',
  });
  assert.equal(findStagedCompanion({ profileHome: home, ...tree }).layout, 'nested');
  for (const replace of [false, true]) {
    const plan = buildActivationPlan({ profile: 'default', root: ROOT, ...tree, repoVersion: '0.3.4', replace });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'nested-copy-present');
    assert.equal(plan.stagedVersion, '0.2.0');
  }
  assert.equal(findStagedCompanion({ profileHome: home, ...fakeTree({ [manifestAt(home, 'unrelated')]: 'name: other\n' }) }), null);
});

test('activation rejects profile paths, lists, wildcards and "all" before any filesystem access', () => {
  for (const profile of ['../outside', '..', 'nested/profile', 'nested\\profile', '--help']) {
    const plan = buildActivationPlan({ profile, root: ROOT, exists: () => assert.fail('must not inspect an invalid profile') });
    assert.equal(plan.reason, 'invalid-profile', profile);
  }
  for (const profile of ['all', 'ALL', '*', 'a,b', 'a b', 'luxord*', '?']) {
    const plan = buildActivationPlan({ profile, root: ROOT, exists: () => assert.fail('must not inspect a multi-profile request') });
    assert.equal(plan.reason, 'single-profile-only', profile);
  }
  assert.equal(buildActivationPlan({ profile: 'x'.repeat(65), root: ROOT, exists: () => false }).reason, 'invalid-profile');
});

test('profile names are casefolded like Hermes does', () => {
  const tree = fakeTree({}, [homeOf('luxord')]);
  assert.equal(buildActivationPlan({ profile: 'LuxOrd', root: ROOT, ...tree }).profile, 'luxord');
});

// ---------------------------------------------------------------------------
// runActivation: dry run by default, apply only with an explicit profile
// ---------------------------------------------------------------------------

function runner(status = 0) {
  const runs = [];
  return { runs, run: (command) => { runs.push(command); return typeof status === 'function' ? status(command) : { status }; } };
}

test('runActivation is a dry run by default: it reports the official command and never shells out', () => {
  const home = homeOf('luxord');
  const { runs, run } = runner();
  const logged = [];
  const result = runActivation({ argv: ['--profile', 'luxord'], deps: { root: ROOT, ...fakeTree({}, [home]), run, log: (line) => logged.push(line), repoVersion: '0.3.4' } });
  assert.equal(result.dryRun, true);
  assert.equal(result.ok, true);
  assert.equal(runs.length, 0);
  assert.match(logged.join('\n'), /Would run: hermes plugins install https:\/\/github\.com\/abundantbeing\/hermes-browser-extension\.git#companion-plugin --enable --profile luxord/);
});

test('runActivation refuses to apply without an explicit profile', () => {
  const { runs, run } = runner();
  const result = runActivation({ argv: ['--apply'], deps: { root: ROOT, exists: fakeFs([]), run, errorLog: () => {} } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'profile-required');
  assert.equal(runs.length, 0);
});

test('runActivation applies exactly one official command for the one named profile, even with many profiles present', () => {
  const files = {};
  const homes = ['default', 'luxord', 'saix', 'namine', 'riku'].map(homeOf);
  for (const home of homes) files[path.join(home, 'config.yaml')] = 'model: x\n';
  const { runs, run } = runner();
  const logged = [];
  const result = runActivation({ argv: ['--apply', '--profile', 'saix'], deps: { root: ROOT, ...fakeTree(files), run, log: (line) => logged.push(line), repoVersion: '0.3.4' } });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'applied');
  assert.deepEqual(runs, [buildPluginInstallCommand({ profile: 'saix' })]);
  assert.deepEqual(result.touches, [path.join(ROOT, 'profiles', 'saix', 'config.yaml')]);
  assert.match(logged.join('\n'), /Restart the saix profile's gateway/);
});

test('apply on a stale flat copy needs --replace, and a nested copy is refused with a move-it hint and nothing runs', () => {
  const home = homeOf('luxord');
  const stale = fakeTree({ [manifestAt(home, COMPANION_PLUGIN_NAME)]: PLUGIN_YAML('0.2.0') });
  const { runs, run } = runner();
  const errors = [];
  const base = { root: ROOT, ...stale, run, log: () => {}, errorLog: (line) => errors.push(line), repoVersion: '0.3.4' };
  assert.equal(runActivation({ argv: ['--apply', '--profile', 'luxord'], deps: base }).reason, 'plugin-stale');
  assert.equal(runs.length, 0);
  const replaced = runActivation({ argv: ['--apply', '--replace', '--profile', 'luxord'], deps: base });
  assert.equal(replaced.ok, true);
  assert.deepEqual(runs[0].args.slice(0, 3), ['plugins', 'install', COMPANION_INSTALL_SOURCE]);
  assert.ok(runs[0].args.includes('--force'));

  const nested = fakeTree({ [manifestAt(homeOf('default'), 'hermes-browser-extension', 'companion-plugin')]: PLUGIN_YAML('0.2.0') });
  const blocked = runActivation({ argv: ['--apply', '--replace', '--profile', 'default'], deps: { ...base, ...nested } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'nested-copy-present');
  assert.equal(runs.length, 1, 'nothing more ran');
  assert.match(errors.join('\n'), /Move that directory out of the profile/);
});

test('an up-to-date enabled profile is a no-op even with --apply', () => {
  const home = homeOf('luxord');
  const tree = fakeTree({ [manifestAt(home, COMPANION_PLUGIN_NAME)]: PLUGIN_YAML('0.3.4'), [path.join(home, 'config.yaml')]: ENABLED_CONFIG });
  const { runs, run } = runner();
  const result = runActivation({ argv: ['--apply', '--profile', 'luxord'], deps: { root: ROOT, ...tree, run, log: () => {}, repoVersion: '0.3.4' } });
  assert.equal(result.ok, true);
  assert.equal(result.noop, true);
  assert.equal(runs.length, 0);
});

test('a failed CLI run, or a spawn that never started, cannot be reported as success', () => {
  const home = homeOf('demo');
  const tree = fakeTree({}, [home]);
  const failed = runActivation({ argv: ['--apply', '--profile', 'demo'], deps: { root: ROOT, ...tree, run: () => ({ status: 3 }), log: () => {} } });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 3);
  const spawnFailed = runActivation({ argv: ['--apply', '--profile', 'demo'], deps: { root: ROOT, ...tree, run: () => ({ status: null, error: new Error('Command unavailable') }), log: () => {} } });
  assert.equal(spawnFailed.ok, false);
  assert.equal(spawnFailed.exitCode, 1);
});

test('lists, wildcards and "all" never reach the CLI', () => {
  const { runs, run } = runner();
  const result = runActivation({ argv: ['--apply', '--profile', 'all'], deps: { root: ROOT, exists: () => assert.fail('no fs access'), run, errorLog: () => {} } });
  assert.equal(result.ok, false);
  assert.equal(runs.length, 0);
});

test('the script never hand-writes config YAML, never deletes or moves files, and hardcodes no personal profile', () => {
  const source = readFileSync(new URL('../scripts/enable-bot-companion-tools.mjs', import.meta.url), 'utf8');
  assert.equal(/writeFileSync|appendFileSync|save_config|rmSync|unlinkSync|renameSync|rmdirSync|cpSync|copyFileSync/.test(source), false, 'no file is written, moved or removed by the script');
  for (const name of ['roxas', 'luxord', 'namine', 'riku', 'saix']) {
    assert.equal(source.toLowerCase().includes(name), false, `no personal profile "${name}" is hardcoded`);
  }
  // Every spawned command is the official `hermes plugins ...` CLI.
  assert.equal([...source.matchAll(/spawnSync\(/g)].length, 1);
  assert.match(source, /command: 'hermes'/);
});

test('the default install source names a subdirectory plugins install understands and the plugin that is in this repository', () => {
  const [url, subdir] = COMPANION_INSTALL_SOURCE.split('#');
  assert.match(url, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/);
  assert.equal(subdir, 'companion-plugin');
  assert.equal(readFileSync(new URL(`../${subdir}/plugin.yaml`, import.meta.url), 'utf8').includes(`name: ${COMPANION_PLUGIN_NAME}`), true);
  assert.match(repoPluginVersion(), /^\d+\.\d+\.\d+$/);
});

// ---------------------------------------------------------------------------
// Discovery is read-only
// ---------------------------------------------------------------------------

test('--list discovers every profile read-only and reports staged version, staleness and enablement', () => {
  const luxord = homeOf('luxord');
  const saix = homeOf('saix');
  const namine = homeOf('namine');
  const tree = fakeTree({
    [manifestAt(ROOT, 'hermes-browser-extension', 'companion-plugin')]: PLUGIN_YAML('0.2.0'),
    [path.join(ROOT, 'config.yaml')]: ENABLED_CONFIG,
    [manifestAt(luxord, COMPANION_PLUGIN_NAME)]: PLUGIN_YAML('0.3.4'),
    [path.join(luxord, 'config.yaml')]: ENABLED_CONFIG,
    [manifestAt(saix, COMPANION_PLUGIN_NAME)]: PLUGIN_YAML('0.3.4'),
    [path.join(saix, 'config.yaml')]: 'model: x\n',
    [path.join(namine, 'config.yaml')]: 'plugins:\n  enabled:\n    - other\n',
  }, [homeOf('riku')]);
  const { runs, run } = runner();
  const logged = [];
  const result = runActivation({ argv: ['--list'], deps: { root: ROOT, ...tree, repoVersion: '0.3.4', run, log: (line) => logged.push(line) } });
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
  assert.match(logged.join('\n'), /nested copy: hermes plugins install\/update does not manage it/);
  for (const extra of [['--apply'], ['--profile', 'a'], ['--replace'], ['--source', 'x'], ['--ref', SHA]]) {
    assert.equal(runActivation({ argv: ['--list', ...extra], deps: { root: ROOT, errorLog: () => {} } }).ok, false, extra.join(' '));
  }
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
    writeFileSync(path.join(root, 'profiles', 'luxord', 'plugins', COMPANION_PLUGIN_NAME, 'plugin.yaml'), PLUGIN_YAML('0.2.0'));
    writeFileSync(path.join(root, 'profiles', 'luxord', 'config.yaml'), 'model: m\n');
    writeFileSync(path.join(root, 'profiles', 'namine', 'config.yaml'), 'model: m\n');
    mkdirSync(path.join(root, 'profiles', 'riku'), { recursive: true });
    const before = snapshot(root);
    const { runs, run } = runner();
    const deps = { root, repoVersion: '0.3.4', run, log: () => {}, errorLog: () => {} };
    const listed = runActivation({ argv: ['--list'], deps });
    assert.equal(listed.profiles.find((row) => row.profile === 'luxord').state, 'stale');
    assert.equal(listed.profiles.find((row) => row.profile === 'namine').state, 'not-staged');
    assert.equal(runActivation({ argv: ['--profile', 'luxord'], deps }).reason, 'plugin-stale');
    assert.equal(runActivation({ argv: ['--profile', 'luxord', '--replace'], deps }).dryRun, true);
    assert.equal(runActivation({ argv: ['--profile', 'riku'], deps }).dryRun, true);
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
