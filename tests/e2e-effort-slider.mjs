#!/usr/bin/env node
// Focused real unpacked-extension QA runner for the inline reasoning-effort slider.
//
// Loads a real unpacked Hermes Browser extension in headless Chrome-for-Testing,
// drives sidepanel.html (and app.html) over CDP against a tiny deterministic
// local mock gateway, and captures screenshots + JSON evidence.
//
// Modes
//   BASELINE (EFFORT_QA_BASELINE=1)
//     Loads the immutable pre-feature snapshot at
//       .hermes/qa/effort-before-extension
//     and records the ORIGINAL model picker + button effort section at 420px
//     (before.png). Asserts the native slider is NOT present yet.
//   AFTER (default)
//     Loads dist/ (run `npm run build` first) and asserts the native effort
//     control contract, preference toggle, legacy surfaces, keyboard, RTL,
//     narrow/zoom, reduced-motion, cancelled gestures, and all built-in themes.
//
// Env
//   EFFORT_QA_BASELINE=1        -> baseline mode
//   EFFORT_QA_EXTENSION=<dir>   -> explicit unpacked extension dir override
//   CHROME_PATH=<exe>           -> Chrome-for-Testing / Chrome binary
//
// This file never mutates production sources, never builds, never commits, and
// never calls paid inference. It only writes ignored .hermes/qa/effort-slider/*
// artifacts and a throwaway tmp profile.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { verifyEffortPolish } from './effort-polish-probes.mjs';
import { verifyLightThemeTakeover } from './light-theme-takeover-probes.mjs';
import { verifyHoverContrastEverywhere } from './hover-contrast-guard-probes.mjs';
import { verifyRoomMemberLayout } from './room-member-layout-probes.mjs';
import { probeEffortColors } from './effort-color-probe.mjs';
import { verifyComposerAutogrow } from './composer-autogrow-probe.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SNAPSHOT = path.join(ROOT, '.hermes', 'qa', 'effort-before-extension');
const QA_DIR = path.join(ROOT, '.hermes', 'qa', 'effort-slider');
const PROFILE = path.join(ROOT, 'tmp', `e2e-effort-slider-${process.pid}`);

const BASELINE = String(process.env.EFFORT_QA_BASELINE || '') === '1';
const EXTENSION_DIR = path.resolve(
  process.env.EFFORT_QA_EXTENSION
    || (BASELINE ? SNAPSHOT : DIST),
);
const DEFAULT_CHROME = 'D:/HermesCaches/puppeteer/chromium/win64-1660154/chrome-win/chrome.exe';
const CHROME_PATH = process.env.CHROME_PATH || DEFAULT_CHROME;

const TEST_TOKEN = 'e2e-effort-token-not-a-secret';
const SETTINGS_KEY = 'hermesBrowserSettings';
const PRESENTATION_KEY = 'hermesBrowserEffortPresentation';
const EFFORT_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const EFFORT_LABELS = {
  minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High',
  xhigh: 'Extra High', max: 'Max', ultra: 'Ultra',
};
const FALLBACK_THEMES = [
  'nous', 'midnight', 'ember', 'mono', 'cyberpunk', 'slate',
  'senter-space', 'aurora', 'solstice', 'everforest', 'classic', 'anti-nous',
];

const BEFORE_PNG = path.join(QA_DIR, 'before.png');
const BEFORE_SECTION_PNG = path.join(QA_DIR, 'before-effort-section.png');
const AFTER_PNG = path.join(QA_DIR, 'after.png');
const FAILURE_PNG = path.join(QA_DIR, 'failure.png');
const EVIDENCE_JSON = path.join(QA_DIR, BASELINE ? 'before-baseline.json' : 'after.json');
const THEME_DIR = path.join(QA_DIR, 'themes');

