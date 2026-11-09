/**
 * Loaded-extension QA for saved connections.
 *
 * Real Chrome for Testing, the built side panel, and two stub gateways that each
 * record the Authorization header they receive. Checks the first -> second -> first
 * round trip, credential isolation, per-connection drafts, protected storage, a
 * second open panel following a switch, and Delete.
 *
 * Run: node tests/e2e-saved-connections.mjs
 * Screenshots: .hermes/qa/saved-connections-*.png
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
const PROFILE = path.join(ROOT, 'tmp', `qa-saved-connections-${process.pid}`);
const QA_DIR = path.join(ROOT, '.hermes', 'qa');
const KEY_FIRST = 'qa-first-gateway-key';
const KEY_SECOND = 'qa-second-gateway-key';
const DRAFT_FIRST = 'draft that belongs to the first connection';

function unpackedExtensionId(extensionPath) {
  const encoding = process.platform === 'win32' ? 'utf16le' : 'utf8';
  const digest = createHash('sha256').update(Buffer.from(path.resolve(extensionPath), encoding)).digest().subarray(0, 16);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .replace(/[0-9a-f]/g, (nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)));
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Hermes-Session-Id, X-Hermes-Session-Key, X-Hermes-Session-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  res.end(body);
}

async function startStubGateway(label) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization || '', headers: req.headers, at: Date.now() });
    if (req.method === 'OPTIONS') { json(res, 204, {}); return; }
    if (url.pathname === '/health' || url.pathname === '/v1/health') { json(res, 200, { status: 'ok', platform: 'hermes-agent', version: label }); return; }
    if (url.pathname === '/v1/capabilities') {
      json(res, 200, {
        object: 'hermes.api_server.capabilities',
        version: label,
        endpoints: {
          health: { method: 'GET', path: '/health' },
          sessions: { method: 'GET', path: '/api/sessions' },
          session_create: { method: 'POST', path: '/api/sessions' },
          session_chat: { method: 'POST', path: '/api/sessions/{session_id}/chat' },
        },
        features: { models: true, session_resources: true, session_chat: true, session_chat_streaming: false, browser_pairing: true },
      });
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') { json(res, 200, { sessions: [], total: 0 }); return; }
    if (url.pathname === '/api/sessions' && req.method === 'POST') { json(res, 200, { session: { id: `${label}-session` } }); return; }
    if (url.pathname === '/v1/models') { json(res, 200, { data: [{ id: 'e2e/test-model', object: 'model' }] }); return; }
    json(res, 200, {});
  });
  server.on('upgrade', (req, socket) => {
    requests.push({ method: 'UPGRADE', path: req.url, authorization: '', headers: req.headers, at: Date.now() });
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { label, baseUrl: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
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
    this.dialogAnswers = [];
    this.dialogs = [];
  }

  async connect() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onmessage = (event) => {
      const payload = JSON.parse(String(event.data));
      if (payload.method === 'Page.javascriptDialogOpening') {
        this.dialogs.push({ type: payload.params.type, message: payload.params.message });
        const answer = this.dialogAnswers.shift() || { accept: true };
        void this.call('Page.handleJavaScriptDialog', answer).catch(() => {});
        return;
      }
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
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime evaluation failed.');
    }
    return result.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch { /* best-effort */ }
  }
}

