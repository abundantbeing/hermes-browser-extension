import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DIST = path.join(ROOT, 'dist');
const PROFILE = path.join(ROOT, 'tmp', `e2e-phase6-browser-control-${process.pid}`);
const QA_DIR = path.join(ROOT, '.hermes', 'qa');
const PANEL_SCREENSHOT = path.join(QA_DIR, 'phase6-hermes-control-settings.png');
const LIVE_SCREENSHOT = path.join(QA_DIR, 'phase6-hermes-control-live.png');
const UNATTACHED_SCREENSHOT = path.join(QA_DIR, 'phase6-hermes-control-unattached.png');
export const TEST_ACCESS_VALUE = ['e2e', 'phase6', 'fixture', 'value'].join('-');
export const TEST_SESSION_ID = 'hermes-browser-phase6-e2e';
export const PUBLIC_PROTOCOL = 'hermes-browser-control-v1';
export const TICKET_PREFIX = 'hermes-browser-control-ticket.';
export const REAL_CAPABILITIES = Object.freeze([
  'controller.noop',
  'browser_back',
  'browser_click',
  'browser_drag',
  'browser_hover',
  'browser_navigate',
  'browser_press',
  'browser_screenshot',
  'browser_scroll',
  'browser_scroll_to',
  'browser_snapshot',
  'browser_tab_activate',
  'browser_tab_close',
  'browser_tab_create',
  'browser_tab_group',
  'browser_tab_ungroup',
  'browser_tabs',
  'browser_type',
]);

