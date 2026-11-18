#!/usr/bin/env node
/**
 * Loaded-extension check: Settings text inputs and textareas use normal inset,
 * not the composer textarea's left padding reservation.
 *
 *   npm run build && node tests/e2e-settings-form-field-inset.mjs
 *   SETTINGS_INSET_SCREEN_DIR=/path  optional screenshot output directory
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { ensureExtensionStartupPage, killProcessTree, resolveChromeExecutable, launchChrome } from './e2e-chrome-env.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PROFILE = path.join(ROOT, 'tmp', `e2e-settings-inset-${process.pid}`);
const ARTIFACTS = process.env.SETTINGS_INSET_SCREEN_DIR
  ? path.resolve(process.env.SETTINGS_INSET_SCREEN_DIR)
  : path.join(ROOT, '.hermes', 'qa', 'settings-form-field-inset');
const SCREENSHOT_SUFFIX = process.env.SETTINGS_INSET_AFTER === '1' ? 'after' : 'before';
const SCREENSHOT = path.join(ARTIFACTS, `settings-page-context-exclusions-${SCREENSHOT_SUFFIX}.png`);
const MAX_INSET_PX = 16;
const TEST_TOKEN = 'e2e-settings-inset-token';
const SETTINGS_CATEGORIES = [
  'connections',
  'agents',
  'models',
  'sessions',
  'permissions',
  'assist',
  'voice',
  'appearance',
  'about',
];

function chromeExecutable() {
  return resolveChromeExecutable([
    '/usr/local/bin/google-chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]);
}

function unpackedExtensionId(extensionPath) {
  const encoding = process.platform === 'win32' ? 'utf16le' : 'utf8';
  const digest = createHash('sha256')
    .update(Buffer.from(path.resolve(extensionPath), encoding))
    .digest()
    .subarray(0, 16);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .replace(/[0-9a-f]/g, (nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)));
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  res.end(body);
}

async function startStubGateway() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Hermes-Session-Id, X-Hermes-Session-Key',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      });
      res.end();
      return;
    }
    if (url.pathname === '/health' || url.pathname === '/v1/health' || url.pathname === '/api/health') {
      json(res, 200, { status: 'ok', platform: 'hermes-agent', version: 'qa' });
      return;
    }
    if (url.pathname === '/v1/capabilities') {
      json(res, 200, {
        object: 'hermes.api_server.capabilities',
        version: 'qa',
        endpoints: { health: { method: 'GET', path: '/health' }, session_chat: { method: 'POST', path: '/api/sessions/{session_id}/chat' } },
        features: { models: true, session_chat: true, session_chat_streaming: false },
      });
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      json(res, 200, { sessions: [], total: 0 });
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      json(res, 200, { session: { id: 'hermes-browser-extension' } });
      return;
    }
    if (url.pathname === '/v1/models') { json(res, 200, { data: [{ id: 'e2e/test-model', object: 'model' }] }); return; }
    if (url.pathname === '/api/model/options') {
      json(res, 200, { models: [{ id: 'e2e/test-model' }], providers: [] });
      return;
    }
    if (/\/chat$/.test(url.pathname) && req.method === 'POST') {
      json(res, 200, { message: { role: 'assistant', content: 'ok' } });
      return;
    }
    json(res, 200, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function waitFor(check, timeoutMs = 25_000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError || new Error(`Timed out after ${timeoutMs}ms`);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onmessage = (event) => {
      const payload = JSON.parse(String(event.data));
      if (!payload.id) return;
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);
      if (payload.error) pending.reject(new Error(payload.error.message || 'CDP error'));
      else pending.resolve(payload.result || {});
    };
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error(`Could not connect to CDP target ${this.url}`));
    });
  }

  call(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('CDP socket is not open.');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime evaluation failed.');
    }
    return result.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch { /* best effort */ }
  }
}