async function openPanel(devtoolsBase, extensionId) {
  const target = await (await fetch(
    `${devtoolsBase}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/sidepanel.html`)}`,
    { method: 'PUT' },
  )).json();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.call('Runtime.enable');
  await client.call('Page.enable');
  await client.call('Page.bringToFront');
  await client.call('Emulation.setDeviceMetricsOverride', { width: 380, height: 820, deviceScaleFactor: 1, mobile: false });
  await panelReady(client);
  return client;
}

const PANEL_READY = `document.readyState === 'complete' && window.__qaMark === undefined
  && Boolean(document.querySelector('#promptInput')) && document.querySelectorAll('#savedConnectionList [data-saved-connection-id]').length > 0`;

async function panelReady(panel) {
  await waitFor(async () => {
    try { return await panel.evaluate(PANEL_READY); } catch { return false; }
  }, 25_000, 200);
}

const markPanel = (panel) => panel.evaluate('window.__qaMark = 1; true');
const panelActive = (panel) => panel.evaluate("document.querySelector('#savedConnectionList [aria-current=\"true\"]')?.dataset.savedConnectionId || ''");
const panelGateway = (panel) => panel.evaluate("document.querySelector('#gatewayUrlInput').value");
const storedActive = (setup) => setup.evaluate("chrome.storage.local.get('hermesBrowserSettings').then((r) => r.hermesBrowserSettings.activeSavedConnectionId || '')");

async function openConnectionsPane(panel) {
  await panel.evaluate(`(() => {
    if (document.querySelector('#settingsDialog')?.hidden !== false) document.querySelector('#settingsButton').click();
    return true;
  })()`);
  await waitFor(() => panel.evaluate("document.querySelector('#settingsDialog')?.hidden === false"));
  await panel.evaluate(`(() => {
    const pane = document.querySelector('#settingsPane-connections');
    if (pane?.hidden !== false) document.querySelector('[data-settings-category="connections"]')?.click();
    return true;
  })()`);
  await waitFor(() => panel.evaluate("document.querySelector('#settingsPane-connections')?.hidden === false"));
}

const cardSelector = '#savedConnectionList [data-saved-connection-id]';
const selectOptions = (panel) => panel.evaluate(`Array.from(document.querySelectorAll('${cardSelector}')).map((card) => ({
  value: card.dataset.savedConnectionId,
  label: card.querySelector('.conn-mode-title').textContent,
  summary: card.querySelector('.conn-mode-desc').textContent,
  selected: card.getAttribute('aria-current') === 'true',
}))`);
const visible = (panel, selector) => panel.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); return Boolean(node) && !node.hidden && node.offsetParent !== null; })()`);
const click = (panel, selector) => panel.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
const clickCard = (panel, id) => click(panel, `${cardSelector}[data-saved-connection-id="${id}"]`);
const settingsOpen = (panel) => panel.evaluate("document.querySelector('#settingsDialog')?.hidden === false");
const focusedId = (panel) => panel.evaluate("document.activeElement?.id || ''");

