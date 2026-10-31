// Loaded-extension E2E for GPT-Live voice chat in the side panel.
//
// Real: the built extension, its side panel, WebRTC between the panel and a
// peer, the panel's microphone (a controlled WAV), dashboard discovery, the
// status probe, the session exchange and a full Hermes chat turn.
// Stand-ins: the OpenAI GPT-Live endpoint is played by a second Chrome page
// that answers the panel's SDP offer and speaks the vendor's event protocol
// over the `oai-events` data channel. Hermes is a deterministic local mock.
//
//   CHROME_PATH=<chrome for testing> npm run test:e2e:voice-live
//   VOICE_QA_DIR=<dir> keeps screenshots and evidence (default: OS temp dir)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launchChrome } from './e2e-chrome-env.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const QA = path.resolve(process.env.VOICE_QA_DIR || path.join(os.tmpdir(), 'hbe-voice-live-qa'));
const EXT = path.resolve(process.env.VOICE_QA_EXTENSION || path.join(ROOT, 'dist'));
const CHROME = process.env.CHROME_PATH || '';
const PROFILE = path.join(QA, 'profile');
const KEY = 'voice-live-qa-local-not-a-secret';
const DASH_TOKEN = 'voice-live-qa-dashboard-token';
const SESSION_ID = 'voice-live-qa';
const QUESTION = "What's the weather like on Mars today?";
const REPLY_1 = 'Mars is cold today. ';
const REPLY_2 = 'The high near the equator is about minus twenty degrees.';
const REPLY = `${REPLY_1}${REPLY_2}`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw last || new Error(`Timed out: ${label}`);
}
class Cdp {
  constructor(url) { this.url = url; this.nextId = 0; this.pending = new Map(); this.scripts = new Set(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        // Every script the page parses, including on-demand module imports.
        if (message.method === 'Debugger.scriptParsed' && message.params?.url) this.scripts.add(message.params.url);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
    };
    await new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = reject; });
  }
  call(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  close() { this.socket?.close(); }
}
async function fetchJson(url, options) { const r = await fetch(url, options); if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`); return r.json(); }
function extensionId(dir) {
  const hex = createHash('sha256').update(Buffer.from(dir, process.platform === 'win32' ? 'utf16le' : 'utf8')).digest('hex').slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (n) => String.fromCharCode(97 + Number.parseInt(n, 16)));
}
async function wavFixture() {
  const rate = 48000;
  const samples = rate * 12;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    const t = index / rate;
    const envelope = 0.06 + 0.16 * Math.pow(0.5 + 0.5 * Math.sin(t * 6), 2);
    wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * (190 * t + 6 * Math.sin(t * 3))) * envelope * 32767), 44 + index * 2);
  }
  const file = path.join(QA, 'controlled-voice.wav');
  await writeFile(file, wav);
  return file;
}

// ---- the fake GPT-Live peer (runs in a normal localhost page) -------------------
const VENDOR_PAGE = `<!doctype html><meta charset="utf-8"><title>GPT-Live stand-in</title><script>
window.vendor = {
  log: [], open: false, micTracks: 0,
  async answer(offerSdp) {
    this.open = false;
    this.channel = null;
    const pc = new RTCPeerConnection();
    this.pc = pc;
    const ctx = new AudioContext();
    await ctx.resume();
    const osc = ctx.createOscillator(); osc.frequency.value = 220;
    const gain = ctx.createGain(); gain.gain.value = 0;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest); osc.start();
    this.gain = gain;
    for (const track of dest.stream.getAudioTracks()) pc.addTrack(track, dest.stream);
    pc.ontrack = () => { this.micTracks += 1; };
    pc.ondatachannel = (event) => {
      this.channel = event.channel;
      this.label = event.channel.label;
      event.channel.onopen = () => { this.open = true; };
      event.channel.onmessage = (e) => this.log.push(JSON.parse(e.data));
      if (event.channel.readyState === 'open') this.open = true;
    };
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); });
      setTimeout(resolve, 4000);
    });
    return pc.localDescription.sdp;
  },
  send(event) { this.channel.send(JSON.stringify(event)); },
  speak(on) { this.gain.gain.value = on ? 0.7 : 0; },
};
</script>`;

let vendorClient = null;
async function servers() {
  const record = { gateway: [], dashboard: [], chat: [], offers: [], statusCalls: 0 };
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(JSON.stringify(body)); };
  const readBody = async (req) => { let raw = ''; for await (const chunk of req) raw += chunk; return raw ? JSON.parse(raw) : null; };

  const dashboard = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = req.method === 'POST' ? await readBody(req) : null;
    record.dashboard.push({ path: url.pathname, method: req.method, profile: url.searchParams.get('profile'), token: req.headers['x-hermes-session-token'] || '' });
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); res.end(); return; }
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><script>window.__HERMES_SESSION_TOKEN__ = "${DASH_TOKEN}";</script>`); return; }
    if (url.pathname === '/vendor') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(VENDOR_PAGE); return; }
    if (url.pathname === '/api/status') return json(res, 200, { version: 'voice-live-qa', gateway_mode: 'single', profiles: [] });
    if (url.pathname.startsWith('/api/audio/voice-live/')) {
      if (req.headers['x-hermes-session-token'] !== DASH_TOKEN) return json(res, 401, { detail: 'Unauthorized' });
      if (url.pathname === '/api/audio/voice-live/status') {
        record.statusCalls += 1;
        return json(res, 200, { ok: true, mode: 'gpt-live', available: true, reason: null, model: 'gpt-live-1', voice: 'marin' });
      }
      if (url.pathname === '/api/audio/voice-live/session' && req.method === 'POST') {
        record.offers.push({ sdp: body?.sdp || '', history: body?.history || null });
        assert.ok(String(body?.sdp || '').endsWith('\r\n'), 'the offer reaches the host byte-exact');
        const answer = await vendorClient.evaluate(`vendor.answer(${JSON.stringify(body.sdp)})`);
        return json(res, 200, { ok: true, session: { id: 'sess_voice_live_qa' }, transport: { type: 'webrtc', sdp: answer } });
      }
    }
    return json(res, 404, { detail: 'Not Found' });
  });
  await new Promise((resolve) => dashboard.listen(0, '127.0.0.1', resolve));
  const dashPort = dashboard.address().port;

  const gateway = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = req.method === 'POST' ? await readBody(req) : null;
    record.gateway.push({ path: url.pathname, method: req.method });
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); res.end(); return; }
    if (url.pathname === '/health' || url.pathname === '/v1/health') return json(res, 200, { status: 'ok', platform: 'hermes-agent', version: 'voice-live-qa' });
    if (url.pathname === '/v1/capabilities') {
      return json(res, 200, {
        object: 'hermes.api_server.capabilities',
        platform: 'hermes-agent',
        auth: { type: 'bearer', required: true },
        features: { models_api: true, session_resources: true, session_chat: true, session_chat_streaming: true, skills_api: true },
        endpoints: {
          health: { method: 'GET', path: '/health' },
          models: { method: 'GET', path: '/v1/models' },
          sessions: { method: 'GET', path: '/api/sessions' },
          session_create: { method: 'POST', path: '/api/sessions' },
          session_chat: { method: 'POST', path: '/api/sessions/{session_id}/chat' },
          session_chat_stream: { method: 'POST', path: '/api/sessions/{session_id}/chat/stream' },
          skills: { method: 'GET', path: '/v1/skills' },
        },
      });
    }
    if (url.pathname === '/api/desktop/dashboard-candidates') return json(res, 200, { candidates: [dashPort] });
    if (url.pathname === '/api/model/options') return json(res, 200, { providers: [{ slug: 'qa', name: 'Local QA', authenticated: true, models: [{ id: 'qa/voice', label: 'Voice QA', context_length: 32000 }] }] });
    if (url.pathname === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'qa/voice', provider: 'qa', context_length: 32000 }] });
    if (['/v1/skills', '/v1/toolsets'].includes(url.pathname)) return json(res, 200, { object: 'list', data: [] });
    if (/^\/api\/sessions\/[^/]+\/chat\/stream$/.test(url.pathname) && req.method === 'POST') {
      record.chat.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('run.started', { run_id: 'run-voice-live' });
      send('tool.started', { tool_name: 'web_search', tool_call_id: 'call-1', status: 'running', preview: 'Mars weather today' });
      await delay(400);
      send('tool.finished', { tool_name: 'web_search', tool_call_id: 'call-1', status: 'completed' });
      send('assistant.delta', { delta: REPLY_1 });
      await delay(300);
      send('assistant.delta', { delta: REPLY_2 });
      send('assistant.completed', { content: REPLY });
      send('run.completed', { run_id: 'run-voice-live', status: 'completed', final_response: REPLY });
      res.end();
      return;
    }
    if (url.pathname === '/api/sessions') return json(res, 200, req.method === 'POST' ? { id: body?.session_id || body?.id || SESSION_ID, session_id: body?.session_id || body?.id || SESSION_ID, title: 'Voice live QA', source: 'hermes_browser_extension' } : { data: [], total: 0, has_more: false });
    if (url.pathname.startsWith('/api/sessions/')) return json(res, 200, { id: SESSION_ID, session_id: SESSION_ID, title: 'Voice live QA', source: 'hermes_browser_extension', messages: [] });
    return json(res, 404, { error: 'No fixture for this route' });
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  return {
    record,
    gatewayBase: `http://127.0.0.1:${gateway.address().port}`,
    dashboardBase: `http://127.0.0.1:${dashPort}`,
    close: () => Promise.all([new Promise((r) => gateway.close(r)), new Promise((r) => dashboard.close(r))]),
  };
}

