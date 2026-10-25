/**
 * Approving a pairing inside the panel (Chrome for Testing, built dist/).
 *
 *   node tests/e2e-pairing-in-panel.mjs                 mock gateway (this file)
 *   HERMES_AGENT_CHECKOUT=<hermes-agent> node ...       the gateway's own handlers
 *   node tests/e2e-pairing-in-panel.mjs --legacy        a gateway that cannot be framed
 *
 * Three journeys against a gateway on a free local port (never 8642):
 *   setup  first-run setup -> Connect step -> the approval page is framed there -> Approve
 *   popup  Connect later -> send while unpaired -> the Connect pop-up frames it -> Approve
 *   deny   the same pop-up, Deny -> "Pairing was denied."
 * With --legacy the gateway says nothing about framing and the approval opens in a tab.
 * Screenshots go to .hermes/qa/ (and HERMES_E2E_SCREEN_DIR when set).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { launchChrome } from './e2e-chrome-env.mjs';

import {
  CdpClient,
  DIST,
  ROOT,
  chromeExecutable,
  ensureExtensionStartupPage,
  fetchJson,
  killChrome,
  unpackedExtensionId,
  waitFor,
} from './e2e-phase6-browser-control.mjs';

const LEGACY = process.argv.includes('--legacy');
const CHECKOUT = process.env.HERMES_AGENT_CHECKOUT || '';
const QA_DIR = path.join(ROOT, '.hermes', 'qa');
const SCREEN_COPY_DIR = process.env.HERMES_E2E_SCREEN_DIR || '';
const PANEL = { width: 420, height: 860 };

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

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const EXTENSION_ORIGIN = /^(?:chrome-extension|moz-extension|safari-web-extension):\/\/[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

// The part of the gateway's contract this journey leans on, for when no
// hermes-agent checkout is given: framing headers, and Approve/Deny that only
// accept the gateway's own page.
function mockPairing(port, state) {
  const own = `http://127.0.0.1:${port}`;
  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;font:15px system-ui;background:#0a0a8a;color:#fff;display:grid;place-items:center;min-height:100vh}
main{padding:24px;max-width:320px}h1{font-weight:300;letter-spacing:.04em;text-transform:uppercase}
button{font:inherit;padding:10px 16px;margin:6px 6px 0 0;border:1px solid #fff;background:transparent;color:#fff}</style></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`;
  const headers = (record) => ({
    'Content-Type': 'text/html; charset=utf-8',
    'Referrer-Policy': 'same-origin',
    ...(record?.origin && !LEGACY
      ? { 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors ${record.origin}` }
      : { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'X-Frame-Options': 'DENY' }),
  });
  const fromOwnPage = (req) => req.headers.origin === own
    && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
  return {
    start(req, body, res) {
      const sent = String(req.headers.origin || '');
      let origin = EXTENSION_ORIGIN.test(String(body.extensionOrigin || '')) ? body.extensionOrigin : '';
      if (sent && sent !== origin) origin = '';
      const id = `pair-${++state.sequence}`;
      state.pairings.set(id, { status: 'pending', token: null, origin });
      json(res, 200, {
        pairing_id: id,
        approval_url: `${own}/api/browser-extension/pair/approve/${id}`,
        ttl_seconds: 180,
        ...(LEGACY ? {} : { embeddable: Boolean(origin) }),
      });
    },
    approve(id, res) {
      const record = state.pairings.get(id);
      if (!record) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, headers(record));
      res.end(page('Approve connection', `<p>Allow Hermes Browser Extension to connect to your local Hermes gateway?</p>
<code>${record.origin || ''}</code>
<form method="post" action="/api/browser-extension/pair/grant/${id}"><button id="approveButton" type="submit">Approve</button></form>
<form method="post" action="/api/browser-extension/pair/deny/${id}"><button id="denyButton" type="submit">Deny</button></form>`));
    },
    act(action, id, req, res) {
      const record = state.pairings.get(id);
      state.posts.push({ action, origin: req.headers.origin || '', site: req.headers['sec-fetch-site'] || '' });
      if (!fromOwnPage(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('own page only'); return; }
      if (!record || record.status !== 'pending') { res.writeHead(410); res.end('expired'); return; }
      if (action === 'grant') {
        record.status = 'approved';
        record.token = `pairing-token-${id}-${String(++state.sequence).padStart(6, '0')}`;
        state.tokens.add(record.token);
      } else {
        record.status = 'denied';
      }
      res.writeHead(200, headers(record));
      res.end(page(action === 'grant' ? 'Approved' : 'Denied', '<p>You can close this.</p>'));
    },
    status(id, res) {
      const record = state.pairings.get(id);
      if (!record) { json(res, 404, { error: { message: 'not found', code: 'pairing_not_found' } }); return; }
      if (record.status === 'approved') { json(res, 200, { status: 'approved', token: record.token }); return; }
      if (record.status === 'denied') { json(res, 410, { error: { message: 'denied', code: 'pairing_denied' } }); return; }
      json(res, 200, { status: 'pending' });
    },
  };
}

async function startPythonGateway(extensionOrigin) {
  const script = path.join(import.meta.dirname, 'e2e-support', 'pairing_gateway.py');
  const child = spawn('python', ['-I', script, CHECKOUT, extensionOrigin], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const line = buffer.split('\n').find((entry) => entry.startsWith('{'));
      if (line) resolve(JSON.parse(line).port);
    });
    child.on('exit', (code) => reject(new Error(`pairing gateway exited (${code}): ${stderr.slice(-1500)}`)));
    setTimeout(() => reject(new Error(`pairing gateway did not start: ${stderr.slice(-1500)}`)), 20_000);
  });
  return { child, port };
}

async function startGateway(extensionOrigin) {
  const state = { pairings: new Map(), tokens: new Set(), requests: [], posts: [], starts: [], sequence: 0 };
  let upstream = null;
  if (CHECKOUT) upstream = await startPythonGateway(extensionOrigin);
  let mock = null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    state.requests.push(`${req.method} ${url.pathname}`);
    if (req.method === 'OPTIONS') { json(res, 204, {}); return; }
    if (url.pathname === '/health' || url.pathname === '/v1/health') { json(res, 200, { status: 'ok', platform: 'hermes-agent', version: 'pairing-in-panel' }); return; }
    if (url.pathname === '/v1/capabilities') {
      json(res, 200, {
        object: 'hermes.api_server.capabilities',
        platform: 'hermes-agent',
        auth: { type: 'bearer', required: true },
        features: { models_api: true, session_resources: true, session_chat: true, skills_api: true, browserPairing: true },
        endpoints: { health: { method: 'GET', path: '/health' }, models: { method: 'GET', path: '/v1/models' }, browser_pairing: { method: 'POST', path: '/api/browser-extension/pair/start' } },
      });
      return;
    }
    if (url.pathname.startsWith('/api/browser-extension/pair/')) {
      const [, , , , action, id] = url.pathname.split('/');
      const body = await readBody(req);
      if (action === 'start') {
        let parsed = {};
        try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { /* none */ }
        state.starts.push({ origin: req.headers.origin || '', body: parsed });
      }
      if (upstream) {
        await new Promise((resolve) => {
          const proxied = httpRequest({ host: '127.0.0.1', port: upstream.port, path: req.url, method: req.method, headers: req.headers }, (answer) => {
            const chunks = [];
            answer.on('data', (chunk) => chunks.push(chunk));
            answer.on('end', () => {
              const payload = Buffer.concat(chunks);
              if (action === 'status') {
                try {
                  const parsed = JSON.parse(payload.toString('utf8'));
                  if (parsed.status === 'approved' && parsed.token) state.tokens.add(parsed.token);
                } catch { /* not json */ }
              }
              if (action === 'grant' || action === 'deny') state.posts.push({ action, status: answer.statusCode, origin: req.headers.origin || '', site: req.headers['sec-fetch-site'] || '' });
              state.lastApprovalHeaders = action === 'approve' ? answer.headers : state.lastApprovalHeaders;
              res.writeHead(answer.statusCode, { ...answer.headers, 'Access-Control-Allow-Origin': '*' });
              res.end(payload);
              resolve();
            });
          });
          proxied.end(body);
        });
        return;
      }
      mock ||= mockPairing(server.address().port, state);
      if (action === 'start') mock.start(req, state.starts.at(-1).body, res);
      else if (action === 'approve') mock.approve(id, res);
      else if (action === 'grant' || action === 'deny') mock.act(action, id, req, res);
      else if (action === 'status') mock.status(id, res);
      else { res.writeHead(404); res.end(); }
      return;
    }
    const auth = String(req.headers.authorization || '');
    if (!(auth.startsWith('Bearer ') && state.tokens.has(auth.slice(7).trim()))) { json(res, 401, { error: { message: 'Invalid gateway API key', code: 'gateway_auth_failed' } }); return; }
    if (url.pathname === '/v1/models') { json(res, 200, { object: 'list', data: [{ id: 'pairing/e2e-model', object: 'model' }] }); return; }
    if (url.pathname === '/api/model/options') { json(res, 200, { providers: [{ slug: 'pairing', name: 'Pairing E2E', models: [{ id: 'pairing/e2e-model', label: 'Pairing E2E Model' }] }] }); return; }
    if (url.pathname === '/v1/skills') { json(res, 200, { skills: [] }); return; }
    if (req.method === 'GET' && url.pathname === '/api/sessions') { json(res, 200, { sessions: [], items: [] }); return; }
    if (req.method === 'POST' && url.pathname === '/api/sessions') { json(res, 200, { id: `pairing-session-${++state.sequence}`, title: 'Pairing E2E Session', created_at: Date.now(), updated_at: Date.now() }); return; }
    if (url.pathname.includes('/messages')) { json(res, 200, { messages: [] }); return; }
    if (url.pathname.startsWith('/api/sessions/')) { json(res, 200, { id: url.pathname.split('/').pop(), title: 'Pairing E2E Session', messages: [] }); return; }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  assert.notEqual(server.address().port, 8642, 'never the real gateway');
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    state,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      if (upstream) upstream.child.kill();
    },
  };
}

