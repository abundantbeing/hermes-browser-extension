#!/usr/bin/env node
// Real unpacked-extension voice QA. Controlled WAV input and a local STT fixture
// exercise actual getUserMedia, MediaRecorder, stop, transcript insertion and paint.
// No paid inference, production test hooks, personal browser profiles or accounts.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { APPEARANCE_THEMES } from '../extension/lib/appearance-themes.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const QA = process.env.VOICE_QA_DIR || path.join(os.tmpdir(), 'hbe-voice-wingbeat-qa');
const BASELINE = process.env.VOICE_QA_BASELINE === '1';
// Perf-only runs measure frame pacing and main-thread cost, then stop. Point
// VOICE_QA_EXTENSION at any build (and VOICE_QA_LABEL at a name) to compare.
const PERF_ONLY = process.env.VOICE_QA_PERF_ONLY === '1';
const EXT = path.resolve(process.env.VOICE_QA_EXTENSION || (BASELINE ? path.join(QA, 'before/extension') : path.join(ROOT, 'dist')));
const PROFILE = path.join(QA, `profile-${process.pid}`);
// Chrome for Testing or Chromium: branded Chrome and Edge block unpacked extensions.
const CHROME = process.env.CHROME_PATH || '';
const PREFIX = process.env.VOICE_QA_LABEL || (BASELINE ? 'before' : 'after');
// VOICE_QA_GPU=1 keeps hardware acceleration on, closer to a real desktop browser.
const GPU = process.env.VOICE_QA_GPU === '1';
const TRANSCRIPT = 'The voice animation follows the current theme.';
const DRAFT = 'Make the voice experience feel like Hermes.';
const KEY = 'voice-qa-local-not-a-secret';
const CUSTOM = {
  schemaVersion: 1, name: 'Voice QA citrine', description: 'Controlled custom-theme fixture.',
  colors: { canvas: '#ffffff', paper: '#f5f5f5', ink: '#111111', muted: '#595959', primary: '#0505e8', primaryDeep: '#03039b', onPrimary: '#ffffff', accent: '#ffd400', onAccent: '#111111', line: '#767676', input: '#ffffff', danger: '#b00020', onDanger: '#ffffff', shellForeground: '#ffffff' },
  darkColors: { canvas: '#101114', paper: '#181a20', ink: '#f4f5f7', muted: '#b5bac4', primary: '#4c59e8', primaryDeep: '#343db8', onPrimary: '#ffffff', accent: '#e6ff57', onAccent: '#101114', line: '#777d8a', input: '#101114', danger: '#ff6b78', onDanger: '#101114', shellForeground: '#ffffff' },
};
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
  constructor(url) { this.url = url; this.nextId = 0; this.pending = new Map(); this.events = []; }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      // onEvent may consume high-volume events (screencast frames) so they are not retained.
      if (!message.id) { if (!this.onEvent?.(message)) this.events.push(message); return; }
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
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
  let seed = 17;
  for (let index = 0; index < samples; index++) {
    const t = index / rate;
    seed = (seed * 16807) % 2147483647;
    const envelope = 0.08 + 0.2 * Math.pow(0.5 + 0.5 * Math.sin(t * 7), 2);
    const voice = Math.sin(2 * Math.PI * (180 * t + 8 * Math.sin(t * 3))) * 0.62 + Math.sin(2 * Math.PI * 470 * t) * 0.2 + (seed / 2147483647 - 0.5) * 0.18;
    wav.writeInt16LE(Math.round(voice * envelope * 32767), 44 + index * 2);
  }
  const file = path.join(QA, 'controlled-voice.wav');
  await writeFile(file, wav);
  return file;
}
async function mockGateway() {
  const requests = [];
  let sttError = false;
  const respond = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(JSON.stringify(body)); };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ path: url.pathname, method: req.method, audioBytes: String(body?.audio || body?.audio_base64 || body?.data_url || '').length });
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); res.end(); return; }
    if (url.pathname === '/health') return respond(res, 200, { status: 'ok', platform: 'hermes-agent', version: 'voice-qa' });
    if (url.pathname === '/v1/capabilities') return respond(res, 200, { platform: 'hermes-agent', features: { models_api: true, session_resources: true, skills_api: true, audio_transcription: true }, endpoints: { models: { path: '/v1/models' }, audio_transcribe: { path: '/api/audio/transcribe' } } });
    if (url.pathname === '/api/audio/transcribe') {
      assert.equal(req.headers.authorization, `Bearer ${KEY}`);
      assert.ok(body?.audio_base64 || body?.audio || body?.data_url, 'the real recorder must upload recorded audio');
      await delay(2200);
      return respond(res, sttError ? 500 : 200, sttError ? { error: 'Controlled transcription failure' } : { transcript: TRANSCRIPT });
    }
    if (url.pathname === '/api/model/options') return respond(res, 200, { providers: [{ slug: 'qa', name: 'Local QA', authenticated: true, models: [{ id: 'qa/voice', label: 'Voice QA', context_length: 32000 }] }] });
    if (url.pathname === '/v1/models') return respond(res, 200, { object: 'list', data: [{ id: 'qa/voice', provider: 'qa', context_length: 32000 }] });
    if (['/v1/skills', '/v1/toolsets'].includes(url.pathname)) return respond(res, 200, { object: 'list', data: [] });
    if (url.pathname === '/api/sessions') return respond(res, 200, req.method === 'POST' ? { id: body?.session_id || body?.id || 'voice-qa', session_id: body?.session_id || body?.id || 'voice-qa', title: 'Voice QA', source: 'hermes_browser_extension' } : { data: [], total: 0, has_more: false });
    if (url.pathname.startsWith('/api/sessions/')) return respond(res, 200, { id: 'voice-qa', session_id: 'voice-qa', title: 'Voice QA', source: 'hermes_browser_extension', messages: [] });
    return respond(res, 404, { error: 'No fixture for this route' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, failStt: () => { sttError = true; }, close: () => new Promise((resolve) => server.close(resolve)) };
}
const AUDIO_PROBE = `(() => {
  window.__voiceQa = { requests: 0, streams: [], contexts: 0, audioReads: 0 };
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (...args) => { window.__voiceQa.requests++; const stream = await capture(...args); window.__voiceQa.streams.push(stream); return stream; };
  const Context = window.AudioContext;
  window.AudioContext = class extends Context {
    constructor(...args) { super(...args); window.__voiceQa.contexts++; }
    createAnalyser() {
      const node = super.createAnalyser();
      const read = node.getFloatTimeDomainData.bind(node);
      node.getFloatTimeDomainData = (samples) => { window.__voiceQa.audioReads++; return read(samples); };
      return node;
    }
  };
})()`;
async function openPage(base, id, file, width = 420) {
  const target = await fetchJson(`${base}/json/new?${encodeURIComponent(`chrome-extension://${id}/${file}`)}`, { method: 'PUT' });
  const client = new Cdp(target.webSocketDebuggerUrl);
  await client.connect();
  await client.call('Runtime.enable'); await client.call('Page.enable');

  await client.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  return client;
}
async function screenshot(client, name, selector = '') {
  const params = { format: 'png', captureBeyondViewport: false };
  if (selector) {
    const clip = await client.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.min(innerWidth, r.width + 16), height: Math.min(innerHeight - r.y + 8, r.height + 78), scale: 1 }; })()`);
    params.clip = clip;
  }
  const result = await client.call('Page.captureScreenshot', params);
  await writeFile(path.join(QA, `${PREFIX}-${name}.png`), Buffer.from(result.data, 'base64'));
}
const PROBE = `(() => {
  const canvas = document.querySelector('.voice-wingbeat');
  const input = document.querySelector('#promptInput');
  const mic = document.querySelector('#voiceButton');
  const rect = mic?.getBoundingClientRect();
  const pixels = canvas && canvas.width && canvas.height ? canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data : null;
  let alpha = 0, count = 0, cx = 0, top = Infinity, r = 0, g = 0, b = 0;
  for (let i = 0; pixels && i < pixels.length; i += 4) if (pixels[i + 3]) { const a = pixels[i + 3]; alpha += a; count++; cx += (i / 4 % canvas.width) * a; top = Math.min(top, Math.floor(i / 4 / canvas.width)); r += pixels[i] * a; g += pixels[i+1] * a; b += pixels[i+2] * a; }
  return { state: canvas?.dataset.voiceState || null, alpha, count, centroid: alpha ? cx / alpha : 0, top: Number.isFinite(top) ? top : null, meanColor: alpha ? [r / alpha, g / alpha, b / alpha].map(Math.round) : [], canvasWidth: canvas?.width, canvasHeight: canvas?.height, pointerEvents: canvas ? getComputedStyle(canvas).pointerEvents : null, micClickable: rect ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === mic || mic.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) : true, label: document.querySelector('#voiceActivityLabel')?.textContent, bars: [...document.querySelectorAll('#voiceActivityBars i')].map(bar => parseFloat(/scaleY\\(([\\d.]+)\\)/.exec(bar.style.transform)?.[1])), hidden: document.querySelector('#voiceActivity')?.hidden, value: input?.value, theme: document.documentElement.dataset.hermesTheme, mode: document.documentElement.dataset.hermesMode, overflow: document.documentElement.scrollWidth - innerWidth, audioRequests: window.__voiceQa.requests, audioContexts: window.__voiceQa.contexts, tracks: window.__voiceQa.streams.flatMap(stream => stream.getTracks().map(track => track.readyState)) };
})()`;
async function chooseTheme(panel, worker, theme, mode) {
  await panel.evaluate(`(() => { document.querySelector('[data-theme="${theme}"]').click(); document.querySelector('[data-color-mode="${mode}"]').click(); })()`);
  await waitFor(() => worker.evaluate(`chrome.storage.local.get('hermesBrowserSettings').then(({hermesBrowserSettings:s}) => s.appearanceTheme === ${JSON.stringify(theme)} && s.colorMode === ${JSON.stringify(mode)})`), 'durable theme selection');
  await waitFor(() => panel.evaluate(`document.documentElement.dataset.hermesTheme === ${JSON.stringify(theme)} && document.documentElement.dataset.hermesMode === ${JSON.stringify(mode)}`), 'painted theme selection');
  await delay(180);
}
// Frame pacing and main-thread cost over a fixed window: Chrome's own task
// counters (Performance.getMetrics) plus an in-page frame-interval sampler.
const PERF_SAMPLER = `(() => {
  const s = window.__voicePerf = { intervals: [], longTasks: [], last: 0, running: true };
  try { s.observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) s.longTasks.push(entry.duration); }); s.observer.observe({ type: 'longtask' }); } catch { /* longtask unsupported */ }
  const tick = (time) => { if (s.last) s.intervals.push(time - s.last); s.last = time; if (s.running) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return true;
})()`;
async function measurePerf(client, seconds = 3) {
  const metrics = async () => Object.fromEntries((await client.call('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
  await client.evaluate(PERF_SAMPLER);
  const before = await metrics();
  await delay(seconds * 1000);
  const after = await metrics();
  const sample = await client.evaluate(`(() => { const s = window.__voicePerf; s.running = false; s.observer?.disconnect(); const c = document.querySelector('.voice-wingbeat'); return { intervals: s.intervals, longTasks: s.longTasks, canvasPixelWidth: c ? c.width : null, canvasCssWidth: c ? c.clientWidth : null }; })()`);
  const elapsed = after.Timestamp - before.Timestamp;
  const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
  const sorted = [...sample.intervals].sort((a, b) => a - b);
  const quantile = (q) => (sorted.length ? round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]) : 0);
  return {
    seconds: round(elapsed, 2),
    fps: round(sample.intervals.length / elapsed),
    frameP50Ms: quantile(0.5),
    frameP95Ms: quantile(0.95),
    frameMaxMs: round(sorted.at(-1) || 0),
    lateFrames: sample.intervals.filter((value) => value > 25).length,
    longTasks: sample.longTasks.length,
    scriptMsPerSecond: round(((after.ScriptDuration - before.ScriptDuration) * 1000) / elapsed),
    mainThreadMsPerSecond: round(((after.TaskDuration - before.TaskDuration) * 1000) / elapsed),
    layoutsPerSecond: round((after.LayoutCount - before.LayoutCount) / elapsed),
    styleRecalcsPerSecond: round((after.RecalcStyleCount - before.RecalcStyleCount) / elapsed),
    heapMb: round(after.JSHeapUsedSize / 1048576),
    canvasPixelWidth: sample.canvasPixelWidth,
    canvasCssWidth: sample.canvasCssWidth,
  };
}
// Optional motion capture for review (VOICE_QA_VIDEO=1): screencast frames of the
// real panel plus an ffmpeg concat list that keeps their true timing.
const VIDEO = process.env.VOICE_QA_VIDEO === '1';
async function recordClip(client, name, seconds = 6) {
  const dir = path.join(QA, `${PREFIX}-${name}-frames`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const frames = [];
  client.onEvent = (message) => {
    if (message.method !== 'Page.screencastFrame') return false;
    frames.push({ data: message.params.data, time: message.params.metadata.timestamp });
    client.call('Page.screencastFrameAck', { sessionId: message.params.sessionId }).catch(() => {});
    return true;
  };
  const viewport = await client.evaluate('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })');
  await client.call('Page.startScreencast', { format: 'jpeg', quality: 95, everyNthFrame: 1, maxWidth: Math.round(viewport.width * viewport.dpr), maxHeight: Math.round(viewport.height * viewport.dpr) });
  await delay(seconds * 1000);
  await client.call('Page.stopScreencast');
  client.onEvent = null;
  const list = [];
  for (let index = 0; index < frames.length; index++) {
    const file = path.join(dir, `${String(index).padStart(4, '0')}.jpg`).replaceAll('\\', '/');
    await writeFile(file, Buffer.from(frames[index].data, 'base64'));
    const next = frames[index + 1]?.time ?? frames[index].time + 1 / 30;
    list.push(`file '${file}'`, `duration ${Math.max(0.001, next - frames[index].time).toFixed(4)}`);
  }
  if (frames.length) list.push(list.at(-2));
  await writeFile(path.join(dir, 'frames.txt'), `${list.join('\n')}\n`);
  const rect = await client.evaluate(`(() => { const r = document.querySelector('#composerDropZone').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: devicePixelRatio }; })()`);
  const fps = frames.length > 1 ? (frames.length - 1) / (frames.at(-1).time - frames[0].time) : 0;
  return { dir, frames: frames.length, fps: Math.round(fps * 10) / 10, composer: rect };
}
await mkdir(QA, { recursive: true });
assert.ok(CHROME && existsSync(CHROME), 'Set CHROME_PATH to a Chrome for Testing or Chromium binary');
const wav = await wavFixture();
const gateway = await mockGateway();
let chromeErrors = '';
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', ...(GPU ? [] : ['--disable-gpu']), '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, `chrome-extension://${extensionId(EXT)}/request-permissions.html`], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
chrome.stderr.on('data', (chunk) => { chromeErrors = (chromeErrors + chunk.toString()).slice(-16000); });
const clients = [];
const evidence = { baseline: BASELINE, extension: EXT, audio: 'controlled WAV, not the user microphone', transcription: 'local deterministic STT fixture, not a live model', themes: [], screenshots: [] };
let panel;
try {
  const portFile = path.join(PROFILE, 'DevToolsActivePort');
  await waitFor(() => existsSync(portFile), 'Chrome debugging port');
  const [port] = (await readFile(portFile, 'utf8')).split('\n');
  const base = `http://127.0.0.1:${Number(port)}`;
  if (GPU) {
    const browser = new Cdp((await fetchJson(`${base}/json/version`)).webSocketDebuggerUrl); clients.push(browser); await browser.connect();
    const info = await browser.call('SystemInfo.getInfo');
    evidence.gpu = { canvas2d: info.gpu?.featureStatus?.['2d_canvas'], compositing: info.gpu?.featureStatus?.gpu_compositing, device: info.gpu?.devices?.[0]?.deviceString };
    console.log('[voice-qa] gpu', JSON.stringify(evidence.gpu));
  }

  const workerTarget = await waitFor(async () => (await fetchJson(`${base}/json/list`)).find(target => target.type === 'service_worker' && target.url.endsWith('/background.js')), 'real extension worker');
  const id = new URL(workerTarget.url).hostname;
  assert.equal(id, extensionId(EXT));
  const worker = new Cdp(workerTarget.webSocketDebuggerUrl); clients.push(worker); await worker.connect();
  await worker.call('Runtime.enable');
  await waitFor(() => worker.evaluate('Boolean(globalThis.chrome?.runtime?.getManifest)'), 'extension worker API');
  assert.equal(await worker.evaluate('chrome.runtime.getManifest().name'), 'Hermes Browser Extension');
  console.log('[voice-qa] real extension worker ready');

  await worker.evaluate(`chrome.storage.local.set({hermesBrowserIntroSeen:true, hermesBrowserSettings:${JSON.stringify({ connectionSchemaVersion: 1, connectionMode: 'local', connectionTransport: 'local-api', gatewayMode: 'local-api', gatewayUrl: gateway.base, apiKey: KEY, tokenSource: 'e2e', sessionId: 'voice-qa', sessionStartMode: 'fresh', model: 'qa/voice', appearanceTheme: 'nous', colorMode: 'dark' })}})`);
  panel = await openPage(base, id, 'sidepanel.html'); clients.push(panel);
  console.log('[voice-qa] real side-panel page opened');
  await waitFor(() => panel.evaluate(`document.querySelector('#startupScreen')?.hidden && !document.querySelector('#promptInput')?.disabled`), 'panel ready');

  await panel.evaluate(AUDIO_PROBE);
  await panel.evaluate(`(() => { const input=document.querySelector('#promptInput'); input.value=${JSON.stringify(DRAFT)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await screenshot(panel, 'idle');
  await panel.call('Performance.enable');
  evidence.perf = { idle: await measurePerf(panel) };
  if (!BASELINE) assert.ok(!evidence.perf.idle.canvasPixelWidth, 'idle keeps no canvas backing store (before first use there is no canvas at all)');
  await panel.evaluate(`document.querySelector('#voiceButton').click()`);
  await waitFor(() => panel.evaluate(`document.querySelector('#voiceActivity')?.classList.contains('recording') && [...document.querySelectorAll('#voiceActivityBars i')].some(bar => parseFloat(/scaleY\\(([\\d.]+)\\)/.exec(bar.style.transform)?.[1]) > 0.3)`), 'actual microphone energy');
  await delay(500);
  evidence.recording = await panel.evaluate(PROBE);
  assert.equal(evidence.recording.audioRequests, 1, 'the glow must not acquire a second microphone');
  assert.equal(evidence.recording.audioContexts, 1, 'the side-panel glow must reuse the existing meter');
  assert.equal(evidence.recording.label, 'Dictating');
  assert.equal(evidence.recording.bars.length, 5);
  await screenshot(panel, 'recording');
  await screenshot(panel, 'recording-detail', '#composerDropZone');
  evidence.perf.recording = await measurePerf(panel);
  if (VIDEO) {
    await panel.call('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: false });
    await delay(300);
    evidence.clip = await recordClip(panel, 'recording');
    await panel.call('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
    await delay(300);
  }
  if (BASELINE) assert.equal(evidence.recording.state, null);
  else {
    assert.equal(evidence.recording.state, 'recording');
    assert.ok(evidence.recording.count > 200);
    assert.equal(evidence.recording.pointerEvents, 'none');
    assert.equal(evidence.recording.micClickable, true);
    evidence.softBoundaries = await panel.evaluate(`(() => {
      const c=document.querySelector('.voice-wingbeat');
      const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let bottom=0, sides=0;
      for(let y=0;y<c.height;y++) for(let x=0;x<c.width;x++) {
        const alpha=pixels[(y*c.width+x)*4+3];
        if(y>=c.height-8) bottom=Math.max(bottom,alpha);
        if(x<2||x>=c.width-2) sides=Math.max(sides,alpha);
      }
      return {bottomMaxAlpha:bottom,sideMaxAlpha:sides};
    })()`);
    assert.equal(evidence.softBoundaries.bottomMaxAlpha, 0, 'the glow must become fully transparent before the lower canvas boundary');
    assert.equal(evidence.softBoundaries.sideMaxAlpha, 0, 'the glow must not form hard vertical clipping pockets');
    const samplingStart = await panel.evaluate('({time:performance.now(),reads:window.__voiceQa.audioReads})');
    await delay(600);
    const samplingEnd = await panel.evaluate('({time:performance.now(),reads:window.__voiceQa.audioReads})');
    evidence.analyserReadsPerSecond = (samplingEnd.reads - samplingStart.reads) / ((samplingEnd.time - samplingStart.time) / 1000);
    assert.ok(evidence.analyserReadsPerSecond > 20, 'the visual must read live audio far more often than the 4 Hz status meter');
    const first = evidence.recording.alpha; await delay(260);
    evidence.liveReaction = await panel.evaluate(PROBE);
    assert.notEqual(evidence.liveReaction.alpha, first);
  }
  if (!BASELINE && !PERF_ONLY) {
    for (const theme of APPEARANCE_THEMES) for (const mode of ['light', 'dark']) {
      await chooseTheme(panel, worker, theme.value, mode);
      const proof = await panel.evaluate(PROBE);
      assert.equal(proof.state, 'recording'); assert.ok(proof.alpha > 0); assert.ok(proof.overflow <= 1); assert.equal(proof.micClickable, true);
      evidence.themes.push({ theme: theme.value, mode, color: proof.meanColor, alpha: proof.alpha, overflow: proof.overflow });
      await screenshot(panel, `${theme.value}-${mode}-detail`, '#composerDropZone');
    }
    const installed = await panel.evaluate(`(async () => { const {installCustomTheme} = await import('./lib/custom-theme-store.mjs'); const r = await installCustomTheme(chrome.storage.local, ${JSON.stringify(CUSTOM)}); return {ok:r.ok,id:r.record?.id}; })()`);
    assert.equal(installed.ok, true);
    evidence.customId = installed.id;
    await waitFor(() => panel.evaluate(`Boolean(document.querySelector('[data-theme="${installed.id}"]'))`), 'custom theme card');
    for (const mode of ['light', 'dark']) {
      await chooseTheme(panel, worker, installed.id, mode);
      const proof = await panel.evaluate(PROBE);
      assert.ok(proof.alpha > 0); assert.ok(proof.overflow <= 1); evidence.themes.push({ theme: 'custom-citrine', mode, color: proof.meanColor, alpha: proof.alpha });
      await screenshot(panel, `custom-${mode}`);
      await screenshot(panel, `custom-${mode}-detail`, '#composerDropZone');
    }
    await chooseTheme(panel, worker, 'nous', 'light'); await screenshot(panel, 'nous-light');
    await chooseTheme(panel, worker, 'nous', 'dark'); await screenshot(panel, 'nous-dark');
    await panel.call('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
    await panel.evaluate(`document.documentElement.style.setProperty('--hermes-text-zoom','1.75');document.documentElement.dir='rtl'`);
    await delay(250); evidence.narrow = await panel.evaluate(PROBE); assert.ok(evidence.narrow.overflow <= 1); assert.ok(evidence.narrow.alpha > 0);
    await screenshot(panel, 'narrow-rtl-175');
    await panel.call('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
    await panel.evaluate(`document.documentElement.style.removeProperty('--hermes-text-zoom');document.documentElement.dir='ltr'`);
    await panel.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await waitFor(() => panel.evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), 'reduced-motion media applied');
    await delay(300); const reduced1 = await panel.evaluate(PROBE); await delay(200); const reduced2 = await panel.evaluate(PROBE);
    assert.equal(reduced1.alpha, reduced2.alpha); assert.ok(reduced1.count > 0); evidence.reducedMotion = { stationary: true, count: reduced1.count };
    await screenshot(panel, 'reduced-motion');
    await panel.call('Emulation.setEmulatedMedia', { features: [] });
  }
  // A slow machine: the glow should keep frames paced by shedding resolution.
  await panel.call('Emulation.setCPUThrottlingRate', { rate: 4 });
  await delay(1500);
  evidence.perf.recordingCpu4x = await measurePerf(panel);
  await panel.call('Emulation.setCPUThrottlingRate', { rate: 1 });
  await writeFile(path.join(QA, `${PREFIX}-perf.json`), `${JSON.stringify(evidence.perf, null, 2)}\n`);
  await panel.evaluate(`document.querySelector('#voiceButton').click()`);
  await waitFor(() => panel.evaluate(`document.querySelector('#voiceActivityLabel')?.textContent === 'Transcribing'`), 'transcription state');
  await delay(300);
  evidence.processing = await panel.evaluate(PROBE);
  await screenshot(panel, 'processing');
  await screenshot(panel, 'processing-detail', '#composerDropZone');
  if (!BASELINE) {
    assert.equal(evidence.processing.state, 'processing');
    const positions = [evidence.processing.centroid];
    for (let frame = 0; frame < 5; frame++) {
      await delay(120);
      const next = await panel.evaluate(PROBE);
      assert.equal(next.state, 'processing');
      positions.push(next.centroid);
    }
    evidence.beamTravel = Math.max(...positions) - Math.min(...positions);
    assert.ok(evidence.beamTravel > 4, 'the processing beam must travel even when the capture spans its turnaround');
  }
  await waitFor(() => panel.evaluate(`document.querySelector('#promptInput').value === ${JSON.stringify(DRAFT + ' ' + TRANSCRIPT)} && document.querySelector('#voiceActivity').hidden`), 'draft plus transcript insertion');
  evidence.finished = await panel.evaluate(PROBE);
  assert.ok(evidence.finished.tracks.every(state => state === 'ended'));
  // The glow folds away instead of cutting off, then releases its backing store.
  const settled = `(async () => { const p = ${PROBE}; return p.state === 'idle' && p.alpha === 0 && !p.canvasWidth ? p : null; })()`;
  if (!BASELINE) { assert.equal(evidence.finished.state, 'idle'); evidence.settled = await waitFor(() => panel.evaluate(settled), 'glow settles and releases its canvas', 3000); }
  await screenshot(panel, 'finished');
  if (!BASELINE) {
    if (!PERF_ONLY) {
      // The fallback tab across themes: short, on-brand, nothing clipped.
      const looks = await openPage(base, id, 'voice-dictation.html', 900); clients.push(looks);
      for (const [theme, mode] of [['nous', 'dark'], ['nous', 'light'], ['ember', 'dark'], ['everforest', 'light']]) {
        await chooseTheme(panel, worker, theme, mode);
        await looks.call('Page.reload');
        await waitFor(() => looks.evaluate(`document.documentElement.dataset.hermesTheme === ${JSON.stringify(theme)} && document.documentElement.dataset.hermesMode === ${JSON.stringify(mode)} && document.querySelector('#voiceStatusTitle')?.hidden === false`), `voice page ${theme} ${mode}`);
        const layout = await looks.evaluate(`(() => { const start = document.querySelector('#startVoiceButton').getBoundingClientRect(); return { overflow: document.documentElement.scrollWidth - innerWidth, startVisible: start.width > 0 && start.right <= innerWidth && start.bottom <= innerHeight, words: document.querySelector('main').innerText.split(/\\s+/).filter(Boolean).length }; })()`);
        assert.ok(layout.overflow <= 1); assert.equal(layout.startVisible, true); assert.ok(layout.words < 60, 'the fallback tab stays short');
        evidence.voicePageThemes = [...(evidence.voicePageThemes || []), { theme, mode, ...layout }];
        await screenshot(looks, `voice-page-${theme}-${mode}`);
      }
    }
    const fallbackTheme = evidence.customId || 'nous';
    await chooseTheme(panel, worker, fallbackTheme, 'dark');
    const voice = await openPage(base, id, 'voice-dictation.html', 900); clients.push(voice);
    await waitFor(() => voice.evaluate(`document.documentElement.dataset.hermesTheme === ${JSON.stringify(fallbackTheme)} && !document.querySelector('#startVoiceButton').disabled`), 'fallback page theme');
    await voice.evaluate(AUDIO_PROBE);
    await voice.evaluate(`document.querySelector('#startVoiceButton').click()`);
    await waitFor(() => voice.evaluate(`document.querySelector('.voice-wingbeat')?.dataset.voiceState === 'recording'`), 'fallback voice-page recording');
    await delay(500); evidence.voicePage = await voice.evaluate(PROBE); assert.ok(evidence.voicePage.alpha > 0); assert.equal(evidence.voicePage.audioRequests, 1); assert.equal(evidence.voicePage.audioContexts, 1);
    await screenshot(voice, 'voice-page-custom');
    await voice.evaluate(`document.querySelector('#startVoiceButton').click()`);
    await waitFor(() => voice.evaluate(`document.querySelector('.voice-wingbeat')?.dataset.voiceState === 'processing'`), 'fallback voice-page processing');
    await screenshot(voice, 'voice-page-processing');
    await waitFor(() => voice.evaluate(`document.querySelector('.voice-wingbeat')?.dataset.voiceState === 'idle' && document.querySelector('#voiceStatus').textContent.includes(${JSON.stringify(TRANSCRIPT)})`), 'fallback voice-page transcript');
    await panel.call('Page.bringToFront');
    gateway.failStt();
    await chooseTheme(panel, worker, 'nous', 'dark');
    await panel.evaluate(`document.querySelector('#voiceButton').click()`);
    await waitFor(() => panel.evaluate(`document.querySelector('#voiceActivity')?.classList.contains('recording')`), 'restart recording');
    await delay(350); await panel.evaluate(`document.querySelector('#voiceButton').click()`);
    await waitFor(() => panel.evaluate(`document.querySelector('.voice-wingbeat')?.dataset.voiceState === 'idle' && document.querySelector('#voiceActivity').hidden`), 'failure clears decoration');
    evidence.failureCleanup = await waitFor(() => panel.evaluate(settled), 'failure settles the glow', 3000); assert.ok(evidence.failureCleanup.tracks.every(state => state === 'ended'));
  }
  evidence.runtimeErrors = clients.flatMap(client => client.events.filter(event => event.method === 'Runtime.exceptionThrown').map(event => event.params.exceptionDetails?.text));
  assert.deepEqual(evidence.runtimeErrors, []);
  evidence.requests = gateway.requests;
  await writeFile(path.join(QA, `${PREFIX}-evidence.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, label: PREFIX, baseline: BASELINE, extension: EXT, themes: evidence.themes.length, microphoneRequests: evidence.recording.audioRequests, audioContexts: evidence.recording.audioContexts, analyserReadsPerSecond: evidence.analyserReadsPerSecond, transcriptPreserved: evidence.finished.value === DRAFT + ' ' + TRANSCRIPT, beamTravel: evidence.beamTravel, perf: evidence.perf, clip: evidence.clip, errors: evidence.runtimeErrors, qa: QA }, null, 2));
} catch (error) {
  console.error('[voice-qa] failure:', error.message);
  console.error('[voice-qa] Chromium stderr:', chromeErrors);
  console.error('[voice-qa] requests:', JSON.stringify(gateway.requests));
  if (panel) console.error('[voice-qa] page events:', JSON.stringify(panel.events.slice(-12)));
  if (panel) { try { await screenshot(panel, 'failure'); console.error(JSON.stringify(await panel.evaluate(PROBE))); } catch { /* failed target */ } }
  throw error;
} finally {
  for (const client of clients) client.close();
  spawnSync('taskkill.exe', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await gateway.close();
  await rm(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
