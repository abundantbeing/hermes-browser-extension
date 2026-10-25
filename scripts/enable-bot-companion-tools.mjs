#!/usr/bin/env node
/**
 * Install and enable the Hermes Browser companion plugin for ONE profile, with
 * Hermes' own `hermes plugins install`. This script is a thin, careful wrapper:
 * the clone, the security scan, the atomic install and the `plugins.enabled`
 * entry are all done by the official CLI; the script adds only what the CLI does
 * not know about this plugin.
 *
 *   - `--list` is a read-only discovery: every profile, whether the companion
 *     plugin is installed there (and which version, in which layout), and whether
 *     the profile's config enables it. Nothing is written or executed.
 *   - it is a DRY RUN by default: it prints the exact command and writes nothing
 *   - it only acts with an explicit `--apply` AND exactly one `--profile <name>`;
 *     lists, wildcards and `all` are refused
 *   - it refuses while an older copy sits in the nested layout
 *     (`plugins/<dir>/companion-plugin`, how this plugin used to be copied in):
 *     that copy and the new one would both match the enabled name and register
 *     every tool twice. It never moves or deletes files; it says what to move
 *   - an installed flat copy of a different version is replaced only with
 *     `--replace` (the CLI's `--force`); the same version is left alone
 *   - it never edits config.yaml itself and hardcodes no personal profile name
 *
 * Usage:
 *   node scripts/enable-bot-companion-tools.mjs --list
 *   node scripts/enable-bot-companion-tools.mjs --profile <name>                  (dry run)
 *   node scripts/enable-bot-companion-tools.mjs --apply --profile <name>
 *   node scripts/enable-bot-companion-tools.mjs --apply --profile <name> --replace
 *   node scripts/enable-bot-companion-tools.mjs --profile <name> --source <git-url#companion-plugin> [--ref <40-hex sha>]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COMPANION_PLUGIN_NAME = 'hermes-browser-companion';
export const COMPANION_PLUGIN_MANIFEST = 'plugin.yaml';
// The plugin lives in a subdirectory of this repository; `hermes plugins install`
// reads `<git url>#<subdir>` and sparse-checks-out only that directory.
export const COMPANION_INSTALL_SOURCE = 'https://github.com/abundantbeing/hermes-browser-extension.git#companion-plugin';

const HELP = [
  'Install and enable the Hermes Browser companion plugin for one profile,',
  'through the official `hermes plugins install`.',
  '',
  '  node scripts/enable-bot-companion-tools.mjs --list                       (discovery, read-only)',
  '  node scripts/enable-bot-companion-tools.mjs --profile <name>            (dry run)',
  '  node scripts/enable-bot-companion-tools.mjs --apply --profile <name>    (apply)',
  '',
  'Options:',
  '  --replace          reinstall over an installed copy of a different version (hermes plugins install --force)',
  '  --source <id>      git URL or owner/repo[/subdir] instead of the default (e.g. a file:// clone while testing)',
  '  --ref <sha>        install exactly this 40-character commit',
  '',
  'Notes:',
  '  - Exactly one profile per run; lists, wildcards and "all" are refused.',
  '  - Enables the PLUGIN (plugins.enabled), never a skill.',
  "  - Restart that profile's gateway afterwards: tools, hooks and the status route load at start.",
  '  - A nested older copy (plugins/<dir>/companion-plugin) must be moved aside first; this',
  '    script never moves or deletes files.',
].join('\n');

// Mirrors Hermes' own profile id rule (lower-case; Hermes casefolds the flag).
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_PROFILE_TOKENS = new Set(['all', '*']);

export function parseArgs(argv = []) {
  const options = { apply: false, profile: '', help: false, list: false, replace: false, source: '', ref: '' };
  let profileFlags = 0;
  const valueOf = (flag, value) => {
    const text = String(value ?? '').trim();
    if (!text || text.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return text;
  };
  const setProfile = (value) => {
    profileFlags += 1;
    if (profileFlags > 1) throw new Error('Only one --profile is allowed per run.');
    options.profile = String(value ?? '').trim();
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--list' || arg === '--discover') options.list = true;
    else if (arg === '--replace') options.replace = true;
    else if (arg === '--source') options.source = valueOf('--source', argv[++index]);
    else if (arg.startsWith('--source=')) options.source = valueOf('--source', arg.slice('--source='.length));
    else if (arg === '--ref') options.ref = valueOf('--ref', argv[++index]);
    else if (arg.startsWith('--ref=')) options.ref = valueOf('--ref', arg.slice('--ref='.length));
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--profile' || arg === '-p') setProfile(argv[++index]);
    else if (arg.startsWith('--profile=')) setProfile(arg.slice('--profile='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.ref && !/^[0-9a-f]{40}$/i.test(options.ref)) throw new Error('--ref must be a full 40-character commit SHA.');
  return options;
}

/**
 * The Hermes root that holds `profiles/`. HERMES_HOME may name the root or a
 * profile directory (`<root>/profiles/<name>`), exactly as Hermes itself reads it.
 */
