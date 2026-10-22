import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ensureExtensionStartupPage, killProcessTree, resolveChromeExecutable } from './e2e-chrome-env.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const QA = path.join(ROOT, '.hermes', 'qa', 'context-capture');
const PROFILE = path.join(QA, `profile-${Date.now()}-${process.pid}`);
const CHROME = resolveChromeExecutable();
assert.ok(CHROME && existsSync(CHROME), 'Set CHROME_PATH to the isolated Chrome-for-Testing binary.');
// Chrome derives an unpacked extension's id from the path: UTF-16LE on Windows, UTF-8 elsewhere.
const id = [...createHash('sha256').update(path.resolve(DIST), process.platform === 'win32' ? 'utf16le' : 'utf8').digest().subarray(0, 16)]
  .flatMap(byte => [String.fromCharCode(97 + (byte >> 4)), String.fromCharCode(97 + (byte & 15))]).join('');
const article = `<html><head><title>Long article fixture</title></head><body><nav>UNRELATED_NAVIGATION</nav><article><h1>LONG_ARTICLE_START</h1>${Array.from({ length: 240 }, (_, i) => `<p>Paragraph ${i}. This published article has content below the fold and its final section must reach the outgoing Browser turn.</p>`).join('')}<p>LONG_ARTICLE_END</p></article></body></html>`;
const gmail = '<html><head><title>Gmail fixture</title></head><body><aside>PRIVATE_INBOX_LIST</aside><main role="main"><h2 class="hP">Fixture thread</h2><div data-message-id="old" style="display:none"><span class="gD">Old sender</span><div class="a3s">COLLAPSED_OLDER_MESSAGE</div></div><div data-message-id="latest"><span class="gD">Latest sender</span><div class="a3s">LATEST_REPLY_BODY</div></div><textarea>UNSENT_DRAFT_VALUE</textarea><div contenteditable="true">UNSENT_DRAFT_TEXT</div></main></body></html>';
const articleCase = process.env.CAPTURE_CASE === 'article';
const fixtureUrl = articleCase ? 'https://example.org/long-article-fixture' : 'https://mail.google.com/mail/u/0/#inbox/ABCDEFGHIJKLMNOP';
const fixtureHtml = articleCase ? article : gmail;
const requests = [];
const sessions = new Map();
function json(res, data, status = 200) { res.writeHead(status, { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(data)); }
const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' }); return res.end(); }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/article') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(article); }
  if (url.pathname === '/health') return json(res, { status: 'ok', platform: 'hermes-agent', version: 'fixture' });
  if (url.pathname === '/v1/capabilities') return json(res, {
    features: { models_api: true, session_resources: true, session_chat: true, session_chat_streaming: true, session_model_routing: true, skills_api: true },
    endpoints: { health: { method: 'GET', path: '/health' }, models: { method: 'GET', path: '/v1/models' }, sessions: { method: 'GET', path: '/api/sessions' }, session_create: { method: 'POST', path: '/api/sessions' }, session_model: { method: 'POST', path: '/api/sessions/{session_id}/model' }, session_chat: { method: 'POST', path: '/api/sessions/{session_id}/chat' }, session_chat_stream: { method: 'POST', path: '/api/sessions/{session_id}/chat/stream' } },
  });
  if (url.pathname === '/v1/models') return json(res, { object: 'list', data: [{ id: 'fixture/model', provider: 'fixture', context_length: 100000 }] });
  if (url.pathname === '/api/model/options') return json(res, { providers: [{ slug: 'fixture', name: 'Fixture', authenticated: true, models: [{ id: 'fixture/model', context_length: 100000 }] }] });
  if (url.pathname === '/v1/skills' || url.pathname === '/v1/toolsets') return json(res, { data: [] });
  if (url.pathname === '/api/desktop/dashboard-candidates') return json(res, { candidates: [] });
  if (url.pathname === '/api/sessions') {
    if (req.method === 'GET') return json(res, { data: [...sessions.values()], total: sessions.size, has_more: false });
    const sid = body.id || body.session_id || `hermes-browser-extension-fixture-${sessions.size}`;
    const session = { id: sid, session_id: sid, title: 'Capture fixture', source: 'hermes_browser', model: body.model || 'fixture/model', provider: 'fixture' };
    sessions.set(sid, session); return json(res, session, 201);
  }
  if (/\/messages$/.test(url.pathname)) return json(res, { data: [] });
  if (/\/model$/.test(url.pathname)) return json(res, { runtime: { effective_model: body.model || 'fixture/model', effective_provider: body.provider || 'fixture', model_lock: 'enforced' } });
  if (/\/chat\/stream$/.test(url.pathname)) {
    const turn = JSON.parse(body.message);
    requests.push(turn);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
    for (const [event, data] of [['run.started', { run_id: `fixture-${requests.length}` }], ['assistant.delta', { delta: 'Capture fixture acknowledged.' }], ['assistant.completed', { content: 'Capture fixture acknowledged.' }], ['run.completed', { status: 'completed' }]]) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return res.end();
  }
  if (/^\/api\/sessions\/[^/]+$/.test(url.pathname)) return json(res, sessions.get(decodeURIComponent(url.pathname.split('/')[3])) || { id: 'hermes-browser-extension-fixture', model: 'fixture/model', provider: 'fixture', source: 'hermes_browser' });
  return json(res, { error: 'Optional fixture route not implemented' }, 404);
});
await mkdir(PROFILE, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
class Cdp {
  constructor(url) { this.url = url; this.pending = new Map(); this.n = 0; this.events = []; }
  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = event => {
      const data = JSON.parse(String(event.data));
      if (!data.id) { this.events.push(data); this.onEvent?.(data); return; }
      const pending = this.pending.get(data.id); if (!pending) return;
      this.pending.delete(data.id); clearTimeout(pending.timer);
      if (data.error) pending.reject(new Error(data.error.message)); else pending.resolve(data.result || {});
    };
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
  }
  call(method, params = {}) {
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    let result;
    try { result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); }
    catch (error) { throw new Error(`${error.message}: ${expression.slice(0, 180)}`); }
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { this.ws?.close(); }
}
async function wait(check, timeout = 30000) {
  const until = Date.now() + timeout; let error;
  while (Date.now() < until) {
    try { const value = await check(); if (value) return value; } catch (e) { error = e; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw error || new Error('Condition timed out');
}
const clients = [];
let chrome;
let chromeError = '';
try {
  chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`, `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, `chrome-extension://${id}/request-permissions.html`], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  chrome.stderr.on('data', data => { chromeError += data; });
  const portFile = path.join(PROFILE, 'DevToolsActivePort');
  await wait(() => existsSync(portFile));
  const [port] = (await readFile(portFile, 'utf8')).split('\n');
  const devtools = `http://127.0.0.1:${Number(port)}`;
  await ensureExtensionStartupPage(devtools, id);
  const targets = () => fetch(`${devtools}/json/list`).then(res => res.json());
  const attach = async target => { const c = new Cdp(target.webSocketDebuggerUrl); await c.connect(); clients.push(c); await c.call('Runtime.enable'); await c.call('Log.enable').catch(() => {}); return c; };
  const newPage = async url => attach(await fetch(`${devtools}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then(res => res.json()));
  const workerTarget = await wait(async () => (await targets()).find(t => t.type === 'service_worker' && t.url === `chrome-extension://${id}/background.js`));
  const worker = await attach(workerTarget);
  assert.equal(await worker.eval("chrome.runtime.getManifest().name"), 'Hermes Browser Extension');
  await worker.eval(`chrome.storage.local.set({ hermesBrowserIntroSeen: true, hermesBrowserSettings: ${JSON.stringify({ connectionMode: 'local', connectionTransport: 'local-api', gatewayMode: 'local-api', gatewayUrl: baseUrl, apiKey: 'fixture-auth', tokenSource: 'fixture', sessionId: 'hermes-browser-extension', sessionStartupMode: 'new-session', model: 'fixture/model', extensionPreferredModel: { modelId: 'fixture/model', rawModelId: 'fixture/model', provider: 'fixture', contextTokens: 100000 }, contextDepth: 'full', includePageText: true, includeTabs: false, browserControlEnabled: false, gmailCaptureEnabled: false, colorMode: 'dark', appearanceTheme: 'nous' })} })`);
  const mail = await newPage('about:blank');
  mail.onEvent = event => {
    if (event.method !== 'Fetch.requestPaused') return;
    mail.call('Fetch.fulfillRequest', { requestId: event.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from(fixtureHtml).toString('base64') }).catch(console.error);
  };
  await mail.call('Fetch.enable', { patterns: [{ urlPattern: articleCase ? 'https://example.org/*' : 'https://mail.google.com/*' }] });
  await mail.call('Page.navigate', { url: fixtureUrl });
  await wait(() => mail.eval(`document.body?.innerText.includes(${JSON.stringify(articleCase ? 'LONG_ARTICLE_END' : 'LATEST_REPLY_BODY')})`));
  const mailTab = await worker.eval(`(async () => (await chrome.tabs.query({})).find(t => t.url === ${JSON.stringify(fixtureUrl)}))()`);
  const panelUrl = `chrome-extension://${id}/sidepanel.html`;
  let panel = await newPage(panelUrl);
  await panel.call('Page.bringToFront');
  await panel.call('Emulation.setDeviceMetricsOverride', { width: 440, height: 900, deviceScaleFactor: 1, mobile: false });
  await wait(() => panel.eval('document.querySelector("#startupScreen")?.hidden && !document.querySelector("#promptInput")?.disabled'));
  await worker.eval(`chrome.tabs.update(${mailTab.id}, {active: true})`);
  await panel.eval('document.querySelector("#contextPageRefreshButton").click()');
  await wait(() => panel.eval(articleCase ? 'document.querySelector("#contextPreview").innerText.includes("LONG_ARTICLE_START")' : '!document.querySelector("#explicitSiteCaptureWrap").hidden'));
  await panel.eval('document.querySelector("#contextScopeButton").click()');
  await wait(() => panel.eval(`Boolean(document.querySelector('[data-scope-action="pin-tab:${mailTab.id}"]'))`));
  await panel.eval(`document.querySelector('[data-scope-action="pin-tab:${mailTab.id}"]').click()`);
  await wait(() => panel.eval('document.querySelector("#contextScopeButton").classList.contains("active")'));
  await panel.call('Page.bringToFront');
  const before = await panel.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(QA, articleCase ? 'article-before.png' : 'gmail-before.png'), Buffer.from(before.data, 'base64'));
  if (!articleCase) {
    await wait(() => panel.eval('!document.querySelector("#explicitSiteCaptureButton").disabled && document.querySelector("#contextScopeMenu").hidden'));
    await panel.eval('document.querySelector("#explicitSiteCaptureButton").click()');
    await wait(() => worker.eval('(async () => (await chrome.storage.local.get("hermesBrowserSettings")).hermesBrowserSettings.gmailCaptureEnabled === true)()'));
  }
  await wait(() => panel.eval('document.querySelector("#explicitSiteCaptureWrap").hidden'));
  async function send(p, label) {
    const count = requests.length;
    await p.eval(`(() => { const input = document.querySelector('#promptInput'); input.value = ${JSON.stringify(label)}; input.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#composer').requestSubmit(); })()`);
    try { await wait(() => requests.length > count); }
    catch (error) { console.error('Send state:', await p.eval('document.body.innerText.slice(-5000)')); throw error; }
    await wait(() => p.eval('document.body.innerText.includes("Capture fixture acknowledged.") && !document.querySelector("#promptInput").disabled'));
    return requests.at(-1);
  }
  const first = await send(panel, articleCase ? 'Read the entire article' : 'Read the fixture thread');
  if (articleCase) {
    assert.match(first.browser_context.payload.pageContext.text, /LONG_ARTICLE_END/);
    assert.doesNotMatch(first.browser_context.payload.pageContext.text, /UNRELATED_NAVIGATION/);
    assert.ok(first.browser_context.payload.pageContext.text.length > 12000);
  } else {
    assert.match(first.browser_context.payload.pageContext.text, /COLLAPSED_OLDER_MESSAGE/);
    assert.match(first.browser_context.payload.pageContext.text, /LATEST_REPLY_BODY/);
  }
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_INBOX_LIST|UNSENT_DRAFT/);
  // Hermes Control is off in this journey, so the turn says control was not requested (not that it is unavailable).
  assert.equal(first.browser_control.availability, 'not_requested');
  assert.equal(await panel.eval('document.querySelector("#explicitSiteCaptureWrap").hidden'), true);
  const after = await panel.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(QA, articleCase ? 'article-after.png' : 'gmail-after.png'), Buffer.from(after.data, 'base64'));
  if (!articleCase) {
    assert.equal(await worker.eval('(async () => (await chrome.storage.local.get("hermesBrowserSettings")).hermesBrowserSettings.gmailCaptureEnabled === true)()'), true);
    const second = await send(panel, 'Read again without another capture click');
    if (second.browser_context.delivery === 'full') assert.match(second.browser_context.payload.pageContext.text, /LATEST_REPLY_BODY/);
  }
  const summary = { case: articleCase ? 'article' : 'gmail', capturedChars: first.browser_context.payload.pageContext.text.length, gmailStickyAcrossSends: !articleCase, articleEndIncluded: articleCase, controllerRequired: false, outgoingRequests: requests.length };
  await writeFile(path.join(QA, articleCase ? 'article-evidence.json' : 'gmail-evidence.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Screenshots: ${QA}`);
} catch (error) {
  console.error('Chrome diagnostics:', chromeError.slice(-1800));
  console.error('Page diagnostics:', JSON.stringify(clients.flatMap(c => c.events.filter(e => e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded' || e.method === 'Runtime.consoleAPICalled').slice(-8)), null, 2).slice(-8000));
  throw error;
} finally {
  for (const c of clients) c.close();
  killProcessTree(chrome);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