const FIXTURE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Phase 6 Control Fixture</title>
<style>
body{font-family:Arial,sans-serif;margin:0;background:#f4f6fb;color:#17191f}main{padding:32px;min-height:1500px}
.card{max-width:640px;padding:24px;border:2px solid #172bff;background:#fff}label{display:block;font-weight:700;margin-bottom:8px}
input,button{font:inherit;padding:12px;border:1px solid #17191f;border-radius:0}button{background:#172bff;color:#fff;margin-left:8px}
#result{margin-top:18px;font-weight:700}.spacer{height:900px}.bottom{padding:20px;background:#d9ffe5;border:1px solid #00a846}
</style></head><body><main>
<section class="card"><h1>Phase 6 Control Fixture</h1><label for="draft">Draft title</label>
<input id="draft" aria-label="Draft title" type="text" autocomplete="off"><button id="apply" type="button">Apply draft</button>
<p id="result" aria-live="polite">Waiting</p></section><div class="spacer"></div><p id="bottom" class="bottom">Scroll target reached</p>
</main><script>
globalThis.phase6State={clicks:0,keys:[],indicatorSeen:false};
document.querySelector('#apply').addEventListener('click',()=>{phase6State.clicks+=1;document.querySelector('#result').textContent='Applied: '+document.querySelector('#draft').value});
document.addEventListener('keydown',(event)=>phase6State.keys.push(event.key));
const observer=new MutationObserver(()=>{if(document.querySelector('hermes-browser-control-indicator'))phase6State.indicatorSeen=true});observer.observe(document.documentElement,{childList:true,subtree:true});
</script></body></html>`;

const SECOND_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Phase 6 Second Page</title></head>
<body style="font-family:Arial,sans-serif;padding:40px"><h1 id="second">Second page reached</h1></body></html>`;

export function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Users\\Jaybo\\AppData\\Local\\hermes\\chrome-for-testing\\chrome\\win64-151.0.7922.76\\chrome-win64\\chrome.exe',
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Hermes Chrome for Testing not found. Set CHROME_PATH.');
  return found;
}

export function unpackedExtensionId(extensionPath) {
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
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Hermes-Profile',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  });
  res.end(body);
}

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function websocketFrame(payload, opcode = 0x1) {
  const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const header = body.length < 126
    ? Buffer.from([0x80 | opcode, body.length])
    : Buffer.from([0x80 | opcode, 126, (body.length >>> 8) & 255, body.length & 255]);
  return Buffer.concat([header, body]);
}

function decodeClientFrames(connection, chunk, onFrame) {
  connection.buffer = Buffer.concat([connection.buffer, chunk]);
  while (connection.buffer.length >= 2) {
    const first = connection.buffer[0];
    const second = connection.buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (connection.buffer.length < 4) return;
      length = connection.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (connection.buffer.length < 10) return;
      const big = connection.buffer.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Oversized WebSocket fixture frame.');
      length = Number(big);
      offset = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (connection.buffer.length < offset + maskLength + length) return;
    const mask = masked ? connection.buffer.subarray(offset, offset + 4) : null;
    const payload = Buffer.from(connection.buffer.subarray(offset + maskLength, offset + maskLength + length));
    connection.buffer = connection.buffer.subarray(offset + maskLength + length);
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    if (opcode === 0x8) {
      connection.socket.end(websocketFrame('', 0x8));
      continue;
    }
    if (opcode === 0x9) {
      connection.socket.write(websocketFrame(payload, 0xA));
      continue;
    }
    if (opcode !== 0x1) continue;
    onFrame(JSON.parse(payload.toString('utf8')));
  }
}

export async function startControllerFixture() {
  const registrations = [];
  const connections = [];
  const results = [];
  const heartbeats = [];
  const issuedTickets = new Set();
  let ticketSequence = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/fixture') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(FIXTURE_PAGE);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/second') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(SECOND_PAGE);
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Hermes-Profile, X-Hermes-Session-Id, X-Hermes-Session-Key',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      });
      res.end();
      return;
    }
    if ((url.pathname === '/health' || url.pathname === '/v1/health') && req.method === 'GET') {
      json(res, 200, { status: 'ok', platform: 'hermes-agent', version: 'phase6-e2e' });
      return;
    }
    if (url.pathname === '/v1/capabilities' && req.method === 'GET') {
      json(res, 200, {
        object: 'hermes.api_server.capabilities',
        platform: 'hermes-agent',
        auth: { type: 'bearer', required: true },
        features: {
          models_api: true,
          session_resources: true,
          session_chat: true,
          session_chat_streaming: true,
          session_model_routing: true,
          skills_api: true,
        },
        endpoints: {
          health: { method: 'GET', path: '/health' },
          models: { method: 'GET', path: '/v1/models' },
          sessions: { method: 'GET', path: '/api/sessions' },
          session_create: { method: 'POST', path: '/api/sessions' },
          session_model: { method: 'POST', path: '/api/sessions/{session_id}/model' },
          session_chat: { method: 'POST', path: '/api/sessions/{session_id}/chat' },
          session_chat_stream: { method: 'POST', path: '/api/sessions/{session_id}/chat/stream' },
          skills: { method: 'GET', path: '/v1/skills' },
        },
      });
      return;
    }
    if (url.pathname === '/api/model/options' && req.method === 'GET') {
      json(res, 200, {
        providers: [{
          slug: 'phase6',
          name: 'Phase 6 E2E',
          authenticated: true,
          models: [{ id: 'phase6/e2e-model', label: 'Phase 6 E2E Model', context_length: 32_000 }],
          capabilities: { 'phase6/e2e-model': { reasoning: false, fast: true } },
        }],
      });
      return;
    }
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      json(res, 200, { object: 'list', data: [{ id: 'phase6/e2e-model', provider: 'phase6', context_length: 32_000 }] });
      return;
    }
    if ((url.pathname === '/v1/skills' || url.pathname === '/v1/toolsets') && req.method === 'GET') {
      json(res, 200, { object: 'list', data: [] });
      return;
    }
    if ((url.pathname === '/api/profiles' || url.pathname === '/api/profiles/active') && req.method === 'GET') {
      json(res, 404, { error: { message: 'Optional profile API unavailable' } });
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      json(res, 200, {
        object: 'list',
        data: [{ id: TEST_SESSION_ID, session_id: TEST_SESSION_ID, title: 'Hermes Browser Extension', source: 'hermes_browser_extension' }],
        total: 1,
        has_more: false,
      });
      return;
    }
    if (url.pathname === `/api/sessions/${TEST_SESSION_ID}/messages` && req.method === 'GET') {
      json(res, 200, { object: 'list', data: [] });
      return;
    }
    if (url.pathname === '/v1/browser-control/register' && req.method === 'POST') {
      assert.equal(req.headers.authorization, ['Bearer', TEST_ACCESS_VALUE].join(' '));
      const body = await requestBody(req);
      assert.ok(String(body.session_id || '').trim(), 'Controller registration session_id is required.');
      const advertised = JSON.stringify(body.capabilities);
      assert.ok(
        advertised === JSON.stringify(['controller.noop'])
        || advertised === JSON.stringify([...REAL_CAPABILITIES]),
        `Unexpected controller capabilities: ${advertised}`,
      );
      assert.equal(body.protocol_version, 1);
      registrations.push(body);
      ticketSequence += 1;
      const ticket = `controller-ticket-${ticketSequence}`;
      issuedTickets.add(ticket);
      json(res, 200, {
        ticket,
        scope: {
          controller_id: body.controller_id,
          browser_profile_id: body.browser_profile_id,
          session_id: body.session_id,
        },
      });
      return;
    }
    json(res, 404, { detail: 'not found' });
  });

  server.on('upgrade', (req, socket) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      assert.equal(url.pathname, '/v1/browser-control/ws');
      assert.equal(url.search, '', 'Controller ticket must never appear in the WebSocket URL.');
      const protocols = String(req.headers['sec-websocket-protocol'] || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      assert.ok(protocols.includes(PUBLIC_PROTOCOL));
      const ticketProtocol = protocols.find((value) => value.startsWith(TICKET_PREFIX));
      assert.ok(ticketProtocol, 'Controller ticket subprotocol was missing.');
      const ticket = ticketProtocol.slice(TICKET_PREFIX.length);
      assert.ok(issuedTickets.delete(ticket), 'Controller ticket was invalid or replayed.');
      const key = String(req.headers['sec-websocket-key'] || '');
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        `Sec-WebSocket-Protocol: ${PUBLIC_PROTOCOL}`,
        '',
        '',
      ].join('\r\n'));
      const connection = {
        socket,
        buffer: Buffer.alloc(0),
        protocols,
        requestTarget: req.url,
        openedAt: Date.now(),
        closedAt: null,
        frames: [],
        send(frame) { socket.write(websocketFrame(frame)); },
      };
      connections.push(connection);
      socket.on('close', () => { connection.closedAt = Date.now(); });
      socket.on('error', () => {
        // MV3 worker termination resets its controller socket. The lifecycle
        // assertion observes reconnection through the next registered socket.
      });
      socket.on('data', (chunk) => decodeClientFrames(connection, chunk, (frame) => {
        connection.frames.push({ method: String(frame?.method || ''), at: Date.now() });
        if (frame?.method === 'browser.controller.heartbeat') {
          const nonce = String(frame?.params?.nonce || '');
          heartbeats.push({ connection: connections.indexOf(connection), nonce });
          connection.send({ method: 'browser.controller.heartbeat', params: { nonce, ok: true } });
          return;
        }
        if (frame?.method === 'browser.controller.result') results.push(frame);
      }));
    } catch (error) {
      socket.destroy(error);
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    registrations,
    connections,
    results,
    heartbeats,
    forceDisconnect(index = connections.length - 1) {
      const connection = connections[index];
      if (!connection) throw new Error(`Controller connection ${index} does not exist.`);
      connection.socket.destroy();
      return index;
    },
    close: async () => {
      for (const connection of connections) connection.socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export class CdpClient {
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
      if (!payload.id) {
        this.events.push(payload);
        return;
      }
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

export async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} failed (${response.status})`);
  return response.json();
}

export async function waitFor(check, timeoutMs = 25_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError || new Error(`Timed out after ${timeoutMs}ms`);
}

export function killChrome(child) {
  if (!child?.pid) return;
  try {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch { /* best effort */ }
}



async function main() {
  assert.ok(existsSync(path.join(DIST, 'manifest.json')), 'Run npm run build before the controller CFT journey.');
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  const fixture = await startControllerFixture();
  let chrome;
  let page;
  let browser;
  let chromeStderr = '';
  try {
    const extensionId = unpackedExtensionId(DIST);
    chrome = spawn(chromeExecutable(), [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      `--user-data-dir=${PROFILE}`,
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      `chrome-extension://${extensionId}/request-permissions.html`,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    chrome.stderr.on('data', (chunk) => { chromeStderr += String(chunk); });

    const activePort = path.join(PROFILE, 'DevToolsActivePort');
    await waitFor(() => existsSync(activePort));
    const [portLine] = (await readFile(activePort, 'utf8')).trim().split('\n');
    const devtoolsBase = `http://127.0.0.1:${Number(portLine)}`;
    const version = await fetchJson(`${devtoolsBase}/json/version`);
    browser = new CdpClient(version.webSocketDebuggerUrl);
    await browser.connect();

    const pageTarget = await waitFor(async () => {
      const targets = await fetchJson(`${devtoolsBase}/json/list`);
      return targets.find((target) => target.type === 'page' && String(target.url || '').startsWith(`chrome-extension://${extensionId}/`)) || null;
    });
    page = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await page.connect();
    await page.call('Runtime.enable');
    await waitFor(() => page.evaluate('Boolean(globalThis.chrome?.runtime?.sendMessage && chrome?.storage?.local)'));

    await page.evaluate(`(() => {
      const authField = ['api', 'Key'].join('');
      return chrome.storage.local.set({
        hermesBrowserSettings: {
          connectionSchemaVersion: 1,
          connectionMode: 'local',
          connectionTransport: 'local-api',
          gatewayMode: 'local-api',
          gatewayUrl: ${JSON.stringify(fixture.baseUrl)},
          [authField]: ${JSON.stringify(TEST_ACCESS_VALUE)},
          tokenSource: 'e2e-controller',
          sessionId: ${JSON.stringify(TEST_SESSION_ID)},
          remoteDashboardSession: {
            storedSessionId: 'stale-dashboard-session-must-not-route-local-control'
          },
          sessionStartMode: 'resume',
          browserControlEnabled: true,
          browserControlPaused: false,
          browserControlScope: 'this-tab',
          browserControlViewBehavior: 'stay',
          textZoomPercent: 125
        },
        hermesBrowserIntroSeen: true
      });
    })()`);

    const rebound = await page.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_SETTINGS_REFRESH' })`);
    assert.equal(rebound?.ok, true, JSON.stringify(rebound));
    assert.equal(rebound?.controlEnabled, true, JSON.stringify(rebound));
    await waitFor(() => fixture.registrations.some((registration) => (
      JSON.stringify(registration.capabilities) === JSON.stringify([...REAL_CAPABILITIES])
    ))).catch((error) => {
      throw new Error(`${error.message}; rebound=${JSON.stringify(rebound)}; registrations=${JSON.stringify(fixture.registrations.map((item) => ({ generation: item.generation, capabilities: item.capabilities, product: item.product })))}`);
    });
    assert.ok(
      fixture.registrations.every((registration) => registration.session_id === TEST_SESSION_ID),
      `local control registered a stale dashboard session: ${JSON.stringify(fixture.registrations)}`,
    );
    await waitFor(() => fixture.connections.length >= 1);
    const controllerStatus = await waitFor(() => page.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' })`).then((value) => (
      value?.connected && value?.controlEnabled && value?.controllerId ? value : null
    )));

    const fixtureUrl = `${fixture.baseUrl}/fixture`;
    const secondUrl = `${fixture.baseUrl}/second`;
    const controlledTab = await page.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(fixtureUrl)}, active: true })`);
    const tabId = Number(controlledTab.id);
    assert.ok(Number.isInteger(tabId) && tabId > 0);
    const controlledTarget = await waitFor(async () => {
      const targets = await fetchJson(`${devtoolsBase}/json/list`);
      return targets.find((target) => target.type === 'page' && String(target.url || '').startsWith(fixtureUrl)) || null;
    });
    const controlled = new CdpClient(controlledTarget.webSocketDebuggerUrl);
    await controlled.connect();
    await controlled.call('Runtime.enable');
    await waitFor(() => controlled.evaluate(`Boolean(document.querySelector('#draft') && globalThis.phase6State)`));

    const lease = await page.evaluate(`chrome.runtime.sendMessage({
      type: 'HERMES_CONTROLLER_LEASE_ACQUIRE',
      kind: 'this-tab',
      ownerId: ${JSON.stringify(controllerStatus.controllerId)},
      ownership: 'owned',
      tabIds: [${tabId}]
    })`);
    assert.equal(lease?.ok, true, JSON.stringify(lease));
    await page.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_DOCUMENT_READY', tabId: ${tabId}, frameId: 0 })`);

    const resolveTarget = (expectedUrl) => page.evaluate(`chrome.runtime.sendMessage({
      type: 'HERMES_CONTROLLER_TARGET_RESOLVE',
      tabId: ${tabId},
      frameId: 0,
      expectedUrl: ${JSON.stringify(expectedUrl)}
    })`);
    let target = await waitFor(() => resolveTarget(fixtureUrl).then((value) => value?.availability === 'available' ? value : null));
    assert.equal(target.isolatedFallback, 'forbidden');
    assert.equal(target.tabId, tabId);
    assert.ok(target.documentGeneration >= 1);

    const indicatorProbe = await page.evaluate(`(async () => {
      try {
        const response = await chrome.tabs.sendMessage(${tabId}, {
          type: 'HERMES_BROWSER_CONTROL_INDICATOR',
          phase: 'start',
          action: 'browser_click',
        });
        return { ok: true, response };
      } catch (error) {
        return { ok: false, error: error?.message || String(error) };
      }
    })()`);
    const indicatorProbeVisible = await controlled.evaluate(`Boolean(document.querySelector('.browser-control-indicator'))`);
    await page.evaluate(`chrome.tabs.sendMessage(${tabId}, { type: 'HERMES_BROWSER_CONTROL_INDICATOR', phase: 'finish', action: 'browser_click' }).catch(() => {})`);
    assert.deepEqual(indicatorProbe, { ok: true, response: { ok: true } }, JSON.stringify(indicatorProbe));
    assert.equal(indicatorProbeVisible, true, JSON.stringify(indicatorProbe));

    const controllerConnectionFor = (action) => {
      const connectionIndex = [...fixture.registrations]
        .map((registration, index) => ({ registration, index }))
        .reverse()
        .find(({ registration }) => Array.isArray(registration.capabilities) && registration.capabilities.includes(action))
        ?.index;
      const connection = Number.isInteger(connectionIndex) ? fixture.connections[connectionIndex] : fixture.connections.at(-1);
      assert.ok(connection, `No controller socket advertises ${action}.`);
      return connection;
    };
    const sendCommand = async (commandId, action, args = {}, targetOverride = target) => {
      const connection = controllerConnectionFor(action);
      connection.send({
        method: 'browser.controller.command',
        params: {
          command_id: commandId,
          action,
          arguments: args,
          tab_id: targetOverride.tabId,
          frame_id: targetOverride.frameId,
          document_generation: targetOverride.documentGeneration,
        },
      });
      return waitFor(() => fixture.results.find((frame) => frame?.params?.command_id === commandId));
    };

    const panelTarget = await fetchJson(
      `${devtoolsBase}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/sidepanel.html`)}`,
      { method: 'PUT' },
    );
    const panel = new CdpClient(panelTarget.webSocketDebuggerUrl);
    await panel.connect();
    await panel.call('Runtime.enable');
    await panel.call('Emulation.setDeviceMetricsOverride', { width: 520, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor(() => panel.evaluate(`Boolean(document.querySelector('#browserControlCard') && document.querySelector('#browserControlStrip'))`));
    await panel.evaluate(`(() => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      globalThis.__phase6PanelTabId = ${tabId};
      chrome.tabs.query = async (queryInfo) => {
        if (queryInfo?.active === true && queryInfo?.currentWindow === true && globalThis.__phase6PanelTabId) {
          return [await chrome.tabs.get(globalThis.__phase6PanelTabId)];
        }
        return query(queryInfo);
      };
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    await waitFor(() => panel.evaluate(`(() => {
      const dialog = document.querySelector('#settingsDialog');
      if (dialog?.hidden !== false) document.querySelector('#settingsButton')?.click();
      return dialog?.hidden === false;
    })()`)).catch(async (error) => {
      const diagnostics = await panel.evaluate(`(() => ({
        readyState: document.readyState,
        settingsButton: Boolean(document.querySelector('#settingsButton')),
        settingsHidden: document.querySelector('#settingsDialog')?.hidden,
        status: document.querySelector('#statusDetail')?.textContent,
        bodyText: document.body?.innerText?.slice(0, 500),
      }))()`);
      const exceptions = panel.events.filter((event) => event.method === 'Runtime.exceptionThrown');
      throw new Error(`${error.message}; panel=${JSON.stringify(diagnostics)}; exceptions=${JSON.stringify(exceptions)}`);
    });
    const controlCardProof = await waitFor(() => panel.evaluate(`(() => {
      const card = document.querySelector('#browserControlCard');
      const state = document.querySelector('#browserControlState');
      const rect = card.getBoundingClientRect();
      const proof = {
        visible: rect.width > 0 && rect.height > 0,
        state: state?.textContent,
        contrast: getComputedStyle(document.querySelector('#browserControlDetachButton')).color,
        scope: document.querySelector('#browserControlScopeInput')?.value,
      };
      return /READY|ACTIVE|PAUSED/i.test(proof.state || '') ? proof : null;
    })()`)).catch(async (error) => {
      const panelState = await panel.evaluate(`(() => ({
        state: document.querySelector('#browserControlState')?.textContent,
        detail: document.querySelector('#browserControlCardDetail')?.textContent,
        attachHidden: document.querySelector('#browserControlAttachButton')?.hidden,
      }))()`);
      const activeTabs = await page.evaluate(`chrome.tabs.query({ active: true }).then((tabs) => tabs.map((tab) => ({ id: tab.id, url: tab.url, windowId: tab.windowId })))`);
      const workerStatus = await page.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' })`);
      const panelWorkerStatus = await panel.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' }).catch((error) => ({ error: error?.message || String(error) }))`);
      const panelExceptions = panel.events.filter((event) => event.method === 'Runtime.exceptionThrown');
      throw new Error(`${error.message}; panelState=${JSON.stringify(panelState)}; activeTabs=${JSON.stringify(activeTabs)}; workerStatus=${JSON.stringify(workerStatus)}; panelWorkerStatus=${JSON.stringify(panelWorkerStatus)}; panelExceptions=${JSON.stringify(panelExceptions)}`);
    });
    assert.equal(controlCardProof.visible, true);
    assert.match(controlCardProof.state, /READY|ACTIVE|PAUSED/i);
    assert.equal(controlCardProof.scope, 'this-tab');
    const zoomProof = await waitFor(() => panel.evaluate(`(() => {
      const titleSize = parseFloat(getComputedStyle(document.querySelector('#browserControlStripTitle')).fontSize);
      const detailSize = parseFloat(getComputedStyle(document.querySelector('#browserControlStripDetail')).fontSize);
      return titleSize >= 15 && detailSize >= 12 ? { titleSize, detailSize } : null;
    })()`));
    assert.ok(zoomProof, `strip typography did not honor the 125% text zoom seed: ${JSON.stringify(zoomProof)}`);
    await panel.evaluate(`document.querySelector('#browserControlCard').scrollIntoView({ block: 'center' })`);
    await mkdir(QA_DIR, { recursive: true });
    const panelShot = await panel.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(PANEL_SCREENSHOT, Buffer.from(panelShot.data, 'base64'));
    await panel.evaluate(`document.querySelector('#closeSettingsButton')?.click()`);
    await waitFor(() => panel.evaluate(`document.querySelector('#settingsDialog')?.hidden === true`));

    const snapshot = await sendCommand('cmd-phase6-snapshot', 'browser_snapshot');
    assert.equal(snapshot.params.ok, true, JSON.stringify(snapshot.params));
    const textboxRef = snapshot.params.result.refs.find((item) => item.role === 'textbox' && /Draft title/i.test(item.name));
    const buttonRef = snapshot.params.result.refs.find((item) => item.role === 'button' && /Apply draft/i.test(item.name));
    assert.ok(textboxRef?.ref, JSON.stringify(snapshot.params.result.refs));
    assert.ok(buttonRef?.ref, JSON.stringify(snapshot.params.result.refs));

    const typed = await sendCommand('cmd-phase6-type', 'browser_type', { ref: textboxRef.ref, text: 'Phase Six Draft' });
    assert.equal(typed.params.ok, true, JSON.stringify(typed.params));
    assert.doesNotMatch(JSON.stringify(typed.params), /Phase Six Draft/);
    const clickPromise = sendCommand('cmd-phase6-click', 'browser_click', { ref: buttonRef.ref });
    const indicatorDuringClick = await waitFor(() => controlled.evaluate(`Boolean(document.querySelector('.browser-control-indicator'))`));
    const clicked = await clickPromise;
    assert.equal(clicked.params.ok, true, JSON.stringify(clicked.params));
    assert.equal(indicatorDuringClick, true);
    const mutation = await waitFor(() => controlled.evaluate(`phase6State.clicks === 1 ? ({ value: document.querySelector('#draft').value, result: document.querySelector('#result').textContent }) : null`));
    assert.deepEqual(mutation, { value: 'Phase Six Draft', result: 'Applied: Phase Six Draft' });

    const pressed = await sendCommand('cmd-phase6-press', 'browser_press', { key: 'a' });
    assert.equal(pressed.params.ok, true, JSON.stringify(pressed.params));
    await waitFor(() => controlled.evaluate(`phase6State.keys.includes('a')`));
    const scrolled = await sendCommand('cmd-phase6-scroll', 'browser_scroll', { direction: 'down' });
    assert.equal(scrolled.params.ok, true, JSON.stringify(scrolled.params));
    await waitFor(() => controlled.evaluate(`scrollY > 0`));

    const screenshot = await sendCommand('cmd-phase6-screenshot', 'browser_screenshot');
    assert.equal(screenshot.params.ok, true, JSON.stringify(screenshot.params));
    assert.match(screenshot.params.result.dataUrl, /^data:image\/png;base64,/);

    controllerConnectionFor('browser_press').send({
      method: 'browser.controller.command',
      params: {
        command_id: 'cmd-phase6-approval',
        action: 'browser_press',
        arguments: { key: 'Enter' },
        tab_id: target.tabId,
        frame_id: target.frameId,
        document_generation: target.documentGeneration,
      },
    });
    const pending = await waitFor(() => page.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' })`).then((value) => value?.pendingApproval || null));
    assert.equal(pending.commandId, 'cmd-phase6-approval');
    await waitFor(() => panel.evaluate(`document.querySelector('#browserControlApproveButton')?.hidden === false`));
    await panel.evaluate(`document.querySelector('#browserControlStrip')?.scrollIntoView({ block: 'center' })`);
    const liveProof = await panel.evaluate(`(() => {
      const strip = document.querySelector('#browserControlStrip');
      const approve = document.querySelector('#browserControlApproveButton');
      const reject = document.querySelector('#browserControlRejectButton');
      const rect = strip?.getBoundingClientRect();
      return {
        settingsHidden: document.querySelector('#settingsDialog')?.hidden === true,
        stripVisible: Boolean(rect && rect.width > 0 && rect.height > 0),
        approveVisible: approve?.hidden === false,
        rejectVisible: reject?.hidden === false,
      };
    })()`);
    assert.deepEqual(liveProof, {
      settingsHidden: true,
      stripVisible: true,
      approveVisible: true,
      rejectVisible: true,
    });
    const liveShot = await panel.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(LIVE_SCREENSHOT, Buffer.from(liveShot.data, 'base64'));
    await panel.evaluate(`document.querySelector('#browserControlApproveButton').click()`);
    const approved = await waitFor(() => fixture.results.find((frame) => frame?.params?.command_id === 'cmd-phase6-approval'));
    assert.equal(approved.params.ok, true, JSON.stringify(approved.params));

    const navigated = await sendCommand('cmd-phase6-navigate', 'browser_navigate', { url: secondUrl });
    assert.equal(navigated.params.ok, true, JSON.stringify(navigated.params));
    await waitFor(() => controlled.evaluate(`location.pathname === '/second'`));
    await page.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_DOCUMENT_READY', tabId: ${tabId}, frameId: 0 })`);
    target = await waitFor(() => resolveTarget(secondUrl).then((value) => value?.availability === 'available' ? value : null));
    const back = await sendCommand('cmd-phase6-back', 'browser_back', {}, target);
    assert.equal(back.params.ok, true, JSON.stringify(back.params));
    await waitFor(() => controlled.evaluate(`location.pathname === '/fixture'`));
    await page.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_DOCUMENT_READY', tabId: ${tabId}, frameId: 0 })`);
    target = await waitFor(() => resolveTarget(fixtureUrl).then((value) => value?.availability === 'available' ? value : null));

    const secondTab = await page.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(secondUrl)}, active: false })`);
    const secondTabId = Number(secondTab.id);
    const secondLease = await page.evaluate(`chrome.runtime.sendMessage({
      type: 'HERMES_CONTROLLER_LEASE_ACQUIRE',
      kind: 'this-tab',
      ownerId: ${JSON.stringify(controllerStatus.controllerId)},
      ownership: 'owned',
      tabIds: [${secondTabId}]
    })`);
    assert.equal(secondLease?.ok, true, JSON.stringify(secondLease));
    const listed = await sendCommand('cmd-phase6-tabs', 'browser_tabs');
    assert.equal(listed.params.ok, true, JSON.stringify(listed.params));
    assert.deepEqual(listed.params.result.tabs.map((item) => item.id).sort((a, b) => a - b), [tabId, secondTabId].sort((a, b) => a - b));
    const activated = await sendCommand('cmd-phase6-activate', 'browser_tab_activate', { tab_id: secondTabId });
    assert.equal(activated.params.ok, true, JSON.stringify(activated.params));
    await waitFor(() => page.evaluate(`chrome.tabs.get(${secondTabId})`).then((value) => value?.active));

    const paused = await page.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_PAUSE' })`);
    assert.equal(paused.paused, true);
    const pausedCommand = await sendCommand('cmd-phase6-paused', 'browser_scroll', { direction: 'down' }, target);
    assert.equal(pausedCommand.params.ok, false);
    assert.equal(pausedCommand.params.error.code, 'controller_paused');
    await page.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_RESUME' })`);

    const persisted = await page.evaluate(`chrome.storage.local.get([
      'hermesBrowserControllerWorker',
      'hermesBrowserControllerRegistry',
      'hermesBrowserTabLeases',
      'hermesBrowserControllerLifecycle'
    ])`);
    const persistedJson = JSON.stringify(persisted);
    assert.equal(persistedJson.includes(TEST_ACCESS_VALUE), false);
    assert.equal(persistedJson.includes('Phase Six Draft'), false);
    assert.equal(persistedJson.includes('data:image/png;base64,'), false);
    assert.equal(persistedJson.includes(fixtureUrl), false);

    const replacementUrl = `${fixtureUrl}?replacement=1`;
    const replacementTab = await page.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(replacementUrl)}, active: true })`);
    const replacementTabId = Number(replacementTab.id);
    assert.ok(Number.isInteger(replacementTabId) && replacementTabId > 0);
    await panel.call('Page.bringToFront');
    await panel.evaluate(`(() => {
      globalThis.__phase6PanelTabId = ${replacementTabId};
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    const unattachedProof = await waitFor(() => panel.evaluate(`(() => {
      const state = document.querySelector('#browserControlState')?.textContent || '';
      const attach = document.querySelector('#browserControlAttachButton');
      const detail = document.querySelector('#browserControlStripDetail')?.textContent || '';
      return attach?.hidden === false && /ATTACH/i.test(state)
        ? { state, detail, attachText: attach.textContent }
        : null;
    })()`));
    assert.match(unattachedProof.detail, /not attached|other tabs?/i);
    assert.match(unattachedProof.attachText, /attach/i);
    const unattachedShot = await panel.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(UNATTACHED_SCREENSHOT, Buffer.from(unattachedShot.data, 'base64'));
    await panel.evaluate(`document.querySelector('#browserControlAttachButton').click()`);
    const replacementStatus = await waitFor(() => page.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' })`).then((value) => (
      value?.leasedTabIds?.length === 1 && Number(value.leasedTabIds[0]) === replacementTabId ? value : null
    )));
    assert.deepEqual(replacementStatus.leasedTabIds, [replacementTabId]);
    const replacementTarget = await waitFor(() => page.evaluate(`chrome.runtime.sendMessage({
      type: 'HERMES_CONTROLLER_TARGET_RESOLVE',
      tabId: ${replacementTabId},
      frameId: 0,
      expectedUrl: ${JSON.stringify(replacementUrl)}
    })`).then((value) => value?.availability === 'available' ? value : null));
    await waitFor(() => panel.evaluate(`document.querySelector('#browserControlState')?.textContent?.match(/READY/i)`));
    const replacementSnapshot = await sendCommand('cmd-phase6-first-try-replacement', 'browser_snapshot', {}, replacementTarget);
    assert.equal(replacementSnapshot.params.ok, true, JSON.stringify(replacementSnapshot.params));
    assert.ok(replacementSnapshot.params.result.refs.some((item) => (
      item.role === 'textbox' && /Draft title/i.test(item.name || '')
    )), JSON.stringify(replacementSnapshot.params.result.refs));

    const detached = await panel.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_DETACH' })`);
    assert.equal(detached.ok, true);
    const detachedStatus = await page.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' })`);
    assert.equal(detachedStatus.controlEnabled, false);
    assert.deepEqual(detachedStatus.leasedTabIds, []);

    const pageConsoleErrors = controlled.events.filter((event) => event.method === 'Runtime.exceptionThrown');
    const panelConsoleErrors = panel.events.filter((event) => event.method === 'Runtime.exceptionThrown');
    assert.deepEqual(pageConsoleErrors, []);
    assert.deepEqual(panelConsoleErrors, []);

    panel.close();
    controlled.close();
    console.log(JSON.stringify({
      verdict: 'PASS',
      browser: 'Hermes Chrome for Testing',
      extensionId,
      controllerId: controllerStatus.controllerId,
      browserProfileId: controllerStatus.browserProfileId,
      exactTarget: { tabId, documentGeneration: target.documentGeneration, isolatedFallback: target.isolatedFallback },
      realActions: ['snapshot', 'type', 'click', 'press', 'scroll', 'screenshot', 'approval', 'navigate', 'back', 'tabs', 'tab-activate'],
      pageMutation: mutation,
      screenshotBytes: Buffer.from(String(screenshot.params.result.dataUrl).split(',')[1], 'base64').length,
      approvalVisible: true,
      newTabAttach: {
        initialState: unattachedProof.state,
        leasedTabIds: replacementStatus.leasedTabIds,
        firstAction: replacementSnapshot.params.ok,
      },
      restrictedPersistence: false,
      detached: true,
      screenshots: [PANEL_SCREENSHOT, LIVE_SCREENSHOT, UNATTACHED_SCREENSHOT],
    }, null, 2));
  } catch (error) {
    error.message = `${error.message}\nChrome stderr tail:\n${chromeStderr.slice(-3000)}`;
    throw error;
  } finally {
    page?.close();
    browser?.close();
    killChrome(chrome);
    await fixture.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await rm(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const directEntryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const currentModulePath = path.resolve(fileURLToPath(import.meta.url));
if (directEntryPath === currentModulePath) {
  await main();
  // Standalone release-gate executable. Some CDP/WebSocket implementations
  // retain idle handles after explicit cleanup.
  process.exit(0);
}