async function shot(page, name) {
  const image = await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await mkdir(QA_DIR, { recursive: true });
  const file = path.join(QA_DIR, `pairing-in-panel-${name}.png`);
  await writeFile(file, Buffer.from(image.data, 'base64'));
  if (SCREEN_COPY_DIR) {
    await mkdir(SCREEN_COPY_DIR, { recursive: true });
    await copyFile(file, path.join(SCREEN_COPY_DIR, path.basename(file)));
  }
  return file;
}

// A real click: the page under the pointer is the framed gateway page, so the
// browser sets Origin and Sec-Fetch-Site exactly as it does for a person.
async function clickInFrame(panel, devtoolsBase, selector) {
  const frame = await panel.evaluate(`(() => {
    const el = document.querySelector('.pairing-approval-frame');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, src: el.getAttribute('src') };
  })()`);
  assert.ok(frame, 'the approval frame is on screen');
  const target = await waitFor(async () => {
    const targets = await fetchJson(`${devtoolsBase}/json/list`);
    return targets.find((entry) => entry.type === 'iframe' && String(entry.url).startsWith(frame.src.split('/approve/')[0])) || null;
  });
  const inner = new CdpClient(target.webSocketDebuggerUrl);
  await inner.connect();
  try {
    await inner.call('Runtime.enable');
    // Scroll the button into the frame, let the page settle, then measure it.
    await waitFor(() => inner.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      return true;
    })()`));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const box = await waitFor(() => inner.evaluate(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    })()`));
    const x = Math.round(frame.x + box.x);
    const y = Math.round(frame.y + box.y);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await panel.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
    }
  } finally {
    inner.close();
  }
}