async function openPage(base, url, width = 420) {
  const target = await fetchJson(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const client = new Cdp(target.webSocketDebuggerUrl);
  await client.connect();
  await client.call('Runtime.enable'); await client.call('Page.enable');
  await client.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  return client;
}
async function screenshot(client, name, selector = '') {
  const params = { format: 'png', captureBeyondViewport: false };
  if (selector) {
    params.clip = await client.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 60), width: Math.min(innerWidth, r.width + 16), height: Math.min(innerHeight - r.y + 60, r.height + 120), scale: 2 }; })()`);
  }
  const result = await client.call('Page.captureScreenshot', params);
  const file = path.join(QA, `voice-live-${name}.png`);
  await writeFile(file, Buffer.from(result.data, 'base64'));
  return file;
}
async function chooseTheme(panel, worker, theme, mode) {
  await panel.evaluate(`(() => { document.querySelector('[data-theme="${theme}"]').click(); document.querySelector('[data-color-mode="${mode}"]').click(); })()`);
  await waitFor(() => worker.evaluate(`chrome.storage.local.get('hermesBrowserSettings').then(({hermesBrowserSettings:s}) => s.appearanceTheme === ${JSON.stringify(theme)} && s.colorMode === ${JSON.stringify(mode)})`), 'durable theme selection');
  await waitFor(() => panel.evaluate(`document.documentElement.dataset.hermesTheme === ${JSON.stringify(theme)} && document.documentElement.dataset.hermesMode === ${JSON.stringify(mode)}`), 'painted theme selection');
  await delay(200);
}
async function measurePerf(client, seconds = 3) {
  const metrics = async () => Object.fromEntries((await client.call('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
  await client.evaluate(`(() => { const s = window.__perf = { intervals: [], last: 0, running: true }; const tick = (t) => { if (s.last) s.intervals.push(t - s.last); s.last = t; if (s.running) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`);
  const before = await metrics();
  await delay(seconds * 1000);
  const after = await metrics();
  const intervals = await client.evaluate('(() => { window.__perf.running = false; return window.__perf.intervals; })()');
  const elapsed = after.Timestamp - before.Timestamp;
  const round = (value) => Math.round(value * 10) / 10;
  return {
    fps: round(intervals.length / elapsed),
    lateFrames: intervals.filter((value) => value > 25).length,
    mainThreadMsPerSecond: round(((after.TaskDuration - before.TaskDuration) * 1000) / elapsed),
    scriptMsPerSecond: round(((after.ScriptDuration - before.ScriptDuration) * 1000) / elapsed),
    layoutsPerSecond: round((after.LayoutCount - before.LayoutCount) / elapsed),
  };
}

const PANEL_PROBE = `(() => {
  const button = document.querySelector('#liveVoiceButton');
  const meter = document.querySelector('#voiceActivity');
  const canvas = document.querySelector('.voice-wingbeat');
  const rect = button?.getBoundingClientRect();
  const hit = rect && rect.width ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) : null;
  return {
    buttonHidden: button?.hidden ?? null,
    buttonDisabled: button?.disabled ?? null,
    buttonLive: button?.classList.contains('live') ?? null,
    buttonPressed: button?.getAttribute('aria-pressed'),
    buttonTitle: button?.title || '',
    buttonClickable: hit ? (hit === button || button.contains(hit)) : null,
    buttonRect: rect ? { right: Math.round(innerWidth - rect.right), width: Math.round(rect.width) } : null,
    micDisabled: document.querySelector('#voiceButton')?.disabled ?? null,
    meterHidden: meter?.hidden ?? null,
    meterLive: meter?.classList.contains('live') ?? null,
    label: document.querySelector('#voiceActivityLabel')?.textContent || '',
    glow: canvas?.dataset.voiceState || null,
    status: [document.querySelector('#activeTitle')?.textContent || '', document.querySelector('#activeUrl')?.textContent || ''],
    tracks: (window.__liveQa?.streams || []).flatMap((stream) => stream.getTracks().map((track) => track.readyState)),
    micRequests: window.__liveQa?.requests ?? 0,
    transcript: [...document.querySelectorAll('.message')].map((node) => node.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(-4),
  };
})()`;

await mkdir(QA, { recursive: true });
assert.ok(CHROME && existsSync(CHROME), 'Set CHROME_PATH to a Chrome for Testing or Chromium binary');
assert.ok(existsSync(path.join(EXT, 'manifest.json')), `Build the extension first (missing ${EXT})`);
await rm(PROFILE, { recursive: true, force: true });
const wav = await wavFixture();
const mock = await servers();
let chromeErrors = '';
const chrome = launchChrome(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`,
  // The peer speaks through a WebRTC track; launchChrome mutes the browser's own output.
  '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns',
  `chrome-extension://${extensionId(EXT)}/request-permissions.html`,
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
chrome.stderr.on('data', (chunk) => { chromeErrors = (chromeErrors + chunk.toString()).slice(-16000); });
const clients = [];
const evidence = {
  extension: EXT,
  boundary: 'GPT-Live is played by a second Chrome peer over real WebRTC; Hermes is a deterministic local mock; the microphone is a controlled WAV',
  screenshots: [],
};
try {
  const portFile = path.join(PROFILE, 'DevToolsActivePort');
  await waitFor(() => existsSync(portFile), 'Chrome debugging port');
  const [port] = (await readFile(portFile, 'utf8')).split('\n');
  const base = `http://127.0.0.1:${Number(port)}`;
  const workerTarget = await waitFor(async () => (await fetchJson(`${base}/json/list`)).find((target) => target.type === 'service_worker' && target.url.endsWith('/background.js')), 'real extension worker');
  const id = new URL(workerTarget.url).hostname;
  assert.equal(id, extensionId(EXT));
  const worker = new Cdp(workerTarget.webSocketDebuggerUrl); clients.push(worker); await worker.connect();
  await worker.call('Runtime.enable');
  await waitFor(() => worker.evaluate('Boolean(globalThis.chrome?.runtime?.getManifest)'), 'extension worker API');
  await worker.evaluate(`chrome.storage.local.set({hermesBrowserIntroSeen:true, hermesBrowserSettings:${JSON.stringify({ connectionSchemaVersion: 1, connectionMode: 'local', connectionTransport: 'local-api', gatewayMode: 'local-api', gatewayUrl: mock.gatewayBase, apiKey: KEY, tokenSource: 'e2e', sessionId: SESSION_ID, sessionStartMode: 'fresh', model: 'qa/voice', appearanceTheme: 'nous', colorMode: 'dark' })}})`);

  vendorClient = await openPage(base, `${mock.dashboardBase}/vendor`, 600); clients.push(vendorClient);
  await waitFor(() => vendorClient.evaluate('Boolean(window.vendor)'), 'GPT-Live stand-in page');

  const panel = await openPage(base, `chrome-extension://${id}/sidepanel.html`); clients.push(panel);
  await panel.call('Debugger.enable');
  const voiceModuleParsed = () => [...panel.scripts].some((url) => url.endsWith('/lib/voice-live.mjs'));
  await waitFor(() => panel.evaluate(`document.querySelector('#startupScreen')?.hidden && !document.querySelector('#promptInput')?.disabled`), 'panel ready');
  await panel.evaluate(`(() => { window.__liveQa = { requests: 0, streams: [] }; const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async (...args) => { window.__liveQa.requests++; const stream = await capture(...args); window.__liveQa.streams.push(stream); return stream; }; })()`);
  console.log('[voice-live-qa] real side panel ready');

  // 1. Offered only because the profile selected GPT-Live; nothing loaded yet.
  await waitFor(() => panel.evaluate(`document.querySelector('#liveVoiceButton')?.hidden === false`), 'live voice button offered', 30000);
  evidence.offered = await panel.evaluate(PANEL_PROBE);
  assert.equal(evidence.offered.buttonDisabled, false);
  assert.equal(evidence.offered.buttonTitle, 'Start live voice chat (GPT-Live)');
  assert.equal(evidence.offered.buttonClickable, true, 'nothing covers the live voice button');
  assert.ok([...panel.scripts].some((url) => url.endsWith('/sidepanel.js')), 'script tracking sees the panel itself');
  assert.equal(voiceModuleParsed(), false, 'the voice module has not loaded before first use');
  assert.equal(evidence.offered.micRequests, 0, 'no microphone before the user asks');
  const statusProbe = mock.record.dashboard.find((entry) => entry.path === '/api/audio/voice-live/status');
  assert.equal(statusProbe?.token, DASH_TOKEN, 'the status probe uses the dashboard session token');
  await panel.call('Performance.enable');
  evidence.perf = { offeredIdle: await measurePerf(panel) };
  assert.equal(mock.record.statusCalls, 1, 'one status probe, no polling while idle');
  evidence.screenshots.push(await screenshot(panel, 'offered-nous-dark'));
  evidence.screenshots.push(await screenshot(panel, 'offered-nous-dark-composer', '#composerDropZone'));
  console.log('[voice-live-qa] button offered', JSON.stringify(evidence.perf.offeredIdle));

  // 2. Start: WebRTC offer -> host -> answer; the data channel opens.
  await panel.evaluate(`document.querySelector('#liveVoiceButton').click()`);
  await waitFor(() => vendorClient.evaluate('vendor.open'), 'oai-events data channel open', 30000);
  assert.equal(await vendorClient.evaluate('vendor.label'), 'oai-events');
  await waitFor(() => vendorClient.evaluate('vendor.micTracks >= 1'), 'the panel microphone reaches the voice');
  assert.equal(mock.record.offers.length, 1, 'one session per start');
  assert.ok(mock.record.offers[0].sdp.includes('m=audio') && mock.record.offers[0].sdp.includes('m=application'), 'audio plus the event channel are negotiated');
  await vendorClient.evaluate(`vendor.send({ type: 'session.started', session: { id: 'sess_voice_live_qa' } })`);
  await waitFor(() => panel.evaluate(`document.querySelector('#voiceActivityLabel')?.textContent === 'Live voice · Listening'`), 'listening state');
  evidence.listening = await panel.evaluate(PANEL_PROBE);
  assert.equal(evidence.listening.buttonLive, true);
  assert.equal(evidence.listening.buttonPressed, 'true');
  assert.equal(evidence.listening.buttonTitle, 'End live voice chat');
  assert.equal(evidence.listening.meterHidden, false);
  assert.equal(evidence.listening.meterLive, true);
  assert.equal(evidence.listening.micDisabled, true, 'dictation waits while live voice owns the microphone');
  assert.equal(voiceModuleParsed(), true, 'the voice module loads on first use');
  assert.equal(evidence.listening.micRequests, 1, 'exactly one microphone');
  assert.deepEqual(evidence.listening.tracks, ['live']);
  await delay(600);
  evidence.screenshots.push(await screenshot(panel, 'listening-nous-dark', '#composerDropZone'));
  console.log('[voice-live-qa] live: listening');

  // 3. The voice speaks: the panel hears it through WebRTC.
  await vendorClient.evaluate('vendor.speak(true)');
  await waitFor(() => panel.evaluate(`document.querySelector('#voiceActivityLabel')?.textContent === 'Live voice · Speaking'`), 'the panel hears the voice', 15000);
  evidence.perf.liveSpeaking = await measurePerf(panel);
  evidence.screenshots.push(await screenshot(panel, 'speaking-nous-dark', '#composerDropZone'));
  await vendorClient.evaluate('vendor.speak(false)');
  await waitFor(() => panel.evaluate(`document.querySelector('#voiceActivityLabel')?.textContent === 'Live voice · Listening'`), 'back to listening');
  console.log('[voice-live-qa] live: speaking', JSON.stringify(evidence.perf.liveSpeaking));

  // 4. A delegation becomes a real Hermes turn; the reply streams back to the voice.
  await vendorClient.evaluate(`(() => {
    vendor.send({ type: 'session.input_transcript.delta', delta: "What's the weather ", start_ms: 1000, end_ms: 1600 });
    vendor.send({ type: 'session.input_transcript.delta', delta: 'like on Mars today?', start_ms: 1600, end_ms: 2400 });
    vendor.send({ type: 'session.output_transcript.delta', delta: 'Let me check with Hermes.', start_ms: 2600, end_ms: 3400 });
    vendor.send({ type: 'session.delegation.created', delegation: { id: 'dlg_voice_live_qa', type: 'client', target: 'backend' } });
  })()`);
  await waitFor(() => mock.record.chat.length === 1, 'Hermes received the spoken request');
  await waitFor(() => panel.evaluate(`document.querySelector('#voiceActivityLabel')?.textContent === 'Live voice · Hermes is working'`), 'working state', 5000).catch(() => null);
  evidence.screenshots.push(await screenshot(panel, 'working-nous-dark', '#composerDropZone'));
  await waitFor(async () => (await vendorClient.evaluate('vendor.log')).filter((event) => event.type === 'session.commentary.append').length >= 2, 'the reply streams back to the voice', 20000);
  await waitFor(() => panel.evaluate(`document.querySelector('#voiceActivityLabel')?.textContent === 'Live voice · Listening'`), 'listening after the turn');
  const chat = mock.record.chat[0];
  const envelope = JSON.parse(chat.message);
  evidence.turn = { protocol: envelope.protocol, humanInput: envelope.human_input, systemTail: String(chat.system_message || '').slice(-420) };
  assert.equal(envelope.protocol, 'hermes.browser.turn.v2', 'a spoken request is a normal browser turn, page context included');
  assert.equal(envelope.human_input?.text, QUESTION, 'the turn carries what the user said');
  assert.match(chat.system_message, /\[Note: this message is a delegation from a live spoken conversation\./);
  assert.match(chat.system_message, /\[Recent spoken conversation, newest last:\nUser: What's the weather like on Mars today\?\nVoice assistant: Let me check with Hermes\.\]/);
  const vendorLog = await vendorClient.evaluate('vendor.log');
  evidence.voiceEvents = vendorLog;
  const thinking = vendorLog.filter((event) => event.type === 'session.thinking.append');
  const commentary = vendorLog.filter((event) => event.type === 'session.commentary.append');
  assert.ok(thinking.some((event) => /^Hermes is working: .+\. Not done yet\.$/.test(event.content) && event.delegation_id === 'dlg_voice_live_qa'), 'tool progress reaches the voice quietly');
  assert.ok(commentary.every((event) => event.delegation_id === 'dlg_voice_live_qa'), 'every reply chunk belongs to the delegation');
  assert.equal(commentary.map((event) => event.content.trim()).join(' '), REPLY, 'the whole reply is spoken, once, in order');
  assert.ok(commentary.length >= 2, 'the first sentence goes out before the turn ends');
  const afterTurn = await panel.evaluate(PANEL_PROBE);
  evidence.afterTurn = afterTurn;
  assert.ok(afterTurn.transcript.some((text) => text.includes(QUESTION)), 'the spoken request shows as a chat bubble');
  assert.ok(afterTurn.transcript.some((text) => text.includes('Mars is cold today.')), 'the reply shows in the chat');
  console.log('[voice-live-qa] delegation round trip ok');

  // 5. Light theme, live.
  await chooseTheme(panel, worker, 'nous', 'light');
  await delay(400);
  evidence.screenshots.push(await screenshot(panel, 'listening-nous-light', '#composerDropZone'));
  await chooseTheme(panel, worker, 'nous', 'dark');

  // 6. Saying "stop" ends the chat; the microphone is released.
  await vendorClient.evaluate(`vendor.send({ type: 'session.input_transcript.delta', delta: 'Stop.', start_ms: 9000, end_ms: 9400 })`);
  await waitFor(async () => (await vendorClient.evaluate('vendor.log')).some((event) => event.type === 'session.close'), 'graceful close requested', 8000);
  const ended = await panel.evaluate(PANEL_PROBE);
  assert.equal(ended.buttonLive, false);
  assert.equal(ended.meterHidden, true);
  assert.equal(ended.label === '' || !ended.meterLive, true);
  await vendorClient.evaluate(`vendor.send({ type: 'session.closed', reason: 'closed', usage: { seconds: 21 } })`);
  await waitFor(() => panel.evaluate(`(window.__liveQa.streams || []).every((stream) => stream.getTracks().every((track) => track.readyState === 'ended'))`), 'microphone released');
  evidence.ended = await panel.evaluate(PANEL_PROBE);
  assert.equal(evidence.ended.micDisabled, false, 'dictation is available again');
  assert.equal(evidence.ended.buttonHidden, false, 'live voice can start again');
  await delay(300);
  evidence.screenshots.push(await screenshot(panel, 'ended-nous-dark', '#composerDropZone'));
  evidence.perf.afterEnd = await measurePerf(panel);
  console.log('[voice-live-qa] ended by voice; mic released', JSON.stringify(evidence.perf.afterEnd));

  // 7. The button ends a session too.
  await panel.evaluate(`document.querySelector('#liveVoiceButton').click()`);
  await waitFor(() => mock.record.offers.length === 2, 'second session');
  await waitFor(() => vendorClient.evaluate('vendor.open'), 'second channel open', 30000);
  await vendorClient.evaluate(`vendor.send({ type: 'session.started', session: { id: 'sess_voice_live_qa_2' } })`);
  await waitFor(() => panel.evaluate(`document.querySelector('#liveVoiceButton')?.classList.contains('live')`), 'second session live');
  assert.ok(Array.isArray(mock.record.offers[1].history) && mock.record.offers[1].history.some((item) => item.role === 'assistant' && JSON.stringify(item).includes('Mars is cold today.')), 'a new live session is seeded with the chat so far');
  await panel.evaluate(`document.querySelector('#liveVoiceButton').click()`);
  await waitFor(async () => (await vendorClient.evaluate('vendor.log')).filter((event) => event.type === 'session.close').length >= 2, 'button close');
  assert.equal(await panel.evaluate(`document.querySelector('#liveVoiceButton').classList.contains('live')`), false);
  console.log('[voice-live-qa] ended by button');

  evidence.result = 'pass';
  console.log(`[voice-live-qa] PASS ${JSON.stringify({ perf: evidence.perf, screenshots: evidence.screenshots.length })}`);
} catch (error) {
  evidence.result = 'fail';
  evidence.error = String(error?.stack || error);
  evidence.chromeErrors = chromeErrors.slice(-4000);
  throw error;
} finally {
  await writeFile(path.join(QA, 'voice-live-evidence.json'), JSON.stringify(evidence, null, 2));
  for (const client of clients) client.close();
  chrome.kill();
  await mock.close();
}
