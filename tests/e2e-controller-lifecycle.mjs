import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PROFILE = path.join(ROOT, 'tmp', `e2e-controller-lifecycle-${process.pid}`);
const TEST_ACCESS_VALUE = ['e2e', 'controller', 'fixture', 'value'].join('-');
const TEST_SESSION_ID = 'hermes-browser-controller-e2e';
const PUBLIC_PROTOCOL = 'hermes-browser-control-v1';
const TICKET_PREFIX = 'hermes-browser-control-ticket.';

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Users\\Jaybo\\AppData\\Local\\hermes\\chrome-for-testing\\chrome\\win64-151.0.7922.76\\chrome-win64\\chrome.exe',
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Hermes Chrome for Testing not found. Set CHROME_PATH.');
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

async function startControllerFixture() {
  const registrations = [];
  const connections = [];
  const results = [];
  const heartbeats = [];
  const issuedTickets = new Set();
  let ticketSequence = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Hermes-Profile',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      });
      res.end();
      return;
    }
    if (url.pathname === '/v1/browser-control/register' && req.method === 'POST') {
      assert.equal(req.headers.authorization, ['Bearer', TEST_ACCESS_VALUE].join(' '));
      const body = await requestBody(req);
      assert.equal(body.session_id, TEST_SESSION_ID);
      assert.deepEqual(body.capabilities, ['controller.noop']);
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
        send(frame) { socket.write(websocketFrame(frame)); },
      };
      connections.push(connection);
      socket.on('error', () => {
        // MV3 worker termination resets its controller socket. The lifecycle
        // assertion observes reconnection through the next registered socket.
      });
      socket.on('data', (chunk) => decodeClientFrames(connection, chunk, (frame) => {
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
    close: async () => {
      for (const connection of connections) connection.socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

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

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} failed (${response.status})`);
  return response.json();
}

async function waitFor(check, timeoutMs = 25_000, intervalMs = 100) {
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

function killChrome(child) {
  if (!child?.pid) return;
  try {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch { /* best effort */ }
}

async function findHermesWorker(devtoolsBase, extensionId) {
  return waitFor(async () => {
    const targets = await fetchJson(`${devtoolsBase}/json/list`);
    return targets.find((target) => (
      target.type === 'service_worker'
      && String(target.url || '') === `chrome-extension://${extensionId}/background.js`
    )) || null;
  });
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

    await page.evaluate(`chrome.storage.local.set({
      hermesBrowserSettings: {
        connectionSchemaVersion: 1,
        connectionMode: 'local',
        connectionTransport: 'local-api',
        gatewayMode: 'local-api',
        gatewayUrl: ${JSON.stringify(fixture.baseUrl)},
        apiKey: ${JSON.stringify(TEST_ACCESS_VALUE)},
        tokenSource: 'e2e-controller',
        sessionId: ${JSON.stringify(TEST_SESSION_ID)},
        sessionStartMode: 'resume'
      },
      hermesBrowserIntroSeen: true
    })`);

    await waitFor(() => fixture.connections.length >= 1);
    const statusBefore = await waitFor(() => page.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' })`).then((value) => (
      value?.connected && value?.controllerId ? value : null
    )));
    const lease = await page.evaluate(`chrome.runtime.sendMessage({
      type: 'HERMES_CONTROLLER_LEASE_ACQUIRE',
      kind: 'this-tab',
      ownerId: ${JSON.stringify(statusBefore.controllerId)},
      ownership: 'owned',
      tabIds: [4242]
    })`);
    assert.equal(lease?.ok, true, JSON.stringify(lease));

    fixture.connections[0].send({
      method: 'browser.controller.command',
      params: {
        command_id: 'cmd-e2e-001',
        action: 'controller.noop',
        arguments: { probe: 'payload-before-restart' },
      },
    });
    const resultBefore = await waitFor(() => fixture.results.find((frame) => frame?.params?.command_id === 'cmd-e2e-001'));
    assert.equal(resultBefore.params.ok, true);
    assert.deepEqual(resultBefore.params.result, { probe: 'payload-before-restart' });

    await page.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_WAKE' })`);
    await waitFor(() => fixture.heartbeats.length >= 1);

    const persistedBefore = await page.evaluate(`chrome.storage.local.get([
      'hermesBrowserControllerWorker',
      'hermesBrowserControllerRegistry',
      'hermesBrowserTabLeases',
      'hermesBrowserControllerLifecycle'
    ])`);
    assert.equal(persistedBefore.hermesBrowserControllerWorker.controllerId, statusBefore.controllerId);
    assert.ok(persistedBefore.hermesBrowserTabLeases.entries.some((item) => item.tabId === 4242));

    const oldWorker = await findHermesWorker(devtoolsBase, extensionId);
    const stopped = await browser.call('Target.closeTarget', { targetId: oldWorker.id });
    assert.equal(stopped.success, true, 'CDP did not stop the loaded MV3 service worker.');
    await waitFor(async () => {
      const targets = await fetchJson(`${devtoolsBase}/json/list`);
      return !targets.some((target) => target.id === oldWorker.id);
    });

    const statusAfter = await waitFor(() => page.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' })`).then((value) => (
      value?.connected && value?.generation > statusBefore.generation ? value : null
    )), 30_000);
    await waitFor(() => fixture.connections.length >= 2);
    assert.equal(statusAfter.controllerId, statusBefore.controllerId);
    assert.equal(statusAfter.browserProfileId, statusBefore.browserProfileId);
    assert.ok(statusAfter.generation > statusBefore.generation);
    assert.deepEqual(statusAfter.leasedTabIds, [4242]);
    assert.equal(fixture.registrations.at(-1).controller_id, fixture.registrations[0].controller_id);
    assert.equal(fixture.registrations.at(-1).browser_profile_id, fixture.registrations[0].browser_profile_id);

    const secondConnection = fixture.connections.at(-1);
    secondConnection.send({
      method: 'browser.controller.command',
      params: {
        command_id: 'cmd-e2e-002',
        action: 'controller.noop',
        arguments: { probe: 'payload-after-restart' },
      },
    });
    const resultAfter = await waitFor(() => fixture.results.find((frame) => frame?.params?.command_id === 'cmd-e2e-002'));
    assert.equal(resultAfter.params.ok, true);
    assert.deepEqual(resultAfter.params.result, { probe: 'payload-after-restart' });

    await page.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_WAKE' })`);
    await waitFor(() => fixture.heartbeats.some((item) => item.connection === fixture.connections.length - 1));

    const persistedAfter = await page.evaluate(`chrome.storage.local.get([
      'hermesBrowserControllerWorker',
      'hermesBrowserControllerRegistry',
      'hermesBrowserTabLeases',
      'hermesBrowserControllerLifecycle'
    ])`);
    const controllerStateJson = JSON.stringify(persistedAfter);
    assert.equal(controllerStateJson.includes(TEST_ACCESS_VALUE), false);
    assert.equal(controllerStateJson.includes('controller-ticket-'), false);
    assert.equal(controllerStateJson.includes('payload-before-restart'), false);
    assert.equal(controllerStateJson.includes('payload-after-restart'), false);
    assert.ok(fixture.connections.every((connection) => !String(connection.requestTarget).includes('ticket')));

    console.log(JSON.stringify({
      verdict: 'PASS',
      browser: 'Hermes Chrome for Testing',
      extensionId,
      registrations: fixture.registrations.length,
      controllerSockets: fixture.connections.length,
      heartbeats: fixture.heartbeats.length,
      controllerIdStable: statusAfter.controllerId === statusBefore.controllerId,
      browserProfileIdStable: statusAfter.browserProfileId === statusBefore.browserProfileId,
      generation: { before: statusBefore.generation, after: statusAfter.generation },
      adoptedLeaseTabIds: statusAfter.leasedTabIds,
      noopResults: [resultBefore.params.result, resultAfter.params.result],
      credentialFreeWebSocketTargets: fixture.connections.map((connection) => connection.requestTarget),
      persistedControllerStateContainsCredentials: false,
      realBrowserActionsEnabled: false,
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

await main();