const log = (...args) => console.log('[effort-qa]', ...args);

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function chromeExecutable() {
  const candidates = [CHROME_PATH].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Chrome not found. Set CHROME_PATH (tried ${CHROME_PATH}).`);
  return found;
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

async function waitFor(check, { timeoutMs = 25_000, intervalMs = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError || new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function killChrome(child) {
  if (!child?.pid) return;
  try {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* best-effort cleanup */ }
}

// ---------------------------------------------------------------------------
// Deterministic local mock gateway (no paid inference, no real credentials)
// ---------------------------------------------------------------------------

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Hermes-Session-Id, X-Hermes-Session-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  res.end(body);
}

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

async function startMockGateway() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const body = await requestBody(req);
    requests.push({ method: req.method, path: url.pathname });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Hermes-Session-Id, X-Hermes-Session-Key',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      });
      res.end();
      return;
    }
    if (url.pathname === '/health' || url.pathname === '/v1/health') {
      json(res, 200, { status: 'ok', platform: 'hermes-agent', version: 'e2e' });
      return;
    }
    if (req.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
      json(res, 401, { error: { message: 'Unauthorized', type: 'authentication_error' } });
      return;
    }
    if (url.pathname === '/v1/capabilities') {
      json(res, 200, {
        object: 'hermes.api_server.capabilities',
        platform: 'hermes-agent',
        auth: { type: 'bearer', required: true },
        features: { models_api: true, session_resources: true, skills_api: true },
        endpoints: {
          health: { method: 'GET', path: '/health' },
          models: { method: 'GET', path: '/v1/models' },
        },
      });
      return;
    }
    if (url.pathname === '/api/model/options') {
      json(res, 200, {
        providers: [{
          slug: 'e2e',
          name: 'E2E Provider',
          authenticated: true,
          models: [
            { id: 'e2e/test-model', label: 'E2E Test Model', context_length: 32_000 },
            { id: 'e2e/alternate-model', label: 'E2E Alternate Model', context_length: 32_000 },
          ],
          capabilities: {
            'e2e/test-model': { reasoning: true, fast: true },
            'e2e/alternate-model': { reasoning: true, fast: true },
          },
        }],
      });
      return;
    }
    if (url.pathname === '/v1/models') {
      json(res, 200, { object: 'list', data: [
        { id: 'e2e-gateway', object: 'model', owned_by: 'hermes', root: 'e2e-gateway', parent: null },
        { id: 'e2e/test-model', provider: 'e2e', context_length: 32_000 },
      ] });
      return;
    }
    if (url.pathname === '/v1/skills' || url.pathname === '/v1/toolsets') {
      json(res, 200, { object: 'list', data: [] });
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      json(res, 200, { object: 'list', data: [], total: 0, has_more: false });
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      const id = body?.id || body?.session_id || 'hermes-effort-qa';
      json(res, 201, {
        id, session_id: id,
        title: body?.title || 'Effort QA',
        source: body?.source || 'hermes_browser_extension',
        model: body?.model || 'e2e/test-model',
        provider: body?.provider || 'e2e',
      });
      return;
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === 'GET') {
      const id = decodeURIComponent(sessionMatch[1]);
      json(res, 200, { id, session_id: id, title: 'Effort QA', source: 'hermes_browser_extension' });
      return;
    }
    json(res, 404, { error: { message: `Unhandled QA route: ${req.method} ${url.pathname}` } });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------------------------------------------------------------------------
// CDP client (copied from tests/e2e-loaded-extension.mjs, no shared refactor)
// ---------------------------------------------------------------------------

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.socket = null;
  }

  async connect() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onmessage = (event) => {
      const payload = JSON.parse(String(event.data));
      if (!payload.id) { this.events.push(payload); return; }
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
    const command = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
    if (process.env.COMPOSER_QA_ONLY !== '1') return command;
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Composer QA CDP command timed out: ${method} ${method === 'Runtime.evaluate' ? String(params.expression).slice(0, 180) : ''}`));
      }, 15_000);
    });
    return Promise.race([command, timeout]).finally(() => clearTimeout(timer));
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime evaluation failed.');
    }
    return result.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch { /* best-effort */ }
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} failed (${response.status})`);
  return response.json();
}

async function saveScreenshot(client, filePath, { captureBeyondViewport = false, clip = null } = {}) {
  const params = { format: 'png', captureBeyondViewport };
  if (clip) params.clip = { ...clip, scale: 1 };
  const shot = await client.call('Page.captureScreenshot', params);
  assert.ok(shot.data, `Screenshot data missing for ${filePath}`);
  await writeFile(filePath, Buffer.from(shot.data, 'base64'));
}

async function elementRect(client, selector) {
  return client.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  })()`);
}

async function dispatchMouse(client, type, x, y, buttons = 0) {
  await client.call('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y),
    button: 'left', buttons, clickCount: 1, pointerType: 'mouse',
  });
}

