/**
 * Loaded-extension QA for truthful gateway failure diagnostics.
 *
 * Real Chrome for Testing, real side panel, real fetch failures, and a stub
 * Hermes gateway that reproduces the reported Python init failure
 * ("Failed to initialize OpenAI client" plus a pydantic_core wheel) as well as
 * a gateway that disappears mid-session.
 *
 * Run: node tests/e2e-gateway-failure-diagnostics.mjs
 * Screenshots: .hermes/qa/gateway-failure-*.png
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PROFILE = path.join(ROOT, 'tmp', `qa-gateway-failure-${process.pid}`);
const QA_DIR = path.join(ROOT, '.hermes', 'qa');
const SCREENSHOT_INIT_FAILURE = path.join(QA_DIR, 'gateway-failure-init-failure.png');
const SCREENSHOT_AMBIGUOUS = path.join(QA_DIR, 'gateway-failure-ambiguous.png');
const TEST_TOKEN = 'hermes-qa-token';

const INIT_FAILURE_BODY = [
  'Traceback (most recent call last):',
  '  File "C:\\Users\\example\\AppData\\Local\\hermes\\venv\\Lib\\site-packages\\openai\\_client.py", line 42, in __init__',
  '    raise OpenAIError("Failed to initialize OpenAI client")',
  'ImportError: pydantic_core/_pydantic_core.cp311-win_amd64.pyd is not a valid Win32 application',
  'the installed pydantic_core wheel does not match the running interpreter',
].join('\n');

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome for Testing\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH.');
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
  res.__hermesQaStatus = status;
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

async function startStubGateway() {
  const requests = [];
  let chatMode = 'ok';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const body = req.method === 'POST' ? await requestBody(req) : null;
    const record = { method: req.method, path: url.pathname, body, authorization: req.headers.authorization || '', status: 0, at: Date.now() };
    res.on('finish', () => { record.status = res.statusCode; });
    requests.push(record);
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
      json(res, 200, { status: 'ok', platform: 'hermes-agent', version: 'qa' });
      return;
    }
    if (url.pathname === '/v1/capabilities') {
      json(res, 200, {
        object: 'hermes.api_server.capabilities',
        version: 'qa',
        endpoints: {
          health: { method: 'GET', path: '/health' },
          sessions: { method: 'GET', path: '/api/sessions' },
          session_create: { method: 'POST', path: '/api/sessions' },
          session_chat: { method: 'POST', path: '/api/sessions/{session_id}/chat' },
        },
        features: {
          models: true,
          session_resources: true,
          session_chat: true,
          session_chat_streaming: false,
          browser_pairing: true,
        },
      });
      return;
    }
    if (/\/chat\/stream$/.test(url.pathname) && req.method === 'POST') {
      if (chatMode !== 'ok') {
        // Streaming route unavailable: Browser uses the documented non-stream fallback.
        json(res, 404, { error: { message: 'Streaming route unavailable.' } });
        return;
      }
      const sessionId = url.pathname.split('/')[3];
      const payload = [
        ['message.delta', { session_id: sessionId, text: 'stub answer' }],
        ['message.complete', { session_id: sessionId, text: 'stub answer' }],
      ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      res.end(payload);
      return;
    }
    if (/\/chat$/.test(url.pathname) && req.method === 'POST') {
      if (chatMode === 'init-failure') {
        json(res, 500, { error: { message: INIT_FAILURE_BODY, type: 'server_error' } });
        return;
      }
      if (chatMode === 'reset-in-handler') {
        // The gateway receives the request, then resets the socket inside the
        // handler: the turn may already have been accepted, so delivery is
        // unconfirmed and Chrome reports an opaque fetch failure.
        req.socket.destroy();
        return;
      }
      json(res, 200, { message: { role: 'assistant', content: 'stub answer' } });
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      json(res, 200, { session: { id: (body && body.id) || 'hermes-browser-extension' } });
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      json(res, 200, { sessions: [], total: 0 });
      return;
    }
    if (url.pathname === '/v1/models') {
      json(res, 200, { data: [{ id: 'e2e/test-model', object: 'model' }] });
      return;
    }
    if (url.pathname === '/api/model/options') {
      json(res, 200, { models: [], providers: [] });
      return;
    }
    json(res, 200, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setChatMode: (mode) => { chatMode = mode; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
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
    try { this.socket?.close(); } catch { /* best-effort */ }
  }
}

