#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backendRoot = process.env.HERMES_BACKEND_REPO || '/home/openclaw/Work/hermes-agent-local/hermes-agent';
const hermesBin = process.env.HERMES_BIN || join(backendRoot, 'venv/bin/hermes');
const chromiumBin = process.env.CHROMIUM_BIN || '/home/hermes-agent/.local/bin/chromium';
const tempRoot = await mkdtemp(join(tmpdir(), 'hermes-browser-action-smoke-'));
const extensionRoot = join(tempRoot, 'extension');
const profileRoot = join(tempRoot, 'hermes-home');
const userDataDir = join(tempRoot, 'chromium-profile');
const token = `smoke-${Date.now()}`;
const children = [];
let pageServer;

function randomPort() {
  return 20_000 + Math.floor(Math.random() * 20_000);
}

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function rpcClient(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const eventWaiters = [];
  socket.addEventListener('message', (message) => {
    const frame = JSON.parse(String(message.data));
    if (frame.id != null) {
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      if (frame.error) waiter.reject(new Error(frame.error.message || 'RPC failed'));
      else waiter.resolve(frame.result);
      return;
    }
    if (frame.method === 'event') {
      for (const waiter of [...eventWaiters]) {
        if (waiter.type !== frame.params?.type) continue;
        eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
        waiter.resolve(frame.params);
      }
    }
  });
  return {
    ready: new Promise((resolveReady, rejectReady) => {
      socket.addEventListener('open', resolveReady, { once: true });
      socket.addEventListener('error', () => rejectReady(new Error('WebSocket failed')), { once: true });
    }),
    request(method, params = {}) {
      return new Promise((resolveRequest, rejectRequest) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    },
    event(type) {
      return new Promise((resolveEvent) => eventWaiters.push({ type, resolve: resolveEvent }));
    },
    close() { socket.close(); },
  };
}

function cdpClient(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (message) => {
    const frame = JSON.parse(String(message.data));
    if (!frame.id) return;
    const waiter = pending.get(frame.id);
    if (!waiter) return;
    pending.delete(frame.id);
    if (frame.error) waiter.reject(new Error(frame.error.message));
    else waiter.resolve(frame.result);
  });
  return {
    ready: new Promise((resolveReady, rejectReady) => {
      socket.addEventListener('open', resolveReady, { once: true });
      socket.addEventListener('error', () => rejectReady(new Error('CDP WebSocket failed')), { once: true });
    }),
    command(method, params = {}) {
      return new Promise((resolveCommand, rejectCommand) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function evaluate(client, expression, awaitPromise = true) {
  const response = await client.command('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'CDP evaluation failed');
  return response.result?.value;
}

async function cleanup() {
  pageServer?.close();
  for (const child of children.reverse()) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
  for (const child of children) {
    if (!child.killed) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
  await rm(tempRoot, { recursive: true, force: true });
}

try {
  await cp(join(repoRoot, 'extension'), extensionRoot, { recursive: true });
  const manifestPath = join(extensionRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace('connect-src http: https: wss:', 'connect-src http: https: ws: wss:');
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), '<all_urls>'])];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const pagePort = randomPort();
  pageServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Hermes smoke page</title><main><button id="save" type="button">Save</button><p>Untrusted page text</p></main>');
  });
  await new Promise((resolveListen) => pageServer.listen(pagePort, '127.0.0.1', resolveListen));

  const gatewayPort = randomPort();
  const gateway = spawn(hermesBin, ['serve', '--host', '127.0.0.1', '--port', String(gatewayPort), '--skip-build', '--isolated'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      HERMES_HOME: profileRoot,
      HERMES_DASHBOARD_SESSION_TOKEN: token,
      HERMES_SERVE_HEADLESS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(gateway);
  let gatewayLog = '';
  gateway.stdout.on('data', (chunk) => { gatewayLog += chunk; });
  gateway.stderr.on('data', (chunk) => { gatewayLog += chunk; });
  await waitFor(
    async () => gatewayLog.includes(`HERMES_BACKEND_READY port=${gatewayPort}`),
    'Hermes gateway readiness sentinel',
    45_000,
  ).catch((error) => {
    throw new Error(`${error.message}\n${gatewayLog.slice(-4000)}`);
  });

  const debugPort = randomPort();
  const chromium = spawn(chromiumBin, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`,
    `http://127.0.0.1:${pagePort}/`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(chromium);
  let chromiumLog = '';
  chromium.stdout.on('data', (chunk) => { chromiumLog += chunk; });
  chromium.stderr.on('data', (chunk) => { chromiumLog += chunk; });

  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const list = await response.json();
    const worker = list.find((target) => target.type === 'service_worker' && target.url.startsWith('chrome-extension://'));
    const page = list.find((target) => target.type === 'page' && target.url.startsWith(`http://127.0.0.1:${pagePort}`));
    return worker && page ? { worker, page, list } : null;
  }, 'loaded unpacked extension and smoke page', 30_000).catch((error) => {
    throw new Error(`${error.message}\n${chromiumLog.slice(-4000)}`);
  });
  const extensionId = new URL(targets.worker.url).host;

  const browserTargetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
  const browserTarget = await browserTargetResponse.json();
  const browserCdp = cdpClient(browserTarget.webSocketDebuggerUrl);
  await browserCdp.ready;
  const created = await browserCdp.command('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel.html` });
  const sidepanelTarget = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const list = await response.json();
    return list.find((target) => target.id === created.targetId && target.webSocketDebuggerUrl);
  }, 'extension sidepanel target');
  const sidepanelCdp = cdpClient(sidepanelTarget.webSocketDebuggerUrl);
  await sidepanelCdp.ready;
  await sidepanelCdp.command('Runtime.enable');

  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/api/ws?token=${encodeURIComponent(token)}`;
  const extensionReady = await evaluate(sidepanelCdp, `(async () => {
    const { createGatewayClient } = await import(chrome.runtime.getURL('lib/gateway-ws.mjs'));
    const { installBrowserActionBridge } = await import(chrome.runtime.getURL('lib/browser-action-bridge.mjs'));
    const client = createGatewayClient();
    await client.connect(${JSON.stringify(gatewayUrl)});
    const created = await client.request('session.create', { title: 'browser action loaded smoke' });
    globalThis.__HERMES_SMOKE_CLIENT__ = client;
    globalThis.__HERMES_SMOKE_SESSION_ID__ = created.session_id;
    globalThis.__HERMES_SMOKE_BRIDGE__ = installBrowserActionBridge({
      client,
      sessionId: () => globalThis.__HERMES_SMOKE_SESSION_ID__,
      runtime: chrome.runtime,
      requestApproval: async () => true,
      onReceipt: ({ result }) => { globalThis.__HERMES_SMOKE_RECEIPT__ = result; },
    });
    return { ready: true, sessionId: created.session_id };
  })()`);
  assert.equal(extensionReady.ready, true);

  const driver = rpcClient(gatewayUrl);
  await driver.ready;
  await browserCdp.command('Target.activateTarget', { targetId: targets.page.id });
  const requestAck = await driver.request('browser.action.request', {
    session_id: extensionReady.sessionId,
    request_id: 'loaded-smoke-screenshot',
    action: { type: 'screenshot' },
  });
  assert.equal(requestAck.status, 'requested');

  const extensionReceipt = await waitFor(
    () => evaluate(sidepanelCdp, 'globalThis.__HERMES_SMOKE_RECEIPT__ || null'),
    'extension-side sanitized screenshot receipt',
  );
  assert.equal(extensionReceipt.ok, true);
  assert.equal(extensionReceipt.actionType, 'screenshot');
  assert.equal(extensionReceipt.hasDataUrl, true);
  assert.equal(Object.hasOwn(extensionReceipt, 'dataUrl'), false);

  const policyChecks = await evaluate(sidepanelCdp, `(async () => {
    const actions = await import(chrome.runtime.getURL('lib/browser-actions.mjs'));
    return {
      restricted: actions.validateBrowserActionRequest({ type: 'openUrl', url: 'https://bank.example/login' }),
      unsupported: actions.validateBrowserActionRequest({ type: 'submitForm' }),
      approval: actions.browserActionApprovalPolicy({ type: 'typeText' }),
    };
  })()`);
  assert.equal(policyChecks.restricted.reason, 'restricted_url');
  assert.equal(policyChecks.unsupported.reason, 'unsupported_action');
  assert.equal(policyChecks.approval.requiresApproval, true);

  driver.close();
  sidepanelCdp.close();
  browserCdp.close();
  console.log(JSON.stringify({
    ok: true,
    extensionId,
    protocol: 'hermes.browser.actions.v1',
    gatewayEvent: 'browser.action.requested',
    resultMethod: 'browser.action.result',
    actionType: extensionReceipt.actionType,
    extensionReceiptHasDataUrl: extensionReceipt.hasDataUrl,
    rawDataUrlReturnedToGateway: false,
    temporaryManifestRelaxations: ['connect-src ws:', 'host_permissions <all_urls> (temp copy only)'],
  }, null, 2));
} finally {
  await cleanup();
}