export function defaultHermesRoot(env = process.env) {
  const configured = String(env?.HERMES_HOME ?? '').trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (path.basename(path.dirname(resolved)).toLowerCase() === 'profiles') return path.dirname(path.dirname(resolved));
    return configured;
  }
  return path.join(homedir(), '.hermes');
}

/**
 * The profile home directory: `profiles/<name>`, or the root for `default`.
 * Hermes always maps `default` to the root, even when a stray `profiles/default`
 * directory exists (this machine has one holding only pairing state).
 */
export function resolveProfileHome({ root = '', profile = '', exists = () => false } = {}) {
  const name = String(profile || '').trim();
  if (!root || !name) return '';
  if (name === 'default') return exists(root) ? root : '';
  const named = path.join(root, 'profiles', name);
  return exists(named) ? named : '';
}

export function companionPluginDir(profileHome = '') {
  return path.join(profileHome, 'plugins', COMPANION_PLUGIN_NAME);
}

export function buildPluginEnableCommand(profile = '') {
  return {
    command: 'hermes',
    args: ['plugins', 'enable', COMPANION_PLUGIN_NAME, '--profile', String(profile || '').trim()],
  };
}

/** `hermes plugins install <source> --enable [--ref <sha>] [--force] --profile <name>`. */
export function buildPluginInstallCommand({ profile = '', source = '', ref = '', force = false } = {}) {
  return {
    command: 'hermes',
    args: [
      'plugins', 'install', String(source || COMPANION_INSTALL_SOURCE), '--enable',
      ...(ref ? ['--ref', String(ref)] : []),
      ...(force ? ['--force'] : []),
      '--profile', String(profile || '').trim(),
    ],
  };
}

