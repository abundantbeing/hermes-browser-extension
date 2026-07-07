#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const distDir = path.join(root, 'dist');
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const json = args.has('--json');
const skipBuild = args.has('--skip-build');
const skipOpen = args.has('--skip-open');
const gatewayUrl = String(process.env.HERMES_BROWSER_GATEWAY_URL || 'http://127.0.0.1:8642').replace(/\/+$/, '');

const knownBrowsers = [
  {
    id: 'edge',
    name: 'Microsoft Edge',
    progIdHints: ['microsoftedge', 'msehtm'],
    envPath: ['LOCALAPPDATA', 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
    localState: ['LOCALAPPDATA', 'Microsoft', 'Edge', 'User Data', 'Local State'],
    extensionsUrl: 'edge://extensions',
  },
  {
    id: 'chrome',
    name: 'Google Chrome',
    progIdHints: ['chromehtml'],
    envPath: ['LOCALAPPDATA', 'Google', 'Chrome', 'Application', 'chrome.exe'],
    localState: ['LOCALAPPDATA', 'Google', 'Chrome', 'User Data', 'Local State'],
    extensionsUrl: 'chrome://extensions',
  },
  {
    id: 'brave',
    name: 'Brave',
    progIdHints: ['brave'],
    envPath: ['LOCALAPPDATA', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    localState: ['LOCALAPPDATA', 'BraveSoftware', 'Brave-Browser', 'User Data', 'Local State'],
    extensionsUrl: 'brave://extensions',
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    progIdHints: ['vivaldi'],
    envPath: ['LOCALAPPDATA', 'Vivaldi', 'Application', 'vivaldi.exe'],
    localState: ['LOCALAPPDATA', 'Vivaldi', 'User Data', 'Local State'],
    extensionsUrl: 'vivaldi://extensions',
  },
];

const actions = [];

function envJoin(parts) {
  const [envName, ...rest] = parts;
  const base = process.env[envName];
  return base ? path.join(base, ...rest) : '';
}

function commandExists(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [command] : ['-v', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0 ? String(result.stdout || '').split(/\r?\n/).find(Boolean) || command : '';
}

function run(action, command, commandArgs, options = {}) {
  actions.push({ id: action, command, args: commandArgs, dryRun });
  if (dryRun) return { status: 0, stdout: '', stderr: '' };
  return spawnSync(command, commandArgs, {
    cwd: options.cwd || root,
    encoding: options.encoding || 'utf8',
    stdio: options.stdio || 'inherit',
    windowsHide: true,
  });
}

function runCapture(command, commandArgs) {
  if (dryRun) return { status: 0, stdout: '', stderr: '' };
  return spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function readDefaultProgId() {
  if (process.platform !== 'win32') return '';
  const result = runCapture('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice', '/v', 'ProgId']);
  if (result.status !== 0) return '';
  const match = String(result.stdout || '').match(/ProgId\s+REG_\w+\s+([^\r\n]+)/i);
  return match ? match[1].trim() : '';
}

function detectDefaultChromiumBrowser() {
  const progId = readDefaultProgId();
  const lower = progId.toLowerCase();
  const hinted = knownBrowsers.find((browser) => browser.progIdHints.some((hint) => lower.includes(hint)));
  const candidates = [hinted, ...knownBrowsers].filter(Boolean);
  const seen = new Set();
  for (const browser of candidates) {
    if (seen.has(browser.id)) continue;
    seen.add(browser.id);
    const configuredPath = envJoin(browser.envPath);
    const executable = configuredPath && fs.existsSync(configuredPath)
      ? configuredPath
      : commandExists(browser.id === 'edge' ? 'msedge.exe' : `${browser.id}.exe`);
    if (executable || browser === hinted) {
      return {
        ...browser,
        progId,
        executable: executable || '',
        detectedBy: hinted === browser ? 'windows-default-browser' : 'installed-chromium-fallback',
      };
    }
  }
  return {
    id: 'unknown',
    name: 'Default Chromium browser',
    progId,
    executable: '',
    extensionsUrl: 'chrome://extensions',
    localState: [],
    detectedBy: 'fallback',
  };
}

function readDevModeSignal(browser) {
  const statePath = browser?.localState?.length ? envJoin(browser.localState) : '';
  const result = { checked: statePath, enabled: null, reason: '' };
  if (!statePath) {
    result.reason = 'no-local-state-path';
    return result;
  }
  if (!fs.existsSync(statePath)) {
    result.reason = 'local-state-not-found';
    return result;
  }
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const value = state?.extensions?.ui?.developer_mode ?? state?.extensions?.settings?.developer_mode;
    result.enabled = typeof value === 'boolean' ? value : null;
    result.reason = result.enabled === null ? 'developer-mode-key-not-found' : 'ok';
    return result;
  } catch (error) {
    result.reason = `local-state-parse-failed: ${error.message}`;
    return result;
  }
}

function openDetached(command, commandArgs, actionId) {
  actions.push({ id: actionId, command, args: commandArgs, dryRun });
  if (dryRun || skipOpen) return;
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  if (result.error) throw result.error;
}

async function probePairing() {
  actions.push({ id: 'probe-local-hermes', url: `${gatewayUrl}/health`, dryRun });
  actions.push({ id: 'start-local-pairing', url: `${gatewayUrl}/api/browser-extension/pair/start`, dryRun });
  if (dryRun) return { ok: false, manualSetup: true, reason: 'dry-run' };
  try {
    const health = await fetch(`${gatewayUrl}/health`, { method: 'GET' });
    if (!health.ok) return { ok: false, manualSetup: true, reason: `health-${health.status}` };
    const response = await fetch(`${gatewayUrl}/api/browser-extension/pair/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hermes Browser Extension', source: 'windows-setup-helper' }),
    });
    const text = await response.text();
    let payload = {};
    try { payload = JSON.parse(text); } catch { payload = {}; }
    if (response.ok && payload.token) return { ok: true, token: payload.token, manualSetup: false };
    return { ok: false, manualSetup: true, reason: payload?.error?.code || payload?.error?.message || `pair-${response.status}` };
  } catch (error) {
    return { ok: false, manualSetup: true, reason: error.message };
  }
}

function readApiServerKey() {
  const envFile = path.join(os.homedir(), '.hermes', '.env');
  if (!fs.existsSync(envFile)) return { envFile, key: '', reason: 'env-not-found' };
  const text = fs.readFileSync(envFile, 'utf8');
  const match = text.match(/^API_SERVER_KEY=(.+)$/m);
  return { envFile, key: match ? match[1].trim() : '', reason: match ? 'ok' : 'key-not-found' };
}

function copySecretToClipboard(secret, label) {
  actions.push({ id: label, command: 'clip', args: ['<redacted>'], dryRun });
  if (dryRun) return true;
  if (!secret) return false;
  const result = spawnSync('clip', { input: secret, encoding: 'utf8', windowsHide: true });
  return result.status === 0;
}

async function main() {
  const browser = detectDefaultChromiumBrowser();
  const devMode = readDevModeSignal(browser);

  if (!skipBuild) {
    const build = run('build-dist', 'npm', ['run', 'build'], { cwd: root });
    if (build.status !== 0) process.exit(build.status || 1);
  } else {
    actions.push({ id: 'build-dist', skipped: true, reason: '--skip-build', dryRun });
  }

  if (!dryRun && !fs.existsSync(distDir)) {
    throw new Error(`dist/ was not found after build: ${distDir}`);
  }

  if (process.platform === 'win32') {
    openDetached('explorer.exe', [distDir], 'open-dist-folder');
  } else {
    actions.push({ id: 'open-dist-folder', skipped: true, reason: 'not-windows', path: distDir, dryRun });
  }

  if (browser.executable) {
    openDetached(browser.executable, [browser.extensionsUrl], 'open-browser-extensions-page');
  } else if (process.platform === 'win32') {
    openDetached('cmd.exe', ['/c', 'start', '', browser.extensionsUrl], 'open-browser-extensions-page');
  } else {
    actions.push({ id: 'open-browser-extensions-page', skipped: true, reason: 'no-browser-executable', url: browser.extensionsUrl, dryRun });
  }

  const pairing = await probePairing();
  let copiedFallbackKey = false;
  const useClip = args.has('--clip');

  if (pairing.token) {
    if (useClip) {
      copiedFallbackKey = copySecretToClipboard(pairing.token, 'copy-pairing-token-to-clipboard');
    } else {
      actions.push({ id: 'copy-pairing-token-to-clipboard', skipped: true, reason: 'no-clip-flag', dryRun });
    }
  } else if (pairing.manualSetup) {
    if (dryRun) {
      actions.push({ id: 'copy-api-server-key-fallback-to-clipboard', command: 'clip', args: ['<redacted>'], dryRun });
      pairing.fallback = { envFile: path.join(os.homedir(), '.hermes', '.env'), reason: 'dry-run', copied: false };
    } else {
      const key = readApiServerKey();
      if (useClip) {
        copiedFallbackKey = copySecretToClipboard(key.key, 'copy-api-server-key-fallback-to-clipboard');
      } else {
        actions.push({ id: 'copy-api-server-key-fallback-to-clipboard', skipped: true, reason: 'no-clip-flag', dryRun });
      }
      pairing.fallback = { envFile: key.envFile, reason: key.reason, copied: copiedFallbackKey };
    }
  }

  const summary = {
    dryRun,
    root,
    distDir,
    gatewayUrl,
    browser: {
      id: browser.id,
      name: browser.name,
      progId: browser.progId || '',
      executable: browser.executable || '',
      extensionsUrl: browser.extensionsUrl,
      detectedBy: browser.detectedBy,
    },
    devMode,
    pairing: { ...pairing, token: pairing.token ? '[REDACTED]' : undefined, copiedFallbackKey },
    actions,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    console.log('Hermes Browser Extension setup/update helper');
    console.log(`- Browser: ${summary.browser.name} (${summary.browser.detectedBy})`);
    console.log(`- Dev mode signal: ${devMode.enabled === null ? devMode.reason : devMode.enabled ? 'enabled' : 'disabled / please enable it on the extensions page'}`);
    console.log(`- Built dist: ${distDir}`);
    console.log(`- Extensions page: ${summary.browser.extensionsUrl}`);
    if (pairing.manualSetup) {
      if (copiedFallbackKey) {
        console.log('- Pairing endpoint unavailable; copied API_SERVER_KEY fallback to clipboard. Paste it into Settings → API key.');
      } else {
        const key = readApiServerKey();
        console.log(`- Pairing endpoint unavailable. Paste this API key fallback into Settings → API key:\n  ${key.key || '(none)'}`);
        console.log('  [SECURITY WARNING] The token/key was not copied to the clipboard. Run setup with --clip if you want to copy it automatically.');
      }
    } else {
      if (copiedFallbackKey) {
        console.log('- Pairing token copied to clipboard. Paste it into Settings → API key if the extension did not auto-connect.');
      } else {
        console.log(`- Pairing token: ${pairing.token || '(none)'}\n  Paste this token into Settings → API key if the extension did not auto-connect.`);
        console.log('  [SECURITY WARNING] The token/key was not copied to the clipboard. Run setup with --clip if you want to copy it automatically.');
      }
    }
    console.log('Load/reload the unpacked extension from dist/.');
  }
}

main().catch((error) => {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message, actions }, null, 2));
    process.stdout.write('\n');
  } else {
    console.error(error.message);
  }
  process.exit(1);
});
