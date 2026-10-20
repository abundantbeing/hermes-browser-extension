// Real unpacked extension UI, deterministic local REST/SSE and Dashboard WS.
// No personal browser profile, real credentials, or model-provider requests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { launchChrome } from './e2e-chrome-env.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const QA = path.join(ROOT, '.hermes', 'qa', 'live-session-recovery');
const PROFILE = path.join(QA, `profile-${process.pid}`);
const KEY = 'live-session-qa-not-a-secret';
const EXT = createHash('sha256').update(Buffer.from(DIST, process.platform === 'win32' ? 'utf16le' : 'utf8')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, n => String.fromCharCode(97 + parseInt(n, 16)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check, label, timeout = 30000) {
  const until = Date.now() + timeout;
  let error;
  while (Date.now() < until) {
    try { const result = await check(); if (result) return result; } catch (e) { error = e; }
    await delay(100);
  }
  throw error || new Error(`Timed out: ${label}`);
}
class Cdp {
  constructor(url) { this.url = url; this.pending = new Map(); this.id = 0; }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.onmessage = event => {
      const data = JSON.parse(String(event.data));
      const call = this.pending.get(data.id);
      if (!call) return;
      this.pending.delete(data.id);
      clearTimeout(call.timer);
      if (data.error) call.reject(new Error(data.error.message)); else call.resolve(data.result);
    };
    await new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = reject; });
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => reject(new Error(`CDP timeout ${method}`)), 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { this.socket?.close(); }
}
async function fetchJson(url, options) { const res = await fetch(url, options); assert.ok(res.ok, `${url}: ${res.status}`); return res.json(); }
const sessions = new Map();
const history = new Map();
const sockets = new Set();
const requests = [];
let stream = null;
let runningExternal = true;
let externalText = 'Already working before Browser opened.';
const externalCorrections = [];
const externalId = 'qa-external-live';
const session = (id, title = id) => ({ id, title, source: 'hermes_browser_extension', profile: 'default', model: 'qa/test-model', provider: 'qa', message_count: history.get(id)?.length || 1 });
sessions.set(externalId, session(externalId, 'External live session'));
history.set(externalId, [{ role: 'user', text: 'Follow this external run' }, { role: 'tool', name: 'read_file', context: 'src/live.js', args: { path: 'src/live.js' } }]);
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); res.end(JSON.stringify(body)); }
function frame(socket, data) {
  const body = Buffer.from(JSON.stringify(data));
  const header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = 0x81;
  if (body.length < 126) header[1] = body.length; else { header[1] = 126; header.writeUInt16BE(body.length, 2); }
  socket.write(Buffer.concat([header, body]));
}
function push(type, payload, id = 'live-external') { for (const socket of sockets) frame(socket, { jsonrpc: '2.0', method: 'event', params: { type, session_id: id, payload } }); }
function rpc(method, params) {
  requests.push({ method, params });
  const stored = params.session_id === 'live-external' ? externalId : params.session_id;
  if (method === 'session.active_list') return { sessions: [{ id: 'live-external', session_key: externalId, status: runningExternal ? 'streaming' : 'idle' }] };
  if (method === 'session.list') return { sessions: [...sessions.values()] };
  if (method === 'session.resume' || method === 'session.activate') return { session_id: stored === externalId ? 'live-external' : stored, session_key: stored, resumed: stored, info: { profile_name: 'default' }, messages: history.get(stored) || [], running: stored === externalId && runningExternal, inflight: stored === externalId && runningExternal ? { assistant: externalText, user: 'Follow this external run', streaming: true, corrections: externalCorrections } : null };
  if (method === 'session.status') return { output: `Hermes TUI Status\nModel: qa/test-model (qa)\nAgent Running: ${stored === externalId && runningExternal ? 'Yes' : 'No'}` };
  if (method === 'session.history') return { messages: history.get(stored) || [] };
  if (method === 'session.create') { const id = `qa-draft-${Date.now()}`; sessions.set(id, session(id)); return { session_id: id, session_key: id, info: { profile_name: 'default' } }; }
  if (method === 'profiles.list') return { profiles: [] };
  if (method === 'session.steer') return { status: 'queued' };
  if (method === 'session.interrupt') { runningExternal = false; return { status: 'accepted' }; }
  if (method === 'prompt.submit') {
    setTimeout(() => { history.set(externalId, [...history.get(externalId), {role:'assistant',text:'Queued follow-up completed.'}]); push('message.complete', {text:'Queued follow-up completed.'}); }, 80);
    return { status: 'accepted' };
  }
  return {};
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ method: req.method, path: url.pathname });
  if (req.method === 'OPTIONS') return json(res, 200, {});
  if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<script>window.__HERMES_SESSION_TOKEN__ = "qa-dashboard-not-a-secret";</script>'); }
  if (url.pathname === '/api/status') return json(res, 200, { version: 'qa', gateway_mode: 'single', profiles: [] });
  if (url.pathname === '/api/desktop/dashboard-candidates') return json(res, 200, { candidates: [server.address().port] });
  if (url.pathname.endsWith('/health')) return json(res, 200, { status: 'ok', platform: 'hermes-agent' });
  if (url.pathname === '/v1/capabilities') return json(res, 200, { features: { session_resources: true, session_chat: true, session_chat_streaming: true, session_model_routing: true }, endpoints: { sessions: { method: 'GET', path: '/api/sessions' }, session_chat: { method: 'POST', path: '/api/sessions/{session_id}/chat' }, session_chat_stream: { method: 'POST', path: '/api/sessions/{session_id}/chat/stream' }, session_model: { method: 'POST', path: '/api/sessions/{session_id}/model' } } });
  if (url.pathname === '/v1/models') return json(res, 200, { data: [{ id: 'qa/test-model', provider: 'qa', context_length: 32000 }] });
  if (url.pathname === '/api/model/options') return json(res, 200, { providers: [{ slug: 'qa', name: 'QA', authenticated: true, models: [{ id: 'qa/test-model', label: 'QA model' }] }] });
  if (url.pathname === '/api/sessions' && req.method === 'GET') return json(res, 200, { data: [...sessions.values()], total: sessions.size });
  if (url.pathname === '/api/sessions' && req.method === 'POST') { const row = session(body.id, body.title); sessions.set(row.id, row); return json(res, 201, row); }
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(.*)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (match[2] === '/messages') return json(res, 200, { data: history.get(id) || [] });
    if (match[2] === '/model') return json(res, 200, { session: sessions.get(id), model: 'qa/test-model', provider: 'qa', runtime: { model: 'qa/test-model', provider: 'qa', model_lock: 'enforced' } });
    if (match[2] === '/chat/stream') {
      sessions.set(id, session(id, 'Browser running session'));
      history.set(id, [{ role: 'user', content: 'Run the navigation QA' }]);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      stream = { id, res, emit: (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`) };
      stream.emit('run.started', { run_id: 'qa-run' });
      stream.emit('assistant.delta', { delta: 'Checking while you switch sessions. ' });
      stream.emit('tool.started', { tool_name: 'terminal', preview: 'npm test', status: 'running' });
      return;
    }
    return json(res, 200, sessions.get(id) || session(id));
  }
  if (url.pathname === '/v1/skills' || url.pathname === '/v1/toolsets') return json(res, 200, { data: [] });
  return json(res, 404, { error: { message: 'Optional QA route unavailable' } });
});
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => sockets.delete(socket));
  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 15;
      let size = buffer[1] & 127; let offset = 2;
      if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
      if (size === 127) { if (buffer.length < 10) return; size = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const masked = buffer[1] & 128;
      if (buffer.length < offset + (masked ? 4 : 0) + size) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null; offset += masked ? 4 : 0;
      const body = Buffer.from(buffer.subarray(offset, offset + size)); buffer = buffer.subarray(offset + size);
      if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
      if (opcode === 8) { socket.end(); return; }
      if (opcode !== 1) continue;
      const msg = JSON.parse(body.toString());
      frame(socket, { jsonrpc: '2.0', id: msg.id, result: rpc(msg.method, msg.params || {}) });
    }
  });
  frame(socket, { jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } });
});
await mkdir(PROFILE, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let chrome, setup, panel;
const proof = {};
try {
  assert.ok(existsSync(process.env.CHROME_PATH), 'Set CHROME_PATH to the isolated Chrome-for-Testing executable.');
  chrome = launchChrome(process.env.CHROME_PATH, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`, `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, `chrome-extension://${EXT}/request-permissions.html`], { stdio: 'ignore', windowsHide: true });
  const portFile = path.join(PROFILE, 'DevToolsActivePort');
  await wait(() => existsSync(portFile), 'CFT debugging port');
  const port = (await readFile(portFile, 'utf8')).split('\n')[0];
  const cdpBase = `http://127.0.0.1:${port}`;
  const worker = await wait(async () => (await fetchJson(`${cdpBase}/json/list`)).find(row => row.type === 'service_worker' && row.url.startsWith(`chrome-extension://${EXT}/`)), 'extension worker');
  setup = new Cdp(worker.webSocketDebuggerUrl); await setup.connect();
  await wait(() => setup.evaluate(`Boolean(globalThis.chrome?.storage?.local)`), 'extension worker initialized');
  await setup.evaluate(`chrome.storage.local.set({ hermesBrowserSettings: ${JSON.stringify({ connectionSchemaVersion: 1, connectionMode: 'local', connectionTransport: 'local-api', gatewayMode: 'local-api', gatewayUrl: base, apiKey: KEY, sessionId: 'qa-browser', model: 'qa/test-model', colorMode: 'dark', appearanceTheme: 'mono', autoNameSessions: false })}, hermesBrowserIntroSeen: true, hermesDesktopRosterUrl: {url: ${JSON.stringify(base)}, cachedAt: Date.now()} })`);
  const page = await fetchJson(`${cdpBase}/json/new?${encodeURIComponent(`chrome-extension://${EXT}/sidepanel.html`)}`, { method: 'PUT' });
  panel = new Cdp(page.webSocketDebuggerUrl); await panel.connect();
  await panel.call('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 1, mobile: false });
  await wait(() => panel.evaluate(`document.querySelector('#startupScreen')?.hidden && !document.querySelector('#promptInput')?.disabled`), 'panel startup');
  await panel.evaluate(`document.querySelector('#promptInput').value='Run the navigation QA'; document.querySelector('#promptInput').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#inlineSendButton').click();`);
  await wait(() => stream, 'REST/SSE run starts');
  await wait(() => panel.evaluate(`document.querySelector('#messages')?.innerText.includes('terminal')`), 'initial tool call');
  const origin = stream.id;
  await panel.evaluate(`document.querySelector('#newSessionButton').click()`);
  await wait(() => panel.evaluate(`!document.querySelector('#messages')?.innerText.includes('terminal')`), 'new session clears original run');
  stream.emit('assistant.delta', { delta: 'This chunk arrived while away. ' });
  await panel.evaluate(`document.querySelector('#sessionMenuButton').click()`);
  await wait(() => panel.evaluate(`document.querySelector('.session-option-row[data-session-id="${origin}"]')?.dataset.liveState === 'running'`), 'original session stays running in picker');
  proof.row = await panel.evaluate(`(() => { const row=document.querySelector('.session-option-row[data-session-id="${origin}"]');const style=getComputedStyle(row);return {state:row.dataset.liveState, background:style.backgroundColor, border:style.borderLeftWidth, label:row.innerText};})()`);
  assert.notEqual(proof.row.background, 'rgba(0, 0, 0, 0)');
  const shot = async name => { const image = await panel.call('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(QA, name), Buffer.from(image.data, 'base64')); };
  await shot('running-session-picker.png');
  proof.layouts = [];
  for (const width of [320, 430]) {
    await panel.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const theme of ['mono', 'nous']) for (const mode of ['dark', 'light']) {
      await panel.evaluate(`document.documentElement.dataset.hermesTheme=${JSON.stringify(theme)};document.documentElement.dataset.hermesMode=${JSON.stringify(mode)}`);
      await delay(80);
      const geometry = await panel.evaluate(`(() => {const row=document.querySelector('.session-option-row[data-session-id="${origin}"]');const meta=row.querySelector('.session-option-meta');const r=row.getBoundingClientRect();const m=meta.getBoundingClientRect();return {rowWidth:r.width,metaWidth:m.width,metaVisible:getComputedStyle(meta).visibility,clipped:meta.scrollWidth>meta.clientWidth,inside:m.left>=r.left && m.right<=r.right+1,background:getComputedStyle(row).backgroundColor};})()`);
      assert.ok(geometry.rowWidth > 0 && geometry.metaWidth > 0 && geometry.metaVisible === 'visible', 'running row and label must paint');
      assert.equal(geometry.clipped, false, 'Running label must not ellipsize');
      assert.equal(geometry.inside, true, 'Running label must stay inside its row');
      proof.layouts.push({ width, theme, mode, ...geometry });
    }
  }
  await panel.call('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 1, mobile: false });
  await panel.evaluate(`document.documentElement.dataset.hermesTheme='nous';document.documentElement.dataset.hermesMode='dark'`);
  await shot('running-session-picker-nous.png');
  await panel.evaluate(`document.documentElement.dataset.hermesTheme='mono';document.documentElement.dataset.hermesMode='dark'`);
  await panel.evaluate(`document.querySelector('.session-option[data-session-id="${origin}"]').click()`);
  await wait(() => panel.evaluate(`document.querySelector('#messages')?.innerText.includes('terminal') && document.querySelector('#messages')?.innerText.includes('while away')`), 'return restores accumulated text and active tool');
  await shot('returned-live-tools.png');
  const final = 'Checking while you switch sessions. This chunk arrived while away. Completed safely.';
  history.set(origin, [...history.get(origin), { role: 'assistant', content: '', tool_calls: [{ id: 'tool1', function: { name: 'terminal', arguments: '{"command":"npm test"}' } }] }, { role: 'tool', tool_call_id: 'tool1', tool_name: 'terminal', content: 'QA output' }, { role: 'assistant', content: final }]);
  stream.emit('assistant.completed', { content: final }); stream.emit('run.completed', { status: 'completed', run_id: 'qa-run', final_response: final }); stream.res.end();
  await wait(() => panel.evaluate(`document.querySelector('#messages')?.innerText.includes('Completed safely') && !document.body.classList.contains('turn-running')`), 'original completes');
  await panel.evaluate(`document.querySelector('#newSessionButton').click()`);
  await panel.evaluate(`document.querySelector('#sessionMenuButton').click()`);
  await wait(() => panel.evaluate(`document.querySelector('.session-option[data-session-id="${origin}"]')`), 'completed session listed');
  await panel.evaluate(`document.querySelector('.session-option[data-session-id="${origin}"]').click()`);
  await wait(() => panel.evaluate(`document.querySelector('.tool-call-entry')?.textContent.includes('terminal')`), 'completed tool history survives reopen');
  proof.local = { newSessionWhileRunning: true, originalRowStillRunning: true, returnedTextAndTools: true, completedHistoryTools: true };
  await panel.evaluate(`document.querySelector('.tool-call-group').open=true;document.querySelector('.tool-call-entry').open=true`);
  await shot('completed-tool-history.png');
  await panel.evaluate(`document.querySelector('#sessionMenuButton').click()`);
  await wait(() => panel.evaluate(`document.querySelector('.session-option-row[data-session-id="${externalId}"]')?.dataset.liveState === 'running'`), 'external session tracked by active_list');
  await panel.evaluate(`document.querySelector('.session-option[data-session-id="${externalId}"]').click()`);
  await wait(() => panel.evaluate(`document.querySelector('#messages')?.innerText.includes('Already working before Browser opened')`), 'external inflight snapshot');
  externalText += ' New live text.';
  push('message.delta', { text: ' New live text.' });
  push('tool.start', { name: 'web_search', context: 'Hermes live sessions' });
  await wait(() => panel.evaluate(`document.querySelector('#messages')?.innerText.includes('New live text') && document.querySelector('#messages')?.innerText.includes('web_search')`), 'external text and tools follow live');
  await shot('external-live-session.png');
  assert.equal(await panel.evaluate(`document.body.classList.contains('turn-running')`), true, 'followed run owns busy composer state');
  for (let i=0; i<35; i++) {
    push('tool.start', {name:'terminal',context:`QA command ${i}`});
    push('tool.complete', {name:'terminal',result:'QA command completed'});
  }
  await wait(() => panel.evaluate(`document.querySelectorAll('.live-tool-work .tool-call-entry').length >= 35`), 'long activity list');
  await panel.evaluate(`document.querySelector('.live-tool-work > summary').click()`);
  assert.equal(await panel.evaluate(`document.querySelector('.live-tool-work').open`), true);
  await panel.evaluate(`document.querySelector('.live-tool-work .tool-call-entry > summary').click()`);
  proof.toolScrollbarSpacing = [];
  for (const width of [320, 430]) {
    await panel.call('Emulation.setDeviceMetricsOverride', {width,height:900,deviceScaleFactor:1,mobile:false});
    for (const theme of ['mono','nous']) for (const mode of ['dark','light']) {
      await panel.evaluate(`document.documentElement.dataset.hermesTheme=${JSON.stringify(theme)};document.documentElement.dataset.hermesMode=${JSON.stringify(mode)}`);
      const geometry = await panel.evaluate(`(() => {const list=document.querySelector('.live-tool-work .tool-call-list');const viewportRight=list.getBoundingClientRect().left+list.clientWidth;const labels=[...list.querySelectorAll('.tool-call-status')];return {gap:Math.min(...labels.map(label=>viewportRight-label.getBoundingClientRect().right)),clipped:labels.some(label=>label.scrollWidth>label.clientWidth),scrollbarWidth:getComputedStyle(list,'::-webkit-scrollbar').width};})()`);
      assert.ok(geometry.gap>=10,'status labels need breathing room before the scrollbar');
      assert.equal(geometry.clipped,false,'tool completion labels must remain readable');
      assert.equal(geometry.scrollbarWidth,'8px','keep the existing branded scrollbar');
      proof.toolScrollbarSpacing.push({width,theme,mode,...geometry});
    }
  }
  await panel.call('Emulation.setDeviceMetricsOverride',{width:430,height:900,deviceScaleFactor:1,mobile:false});
  await panel.evaluate(`document.documentElement.dataset.hermesTheme='mono';document.documentElement.dataset.hermesMode='dark'`);
  await shot('live-tools-expanded.png');
  await panel.evaluate(`window.__qaGroup=document.querySelector('.live-tool-work');window.__qaList=window.__qaGroup.querySelector('.tool-call-list');window.__qaEntry=window.__qaList.querySelector('.tool-call-entry');window.__qaLive=document.querySelector('.live-thinking-slot')?.closest('.message-row');window.__qaList.scrollTop=120;window.__qaScroll=window.__qaList.scrollTop`);
  history.set(externalId,[...history.get(externalId), {role:'assistant',text:'Snapshot updated while reading tools.'}]);
  externalCorrections.push('Use the verified source instead.');
  const resumeCount = requests.filter(row=>row.method==='session.activate').length;
  push('tool.start',{name:'read_file',context:'src/another-file.js'});
  await delay(6500);
  assert.ok(requests.filter(row=>row.method==='session.activate').length >= resumeCount+2, 'exercise multiple real roster/snapshot polls');
  const stayedOpen = await panel.evaluate(`({sameLiveRow:window.__qaLive===document.querySelector('.live-thinking-slot')?.closest('.message-row'),liveEntering:window.__qaLive.classList.contains('is-entering'),sameGroup:window.__qaGroup===document.querySelector('.live-tool-work'),sameList:window.__qaList===document.querySelector('.live-tool-work .tool-call-list'),sameEntry:window.__qaEntry===window.__qaList.querySelector('.tool-call-entry'),open:window.__qaGroup.open,entryOpen:window.__qaEntry.open,scroll:window.__qaList.scrollTop,before:window.__qaScroll,thumbWidth:getComputedStyle(window.__qaList,'::-webkit-scrollbar').width})`);
  assert.equal(stayedOpen.sameGroup && stayedOpen.sameList && stayedOpen.sameEntry && stayedOpen.open && stayedOpen.entryOpen, true, 'live refresh must not replace or close disclosure nodes');
  assert.equal(stayedOpen.sameLiveRow,true,'the live assistant card must not be recreated on history polls');
  assert.equal(stayedOpen.liveEntering,false,'history polls must not restart the entry fade');
  assert.equal(await panel.evaluate(`document.querySelectorAll('.steer-sent').length===1 && document.querySelector('.steer-sent').textContent.includes('Use the verified source instead.')`),true,'a steer from another client appears once in the followed transcript');
  proof.externalSteerVisible = true;
  assert.equal(stayedOpen.scroll, stayedOpen.before, 'live updates and history rebuilds must preserve tool scroll');
  assert.equal(stayedOpen.thumbWidth,'8px','reuse branded scrollbar');
  proof.disclosurePersistence = stayedOpen;
  await shot('live-tools-scroll-preserved.png');
  await panel.evaluate(`document.querySelector('.live-tool-work > summary').click()`);
  assert.equal(await panel.evaluate(`document.querySelector('.message.assistant .thinking-indicator').getBoundingClientRect().height > 0`), true, 'collapse never hides thinking');
  const face = () => panel.evaluate(`document.querySelector('.message.assistant .thinking-glyph')?.textContent`);
  const firstFace = await face(); await delay(3400); const nextFace = await face();
  assert.ok(firstFace && nextFace && firstFace !== nextFace, 'classic kaomoji really rotates in the browser');
  const thinkingGeometry = await panel.evaluate(`(() => {const glyph=document.querySelector('.message.assistant .thinking-glyph');const words=glyph.parentElement.querySelector('.thinking-words');return {singleFace:glyph.children.length===0,inMessageCard:Boolean(glyph.closest('.message.assistant')),gap:words.getBoundingClientRect().left-glyph.getBoundingClientRect().right};})()`);
  assert.equal(thinkingGeometry.singleFace && thinkingGeometry.inMessageCard, true, 'one face stays inside the original thinking message card');
  assert.ok(thinkingGeometry.gap >= 0 && thinkingGeometry.gap <= 8, 'restore the tight original face/text spacing');
  proof.thinking = thinkingGeometry;
  await shot('restored-thinking-card.png');
  await panel.evaluate(`document.querySelector('#promptInput').value='Use the other file';document.querySelector('#promptInput').dispatchEvent(new Event('input',{bubbles:true}))`);
  await wait(() => panel.evaluate(`!document.querySelector('#steerButton').hidden && !document.querySelector('#queueButton').hidden && document.querySelector('#inlineSendButton').hidden`), 'followed busy draft exposes steer and queue, not send');
  await shot('followed-live-composer.png');
  await panel.evaluate(`document.querySelector('#steerButton').click()`);
  await wait(() => requests.find(row => row.method === 'session.steer'), 'follow steer RPC');
  assert.equal(requests.find(row => row.method === 'session.steer').params.session_id, 'live-external');
  await wait(() => panel.evaluate(`document.querySelector('#promptInput').value === ''`), 'accepted steer clears only its submitted draft');
  await panel.evaluate(`document.querySelector('#promptInput').value='Continue with the queued follow-up';document.querySelector('#promptInput').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#queueButton').click()`);
  await wait(() => panel.evaluate(`!document.querySelector('#queueNotice').hidden`), 'followed run accepts queue');
  assert.equal(requests.filter(row => row.method === 'prompt.submit' || row.method === 'session.interrupt').length, 0, 'passive following, expanding tools and queuing never start or interrupt a run');
  proof.followSubmittedOrInterrupted = false;
  proof.activity = { expandable: true, individualCalls: true, thinkingVisibleWhenCollapsed: true, classicFacesRotate: true };
  proof.composer = { externalBusy: true, steerAndQueueVisible: true, steerRuntimeId: 'live-external', queuedUntilCompletion: true };
  runningExternal = false;
  history.set(externalId, [...history.get(externalId), { role: 'assistant', text: externalText + ' Finished.' }]);
  // Deliberately omit message.complete: the status/snapshot poll must settle.
  await wait(() => panel.evaluate(`document.querySelector('#messages')?.innerText.includes('Finished.')`), 'missed completion reconciles through snapshot');
  proof.external = { rosterDetected: true, snapshotRestored: true, deltasAndTools: true, missedCompletionRecovered: true };
  await wait(async () => requests.find(row => row.method === 'prompt.submit') || await panel.evaluate(`!document.querySelector('#sessionOwnershipNotice').hidden`), 'queued turn proceeds through existing shared-session confirmation');
  if (await panel.evaluate(`!document.querySelector('#sessionOwnershipNotice').hidden`)) {
    await panel.evaluate(`document.querySelector('[data-session-ownership-action="continue"]').click()`);
  }
  await wait(() => requests.find(row => row.method === 'prompt.submit'), 'queued turn submits after external completion');
  assert.equal(requests.find(row => row.method === 'prompt.submit').params.session_id, 'live-external');
  await wait(() => panel.evaluate(`document.querySelector('#messages')?.innerText.includes('Queued follow-up completed.') && !document.body.classList.contains('turn-running')`), 'queued turn finishes and clears busy state');
  proof.composer.queueFlushedToSameRuntime = true;
  runningExternal = true;
  externalText = 'Stop verification run.';
  await panel.evaluate(`document.querySelector('#newSessionButton').click();document.querySelector('#sessionMenuButton').click()`);
  await wait(() => panel.evaluate(`document.querySelector('.session-option[data-session-id="${externalId}"]')`), 'stop test session listed');
  await panel.evaluate(`document.querySelector('.session-option[data-session-id="${externalId}"]').click()`);
  await wait(() => panel.evaluate(`document.body.classList.contains('turn-running') && !document.querySelector('#stopButton').hidden`), 'followed Stop available');
  await panel.evaluate(`document.querySelector('#stopButton').click()`);
  await wait(() => requests.find(row => row.method === 'session.interrupt'), 'follow stop RPC');
  assert.equal(requests.find(row => row.method === 'session.interrupt').params.session_id, 'live-external');
  proof.composer.stopRuntimeId = 'live-external';
  await writeFile(path.join(QA, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
} catch (error) {
  console.error(error.stack);
  if (panel) console.error(await panel.evaluate(`({text:document.body.innerText.slice(-8000),url:location.href})`).catch(() => null));
  process.exitCode = 1;
} finally {
  panel?.close(); setup?.close();
  if (chrome?.pid) spawnSync('taskkill.exe', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  stream?.res?.end();
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