function yamlScalar(text, key) {
  const match = new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'm').exec(String(text || ''));
  return match ? match[1].replace(/^['"]|['"]$/g, '') : '';
}

/** `name` and `version` of a plugin.yaml, without a YAML parser. */
export function readPluginManifest(text = '') {
  return { name: yamlScalar(text, 'name'), version: yamlScalar(text, 'version') };
}

/**
 * Find the staged companion plugin the way Hermes discovers user plugins: a
 * manifest named `hermes-browser-companion` at `plugins/<dir>/plugin.yaml` or one
 * level deeper (`plugins/<category>/<dir>/plugin.yaml`). The canonical
 * `plugins/hermes-browser-companion/` location is preferred.
 */
export function findStagedCompanion({ profileHome = '', exists = () => false, readDir = () => [], readText = () => '' } = {}) {
  if (!profileHome) return null;
  const pluginsRoot = path.join(profileHome, 'plugins');
  const describe = (pluginDir, layout) => {
    const manifestPath = path.join(pluginDir, COMPANION_PLUGIN_MANIFEST);
    let text = '';
    try { text = readText(manifestPath); } catch { text = ''; }
    const manifest = readPluginManifest(text);
    return { pluginDir, manifestPath, layout, name: manifest.name || COMPANION_PLUGIN_NAME, version: manifest.version };
  };
  const canonical = companionPluginDir(profileHome);
  if (exists(path.join(canonical, COMPANION_PLUGIN_MANIFEST))) return describe(canonical, 'flat');
  const names = (directory) => {
    try { return readDir(directory).filter((entry) => !(entry.startsWith('__') && entry.endsWith('__'))); } catch { return []; }
  };
  const matches = (pluginDir) => {
    const manifestPath = path.join(pluginDir, COMPANION_PLUGIN_MANIFEST);
    if (!exists(manifestPath)) return false;
    try { return readPluginManifest(readText(manifestPath)).name === COMPANION_PLUGIN_NAME; } catch { return false; }
  };
  for (const entry of names(pluginsRoot)) {
    const first = path.join(pluginsRoot, entry);
    if (matches(first)) return describe(first, 'flat');
    for (const inner of names(first)) {
      const second = path.join(first, inner);
      if (matches(second)) return describe(second, 'nested');
    }
  }
  return null;
}

/**
 * Whether a profile's config.yaml lists the companion plugin under
 * `plugins.enabled`: 'yes' | 'no' | 'unknown' (no file, or a shape this
 * line scanner does not understand). It never writes.
 */
export function companionEnabledInConfig(text = null) {
  if (typeof text !== 'string') return 'unknown';
  const lines = text.split(/\r?\n/);
  const pluginsAt = lines.findIndex((line) => /^plugins:\s*(#.*)?$/.test(line));
  if (pluginsAt < 0) return 'no';
  let enabledAt = -1;
  let indent = 0;
  for (let index = pluginsAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line) && line.trim() && !line.startsWith('#')) break;
    const match = /^(\s+)enabled:\s*(.*?)\s*(#.*)?$/.exec(line);
    if (match) { enabledAt = index; indent = match[1].length; break; }
  }
  if (enabledAt < 0) return 'no';
  const inline = /^(\s+)enabled:\s*(.*?)\s*(#.*)?$/.exec(lines[enabledAt])[2];
  if (inline.startsWith('[')) {
    return inline.replace(/[[\]'"]/g, '').split(',').map((item) => item.trim()).includes(COMPANION_PLUGIN_NAME) ? 'yes' : 'no';
  }
  if (inline && inline !== '|' && inline !== '>') return 'unknown';
  for (let index = enabledAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^(\s*)-\s*['"]?([^'"#\s][^'"#]*?)['"]?\s*(#.*)?$/.exec(line);
    if (!item || item[1].length < indent) break;
    if (item[2] === COMPANION_PLUGIN_NAME) return 'yes';
  }
  return 'no';
}

/** This repository's companion plugin version (`companion-plugin/plugin.yaml`). */
export function repoPluginVersion(readText = (file) => readFileSync(file, 'utf8')) {
  try {
    const manifest = fileURLToPath(new URL(`../companion-plugin/${COMPANION_PLUGIN_MANIFEST}`, import.meta.url));
    return readPluginManifest(readText(manifest)).version;
  } catch {
    return '';
  }
}

/** Read-only discovery of every profile under the Hermes root. */
export function discoverProfiles({
  root = '',
  exists = () => false,
  readDir = () => [],
  readText = () => '',
  isDirectory = () => true,
  repoVersion = '',
} = {}) {
  const names = [];
  if (exists(root)) names.push('default');
  try {
    for (const entry of readDir(path.join(root, 'profiles'))) {
      if (PROFILE_NAME.test(entry) && isDirectory(path.join(root, 'profiles', entry))) names.push(entry);
    }
  } catch { /* no profiles directory */ }
  return [...new Set(names)].map((name) => {
    const profileHome = resolveProfileHome({ root, profile: name, exists });
    const staged = findStagedCompanion({ profileHome, exists, readDir, readText });
    const configPath = path.join(profileHome, 'config.yaml');
    let configText = null;
    try { if (exists(configPath)) configText = readText(configPath); } catch { configText = null; }
    const enabled = companionEnabledInConfig(configText);
    const stale = Boolean(staged && repoVersion && staged.version && staged.version !== repoVersion);
    return {
      profile: name,
      profileHome,
      staged: staged ? { pluginDir: staged.pluginDir, layout: staged.layout, version: staged.version } : null,
      enabled,
      stale,
      state: !staged ? 'not-staged' : stale ? 'stale' : enabled === 'yes' ? 'enabled' : 'staged',
    };
  });
}

/**
 * Resolve what to run without touching the filesystem or shelling out.
 * `ok: false` carries a machine-readable `reason`; the caller reports it and
 * changes nothing. `ok: true` carries the one official command (or none, with
 * `noop: true`, when the profile already has the current copy enabled).
 */
export function buildActivationPlan({
  profile = '',
  root = '',
  exists = () => false,
  readDir = () => [],
  readText = () => '',
  repoVersion = '',
  replace = false,
  source = '',
  ref = '',
} = {}) {
  const raw = String(profile || '').trim();
  if (!raw) return { ok: false, reason: 'profile-required', profile: '' };
  const name = raw.toLowerCase();
  if (RESERVED_PROFILE_TOKENS.has(name) || /[,\s*?]/.test(raw)) return { ok: false, reason: 'single-profile-only', profile: raw };
  if (!PROFILE_NAME.test(name)) return { ok: false, reason: 'invalid-profile', profile: raw };
  const profileHome = resolveProfileHome({ root, profile: name, exists });
  if (!profileHome) return { ok: false, reason: 'profile-missing', profile: name };
  const staged = findStagedCompanion({ profileHome, exists, readDir, readText });
  const base = { profile: name, profileHome, repoVersion, touches: [path.join(profileHome, 'config.yaml')] };

  if (!staged) {
    return { ok: true, ...base, action: 'install', command: buildPluginInstallCommand({ profile: name, source, ref }) };
  }
  const { pluginDir, manifestPath, layout, version } = staged;
  const where = { pluginDir, manifestPath, layout, stagedVersion: version };
  if (layout === 'nested') {
    // Hermes discovers this copy and the one `plugins install` would add under the
    // same enabled name, so both would load and register every tool twice.
    return { ok: false, reason: 'nested-copy-present', ...base, ...where };
  }
  const current = Boolean(version) && (!repoVersion || version === repoVersion);
  if (current) {
    const enabled = companionEnabledInConfig(readConfig(profileHome, exists, readText));
    if (enabled === 'yes') return { ok: true, ...base, ...where, action: 'none', noop: true, command: null };
    return { ok: true, ...base, ...where, action: 'enable', command: buildPluginEnableCommand(name) };
  }
  if (!replace) return { ok: false, reason: 'plugin-stale', ...base, ...where };
  return { ok: true, ...base, ...where, action: 'replace', command: buildPluginInstallCommand({ profile: name, source, ref, force: true }) };
}

function readConfig(profileHome, exists, readText) {
  const configPath = path.join(profileHome, 'config.yaml');
  try { return exists(configPath) ? readText(configPath) : null; } catch { return null; }
}

const REFUSAL_HINTS = Object.freeze({
  'nested-copy-present': 'An older copy is nested under plugins/<dir>/companion-plugin. Move that directory out of the profile (for example to plugins-backup/), then run this again. See companion-plugin/install.md.',
  'plugin-stale': 'A copy of a different version is installed. Re-run with --replace to reinstall it, or use hermes plugins update hermes-browser-companion.',
});

export function runActivation({ argv = [], deps = {} } = {}) {
  const {
    env = process.env,
    exists = (target) => existsSync(target),
    readDir = (directory) => readdirSync(directory),
    readText = (file) => readFileSync(file, 'utf8'),
    isDirectory = (target) => { try { return readdirSync(target) && true; } catch { return false; } },
    run = (command) => spawnSync(command.command, command.args, { stdio: 'inherit' }),
    log = (line) => console.log(line),
    errorLog = (line) => console.error(line),
    root: rootOverride = '',
    repoVersion = repoPluginVersion(),
  } = deps;

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    errorLog(String(error?.message || error));
    return { ok: false, reason: 'bad-args', exitCode: 2 };
  }
  if (options.help) {
    log(HELP);
    return { ok: true, reason: 'help', exitCode: 0 };
  }

  const root = String(rootOverride || options.hermesHome || defaultHermesRoot(env));

  if (options.list) {
    if (options.apply || options.profile || options.replace || options.source || options.ref) {
      errorLog('--list is read-only discovery; run it without --apply, --profile, --replace, --source or --ref.');
      return { ok: false, reason: 'bad-args', exitCode: 2 };
    }
    const profiles = discoverProfiles({ root, exists, readDir, readText, isDirectory, repoVersion });
    log(`Hermes root: ${root}`);
    log(`Repository companion plugin version: ${repoVersion || 'unknown'}`);
    for (const row of profiles) {
      const where = row.staged ? `${row.staged.layout} copy v${row.staged.version || '?'} at ${row.staged.pluginDir}` : 'not staged';
      log(`  ${row.profile.padEnd(16)} ${row.state.padEnd(11)} enabled=${row.enabled}  ${where}`);
      if (row.staged?.layout === 'nested') {
        log(`  ${' '.repeat(16)} nested copy: hermes plugins install/update does not manage it; see companion-plugin/install.md to replace it`);
      }
    }
    log(JSON.stringify({ mode: 'list', root, repoVersion, profiles }, null, 2));
    return { ok: true, mode: 'list', root, repoVersion, profiles, exitCode: 0 };
  }

  const plan = buildActivationPlan({
    profile: options.profile, root, exists, readDir, readText, repoVersion,
    replace: options.replace, source: options.source, ref: options.ref,
  });
  const mode = options.apply ? 'apply' : 'dry-run';
  if (!plan.ok) {
    errorLog(JSON.stringify({ mode, ...plan, hint: REFUSAL_HINTS[plan.reason] || undefined }, null, 2));
    return { ...plan, mode, exitCode: 1 };
  }

  const report = {
    mode,
    profile: plan.profile,
    profileHome: plan.profileHome,
    action: plan.action,
    pluginDir: plan.pluginDir,
    manifestPath: plan.manifestPath,
    layout: plan.layout,
    stagedVersion: plan.stagedVersion,
    repoVersion: plan.repoVersion,
    command: plan.command,
    touches: plan.touches,
    status: plan.noop ? 'already-current' : 'ready',
  };
  if (plan.noop) {
    log(`Profile ${plan.profile} already has ${COMPANION_PLUGIN_NAME} ${plan.stagedVersion} installed and enabled. Nothing to do.`);
    log(JSON.stringify(report, null, 2));
    return { ok: true, noop: true, ...report, exitCode: 0 };
  }
  if (!options.apply) {
    log(`Would run: ${plan.command.command} ${plan.command.args.join(' ')}`);
    log(`Only this profile is changed: ${plan.touches.join(', ')}`);
    log(JSON.stringify(report, null, 2));
    return { ok: true, dryRun: true, ...report, exitCode: 0 };
  }

  log(`Running for profile ${plan.profile}: ${plan.command.command} ${plan.command.args.join(' ')}`);
  const result = run(plan.command);
  const runStatus = !result?.error && Number.isInteger(result?.status) ? result.status : 1;
  if (runStatus === 0) log(`Restart the ${plan.profile} profile's gateway so the plugin's tools, hooks and status route load.`);
  return { ok: runStatus === 0, ...report, status: runStatus === 0 ? 'applied' : 'failed', runStatus, exitCode: runStatus };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const result = runActivation({ argv: process.argv.slice(2) });
  process.exitCode = Number(result.exitCode) || 0;
}
