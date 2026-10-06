#!/usr/bin/env node
/**
 * Enable the Hermes Browser companion plugin for ONE given profile.
 *
 * This script is intentionally conservative:
 *   - it is a DRY RUN by default; nothing is written or executed
 *   - it only acts with an explicit `--apply` AND `--profile <name>`
 *   - it only touches the given profile directory, and refuses unless the
 *     companion plugin manifest is already staged there
 *   - it never hand-edits config.yaml or rewrites skills; it shells out to the
 *     documented `hermes plugins enable <name> --profile <name>` convention,
 *     which writes `plugins.enabled` (the opt-in allow-list)
 *   - it hardcodes no personal profile name
 *
 * Usage:
 *   node scripts/enable-bot-companion-tools.mjs --profile <name>
 *   node scripts/enable-bot-companion-tools.mjs --apply --profile <name>
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const COMPANION_PLUGIN_NAME = 'hermes-browser-companion';
export const COMPANION_PLUGIN_MANIFEST = 'plugin.yaml';

const HELP = [
  'Enable the Hermes Browser companion plugin for one profile.',
  '',
  '  node scripts/enable-bot-companion-tools.mjs --profile <name>            (dry run)',
  '  node scripts/enable-bot-companion-tools.mjs --apply --profile <name>    (apply)',
  '',
  'Notes:',
  '  - Enables the PLUGIN (plugins.enabled), never a skill.',
  '  - A newly discovered plugin auto-enables its toolset; a toolset that is',
  '    explicitly turned off needs its own validated `hermes tools enable` call.',
].join('\n');

export function parseArgs(argv = []) {
  const options = { apply: false, profile: '', help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--profile' || arg === '-p') options.profile = String(argv[++index] ?? '').trim();
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length).trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function defaultHermesRoot(env = process.env) {
  const configured = String(env?.HERMES_HOME ?? '').trim();
  if (configured) return configured;
  return path.join(homedir(), '.hermes');
}

/** The profile home directory: `profiles/<name>`, or the root for `default`. */
export function resolveProfileHome({ root = '', profile = '', exists = () => false } = {}) {
  const name = String(profile || '').trim();
  if (!root || !name) return '';
  const named = path.join(root, 'profiles', name);
  if (exists(named)) return named;
  if (name === 'default' && exists(root)) return root;
  return '';
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

/**
 * Resolve an activation plan without touching the filesystem or shelling out.
 * `ok: false` carries a machine-readable `reason`; the caller must report it
 * rather than change any real configuration.
 */
export function buildActivationPlan({ profile = '', root = '', exists = () => false } = {}) {
  const name = String(profile || '').trim();
  if (!name) return { ok: false, reason: 'profile-required', profile: '' };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) return { ok: false, reason: 'invalid-profile', profile: name };
  const profileHome = resolveProfileHome({ root, profile: name, exists });
  if (!profileHome) return { ok: false, reason: 'profile-missing', profile: name };
  const pluginDir = companionPluginDir(profileHome);
  const manifestPath = path.join(pluginDir, COMPANION_PLUGIN_MANIFEST);
  if (!exists(manifestPath)) {
    return { ok: false, reason: 'plugin-not-staged', profile: name, profileHome, pluginDir, manifestPath };
  }
  return { ok: true, profile: name, profileHome, pluginDir, manifestPath, command: buildPluginEnableCommand(name) };
}

export function runActivation({ argv = [], deps = {} } = {}) {
  const {
    env = process.env,
    exists = (target) => existsSync(target),
    run = (command) => spawnSync(command.command, command.args, { stdio: 'inherit' }),
    log = (line) => console.log(line),
    errorLog = (line) => console.error(line),
    root: rootOverride = '',
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
  const plan = buildActivationPlan({ profile: options.profile, root, exists });
  const mode = options.apply ? 'apply' : 'dry-run';
  if (!plan.ok) {
    errorLog(JSON.stringify({ mode, ...plan }, null, 2));
    return { ...plan, mode, exitCode: 1 };
  }

  const report = {
    mode,
    profile: plan.profile,
    profileHome: plan.profileHome,
    pluginDir: plan.pluginDir,
    manifestPath: plan.manifestPath,
    command: plan.command,
    status: 'ready',
  };
  if (!options.apply) {
    log(`Would run: ${plan.command.command} ${plan.command.args.join(' ')}`);
    log(JSON.stringify(report, null, 2));
    return { ok: true, dryRun: true, ...report, exitCode: 0 };
  }

  log(`Enabling ${COMPANION_PLUGIN_NAME} for profile ${plan.profile}...`);
  const result = run(plan.command);
  const runStatus = !result?.error && Number.isInteger(result?.status) ? result.status : 1;
  return { ok: runStatus === 0, ...report, status: runStatus === 0 ? 'enabled' : 'failed', runStatus, exitCode: runStatus };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const result = runActivation({ argv: process.argv.slice(2) });
  process.exitCode = Number(result.exitCode) || 0;
}