const fieldInsetProbe = `(() => {
  const dialog = document.querySelector('#settingsDialog');
  if (!dialog || dialog.hidden) return { ok: false, fields: [], reason: 'settings closed' };
  const nodes = [...dialog.querySelectorAll('textarea, input')].filter((el) => {
    if (el.closest('[hidden]')) return false;
    if (el.closest('.text-zoom-input-wrap, .marketplace-theme-search')) return false;
    if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'file' || el.type === 'hidden' || el.type === 'range' || el.type === 'number') return false;
    return el.getClientRects().length > 0;
  });
  const fields = nodes.map((el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
    const padLeft = Number.parseFloat(style.paddingLeft) || 0;
    const textIndent = Number.parseFloat(style.textIndent) || 0;
    const inset = borderLeft + padLeft + textIndent;
    return {
      id: el.id || el.name || el.className || el.tagName.toLowerCase(),
      inset,
      textIndent,
      paddingLeft: padLeft,
    };
  });
  return { ok: true, fields };
})()`;

async function openSettingsHome(panel) {
  await panel.evaluate(`(() => {
    const dialog = document.querySelector('#settingsDialog');
    if (!dialog) return false;
    dialog.hidden = false;
    dialog.setAttribute('aria-hidden', 'false');
    document.querySelector('[data-settings-pane]')?.setAttribute('hidden', '');
    document.querySelectorAll('[data-settings-category]').forEach((card) => { card.parentElement?.removeAttribute('hidden'); });
    return true;
  })()`);
}

async function openSettingsPane(panel, pane) {
  await panel.evaluate(`(() => {
    const open = document.querySelector('[data-settings-pane]:not([hidden])');
    if (open) open.setAttribute('hidden', '');
    const card = document.querySelector('[data-settings-category="${pane}"]');
    card?.click();
    const paneEl = document.querySelector('[data-settings-pane="${pane}"]');
    if (paneEl) {
      paneEl.hidden = false;
      paneEl.removeAttribute('hidden');
    }
    return true;
  })()`);
  await waitFor(() => panel.evaluate(`document.querySelector('[data-settings-pane="${pane}"]')?.hidden === false`));
}

async function prepareSettingsPaneForInsetProbe(panel, pane) {
  if (pane !== 'appearance') return;
  await panel.evaluate(`(() => {
    const manager = document.querySelector('#customThemeManager');
    if (manager) {
      manager.open = true;
    }
    return true;
  })()`);
  await waitFor(() => panel.evaluate(`document.querySelector('#customThemeManager')?.open === true`));
}

async function saveScreenshot(client, filePath) {
  const shot = await client.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  assert.ok(shot.data, `Screenshot data missing for ${filePath}`);
  await writeFile(filePath, Buffer.from(shot.data, 'base64'));
}