async function openPanel(devtoolsBase, extensionId) {
  const panelTarget = await fetchJson(`${devtoolsBase}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/sidepanel.html`)}`, { method: 'PUT' });
  const panel = new CdpClient(panelTarget.webSocketDebuggerUrl);
  await panel.connect();
  await panel.call('Runtime.enable');
  await panel.call('Emulation.setDeviceMetricsOverride', { ...PANEL, deviceScaleFactor: 1, mobile: false });
  return { panel, targetId: panelTarget.id };
}

async function journey(name, run) {
  const extensionId = unpackedExtensionId(DIST);
  const extensionOrigin = `chrome-extension://${extensionId}`;
  const profile = path.join(ROOT, 'tmp', `e2e-pairing-in-panel-${name}-${process.pid}`);
  await rm(profile, { recursive: true, force: true });
  await mkdir(profile, { recursive: true });
  const gateway = await startGateway(extensionOrigin);
  let chrome;
  let browser;
  let panel;
  let stderr = '';
  try {
    chrome = launchChrome(chromeExecutable(), [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`,
      `chrome-extension://${extensionId}/request-permissions.html`,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    chrome.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const activePort = path.join(profile, 'DevToolsActivePort');
    await waitFor(() => existsSync(activePort));
    const [portLine] = (await readFile(activePort, 'utf8')).trim().split('\n');
    const devtoolsBase = `http://127.0.0.1:${Number(portLine)}`;
    await ensureExtensionStartupPage(devtoolsBase, extensionId);
    const version = await fetchJson(`${devtoolsBase}/json/version`);
    browser = new CdpClient(version.webSocketDebuggerUrl);
    await browser.connect();

    const seedTarget = await waitFor(async () => (await fetchJson(`${devtoolsBase}/json/list`))
      .find((target) => target.type === 'page' && String(target.url || '').startsWith(`chrome-extension://${extensionId}/`)) || null);
    const seed = new CdpClient(seedTarget.webSocketDebuggerUrl);
    await seed.connect();
    await seed.call('Runtime.enable');
    await waitFor(() => seed.evaluate('Boolean(globalThis.chrome?.storage?.local)'));
    await seed.evaluate(`chrome.storage.local.set({
      hermesBrowserSettings: {
        connectionSchemaVersion: 1, connectionMode: 'local', connectionTransport: 'local-api', gatewayMode: 'local-api',
        gatewayUrl: ${JSON.stringify(gateway.baseUrl)}, sessionStartMode: 'new-session'
      }
    })`);
    seed.close();

    const opened = await openPanel(devtoolsBase, extensionId);
    panel = opened.panel;
    const result = await run({ panel, devtoolsBase, gateway, extensionId, extensionOrigin, openPanel: () => openPanel(devtoolsBase, extensionId) });
    const exceptions = panel.events.filter((event) => event.method === 'Runtime.exceptionThrown');
    assert.deepEqual(exceptions, [], `${name}: no exceptions in the panel`);
    return result;
  } catch (error) {
    error.message = `${name}: ${error.message}\nChrome stderr tail:\n${stderr.slice(-1500)}`;
    throw error;
  } finally {
    try { panel?.close(); } catch { /* best effort */ }
    try { browser?.close(); } catch { /* best effort */ }
    killChrome(chrome);
    await gateway.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

const settleStep = (panel, step) => waitFor(() => panel.evaluate(`document.querySelector('.onboarding-stage')?.dataset.step === ${JSON.stringify(step)}`));

async function toSetupConnect(panel) {
  await waitFor(() => panel.evaluate(`Boolean(document.querySelector('#onboardingFlow:not([hidden]) [data-onboarding-next]'))`), 45_000);
  for (const step of ['font', 'style', 'layout', 'connect']) {
    await panel.evaluate(`document.querySelector('[data-onboarding-next]').click()`);
    await settleStep(panel, step);
  }
}

const frameState = (panel) => panel.evaluate(`(() => {
  const frame = document.querySelector('.pairing-approval-frame');
  const rect = frame?.getBoundingClientRect();
  return frame ? {
    src: frame.getAttribute('src'), sandbox: frame.getAttribute('sandbox'),
    width: Math.round(rect.width), height: Math.round(rect.height), visible: Boolean(rect.width && rect.height),
    inSetup: Boolean(frame.closest('#onboardingFlow')), inPopup: Boolean(frame.closest('#connectPanel')),
  } : null;
})()`);

async function tabsOnApproval(devtoolsBase) {
  const targets = await fetchJson(`${devtoolsBase}/json/list`);
  return targets.filter((target) => target.type === 'page' && String(target.url).includes('/pair/approve/'));
}

async function main() {
  assert.ok(existsSync(path.join(DIST, 'manifest.json')), 'Run npm run build before this journey.');
  const report = { verdict: 'PASS', mode: LEGACY ? 'legacy gateway' : (CHECKOUT ? 'hermes-agent handlers' : 'mock gateway'), journeys: {} };

  if (LEGACY) {
    report.journeys.legacy = await journey('legacy', async ({ panel, devtoolsBase, gateway }) => {
      await toSetupConnect(panel);
      await panel.evaluate(`document.querySelector('[data-onboarding-connect]').click()`);
      const tabs = await waitFor(async () => {
        const found = await tabsOnApproval(devtoolsBase);
        return found.length ? found : null;
      }, 25_000);
      assert.equal(await frameState(panel), null, 'an older gateway is never framed');
      assert.equal(gateway.state.starts[0].body.extensionOrigin.startsWith('chrome-extension://'), true, 'the origin is still sent');
      return { tabOpened: tabs[0].url.replace(/\/[^/]+$/, '/<id>'), shot: await shot(panel, 'legacy-opens-a-tab') };
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  report.journeys.setup = await journey('setup', async ({ panel, devtoolsBase, gateway, extensionOrigin }) => {
    await toSetupConnect(panel);
    await shot(panel, 'setup-1-connect-step');
    await panel.evaluate(`document.querySelector('[data-onboarding-connect]').click()`);
    const frame = await waitFor(async () => {
      const state = await frameState(panel);
      return state?.visible ? state : null;
    }, 25_000);
    assert.equal(frame.inSetup, true, "the page is in setup's Connect step");
    assert.equal(frame.sandbox, 'allow-forms allow-same-origin');
    assert.match(frame.src, /\/api\/browser-extension\/pair\/approve\//);
    assert.deepEqual(await tabsOnApproval(devtoolsBase), [], 'no tab was opened');
    assert.equal(gateway.state.starts[0].body.extensionOrigin, extensionOrigin, 'the request carried the exact origin');
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const shotFile = await shot(panel, 'setup-2-approval-in-panel');
    // Two poll beats later the same page is still the one on screen.
    assert.equal((await frameState(panel)).src, frame.src);
    await clickInFrame(panel, devtoolsBase, '#approveButton');
    await waitFor(async () => (await panel.evaluate(`document.querySelector('#onboardingFlow')?.hidden !== false || document.querySelector('.onboarding-connect.is-connected') !== null`)), 45_000);
    const grant = gateway.state.posts.find((post) => post.action === 'grant');
    assert.ok(grant, 'Approve reached the gateway');
    assert.equal(grant.origin, gateway.baseUrl, "the browser posted from the gateway's own page");
    assert.equal(grant.site, 'same-origin');
    const stored = await panel.evaluate(`chrome.storage.local.get(['hermesBrowserSettings'])`);
    assert.equal(stored.hermesBrowserSettings.tokenSource, 'pairing');
    assert.equal(await frameState(panel), null, 'the page is gone once paired');
    return { frame, gatewayHeaders: gateway.state.lastApprovalHeaders && {
      csp: gateway.state.lastApprovalHeaders['content-security-policy'],
      xFrameOptions: gateway.state.lastApprovalHeaders['x-frame-options'] || null,
    }, shot: shotFile, connected: await shot(panel, 'setup-3-connected') };
  });

  report.journeys.popup = await journey('popup', async ({ panel, devtoolsBase, gateway }) => {
    await toSetupConnect(panel);
    await panel.evaluate(`document.querySelector('[data-onboarding-next]').click()`); // "Connect later"
    await waitFor(() => panel.evaluate(`document.querySelector('#onboardingFlow')?.hidden === true && !document.body.classList.contains('startup-active')`), 25_000);
    await panel.evaluate(`document.querySelector('#sendButton').click()`);
    await waitFor(() => panel.evaluate(`(() => { const p = document.querySelector('#connectPanel'); return p && !p.hidden && getComputedStyle(p).display !== 'none'; })()`));
    await shot(panel, 'popup-1-connect');
    await panel.evaluate(`document.querySelector('#connectButton').click()`);
    const frame = await waitFor(async () => {
      const state = await frameState(panel);
      return state?.visible ? state : null;
    }, 25_000);
    assert.equal(frame.inPopup, true, 'the page is in the Connect pop-up');
    assert.deepEqual(await tabsOnApproval(devtoolsBase), []);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const approvalShot = await shot(panel, 'popup-2-approval-in-panel');
    await clickInFrame(panel, devtoolsBase, '#approveButton');
    await waitFor(() => panel.evaluate(`document.querySelector('#connectPanel')?.hidden === true`), 45_000);
    assert.ok(gateway.state.posts.find((post) => post.action === 'grant' && post.origin === gateway.baseUrl));
    return { frame, shot: approvalShot, connected: await shot(panel, 'popup-3-connected') };
  });

  report.journeys.deny = await journey('deny', async ({ panel, devtoolsBase, gateway }) => {
    await toSetupConnect(panel);
    await panel.evaluate(`document.querySelector('[data-onboarding-next]').click()`);
    await waitFor(() => panel.evaluate(`document.querySelector('#onboardingFlow')?.hidden === true && !document.body.classList.contains('startup-active')`), 25_000);
    await panel.evaluate(`document.querySelector('#sendButton').click()`);
    await waitFor(() => panel.evaluate(`(() => { const p = document.querySelector('#connectPanel'); return p && !p.hidden && getComputedStyle(p).display !== 'none'; })()`));
    await panel.evaluate(`document.querySelector('#connectButton').click()`);
    await waitFor(async () => (await frameState(panel))?.visible, 25_000);
    await clickInFrame(panel, devtoolsBase, '#denyButton');
    await waitFor(() => gateway.state.posts.find((post) => post.action === 'deny'), 15_000);
    const message = await waitFor(() => panel.evaluate(`(() => {
      const text = document.querySelector('#connectStatus')?.textContent || document.querySelector('#statusDetail')?.textContent || '';
      return /denied/i.test(text) ? text : null;
    })()`), 15_000);
    assert.equal(await frameState(panel), null, 'the page is gone after a denial');
    return { message, shot: await shot(panel, 'deny-1-denied') };
  });

  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