async function pressKey(panel, key) {
  const code = { Enter: 13, Escape: 27 }[key];
  for (const type of ['keyDown', 'keyUp']) {
    await panel.call('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  }
}

async function nameConnection(panel, trigger, name, { how = 'button', reloads = false } = {}) {
  await click(panel, trigger);
  await waitFor(() => visible(panel, '#savedConnectionEditor'));
  await setField(panel, '#savedConnectionNameInput', name);
  if (reloads) await markPanel(panel);
  if (how === 'enter') await pressKey(panel, 'Enter');
  else await click(panel, '#savedConnectionNameSave');
}

async function saveSettings(panel) {
  await panel.evaluate("document.querySelector('#saveSettingsTopButton').click(); true");
  await new Promise((resolve) => setTimeout(resolve, 700));
}

async function setField(panel, selector, value) {
  await panel.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function shot(panel, name) {
  const image = await panel.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(QA_DIR, `saved-connections-${name}.png`), Buffer.from(image.data, 'base64'));
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  assert.ok(existsSync(path.join(DIST, 'manifest.json')), 'Run npm run build before this QA script.');
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  await mkdir(QA_DIR, { recursive: true });

  const first = await startStubGateway('first');
  const second = await startStubGateway('second');
  let chrome;
  let setup;
  const panels = [];
  try {
    const extensionId = unpackedExtensionId(DIST);
    chrome = launchChrome(resolveChromeExecutable(['D:\\HermesCaches\\chrome-for-testing\\chrome-win64\\chrome.exe']), [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--autoplay-policy=user-gesture-required', '--remote-debugging-port=0',
      `--user-data-dir=${PROFILE}`, `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`,
      `chrome-extension://${extensionId}/request-permissions.html`,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

    const activePort = path.join(PROFILE, 'DevToolsActivePort');
    await waitFor(() => existsSync(activePort));
    const [portLine] = (await readFile(activePort, 'utf8')).trim().split('\n');
    const devtoolsBase = `http://127.0.0.1:${Number(portLine)}`;
    await ensureExtensionStartupPage(devtoolsBase, extensionId);

    const wakeTarget = (await (await fetch(`${devtoolsBase}/json/list`)).json()).find((target) => (
      target.type === 'page' && String(target.url || '').startsWith(`chrome-extension://${extensionId}/`)));
    const wake = new CdpClient(wakeTarget.webSocketDebuggerUrl);
    await wake.connect();
    await wake.call('Runtime.enable');
    await waitFor(() => wake.evaluate('Boolean(globalThis.chrome?.storage?.local)'));
    setup = wake;
    await setup.evaluate(`chrome.storage.local.set({hermesBrowserSettings:${JSON.stringify({
      connectionSchemaVersion: 1,
      connectionMode: 'local',
      connectionTransport: 'local-api',
      gatewayMode: 'local-api',
      gatewayUrl: first.baseUrl,
      apiKey: KEY_FIRST,
      tokenSource: 'qa',
      sessionId: 'hermes-browser-extension',
      sessionStartMode: 'fresh',
      model: 'e2e/test-model',
      appearanceTheme: 'mono',
      colorMode: 'dark',
    })}, hermesBrowserIntroSeen: true})`);

    // 1. The existing setup becomes the first saved connection and reaches only its own gateway.
    const panel = await openPanel(devtoolsBase, extensionId);
    panels.push(panel);
    await waitFor(() => first.requests.some((request) => request.authorization === `Bearer ${KEY_FIRST}`), 20_000);
    const firstId = await waitFor(async () => (await storedActive(setup)) || null, 10_000);
    check('first gateway receives its own key', first.requests.some((request) => request.authorization === `Bearer ${KEY_FIRST}`));
    await openConnectionsPane(panel);
    const initialOptions = await selectOptions(panel);
    check('the current setup is the first saved connection', initialOptions.length === 1 && initialOptions[0].selected, JSON.stringify(initialOptions));
    check('the only connection cannot be deleted', await panel.evaluate("document.querySelector('#savedConnectionDelete').disabled === true"));
    check('the card names the kind and address, not the key', initialOptions[0].summary === `Local gateway \u00b7 ${new URL(first.baseUrl).host}`, initialOptions[0].summary);
    await shot(panel, '1-first-connection');

    // The name field opens inline, Escape closes only it, and an empty name is not accepted.
    await click(panel, '#savedConnectionAdd');
    await waitFor(() => visible(panel, '#savedConnectionEditor'));
    check('Add opens an inline name field in place of the buttons', (await visible(panel, '#savedConnectionNameInput')) && !(await visible(panel, '#savedConnectionActions')));
    check('the name field has focus', (await focusedId(panel)) === 'savedConnectionNameInput');
    await shot(panel, '5-name-field');
    await pressKey(panel, 'Escape');
    check('Escape closes the name field and keeps Settings open', !(await visible(panel, '#savedConnectionEditor')) && (await visible(panel, '#savedConnectionActions')) && (await settingsOpen(panel)));
    check('focus returns to the Add button', (await focusedId(panel)) === 'savedConnectionAdd');
    await click(panel, '#savedConnectionAdd');
    await waitFor(() => visible(panel, '#savedConnectionEditor'));
    await setField(panel, '#savedConnectionNameInput', '   ');
    await pressKey(panel, 'Enter');
    check('an empty name is not accepted', (await visible(panel, '#savedConnectionEditor')) && (await selectOptions(panel)).length === 1);
    await click(panel, '#savedConnectionNameCancel');

    // 2. A draft typed on the first connection.
    await panel.evaluate(`(() => { document.querySelector('#settingsDialog')?.querySelector('[data-settings-close], #closeSettingsButton')?.click(); return true; })()`);
    await panel.evaluate(`(() => {
      const input = document.querySelector('#promptInput');
      input.value = ${JSON.stringify(DRAFT_FIRST)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // 3. Add a second connection, point it at the second gateway with its own key.
    await openConnectionsPane(panel);
    await nameConnection(panel, '#savedConnectionAdd', 'Second gateway', { how: 'enter', reloads: true });
    await panelReady(panel);
    const secondId = await storedActive(setup);
    check('Add makes the new connection active', secondId && secondId !== firstId);
    await openConnectionsPane(panel);
    const twoOptions = await selectOptions(panel);
    check('both connections are listed, the new one selected', twoOptions.length === 2 && twoOptions.find((option) => option.selected)?.label === 'Second gateway', JSON.stringify(twoOptions));
    await setField(panel, '#gatewayUrlInput', second.baseUrl);
    await setField(panel, '#apiKeyInput', KEY_SECOND);
    await saveSettings(panel);
    await markPanel(panel);
    await panel.evaluate('window.location.reload(); true');
    await panelReady(panel);
    await waitFor(() => second.requests.some((request) => request.authorization === `Bearer ${KEY_SECOND}`), 20_000);
    check('second gateway receives its own key', second.requests.some((request) => request.authorization === `Bearer ${KEY_SECOND}`));
    check('second gateway never receives the first key', !second.requests.some((request) => request.authorization === `Bearer ${KEY_FIRST}`));
    check('the second card shows the second address', (await selectOptions(panel)).find((option) => option.label === 'Second gateway')?.summary === `Local gateway \u00b7 ${new URL(second.baseUrl).host}`);
    const draftOnSecond = await panel.evaluate("document.querySelector('#promptInput').value");
    check('the second connection starts with an empty composer', draftOnSecond === '', JSON.stringify(draftOnSecond));
    await openConnectionsPane(panel);
    await shot(panel, '2-second-connection');

    // 4. Credentials are not in storage in plain text.
    const stored = JSON.stringify(await setup.evaluate('chrome.storage.local.get(null)'));
    check('no API key is stored in plain text', !stored.includes(KEY_FIRST) && !stored.includes(KEY_SECOND));

    // 5. A second open panel follows a switch made in the first.
    const other = await openPanel(devtoolsBase, extensionId);
    panels.push(other);
    check('a second panel opens on the active connection', (await panelActive(other)) === secondId);
    const firstRequestsBeforeSwitch = first.requests.length;
    await markPanel(panel);
    await markPanel(other);
    await clickCard(panel, firstId);
    await panelReady(panel);
    check('switching back selects the first connection', (await panelActive(panel)) === firstId && (await storedActive(setup)) === firstId);
    check('the first connection points at the first gateway', (await panelGateway(panel)) === first.baseUrl);
    await waitFor(() => first.requests.length > firstRequestsBeforeSwitch && first.requests.slice(firstRequestsBeforeSwitch).some((request) => request.authorization === `Bearer ${KEY_FIRST}`), 20_000);
    check('the first gateway gets its own key again', first.requests.slice(firstRequestsBeforeSwitch).some((request) => request.authorization === `Bearer ${KEY_FIRST}`));
    check('the first gateway never receives the second key', !first.requests.some((request) => request.authorization === `Bearer ${KEY_SECOND}`));
    const draftBack = await waitFor(async () => {
      const value = await panel.evaluate("document.querySelector('#promptInput').value");
      return value || null;
    }, 10_000).catch(() => '');
    check('the first connection restores its own draft', draftBack === DRAFT_FIRST, JSON.stringify(draftBack));
    await panelReady(other).catch(() => {});
    check('the other open panel moved to the first connection too', (await panelActive(other)) === firstId);
    await shot(panel, '3-back-on-first');

    // 6. Rename, then delete the second connection.
    await openConnectionsPane(panel);
    await click(panel, '#savedConnectionRename');
    await waitFor(() => visible(panel, '#savedConnectionEditor'));
    check('Rename opens the name field with the current name', (await panel.evaluate("document.querySelector('#savedConnectionNameInput').value")) === 'Connection 1');
    await setField(panel, '#savedConnectionNameInput', 'Primary');
    await click(panel, '#savedConnectionNameSave');
    await waitFor(async () => (await selectOptions(panel)).some((option) => option.label === 'Primary'), 10_000);
    check('Rename changes the label', (await selectOptions(panel)).some((option) => option.label === 'Primary'));
    await markPanel(panel);
    await clickCard(panel, secondId);
    await panelReady(panel);
    await openConnectionsPane(panel);
    await click(panel, '#savedConnectionDelete');
    await waitFor(() => visible(panel, '#savedConnectionConfirm'));
    check('Delete asks inline, naming the connection and what is removed', (await panel.evaluate("document.querySelector('#savedConnectionConfirmTitle').textContent")).includes('Second gateway')
      && (await panel.evaluate("document.querySelector('#savedConnectionConfirmDetail').textContent")).includes('Chats stay'));
    await shot(panel, '6-delete-confirm');
    await pressKey(panel, 'Escape');
    check('Escape cancels Delete and keeps the connection', !(await visible(panel, '#savedConnectionConfirm')) && (await selectOptions(panel)).length === 2 && (await settingsOpen(panel)));
    await click(panel, '#savedConnectionDelete');
    await waitFor(() => visible(panel, '#savedConnectionConfirm'));
    await click(panel, '#savedConnectionDeleteCancel');
    check('Cancel keeps the connection', (await selectOptions(panel)).length === 2);
    await click(panel, '#savedConnectionDelete');
    await waitFor(() => visible(panel, '#savedConnectionConfirm'));
    await markPanel(panel);
    await click(panel, '#savedConnectionDeleteConfirm');
    await waitFor(async () => (await selectOptions(panel)).length === 1, 15_000);
    await waitFor(async () => (await storedActive(setup)) === firstId, 15_000).catch(() => {});
    const afterDelete = await selectOptions(panel);
    check('Delete removes the connection and returns to the first', afterDelete.length === 1 && (await storedActive(setup)) === firstId, JSON.stringify(afterDelete));
    const keysLeft = await setup.evaluate(`chrome.storage.local.get(null).then((all) => Object.keys(all).filter((key) => key.includes(${JSON.stringify(secondId)})))`);
    check('Delete removes the connection\'s stored records', keysLeft.length === 0, JSON.stringify(keysLeft));
    check('the last connection cannot be deleted', await panel.evaluate("document.querySelector('#savedConnectionDelete').disabled === true"));
    await shot(panel, '4-after-delete');
    check('no native browser dialog was opened', panel.dialogs.length === 0, JSON.stringify(panel.dialogs));

    // 7. Custom headers reach the gateway on every request, and only that gateway. A browser cannot put headers on a WebSocket handshake.
    const setHeaders = (headers) => panel.evaluate(`(async () => {
      const lib = await import('./lib/saved-connections.mjs');
      const stored = await chrome.storage.local.get(['hermesBrowserSettings', lib.SAVED_CONNECTION_SECRETS_STORAGE_KEY]);
      const live = await lib.hydrateHermesBrowserSettingsFromStorage(stored);
      await chrome.storage.local.set(await lib.packedHermesBrowserSettingsWrite({ ...live, connectionHeaders: ${JSON.stringify(headers)} }, chrome.storage.local));
      return true;
    })()`);
    const probe = async (gateway) => {
      const before = gateway.requests.length;
      await setup.evaluate(`fetch(${JSON.stringify(`${gateway.baseUrl}/headers-probe`)}).then((response) => response.status)`);
      const seen = gateway.requests.slice(before);
      return { plain: seen.find((request) => request.path === '/headers-probe')?.headers['x-proxy-token'] || '', socket: '' };
    };
    await setHeaders([{ name: 'X-Proxy-Token', value: 'proxy-e2e-value' }]);
    const withHeader = await waitFor(async () => {
      const result = await probe(first);
      return result.plain ? result : null;
    }, 20_000, 500).catch(() => ({ plain: '', socket: '' }));
    check('a custom header reaches the gateway on a plain request', withHeader.plain === 'proxy-e2e-value', JSON.stringify(withHeader));
    await markPanel(panel);
    await panel.evaluate('window.location.reload(); true');
    await panelReady(panel);
    const ownRequests = await waitFor(() => first.requests.some((request) => request.path === '/health' && request.headers['x-proxy-token'] === 'proxy-e2e-value'), 15_000).catch(() => false);
    check('and on the panel itself', Boolean(ownRequests));
    const unrelated = await probe(second);
    check("another service on the same machine does not receive it", !unrelated.plain && !unrelated.socket, JSON.stringify(unrelated));
    const storedWithHeaders = JSON.stringify(await setup.evaluate('chrome.storage.local.get(null)'));
    check('the header value is not stored in plain text', !storedWithHeaders.includes('proxy-e2e-value'));
    await setHeaders([]);
    const without = await waitFor(async () => {
      const result = await probe(first);
      return !result.plain ? result : null;
    }, 20_000, 500).catch(() => ({ plain: 'still-sent', socket: '' }));
    check('removing the header stops it being sent', !without.plain && !without.socket, JSON.stringify(without));

    // 8. A long name and several connections still fit a narrow panel, in the light theme too.
    const longName = 'A connection with a very long name that keeps going past the edge of the card';
    await nameConnection(panel, '#savedConnectionAdd', longName, { reloads: true });
    await panelReady(panel);
    for (const extra of ['Staging', 'Home lab', 'Work']) {
      await openConnectionsPane(panel);
      await nameConnection(panel, '#savedConnectionAdd', extra, { reloads: true });
      await panelReady(panel);
    }
    await setup.evaluate("chrome.storage.local.get('hermesBrowserSettings').then((r) => chrome.storage.local.set({ hermesBrowserSettings: { ...r.hermesBrowserSettings, colorMode: 'light' } }))");
    await markPanel(panel);
    await panel.evaluate('window.location.reload(); true');
    await panelReady(panel);
    await openConnectionsPane(panel);
    check('five connections are listed', (await selectOptions(panel)).length === 5);
    check('a long name wraps inside its card and the pane does not scroll sideways', await panel.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('${cardSelector}'));
      const pane = document.querySelector('#settingsPane-connections');
      return cards.every((card) => card.scrollWidth <= card.clientWidth + 1) && pane.scrollWidth <= pane.clientWidth + 1;
    })()`));
    await shot(panel, '7-five-connections-light');
  } finally {
    for (const open of panels) open.close();
    setup?.close();
    killProcessTree(chrome);
    await first.close();
    await second.close();
    await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
  }
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