async function dispatchKey(client, type, key, code, windowsVirtualKeyCode) {
  await client.call('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode });
}

// ---------------------------------------------------------------------------
// Extension bootstrap
// ---------------------------------------------------------------------------

async function launchExtension({ extensionId }) {
  const chrome = spawn(chromeExecutable(), [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--remote-debugging-port=0',
    `--user-data-dir=${PROFILE}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    `chrome-extension://${extensionId}/request-permissions.html`,
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  chrome.stderr.on('data', () => { /* drain */ });

  const activePort = path.join(PROFILE, 'DevToolsActivePort');
  await waitFor(() => existsSync(activePort), { label: 'DevToolsActivePort' });
  const [portLine] = (await readFile(activePort, 'utf8')).trim().split('\n');
  const devtoolsBase = `http://127.0.0.1:${Number(portLine)}`;

  const workerTarget = await waitFor(async () => {
    const targets = await fetchJson(`${devtoolsBase}/json/list`);
    const candidates = targets.filter((target) => {
      if (target.type !== 'service_worker') return false;
      try { return new URL(String(target.url || '')).pathname === '/background.js'; }
      catch { return false; }
    });
    for (const candidate of candidates) {
      const probe = new CdpClient(candidate.webSocketDebuggerUrl);
      try {
        await probe.connect();
        await probe.call('Runtime.enable');
        const isHermes = await probe.evaluate(`globalThis.chrome?.runtime?.getManifest?.()?.name === 'Hermes Browser Extension'`);
        if (isHermes) return candidate;
      } catch { /* unrelated component worker */ }
      finally { probe.close(); }
    }
    return null;
  }, { label: 'extension service worker' });

  const worker = new CdpClient(workerTarget.webSocketDebuggerUrl);
  await worker.connect();
  await worker.call('Runtime.enable');
  await waitFor(() => worker.evaluate('Boolean(globalThis.chrome?.storage?.local)'), { label: 'chrome.storage.local' });
  return { chrome, worker, devtoolsBase, extensionId };
}

async function seedSettings(worker, mock, overrides = {}) {
  const settings = {
    connectionSchemaVersion: 1,
    connectionMode: 'local',
    connectionTransport: 'local-api',
    gatewayMode: 'local-api',
    gatewayUrl: mock.baseUrl,
    apiKey: TEST_TOKEN,
    tokenSource: 'e2e',
    sessionId: 'hermes-effort-qa',
    sessionStartMode: 'fresh',
    model: 'e2e/test-model',
    appearanceTheme: 'nous',
    colorMode: 'dark',
    thinkingEnabled: true,
    fastMode: false,
    reasoningEffort: 'medium',
    inlineAssistEnabled: true,
    inlineAssistModel: 'e2e/test-model',
    inlineAssistReasoningEffort: 'medium',
    ...overrides,
  };
  await worker.evaluate(`chrome.storage.local.set({${JSON.stringify(SETTINGS_KEY)}:${JSON.stringify(settings)}, hermesBrowserIntroSeen: true})`);
  return settings;
}

async function openPage(devtoolsBase, extensionId, file, { width = 420, height = 900, bootstrapScript = '', openerClient = null } = {}) {
  const url = `chrome-extension://${extensionId}/${file}`;
  let target;
  if (bootstrapScript) {
    const existingIds = new Set((await fetchJson(`${devtoolsBase}/json/list`)).map(item => item.id));
    assert.ok(openerClient, 'draft fixture requires an extension-page opener');
    // window.open copies this origin's sessionStorage into the new panel.
    await openerClient.evaluate(`(() => {
      const previous = sessionStorage.getItem('hermesBrowserInstanceId');
      ${bootstrapScript}
      window.open(${JSON.stringify(url)}, '_blank');
      if (previous) sessionStorage.setItem('hermesBrowserInstanceId', previous);
      else sessionStorage.removeItem('hermesBrowserInstanceId');
    })()`);
    target = await waitFor(async () => (await fetchJson(`${devtoolsBase}/json/list`)).find(item => !existingIds.has(item.id) && item.url === url), { label: 'restored-draft panel target' });
  } else {
    target = await fetchJson(`${devtoolsBase}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  }
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.call('Runtime.enable');
  await client.call('Log.enable');
  await client.call('Page.enable');
  if (width) {
    await client.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }
  if (bootstrapScript) await client.call('Page.bringToFront');
  return { client, targetId: target.id };
}

// ---------------------------------------------------------------------------
// Side-panel probes
// ---------------------------------------------------------------------------

const PANEL_READY = `(() => {
  const startup = document.querySelector('#startupScreen');
  const input = document.querySelector('#promptInput');
  return Boolean(startup && startup.hidden && input && !input.disabled);
})()`;

async function waitPanelReady(client) {
  await waitFor(() => client.evaluate(PANEL_READY), { label: 'side panel ready', timeoutMs: 30_000 });
}

async function openModelMenu(client) {
  // The model runtime-options section renders inside #modelMenu (hidden until opened).
  await waitFor(() => client.evaluate(`Boolean(document.querySelector('#modelMenuButton'))`), { label: 'model menu button' });
  const alreadyOpen = await client.evaluate(`!document.querySelector('#modelMenu')?.hidden`);
  if (!alreadyOpen) {
    await client.evaluate(`document.querySelector('#modelMenuButton').click()`);
  }
  await waitFor(() => client.evaluate(`(() => {
    const list = document.querySelector('#modelOptionsList');
    return Boolean(list && !document.querySelector('#modelMenu')?.hidden && list.children.length > 0);
  })()`), { label: 'model options rendered' });
}

async function readEffortDom(client) {
  return client.evaluate(`(() => {
    const list = document.querySelector('#modelOptionsList');
    const root = document.documentElement;
    const slider = list?.querySelector('input[type="range"]') || document.querySelector('.effort-control input[type="range"]');
    const control = document.querySelector('#modelOptionsList .effort-control') || document.querySelector('.effort-control');
    const value = document.querySelector('#modelOptionsList .effort-control-value');
    const stops = document.querySelectorAll('#modelOptionsList .effort-control-stop');
    const viewButtons = document.querySelectorAll('#modelOptionsList [data-effort-view="buttons"], .effort-control [data-effort-view="buttons"]');
    const legacyButtons = document.querySelectorAll('#modelOptionsList [data-effort], #modelOptionsList .model-effort-list [data-effort]');
    const presentation = control?.dataset?.effortPresentation
      || list?.querySelector('[data-effort-presentation]')?.dataset?.effortPresentation
      || null;
    return {
      hasModelOptionsList: Boolean(list),
      optionsChildren: list ? list.children.length : 0,
      optionsText: (list?.innerText || '').slice(0, 400),
      hasEffortControl: Boolean(control),
      hasSlider: Boolean(slider),
      sliderMin: slider?.min ?? null,
      sliderMax: slider?.max ?? null,
      sliderStep: slider?.step ?? null,
      sliderValue: slider?.value ?? null,
      sliderAriaValueText: slider?.getAttribute('aria-valuetext') ?? null,
      sliderDisabled: slider ? Boolean(slider.disabled) : null,
      valueText: value?.textContent ?? null,
      stopCount: stops.length,
      viewButtonCount: viewButtons.length,
      legacyEffortButtonCount: legacyButtons.length,
      legacyEffortValues: Array.from(document.querySelectorAll('#modelOptionsList [data-effort]')).map((b) => b.dataset.effort),
      presentation,
      rootEffortCharge: document.querySelector('#modelOptionsList .effort-control')?.dataset.effortCharge ?? null,
      theme: root.dataset.hermesTheme ?? null,
      mode: root.dataset.hermesMode ?? null,
    };
  })()`);
}

// ---------------------------------------------------------------------------
// Baseline flow
// ---------------------------------------------------------------------------

async function runBaseline({ panel, worker, extensionId }) {
  await waitPanelReady(panel.client);
  await openModelMenu(panel.client);

  const dom = await readEffortDom(panel.client);

  // Baseline must NOT carry the native slider; the original button grid stands.
  assert.equal(dom.hasSlider, false, `Baseline unexpectedly exposes a native range slider: ${JSON.stringify(dom)}`);
  assert.equal(dom.hasEffortControl, false, `Baseline unexpectedly exposes .effort-control: ${JSON.stringify(dom)}`);
  assert.equal(dom.stopCount, 0, `Baseline unexpectedly exposes .effort-control-stop: ${JSON.stringify(dom)}`);
  assert.equal(dom.legacyEffortButtonCount, 7, `Baseline should show 7 original [data-effort] buttons: ${JSON.stringify(dom)}`);
  assert.deepEqual(
    dom.legacyEffortValues,
    EFFORT_VALUES,
    `Baseline original effort values must match canonical order: ${JSON.stringify(dom)}`,
  );

  // The legacy full-tab surface keeps its own static section (compat check).
  const settingsHasLegacyEffort = await panel.client.evaluate(
    `document.querySelectorAll('#settingsDialog [data-runtime-effort]').length`,
  );

  // 420px captures: model picker + effort section.
  await panel.client.call('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
  await panel.client.evaluate(`document.querySelector('#modelOptionsList')?.scrollIntoView({ block: 'center' })`);
  await new Promise((r) => setTimeout(r, 250));
  await saveScreenshot(panel.client, BEFORE_PNG, { captureBeyondViewport: false });

  const sectionRect = await elementRect(panel.client, '#modelOptionsList');
  if (sectionRect && sectionRect.width > 0 && sectionRect.height > 0) {
    await saveScreenshot(panel.client, BEFORE_SECTION_PNG, {
      captureBeyondViewport: true,
      clip: { x: sectionRect.x, y: sectionRect.y, width: sectionRect.width, height: sectionRect.height },
    });
  }

  const evidence = {
    mode: 'baseline',
    extensionDir: EXTENSION_DIR,
    extensionId,
    model: dom,
    settingsLegacyRuntimeEffortCount: settingsHasLegacyEffort,
    screenshots: {
      panel: path.relative(ROOT, BEFORE_PNG),
      effortSection: existsSync(BEFORE_SECTION_PNG) ? path.relative(ROOT, BEFORE_SECTION_PNG) : null,
    },
    assertions: {
      nativeSliderAbsent: !dom.hasSlider,
      effortControlAbsent: !dom.hasEffortControl,
      legacyEffortButtonsPresent: dom.legacyEffortButtonCount === 7,
    },
    capturedAt: new Date().toISOString(),
  };
  await writeFile(EVIDENCE_JSON, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return evidence;
}

// ---------------------------------------------------------------------------
// AFTER flow
// ---------------------------------------------------------------------------

async function readSettings(client) {
  return client.evaluate(`(async () => (await chrome.storage.local.get(${JSON.stringify(SETTINGS_KEY)}))[${JSON.stringify(SETTINGS_KEY)}])()`);
}

async function readPresentation(client) {
  return client.evaluate(`(async () => (await chrome.storage.local.get(${JSON.stringify(PRESENTATION_KEY)}))[${JSON.stringify(PRESENTATION_KEY)}])()`);
}

async function setSliderTo(client, index) {
  // Real value set + input (preview) then change (commit), mirroring native input.
  await client.evaluate(`(() => {
    const s = document.querySelector('#modelOptionsList input[type="range"]');
    s.value = String(${index});
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

async function resolveThemes() {
  try {
    const modulePath = path.join(EXTENSION_DIR, 'lib', 'appearance-themes.mjs');
    if (existsSync(modulePath)) {
      const mod = await import(pathToFileURL(modulePath).href);
      if (Array.isArray(mod.APPEARANCE_THEMES) && mod.APPEARANCE_THEMES.length) {
        return mod.APPEARANCE_THEMES.map((theme) => theme.value);
      }
    }
  } catch { /* fall through */ }
  return FALLBACK_THEMES;
}

async function runAfter({ panel, web, worker, extensionId }) {
  const evidence = { mode: 'after', extensionDir: EXTENSION_DIR, extensionId, checks: {}, themes: {} };
  await waitPanelReady(panel.client);
  await openModelMenu(panel.client);
  if (process.env.EFFORT_COLOR_ONLY === '1') {
    const report = await probeEffortColors({ client: panel.client, qaDir: QA_DIR, saveScreenshot });
    console.log('[effort-color]', JSON.stringify(report));
    return evidence;
  }
  if (process.env.ROOM_LAYOUT_ONLY === '1') {
    const out = await verifyRoomMemberLayout({ client: panel.client, evidence, qaDir: QA_DIR, saveScreenshot });
    console.log('[room-layout]', JSON.stringify({ palettes: out.palettes, failures: out.failures.length }));
    for (const f of out.failures.slice(0, 12)) console.log('[room-layout] FAIL', JSON.stringify(f).slice(0, 400));
    assert.equal(out.failures.length, 0, 'room member popover/picker layout broken');
    return evidence;
  }
  if (process.env.HOVER_GUARD_ONLY === '1') {
    const guard = await verifyHoverContrastEverywhere({ client: panel.client, evidence, qaDir: QA_DIR, saveScreenshot });
    console.log('[hover-guard]', JSON.stringify({ palettes: guard.palettes, controls: guard.controls, measurements: guard.measurements, skipped: guard.skipped, failures: guard.failures.length }));
    for (const f of guard.failures.slice(0, 40)) console.log('[hover-guard] FAIL', JSON.stringify(f));
    assert.equal(guard.failures.length, 0, 'hover/focus contrast guard found unreadable labels');
    return evidence;
  }
  if (process.env.EFFORT_THEME_ONLY === '1') {
    await verifyLightThemeTakeover({ client: panel.client, evidence, qaDir: QA_DIR, saveScreenshot, phase: process.env.EFFORT_THEME_QA_PHASE || 'after' });
    evidence.failedChecks = Object.entries(evidence.checks).filter(([, ok]) => !ok).map(([name]) => name);
    await writeFile(EVIDENCE_JSON, JSON.stringify(evidence, null, 2));
    assert.deepEqual(evidence.failedChecks, []);
    return evidence;
  }

  const dom = await readEffortDom(panel.client);
  const checks = evidence.checks;

  checks.nativeSliderPresent = dom.hasSlider === true;
  checks.effortControlPresent = dom.hasEffortControl === true;
  checks['range_min0_max6_step1'] = dom.sliderMin === '0' && dom.sliderMax === '6' && dom.sliderStep === '1';
  checks.sevenStops = dom.stopCount === 7;
  checks.valueElementPresent = typeof dom.valueText === 'string' && dom.valueText.length > 0;
  checks.buttonsTogglePresent = dom.viewButtonCount >= 1;
  checks.legacyButtonsPreserved = await panel.client.evaluate(
    `document.querySelectorAll('#settingsDialog [data-runtime-effort]').length >= 7`,
  );

  // Sweep all seven canonical values and record charge + label per stop.
  const stops = [];
  for (let index = 0; index < EFFORT_VALUES.length; index += 1) {
    await setSliderTo(panel.client, index);
    await new Promise((r) => setTimeout(r, 60));
    const state = await panel.client.evaluate(`(() => {
      const root = document.documentElement;
      const value = document.querySelector('#modelOptionsList .effort-control-value');
      return { value: value?.textContent ?? null, charge: document.querySelector('#modelOptionsList .effort-control')?.dataset.effortCharge ?? null };
    })()`);
    stops.push({ index, expected: EFFORT_VALUES[index], label: state.value, charge: state.charge });
  }
  evidence.stops = stops;
  checks.allStopsRendered = stops.every((stop) => stop.charge) && stops.length === 7;
  checks.chargeMaxUltra = stops[5].charge === 'max' && stops[6].charge === 'ultra';

  // input preview must not change stored settings; change commits.
  const before = await readSettings(panel.client);
  await panel.client.evaluate(`(() => {
    const s = document.querySelector('#modelOptionsList input[type="range"]');
    s.value = '6';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 80));
  const afterPreview = await readSettings(panel.client);
  checks.inputPreviewDoesNotCommit = afterPreview.reasoningEffort === before.reasoningEffort;
  await setSliderTo(panel.client, 0); // commit minimal
  const afterCommit = await readSettings(panel.client);
  checks.changeCommits = afterCommit.reasoningEffort === 'minimal';

  // Preference toggle: buttons <-> slider, persisted under standalone key.
  await panel.client.evaluate(`document.querySelector('#modelOptionsList [data-effort-view="buttons"], .effort-control [data-effort-view="buttons"]')?.click()`);
  await new Promise((r) => setTimeout(r, 120));
  checks.buttonsPreferenceStored = (await readPresentation(panel.client)) === 'buttons';
  const buttonsDom = await readEffortDom(panel.client);
  checks.buttonsViewRestoresGrid = buttonsDom.legacyEffortButtonCount === 7 && buttonsDom.presentation === 'buttons';
  // Reload and confirm preference hydrates.
  await panel.client.call('Page.reload');
  await waitPanelReady(panel.client);
  await openModelMenu(panel.client);
  const reloadedDom = await readEffortDom(panel.client);
  checks.preferenceHydratesAfterReload = reloadedDom.presentation === 'buttons';
  // Restore slider presentation for the remaining checks.
  await panel.client.evaluate(`document.querySelector('[data-effort-view="slider"]')?.click()`);
  await new Promise((r) => setTimeout(r, 120));
  checks.sliderPreferenceStored = (await readPresentation(panel.client)) === 'slider';

  // Keyboard Home/End/arrows with focus preservation (trusted CDP key events).
  const focusBefore = await panel.client.evaluate(`(() => {
    const s = document.querySelector('#modelOptionsList input[type="range"]');
    s.focus();
    return document.activeElement === s;
  })()`);
  await setSliderTo(panel.client, 2);
  await dispatchKey(panel.client, 'rawKeyDown', 'ArrowRight', 'ArrowRight', 39);
  await dispatchKey(panel.client, 'keyUp', 'ArrowRight', 'ArrowRight', 39);
  const afterArrow = await panel.client.evaluate(`({ value: document.querySelector('#modelOptionsList input[type="range"]').value, focused: document.activeElement?.matches('#modelOptionsList input[type="range"]') })`);
  await dispatchKey(panel.client, 'rawKeyDown', 'Home', 'Home', 36);
  await dispatchKey(panel.client, 'keyUp', 'Home', 'Home', 36);
  const afterHome = await panel.client.evaluate(`document.querySelector('#modelOptionsList input[type="range"]').value`);
  await dispatchKey(panel.client, 'rawKeyDown', 'End', 'End', 35);
  await dispatchKey(panel.client, 'keyUp', 'End', 'End', 35);
  const afterEnd = await panel.client.evaluate(`document.querySelector('#modelOptionsList input[type="range"]').value`);
  checks.keyboardFocusPreserved = focusBefore === true && afterArrow.focused === true;
  checks.keyboardArrowMoves = Number(afterArrow.value) > 2;
  checks.keyboardHomeEnd = afterHome === '0' && afterEnd === '6';

  // Chat/Assist field isolation: committing chat effort must not mutate assist effort.
  const isolationStart = await readSettings(panel.client);
  await setSliderTo(panel.client, 4); // xhigh on the chat picker
  await new Promise((r) => setTimeout(r, 80));
  const isolationEnd = await readSettings(panel.client);
  checks.chatAssistIsolation = isolationEnd.reasoningEffort === 'xhigh'
    && isolationEnd.inlineAssistReasoningEffort === isolationStart.inlineAssistReasoningEffort;

  // Cancelled gesture: pointerdown + move + pointercancel must revert without commit.
  const cancelled = await panel.client.evaluate(`(() => {
    const s = document.querySelector('#modelOptionsList input[type="range"]');
    const committed = s.value;
    s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    s.value = '6';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
    const preview = s.value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return { committed, preview, reverted: s.value };
  })()`);
  checks.cancelledGestureReverts = cancelled.reverted === cancelled.committed;

  // Reduced motion.
  await panel.client.call('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reduced = await readEffortDom(panel.client);
  checks.reducedMotionStillRenders = reduced.hasSlider === true;
  await panel.client.call('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

  // RTL.
  await panel.client.evaluate(`document.documentElement.dir = 'rtl'`);
  const rtl = await readEffortDom(panel.client);
  checks.rtlStillRenders = rtl.hasSlider === true;
  await panel.client.evaluate(`document.documentElement.dir = 'ltr'`);

  // Narrow 320px and 150% zoom.
  await panel.client.call('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
  const narrow = await panel.client.evaluate(`(() => {
    const root = document.documentElement;
    return { overflow: root.scrollWidth - root.clientWidth, slider: Boolean(document.querySelector('#modelOptionsList input[type="range"]')) };
  })()`);
  checks.narrow320NoOverflow = narrow.overflow <= 1 && narrow.slider === true;
  await panel.client.call('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
  await panel.client.evaluate(`(() => {
    const input = document.querySelector('#textZoomInput');
    if (input) { input.value = '150'; input.dispatchEvent(new Event('change', { bubbles: true })); }
    else { document.documentElement.style.zoom = '1.5'; }
  })()`);
  const zoomed = await panel.client.evaluate(`(() => {
    const root = document.documentElement;
    return { overflow: root.scrollWidth - root.clientWidth, slider: Boolean(document.querySelector('#modelOptionsList input[type="range"]')) };
  })()`);
  checks.zoom150StillRenders = zoomed.slider === true;
  if (await panel.client.evaluate(`Boolean(document.querySelector('#textZoomInput'))`)) {
    await panel.client.evaluate(`(() => { const i = document.querySelector('#textZoomInput'); i.value = '100'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  } else {
    await panel.client.evaluate(`document.documentElement.style.zoom = ''`);
  }

  await verifyEffortPolish({ client: panel.client, evidence, qaDir: QA_DIR, saveScreenshot });

  // after.png at 420px.
  await panel.client.call('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
  await panel.client.evaluate(`document.querySelector('#modelOptionsList')?.scrollIntoView({ block: 'center' })`);
  await new Promise((r) => setTimeout(r, 200));
  await saveScreenshot(panel.client, AFTER_PNG, { captureBeyondViewport: false });

  // Themed captures: every built-in theme x light/dark (styling-only via root dataset).
  const themes = await resolveThemes();
  await mkdir(THEME_DIR, { recursive: true });
  await panel.client.call('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
  for (const theme of themes) {
    for (const mode of ['light', 'dark']) {
      await panel.client.evaluate(`(() => {
        const root = document.documentElement;
        root.dataset.hermesTheme = ${JSON.stringify(theme)};
        root.dataset.hermesMode = ${JSON.stringify(mode)};
        root.dataset.hermesColorMode = ${JSON.stringify(mode)};
      })()`);
      await new Promise((r) => setTimeout(r, 40));
      const rect = await elementRect(panel.client, '#modelOptionsList');
      const file = path.join(THEME_DIR, `${theme}-${mode}.png`);
      if (rect && rect.width > 0 && rect.height > 0) {
        await saveScreenshot(panel.client, file, { captureBeyondViewport: true, clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
        evidence.themes[`${theme}-${mode}`] = path.relative(ROOT, file);
      }
    }
  }

  // Full-tab app.html compatibility (best-effort).
  try {
    await web.client.call('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor(() => web.client.evaluate(`Boolean(document.querySelector('#modelOptionsList'))`), { label: 'app.html model options', timeoutMs: 20_000 });
    const appDom = await web.client.evaluate(`(() => {
      const list = document.querySelector('#modelOptionsList');
      return {
        hasSlider: Boolean(list?.querySelector('input[type="range"]') || document.querySelector('.effort-control input[type="range"]')),
        hasEffortControl: Boolean(document.querySelector('.effort-control')),
        runtimeEffortButtons: document.querySelectorAll('[data-runtime-effort]').length,
      };
    })()`);
    await web.client.evaluate(`if (document.querySelector('#modelPicker').hidden) document.querySelector('#modelPickerButton').click()`);
    const webSelection = await web.client.evaluate(`(() => { const s = document.querySelector('#modelOptionsList .effort-control-range'); const next = s.value === '3' ? '2' : '3'; s.value = next; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return next === '3' ? 'high' : 'medium'; })()`);
    const committed = await waitFor(() => web.client.evaluate(`(async () => { const c = document.querySelector('#modelOptionsList .effort-control'); const saved = (await chrome.storage.local.get('hermesBrowserSettings')).hermesBrowserSettings; return c?.dataset.effortValue === ${JSON.stringify(webSelection)} && saved?.reasoningEffort === ${JSON.stringify(webSelection)} ? { value: c.dataset.effortValue, stored: saved.reasoningEffort, releaseNodes: c.querySelectorAll('.effort-control-release, .effort-control-release-particle').length, open: !document.querySelector('#modelPicker').hidden } : null; })()`), { label: 'full-tab effort commit without release particles', timeoutMs: 3000 });
    appDom.selection = committed;
    checks.fullTabEffortCommitWithoutBurst = committed.value === webSelection && committed.releaseNodes === 0 && committed.open;
    await saveScreenshot(web.client, path.join(QA_DIR, 'full-tab-no-release.png'));
    evidence.fullTab = appDom;
    checks.fullTabEffortControlPresent = appDom.hasSlider === true || appDom.hasEffortControl === true;
  } catch (error) {
    evidence.fullTab = { error: String(error?.message || error) };
    checks.fullTabEffortControlPresent = false;
  }

  evidence.screenshots = { panel: path.relative(ROOT, AFTER_PNG), themes: evidence.themes };
  evidence.capturedAt = new Date().toISOString();

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  evidence.failedChecks = failed;
  await writeFile(EVIDENCE_JSON, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  assert.deepEqual(failed, [], `AFTER effort-slider checks failed: ${failed.join(', ')}`);
  return evidence;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(CHROME_PATH)) throw new Error(`chrome-for-testing not found at ${CHROME_PATH}`);
  if (!existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) {
    throw new Error(`Extension dir has no manifest.json: ${EXTENSION_DIR}${BASELINE ? '' : ' (run `npm run build`)'}`);
  }
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  await mkdir(QA_DIR, { recursive: true });

  const mock = await startMockGateway();
  let chrome;
  let worker;
  let panel;
  let web;
  try {
    const extensionId = unpackedExtensionId(EXTENSION_DIR);
    const launched = await launchExtension({ extensionId });
    chrome = launched.chrome;
    worker = launched.worker;
    const { devtoolsBase } = launched;

    await seedSettings(worker, mock);

    panel = await openPage(devtoolsBase, extensionId, 'sidepanel.html', { width: 420, height: 900 });

    if (process.env.COMPOSER_QA_ONLY === '1') {
      await verifyComposerAutogrow({
        client: panel.client, worker, saveScreenshot,
        baseline: process.env.COMPOSER_QA_BASELINE === '1',
        openPanel: (file, bootstrapScript) => openPage(devtoolsBase, extensionId, file, { width: 420, height: 900, bootstrapScript, openerClient: panel.client }),
      });
    } else if (BASELINE) {
      const evidence = await runBaseline({ panel, worker, extensionId });
      log('BASELINE complete');
      log('evidence:', JSON.stringify({ model: evidence.model, screenshots: evidence.screenshots }, null, 2));
    } else {
      web = await openPage(devtoolsBase, extensionId, 'app.html', { width: 1024, height: 900 });
      const evidence = await runAfter({ panel, web, worker, extensionId });
      log('AFTER complete; failed checks:', evidence.failedChecks);
    }
  } catch (error) {
    try {
      if (panel?.client) await saveScreenshot(panel.client, FAILURE_PNG, { captureBeyondViewport: false });
    } catch { /* best-effort failure capture */ }
    throw error;
  } finally {
    try { panel?.client?.close(); } catch { /* ignore */ }
    try { web?.client?.close(); } catch { /* ignore */ }
    try { worker?.close(); } catch { /* ignore */ }
    killChrome(chrome);
    await mock.close().catch(() => {});
    await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('[effort-qa] FAILED:', error?.stack || error);
  process.exitCode = 1;
});