async function focusConnectionCard(panel) {
  await panel.evaluate(`(() => {
    const card = document.querySelector('#statusCard');
    card?.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function saveScreenshot(client, filePath) {
  const shot = await client.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  assert.ok(shot.data, `Screenshot data missing for ${filePath}`);
  await writeFile(filePath, Buffer.from(shot.data, 'base64'));
}

function killChrome(child) {
  if (!child?.pid) return;
  try {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* best-effort */ }
}

const paneldState = `(() => {
  const messages = Array.from(document.querySelectorAll('.message-content')).map((node) => node.textContent).join('\\n');
  return {
    messages,
    inputValue: document.querySelector('#promptInput')?.value || '',
    title: document.querySelector('#activeTitle')?.textContent || '',
    detail: document.querySelector('#activeUrl')?.textContent || '',
    connectStatus: document.querySelector('#connectStatus')?.textContent || '',
    connection: document.querySelector('#connectionPill')?.getAttribute('aria-label') || '',
    retryVisible: (() => {
      const button = document.querySelector('#statusRetryProbeButton');
      if (!button) return false;
      const actions = document.querySelector('#statusActions');
      return Boolean(button.offsetParent !== null && actions && !actions.hidden);
    })(),
  };
})()`;

async function openSettings(panel) {
  await panel.evaluate(`document.querySelector('#settingsButton').click(); true`);
  await waitFor(() => panel.evaluate("document.querySelector('#settingsDialog')?.hidden === false"));
}

async function submitPrompt(panel, text) {
  await panel.evaluate(`(() => {
    const input = document.querySelector('#promptInput');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#composer').requestSubmit();
    return true;
  })()`);
}

async function main() {
  assert.ok(existsSync(path.join(DIST, 'manifest.json')), 'Run npm run build before this QA script.');
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  await mkdir(QA_DIR, { recursive: true });

  const gateway = await startStubGateway();
  let chrome;
  let setup;
  let panel;
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

    // The MV3 service worker is lazy: it does not exist as a debug target until
    // an extension page wakes it. Open the loaded page, message the background,
    // and only then look for the worker target.
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

    let lastTargets = [];
    const workerTarget = await waitFor(async () => {
      lastTargets = await (await fetch(`${devtoolsBase}/json/list`)).json();
      const candidates = lastTargets.filter((target) => {
        if (target.type !== 'service_worker') return false;
        try { return new URL(String(target.url || '')).pathname === '/background.js'; }
        catch { return false; }
      });
      for (const candidate of candidates) {
        const probe = new CdpClient(candidate.webSocketDebuggerUrl);
        try {
          await probe.connect();
          await probe.call('Runtime.enable');
          const isHermesBrowser = await probe.evaluate("globalThis.chrome?.runtime?.getManifest?.()?.name === 'Hermes Browser Extension'");
          if (isHermesBrowser) return candidate;
        } catch {
          // Chrome for Testing may expose unrelated component workers named background.js.
        } finally {
          probe.close();
        }
      }
      return null;
    }, 45_000, 400).catch((error) => {
      console.error('[qa] targets', JSON.stringify(lastTargets.map((t) => ({ type: t.type, url: t.url })), null, 1));
      throw error;
    });
    setup = new CdpClient(workerTarget.webSocketDebuggerUrl);
    await setup.connect();
    await setup.call('Runtime.enable');
    await waitFor(() => setup.evaluate('Boolean(globalThis.chrome?.storage?.local)'));
    await setup.evaluate("void chrome.runtime.sendMessage({ type: 'HERMES_INLINE_SESSION_STATUS' }).catch(() => null); true");

    await setup.evaluate(`chrome.storage.local.set({hermesBrowserSettings:${JSON.stringify({
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
    })}, hermesBrowserIntroSeen: true})`);

    const pageTarget = await (await fetch(
      `${devtoolsBase}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/sidepanel.html`)}`,
      { method: 'PUT' },
    )).json();
    panel = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await panel.connect();
    await panel.call('Runtime.enable');
    await panel.call('Log.enable');
    await panel.call('Page.enable');
    try {
      await waitFor(() => panel.evaluate(`(() => {
        const startup = document.querySelector('#startupScreen');
        const input = document.querySelector('#promptInput');
        return Boolean(startup?.hidden && input && !input.disabled);
      })()`), 30_000);
    } catch (error) {
      const boot = await panel.evaluate(`(() => ({
        href: location.href,
        readyState: document.readyState,
        startupHidden: document.querySelector('#startupScreen')?.hidden,
        startupText: document.querySelector('#startupScreen')?.innerText?.slice(0, 400) || '',
        bodyText: document.body?.innerText?.slice(0, 400) || '',
        hasChrome: Boolean(globalThis.chrome?.runtime),
        hasHermes: Boolean(globalThis.HermesBrowser) || Boolean(globalThis.__hermesBrowser),
      }))()`).catch(() => null);
      console.error('[qa] panel boot state', JSON.stringify(boot, null, 1));
      console.error('[qa] panel console errors', JSON.stringify(panel.events?.slice(-12) || [], null, 1));
      throw error;
    }

    // ---- Scenario A: gateway answered, chat failed inside the gateway -------
    gateway.setChatMode('init-failure');
    const failingPrompt = 'Explain the failing gateway turn.';
    await submitPrompt(panel, failingPrompt);
    const failedState = await waitFor(() => panel.evaluate(`(() => {
      const state = ${paneldState};
      if (!state.messages.includes('gateway runtime dependency failed to initialize')) return null;
      return state;
    })()`), 30_000).catch(async (error) => {
      const state = await panel.evaluate(paneldState).catch(() => null);
      console.error('[qa] scenario A state', JSON.stringify(state, null, 1));
      console.error('[qa] gateway requests', JSON.stringify(gateway.requests.map((r) => ({ m: r.method, p: r.path, s: r.status })), null, 1));
      console.error('[qa] panel console tail', JSON.stringify(panel.events.slice(-10), null, 1));
      throw error;
    });
    assert.equal(failedState.inputValue, failingPrompt, 'Draft must be preserved when the turn never reached Hermes.');
    assert.equal(failedState.connection, 'Hermes connected', 'A server-side runtime failure must not report the gateway as unreachable.');
    assert.match(failedState.connectStatus, /gateway runtime failure|gateway is running/i);
    assert.match(failedState.connectStatus, /pydantic_core/i);
    for (const forbidden of ['Traceback', 'site-packages', '_pydantic_core.cp311', 'C:\\Users', 'computer_use', 'aiohttp', 'is not listening']) {
      assert.ok(!failedState.messages.includes(forbidden), `Transcript must not leak "${forbidden}"`);
      assert.ok(!failedState.connectStatus.includes(forbidden), `Panel copy must not leak "${forbidden}"`);
    }
    await focusConnectionCard(panel);
    await saveScreenshot(panel, SCREENSHOT_INIT_FAILURE);
    const fallbackChatRequests = () => gateway.requests.filter((request) => /\/chat$/.test(request.path) && request.method === 'POST').length;
    assert.equal(fallbackChatRequests(), 1, 'A gateway runtime failure must not replay the rejected turn.');
    console.log('[qa] scenario A ok:', JSON.stringify({ title: failedState.title, connectStatus: failedState.connectStatus.slice(0, 220) }, null, 1));

    // ---- Scenario B: the gateway resets the socket inside the request handler,
    // so the turn may already have been delivered mid-flight -----------------
    gateway.setChatMode('reset-in-handler');
    const draftingPrompt = 'Keep this draft when the gateway dies.';
    await submitPrompt(panel, draftingPrompt);
    const deadState = await waitFor(() => panel.evaluate(`(() => {
      const state = ${paneldState};
      if (!state.messages.includes('did not say whether the connection was refused or blocked by CORS')) return null;
      return state;
    })()`), 30_000);
    assert.equal(deadState.inputValue, draftingPrompt, 'Draft must survive a mid-flight reset.');
    assert.match(deadState.title, /unavailable|did not answer/i);
    assert.match(deadState.detail, /cannot tell/i);
    // The reset happened after the request left the browser, so the copy must
    // never claim the turn was not delivered, and it must warn about a duplicate.
    assert.doesNotMatch(deadState.messages, /nothing was delivered|nothing was sent/i);
    assert.doesNotMatch(deadState.detail, /nothing was delivered|nothing was sent/i);
    assert.match(deadState.messages, /duplicate/i);
    for (const forbidden of ['not listening', 'aiohttp', 'Traceback', 'C:\\Users', 'Failed to fetch']) {
      assert.ok(!deadState.detail.includes(forbidden), `Panel copy must not claim "${forbidden}"`);
      assert.ok(!deadState.messages.includes(forbidden), `Transcript must not leak "${forbidden}"`);
    }
    const chatAttemptsFor = (needle) => gateway.requests.filter((request) => (
      /\/chat$/.test(request.path)
      && request.method === 'POST'
      && String(request.body?.message || '').includes(needle)
    )).length;
    // Chrome may retry once at the socket layer when a reused connection is reset,
    // so a raw attempt count is not a duplicate-send signal. What must hold is that
    // Browser issues no further attempt once it has classified the failure.
    const attemptsAtFailure = chatAttemptsFor('Keep this draft');
    assert.ok(attemptsAtFailure >= 1, 'The failed turn must have reached the gateway at least once.');
    await openSettings(panel);
    const recoveryState = await panel.evaluate(paneldState);
    assert.match(recoveryState.title, /unavailable|gateway test failed/i);
    assert.equal(recoveryState.retryVisible, true, 'A classified gateway failure must expose the recovery action.');
    const messagesAtFailure = deadState.messages;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(chatAttemptsFor('Keep this draft'), attemptsAtFailure, 'Browser must not replay the turn after classifying the failure.');
    assert.equal((await panel.evaluate(paneldState)).messages, messagesAtFailure, 'No extra turn may appear after the failure was classified.');
    await focusConnectionCard(panel);
    await saveScreenshot(panel, SCREENSHOT_AMBIGUOUS);
    if (recoveryState.retryVisible) {
      await panel.evaluate(`document.querySelector('#statusRetryProbeButton').click()`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(chatAttemptsFor('Keep this draft'), attemptsAtFailure, 'The recovery action must not send a turn.');
      assert.equal(await panel.evaluate(`document.querySelector('#promptInput').value`), draftingPrompt, 'The recovery action must not clear the preserved draft.');
    }
    console.log('[qa] scenario B ok:', JSON.stringify({ title: deadState.title, detail: deadState.detail.slice(0, 220) }, null, 1));

    // ---- Scenario C: the gateway is gone and the user probes from Settings --
    await gateway.close();
    await panel.evaluate(`document.querySelector('#testConnectionButton')?.click(); true`);
    const probeState = await waitFor(() => panel.evaluate(`(() => {
      const state = ${paneldState};
      if (!state.detail.includes('cannot tell')) return null;
      return state;
    })()`), 30_000);
    assert.match(probeState.title, /gateway test failed/i);
    for (const forbidden of ['not listening', 'aiohttp', 'Traceback', 'Failed to fetch']) {
      assert.ok(!probeState.detail.includes(forbidden), `Probe copy must not claim "${forbidden}"`);
    }
    const probeRecovery = await panel.evaluate(paneldState);
    assert.equal(probeRecovery.retryVisible, true, 'The probe failure must expose the recovery action.');
    const messagesBeforeProbeRetry = probeState.messages;
    await panel.evaluate(`document.querySelector('#statusRetryProbeButton').click()`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal((await panel.evaluate(paneldState)).messages, messagesBeforeProbeRetry, 'The probe recovery action must not add a turn.');
    console.log('[qa] scenario C ok:', JSON.stringify({ title: probeState.title, detail: probeState.detail.slice(0, 220) }, null, 1));

    console.log('[qa] screenshots:', SCREENSHOT_INIT_FAILURE, SCREENSHOT_AMBIGUOUS);
  } catch (error) {
    if (chromeStderr) console.error('[qa] chrome stderr tail:', chromeStderr.slice(-1500));
    throw error;
  } finally {
    panel?.close();
    setup?.close();
    killChrome(chrome);
    await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
    await gateway.close().catch(() => {});
  }
}

await main();