/**
 * Loaded-extension pairing journey (Chrome for Testing).
 *
 * Fresh dist storage (no token, no session) -> startup screen shows the
 * one-click Connect button -> clicking it starts gateway pairing -> the
 * approval tab opens -> Approve -> the extension receives a scoped token
 * and completes readiness on its own.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  DIST,
  ROOT,
  chromeExecutable,
  fetchJson,
  killChrome,
  unpackedExtensionId,
  waitFor,
} from './e2e-phase6-browser-control.mjs';

const PROFILE = path.join(ROOT, 'tmp', `e2e-phase6-pairing-${process.pid}`);
const QA_DIR = path.join(ROOT, '.hermes', 'qa');
const APPROVAL_SCREENSHOT = path.join(QA_DIR, 'phase6-pairing-approval.png');
const CONNECTED_SCREENSHOT = path.join(QA_DIR, 'phase6-pairing-connected.png');

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Hermes-Profile, X-Hermes-Session-Id, X-Hermes-Session-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  res.end(JSON.stringify(payload));
}

async function startPairingFixture() {
  const pairings = new Map();
  const tokens = new Set();
  const requests = [];
  let sequence = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push(`${req.method} ${url.pathname}`);
    if (req.method === 'OPTIONS') {
      json(res, 204, {});
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
      json(res, 200, { status: 'ok', platform: 'hermes-agent', version: 'phase6-pairing' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
      json(res, 200, {
        object: 'hermes.api_server.capabilities',
        platform: 'hermes-agent',
        auth: { type: 'bearer', required: true },
        features: {
          models_api: true,
          session_resources: true,
          session_chat: true,
          session_chat_streaming: true,
          skills_api: true,
          browserPairing: true,
        },
        endpoints: {
          health: { method: 'GET', path: '/health' },
          models: { method: 'GET', path: '/v1/models' },
          sessions: { method: 'GET', path: '/api/sessions' },
          session_create: { method: 'POST', path: '/api/sessions' },
          session_chat: { method: 'POST', path: '/api/sessions/{session_id}/chat' },
          session_chat_stream: { method: 'POST', path: '/api/sessions/{session_id}/chat/stream' },
          skills: { method: 'GET', path: '/v1/skills' },
          browser_pairing: { method: 'POST', path: '/api/browser-extension/pair/start' },
        },
      });
      return;
    }
    // Pairing surface (public, like the loopback gateway).
    if (req.method === 'POST' && url.pathname === '/api/browser-extension/pair/start') {
      const id = `pair-${++sequence}`;
      pairings.set(id, { status: 'pending', token: null });
      json(res, 200, {
        pairing_id: id,
        approval_url: `http://127.0.0.1:${server.address().port}/approve/${id}`,
        expires_in: 180,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/approve/')) {
      const id = url.pathname.split('/').pop();
      const record = pairings.get(id);
      if (!record) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body><h1>Approve Hermes Browser</h1>
<form method="post" action="/grant/${id}"><button id="approveButton" type="submit">Approve</button></form>
<form method="post" action="/deny/${id}"><button id="denyButton" type="submit">Deny</button></form></body></html>`);
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/grant/')) {
      const id = url.pathname.split('/').pop();
      const record = pairings.get(id);
      if (!record || record.status !== 'pending') {
        res.writeHead(410, { 'Content-Type': 'text/plain' });
        res.end('expired');
        return;
      }
      const token = `pairing-token-${id}-${Buffer.from(String(++sequence)).toString('hex').padStart(6, '0')}`;
      tokens.add(token);
      record.status = 'approved';
      record.token = token;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>Approved</h1></body></html>');
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/deny/')) {
      const id = url.pathname.split('/').pop();
      const record = pairings.get(id);
      if (record) record.status = 'denied';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>Denied</h1></body></html>');
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/browser-extension/pair/status/')) {
      const id = url.pathname.split('/').pop();
      const record = pairings.get(id);
      if (!record) {
        json(res, 404, { error: { message: 'Pairing request was not found.', code: 'pairing_not_found' } });
        return;
      }
      if (record.status === 'approved') {
        json(res, 200, { status: 'approved', token: record.token });
        return;
      }
      if (record.status === 'denied') {
        json(res, 410, { error: { message: 'Pairing request was denied.', code: 'pairing_denied' } });
        return;
      }
      json(res, 200, { status: 'pending' });
      return;
    }
    const auth = String(req.headers.authorization || '');
    const authed = auth.startsWith('Bearer ') && (auth.slice(7).trim() === 'fixture-key' || tokens.has(auth.slice(7).trim()));
    if (!authed) {
      json(res, 401, { error: { message: 'Invalid gateway API key', code: 'gateway_auth_failed' } });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      json(res, 200, { object: 'list', data: [{ id: 'pairing/e2e-model', object: 'model' }] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/model/options') {
      json(res, 200, { providers: [{ slug: 'pairing', name: 'Pairing E2E', models: [{ id: 'pairing/e2e-model', label: 'Pairing E2E Model' }] }] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/skills') {
      json(res, 200, { skills: [] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      json(res, 200, { sessions: [], items: [] });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      const record = {
        id: `pairing-session-${++sequence}`,
        title: 'Pairing E2E Session',
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      json(res, 200, record);
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
      json(res, 200, { id: url.pathname.split('/').pop(), title: 'Pairing E2E Session', messages: [] });
      return;
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/sessions/')) {
      json(res, 200, { id: url.pathname.split('/').pop(), title: 'Pairing E2E Session' });
      return;
    }
    if (req.method === 'GET' && url.pathname.includes('/messages')) {
      json(res, 200, { messages: [] });
      return;
    }
    if (req.method === 'POST' && url.pathname.includes('/chat')) {
      json(res, 200, { id: 'pairing-run', status: 'completed', output: 'ok' });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    pairings,
    tokens,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  assert.ok(existsSync(path.join(DIST, 'manifest.json')), 'Run npm run build before the pairing CFT journey.');
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  const fixture = await startPairingFixture();
  let chrome;
  let browser;
  let panel;
  let approval;
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
    browser = new (await import('./e2e-phase6-browser-control.mjs')).CdpClient(version.webSocketDebuggerUrl);
    await browser.connect();

    const extensionPageTarget = await waitFor(async () => {
      const targets = await fetchJson(`${devtoolsBase}/json/list`);
      return targets.find((target) => target.type === 'page' && String(target.url || '').startsWith(`chrome-extension://${extensionId}/`)) || null;
    });
    const extensionPage = new (await import('./e2e-phase6-browser-control.mjs')).CdpClient(extensionPageTarget.webSocketDebuggerUrl);
    await extensionPage.connect();
    await extensionPage.call('Runtime.enable');
    await waitFor(() => extensionPage.evaluate('Boolean(globalThis.chrome?.storage?.local)'));
    await extensionPage.evaluate(`(() => {
      return chrome.storage.local.set({
        hermesBrowserSettings: {
          connectionSchemaVersion: 1,
          connectionMode: 'local',
          connectionTransport: 'local-api',
          gatewayMode: 'local-api',
          gatewayUrl: ${JSON.stringify(fixture.baseUrl)},
          sessionStartMode: 'new-session'
        },
        hermesBrowserIntroSeen: true
      });
    })()`);

    const panelTarget = await fetchJson(
      `${devtoolsBase}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/sidepanel.html`)}`,
      { method: 'PUT' },
    );
    panel = new (await import('./e2e-phase6-browser-control.mjs')).CdpClient(panelTarget.webSocketDebuggerUrl);
    await panel.connect();
    await panel.call('Runtime.enable');
    await panel.call('Emulation.setDeviceMetricsOverride', { width: 520, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor(() => panel.evaluate(`Boolean(document.querySelector('#startupScreen') && document.querySelector('#startupConnectButton'))`));

    const connectVisible = await waitFor(() => panel.evaluate(`(() => {
      const button = document.querySelector('#startupConnectButton');
      return button && button.hidden === false ? { text: button.textContent } : null;
    })()`)).catch(async (error) => {
      const diagnostics = await panel.evaluate(`(() => ({
        startupHidden: document.querySelector('#startupScreen')?.hidden,
        title: document.querySelector('#startupTitle')?.textContent,
        detail: document.querySelector('#startupDetail')?.textContent,
        buttonHidden: document.querySelector('#startupConnectButton')?.hidden,
        connectPanelHidden: document.querySelector('#connectPanel')?.hidden,
        bodySnippet: document.body?.innerText?.slice(0, 600),
      }))()`);
      const exceptions = panel.events.filter((event) => event.method === 'Runtime.exceptionThrown');
      throw new Error(`${error.message}; panel=${JSON.stringify(diagnostics)}; exceptions=${JSON.stringify(exceptions)}`);
    });
    assert.match(connectVisible.text, /connect/i);

    await panel.evaluate(`document.querySelector('#startupConnectButton').click()`);
    const approvalTarget = await waitFor(async () => {
      const targets = await fetchJson(`${devtoolsBase}/json/list`);
      return targets.find((target) => target.type === 'page' && String(target.url || '').includes('/approve/')) || null;
    }, 25_000).catch(async (error) => {
      const panelState = await panel.evaluate(`(() => ({
        statusText: document.querySelector('#statusDetail')?.textContent || '',
        connectStatus: document.querySelector('#connectStatus')?.textContent || '',
        startupDetail: document.querySelector('#startupDetail')?.textContent || '',
        sendLabel: document.querySelector('#sendButton')?.textContent || '',
      }))()`);
      const tabs = await fetchJson(`${devtoolsBase}/json/list`);
      const tabProbe = await panel.evaluate(`(async () => {
        try {
          const tab = await chrome.tabs.create({ url: 'about:blank' });
          return { ok: true, tabId: tab && tab.id };
        } catch (error) {
          return { ok: false, error: error?.message || String(error) };
        }
      })()`);
      const consoleLog = panel.events
        .filter((event) => event.method === 'Runtime.consoleAPICalled')
        .map((event) => event.params?.args?.map((arg) => arg.value ?? arg.description ?? '').join(' '))
        .slice(-10);
      throw new Error(`${error.message}; fixtureRequests=${JSON.stringify(fixture.requests)}; panel=${JSON.stringify(panelState)}; tabs=${JSON.stringify(tabs.filter((t) => t.type === 'page').map((t) => ({ url: String(t.url).slice(0, 100) })))}; tabProbe=${JSON.stringify(tabProbe)}; console=${JSON.stringify(consoleLog)}`);
    });
    approval = new (await import('./e2e-phase6-browser-control.mjs')).CdpClient(approvalTarget.webSocketDebuggerUrl);
    await approval.connect();
    await approval.call('Runtime.enable');
    await waitFor(() => approval.evaluate(`Boolean(document.querySelector('#approveButton'))`));
    const approvalShot = await approval.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await mkdir(QA_DIR, { recursive: true });
    await writeFile(APPROVAL_SCREENSHOT, Buffer.from(approvalShot.data, 'base64'));
    await approval.evaluate(`document.querySelector('#approveButton').click()`);

    const connected = await waitFor(() => panel.evaluate(`(() => {
      const screen = document.querySelector('#startupScreen');
      return screen?.hidden === true ? { startupHidden: true } : null;
    })()`), 45_000);
    assert.equal(connected.startupHidden, true);

    const stored = await panel.evaluate(`chrome.storage.local.get(['hermesBrowserSettings'])`);
    assert.equal(stored.hermesBrowserSettings.tokenSource, 'pairing');
    assert.ok(String(stored.hermesBrowserSettings.apiKey || '').startsWith('pairing-token-'), 'pairing token was not stored');
    assert.match(
      String(stored.hermesBrowserSettings.sessionId || ''),
      /^hermes-browser-extension-/,
      `durable session was not created; sessionId=${JSON.stringify(stored.hermesBrowserSettings.sessionId)}; fixtureRequests=${JSON.stringify(fixture.requests)}`,
    );

    const connectedShot = await panel.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(CONNECTED_SCREENSHOT, Buffer.from(connectedShot.data, 'base64'));

    const panelExceptions = panel.events.filter((event) => event.method === 'Runtime.exceptionThrown');
    assert.deepEqual(panelExceptions, []);

    console.log(JSON.stringify({
      verdict: 'PASS',
      browser: 'Hermes Chrome for Testing',
      extensionId,
      gateway: fixture.baseUrl,
      pairingId: [...fixture.pairings.keys()][0],
      storedTokenSource: stored.hermesBrowserSettings.tokenSource,
      storedSessionId: stored.hermesBrowserSettings.sessionId,
      screenshots: [APPROVAL_SCREENSHOT, CONNECTED_SCREENSHOT],
    }, null, 2));
  } catch (error) {
    error.message = `${error.message}\nChrome stderr tail:\n${chromeStderr.slice(-2000)}`;
    throw error;
  } finally {
    try { approval?.close(); } catch { /* best effort */ }
    try { panel?.close(); } catch { /* best effort */ }
    try { browser?.close(); } catch { /* best effort */ }
    killChrome(chrome);
    await fixture.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
