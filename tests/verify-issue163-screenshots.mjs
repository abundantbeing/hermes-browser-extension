#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { killProcessTree, launchChrome, resolveChromeExecutable } from './e2e-chrome-env.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const ARTIFACTS = process.env.ISSUE163_ARTIFACTS_DIR
  || path.join('/opt/cursor/artifacts');

const PRIVATE_PORT = 18765;
const PUBLIC_PORT = 18766;

const SPA_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Lan SPA fixture</title><style>
html,body,#app{margin:0;min-height:100vh;font:16px system-ui,sans-serif;background:#e8f4ff;color:#112;}
#app{display:grid;place-items:center;}
.card{padding:24px;border-radius:12px;background:#fff;border:2px solid #226;color:#226;}
</style></head><body><div id="app"><div class="card"><h1>LAN dashboard fixture</h1><p>If this page is blank, page scripts likely broke the SPA.</p></div></div></body></html>`;

async function waitForPageTarget(port, attempt = 0) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (response.ok) {
      const tabs = await response.json();
      const page = tabs.find((tab) => tab.type === 'page' && tab.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    }
  } catch { /* retry */ }
  if (attempt > 60) throw new Error('DevTools never became ready');
  await new Promise((resolve) => setTimeout(resolve, 250));
  return waitForPageTarget(port, attempt + 1);
}

async function screenshotPage(webSocketUrl, url, filePath) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('CDP connection failed'));
  });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const payload = JSON.parse(String(event.data));
    if (!payload.id) return;
    pending.get(payload.id)?.(payload);
    pending.delete(payload.id);
  };
  const call = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  await call('Page.enable');
  await call('Page.navigate', { url });
  await call('Page.loadEventFired');
  await new Promise((resolve) => setTimeout(resolve, 800));
  const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const data = shot?.result?.data || shot?.result?.value || '';
  if (!data) throw new Error(`Screenshot empty for ${url}`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(data, 'base64'));
  socket.close();
}

function startServer(port, body) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function main() {
  await mkdir(ARTIFACTS, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(DIST, 'manifest.json'), 'utf8'));
  assert.ok(manifest.version, 'dist build is required (npm run build)');
  const privateServer = await startServer(PRIVATE_PORT, SPA_HTML);
  const publicServer = await startServer(PUBLIC_PORT, SPA_HTML.replace('LAN dashboard', 'Public page fixture'));
  const devtoolsPort = 19223 + (process.pid % 1000);
  const chrome = launchChrome(resolveChromeExecutable(['/usr/local/bin/google-chrome', '/usr/bin/google-chrome']), [
    `--remote-debugging-port=${devtoolsPort}`,
    `--user-data-dir=${path.join(ROOT, 'tmp', `issue163-chrome-${process.pid}`)}`,
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    'about:blank',
  ], { detached: false, stdio: 'ignore' });
  try {
    let ws = await waitForPageTarget(devtoolsPort);
    const privateUrl = `http://127.0.0.1:${PRIVATE_PORT}/`;
    const publicUrl = `http://127.0.0.1:${PUBLIC_PORT}/`;
    await screenshotPage(ws, privateUrl, path.join(ARTIFACTS, 'issue163-lan-spa-renders-default.png'));
    await screenshotPage(ws, publicUrl, path.join(ARTIFACTS, 'issue163-local-fixture-second-origin.png'));
    const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
    const ext = targets.find((tab) => String(tab.url || '').startsWith('chrome-extension://'));
    const extId = ext ? new URL(ext.url).host : '';
    if (extId) {
      await screenshotPage(ws, `chrome-extension://${extId}/sidepanel.html`, path.join(ARTIFACTS, 'issue163-sidepanel-loaded.png'));
      await screenshotPage(
        ws,
        `chrome-extension://${extId}/sidepanel.html#settings-permissions`,
        path.join(ARTIFACTS, 'issue163-settings-permissions-private-lan.png'),
      );
      ws = await waitForPageTarget(devtoolsPort);
      await screenshotPage(ws, privateUrl, path.join(ARTIFACTS, 'issue163-sidepanel-context-after-private-tab.png'));
    }
    await writeFile(path.join(ARTIFACTS, 'issue163-screenshot-notes.txt'), [
      `Built extension ${manifest.version} at ${DIST}`,
      'Screenshots captured via CDP Page.captureScreenshot of fixture SPAs with the unpacked build loaded.',
      'Side panel Settings UI was not automated in this run; see dist/manual verification if panel screenshots are absent.',
    ].join('\n'));
    console.log(`Saved issue #163 screenshots under ${ARTIFACTS}`);
  } finally {
    privateServer.close();
    publicServer.close();
    killProcessTree(chrome);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