async function main() {
  assert.ok(existsSync(path.join(DIST, 'manifest.json')), 'Run npm run build before this QA script.');
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  await mkdir(ARTIFACTS, { recursive: true });

  const gateway = await startStubGateway();
  let chrome;
  let panel;
  let setup;
  try {
    const extensionId = unpackedExtensionId(DIST);
    const chromeArgs = [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--window-size=420,900',
      '--remote-debugging-port=0',
      `--user-data-dir=${PROFILE}`,
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      `chrome-extension://${extensionId}/request-permissions.html`,
    ];
    if (process.env.SETTINGS_INSET_HEADLESS === '1') chromeArgs.unshift('--headless=new');
    chrome = launchChrome(chromeExecutable(), chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

    const activePort = path.join(PROFILE, 'DevToolsActivePort');
    await waitFor(() => existsSync(activePort));
    const [portLine] = (await readFile(activePort, 'utf8')).trim().split('\n');
    const devtoolsBase = `http://127.0.0.1:${Number(portLine)}`;
    await ensureExtensionStartupPage(devtoolsBase, extensionId, 'request-permissions.html', 45_000);

    const wakeTarget = (await (await fetch(`${devtoolsBase}/json/list`)).json()).find((target) => (
      target.type === 'page'
      && String(target.url || '').startsWith(`chrome-extension://${extensionId}/`)
    ));
    if (wakeTarget) {
      const wakeClient = new CdpClient(wakeTarget.webSocketDebuggerUrl);
      try {
        await wakeClient.connect();
        await wakeClient.call('Runtime.enable');
        await waitFor(() => wakeClient.evaluate('Boolean(globalThis.chrome?.runtime?.sendMessage)'));
        await wakeClient.evaluate("void chrome.runtime.sendMessage({ type: 'HERMES_INLINE_SESSION_STATUS' }).catch(() => null); true");
      } finally {
        wakeClient.close();
      }
    }

    const workerTarget = await waitFor(async () => {
      const targets = await (await fetch(`${devtoolsBase}/json/list`)).json();
      return targets.find((target) => (
        target.type === 'service_worker'
        && String(target.url || '').startsWith(`chrome-extension://${extensionId}/`)
      )) || null;
    }, 30_000);
    setup = new CdpClient(workerTarget.webSocketDebuggerUrl);
    await setup.connect();
    await setup.call('Runtime.enable');
    await waitFor(() => setup.evaluate('Boolean(globalThis.chrome?.storage?.local)'));
    await setup.evaluate(`chrome.storage.local.set(${JSON.stringify({
      hermesBrowserSettings: {
        connectionSchemaVersion: 1,
        connectionMode: 'local',
        connectionTransport: 'local-api',
        gatewayMode: 'local-api',
        gatewayUrl: gateway.baseUrl,
        apiKey: TEST_TOKEN,
        tokenSource: 'qa',
        sessionId: 'hermes-browser-extension',
        sessionStartMode: 'fresh',
        model: 'e2e/test-model',
        appearanceTheme: 'mono',
        colorMode: 'dark',
      },
      hermesBrowserIntroSeen: true,
      hermesOnboardingCompleted: true,
    })})`);

    const pageTarget = await (await fetch(
      `${devtoolsBase}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/sidepanel.html`)}`,
      { method: 'PUT' },
    )).json();
    panel = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await panel.connect();
    await panel.call('Runtime.enable');
    await panel.call('Page.enable');
    await panel.call('Emulation.setDeviceMetricsOverride', {
      width: 420,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await panel.call('Page.bringToFront');
    await waitFor(() => panel.evaluate(`(() => {
      const settings = document.querySelector('#settingsButton');
      const dialog = document.querySelector('#settingsDialog');
      return Boolean(settings && dialog);
    })()`), 45_000).catch(async (error) => {
      const boot = await panel.evaluate(`(() => ({
        readyState: document.readyState,
        startupHidden: document.querySelector('#startupScreen')?.hidden,
        body: document.body?.innerText?.slice(0, 300) || '',
      }))()`).catch(() => null);
      console.error('[settings-inset] panel boot state', JSON.stringify(boot));
      throw error;
    });

    await openSettingsHome(panel);
    const failures = [];
  for (const pane of SETTINGS_CATEGORIES) {
      await openSettingsPane(panel, pane);
      await prepareSettingsPaneForInsetProbe(panel, pane);
      const probe = await panel.evaluate(fieldInsetProbe);
      if (!probe?.ok) {
        failures.push({ pane, reason: probe?.reason || 'probe failed' });
        continue;
      }
      if (pane === 'appearance') {
        const measuredIds = probe.fields.map((field) => field.id);
        if (!measuredIds.includes('customThemeImportTextarea')) {
          failures.push({ pane, field: 'customThemeImportTextarea', kind: 'missing', reason: 'custom theme import textarea not measured' });
        }
      }
      for (const field of probe.fields) {
        if (field.textIndent > 0.01) {
          failures.push({ pane, field: field.id, kind: 'text-indent', value: field.textIndent });
        }
        if (field.inset > MAX_INSET_PX + 0.5) {
          failures.push({ pane, field: field.id, kind: 'inset', value: field.inset, paddingLeft: field.paddingLeft });
        }
      }
    }

    await openSettingsPane(panel, 'permissions');
    await panel.evaluate(`document.querySelector('#pageContextExcludedOriginsInput')?.scrollIntoView({ block: 'center' })`);
    await saveScreenshot(panel, SCREENSHOT);

    const exclusions = await panel.evaluate(`(() => {
      const el = document.querySelector('#pageContextExcludedOriginsInput');
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        paddingLeft: Number.parseFloat(style.paddingLeft) || 0,
        textIndent: Number.parseFloat(style.textIndent) || 0,
      };
    })()`);
    console.log('[settings-inset] exclusions field', JSON.stringify(exclusions));
    console.log('[settings-inset] screenshot', SCREENSHOT);

    if (failures.length) {
      console.error('[settings-inset] failures', JSON.stringify(failures, null, 2));
      throw new Error(`[settings-inset] ${failures.length} field inset failure(s)`);
    }
    console.log('[settings-inset] all visible settings text fields within inset budget');
  } finally {
    panel?.close();
    setup?.close?.();
    if (chrome) killProcessTree(chrome);
    await gateway.close();
    await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}