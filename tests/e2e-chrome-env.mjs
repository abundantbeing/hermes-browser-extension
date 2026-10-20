// Shared launch helpers for the real-Chromium e2e scripts.
//
// These keep the scripts runnable on Linux/macOS (CI containers, headless
// Chromium from a Playwright cache) as well as on the Windows machine they were
// first written on:
//   - chromeExecutable() honours CHROME_PATH, then falls back to a Playwright
//     style browser cache (PLAYWRIGHT_BROWSERS_PATH, ~/.cache/ms-playwright,
//     /opt/pw-browsers) before the Windows install locations.
//   - killProcessTree() uses taskkill on Windows and a process-group/SIGKILL
//     elsewhere.
//   - ensureExtensionStartupPage() recovers the startup tab when Chromium
//     navigates it before the unpacked extension is registered.
//   - launchChrome() is the one way a check starts a browser, so every browser
//     it opens is muted. tests/test-browser-silence.test.mjs fails any script
//     that spawns Chrome another way.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

function playwrightChromiumCandidates() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    '/opt/pw-browsers',
  ].filter(Boolean);
  const found = [];
  for (const root of roots) {
    let entries = [];
    try { entries = readdirSync(root); } catch { continue; }
    for (const entry of entries.filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
      found.push(
        path.join(root, entry, 'chrome-linux', 'chrome'),
        path.join(root, entry, 'chrome-linux64', 'chrome'),
        path.join(root, entry, 'chrome-win', 'chrome.exe'),
        path.join(root, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      );
    }
  }
  return found;
}

export function resolveChromeExecutable(extraCandidates = []) {
  const candidates = [
    process.env.CHROME_PATH,
    ...extraCandidates,
    ...playwrightChromiumCandidates(),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Chrome for Testing not found. Set CHROME_PATH.');
  return found;
}

// A check's browser never makes noise: a page with a video or a live stream
// would otherwise play through the speakers of whoever runs the check.
export const MUTE_AUDIO_FLAG = '--mute-audio';

/** `args` with the mute flag first and exactly once, whatever the caller passed. */
export function chromeLaunchArgs(args = []) {
  return [MUTE_AUDIO_FLAG, ...args.filter((arg) => arg !== MUTE_AUDIO_FLAG)];
}

/** Starts Chrome muted. Same arguments as `spawn(executable, args, options)`; `start` is only for tests. */
export function launchChrome(executable, args = [], options = {}, start = spawn) {
  return start(executable, chromeLaunchArgs(args), options);
}

export function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    }
    child.kill('SIGKILL');
  } catch { /* best effort */ }
}

async function cdpEvaluateOnce(webSocketUrl, expression, navigateTo) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`Could not connect to ${webSocketUrl}`));
  });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const payload = JSON.parse(String(event.data));
    const entry = payload.id ? pending.get(payload.id) : null;
    if (!entry) return;
    pending.delete(payload.id);
    entry(payload);
  };
  const call = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    if (navigateTo) await call('Page.navigate', { url: navigateTo });
    const result = await call('Runtime.evaluate', { expression, returnByValue: true });
    return result.result?.result?.value;
  } finally {
    try { socket.close(); } catch { /* best effort */ }
  }
}

// Chromium opens the startup URL while it is still registering --load-extension
// extensions on some platforms, which leaves the tab on chrome-error://. The
// extension APIs then never appear and every later wait times out. Re-navigate
// the startup tab until it really is the extension document.
export async function ensureExtensionStartupPage(devtoolsBase, extensionId, startupPath = 'request-permissions.html', timeoutMs = 20_000) {
  const prefix = `chrome-extension://${extensionId}/`;
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`${devtoolsBase}/json/list`)).json();
      const target = targets.find((item) => item.type === 'page' && String(item.url || '').startsWith(prefix));
      if (target) {
        const ready = await cdpEvaluateOnce(target.webSocketDebuggerUrl, 'location.protocol === "chrome-extension:" && Boolean(globalThis.chrome?.runtime?.sendMessage)');
        if (ready === true) return true;
        lastState = ready;
        await cdpEvaluateOnce(target.webSocketDebuggerUrl, 'true', `${prefix}${startupPath}`);
      }
    } catch (error) {
      lastState = error?.message || String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Extension startup page never became an extension document (${JSON.stringify(lastState)}).`);
}
