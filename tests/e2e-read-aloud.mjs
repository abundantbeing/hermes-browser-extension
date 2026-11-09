/**
 * Loaded-extension check for reading a reply aloud.
 *
 * Real Chrome for Testing (muted), the real side panel, and a stub Hermes gateway that
 * also plays the Desktop dashboard: it serves the session token, the voice-config probe
 * and POST /api/audio/speak, which returns a short WAV as a data URL like Hermes does.
 * Nothing here talks to a real gateway.
 *
 * Run: node tests/e2e-read-aloud.mjs
 * Environment:
 *   CHROME_PATH            Chrome for Testing
 *   HBE_E2E_DIST           extension folder to load (default: dist)
 *   HBE_E2E_PORT           remote debugging port (default: any free port)
 *   HBE_E2E_PROFILE        profile folder, deleted at the end (default: tmp/e2e-read-aloud-<pid>)
 *   HBE_E2E_SHOTS          where screenshots go (default: .hermes/qa)
 *   HBE_E2E_PREFIX         screenshot name prefix (default: read-aloud)
 *   HBE_E2E_EXPECT_BUTTON  "no" when the build has no speaker button (a "before" run)
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { ensureExtensionStartupPage, killProcessTree, launchChrome, resolveChromeExecutable } from './e2e-chrome-env.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.resolve(process.env.HBE_E2E_DIST || path.join(ROOT, 'dist'));
const PROFILE = path.resolve(process.env.HBE_E2E_PROFILE || path.join(ROOT, 'tmp', `e2e-read-aloud-${process.pid}`));
const SHOTS = path.resolve(process.env.HBE_E2E_SHOTS || path.join(ROOT, '.hermes', 'qa'));
const PREFIX = process.env.HBE_E2E_PREFIX || 'read-aloud';
const EXPECT_BUTTON = process.env.HBE_E2E_EXPECT_BUTTON !== 'no';
const PORT = Number(process.env.HBE_E2E_PORT || 0);
const TOKEN = 'hermes-qa-token';
const DASHBOARD_TOKEN = 'qa-dashboard-token';

const REPLY = [
  'Here is the plan for **your** release.',
  '',
  '1. Run the build.',
  '2. Load it in Chrome and read [the guide](https://docs.example.com/guide).',
  '',
  '```bash',
  'npm run build',
  '```',
  '',
  'Then wait for the green check.',
].join('\n');
const SPOKEN_REPLY = 'Here is the plan for your release.\nRun the build.\nLoad it in Chrome and read the guide.\nThen wait for the green check.';

function unpackedExtensionId(extensionPath) {
  const encoding = process.platform === 'win32' ? 'utf16le' : 'utf8';
  const digest = createHash('sha256').update(Buffer.from(path.resolve(extensionPath), encoding)).digest().subarray(0, 16);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .replace(/[0-9a-f]/g, (nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)));
}

function wavDataUrl(seconds = 3) {
  const rate = 8000;
  const samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(Math.round(Math.sin((index / rate) * 2 * Math.PI * 330) * 2000), 44 + index * 2);
  return `data:audio/wav;base64,${buffer.toString('base64')}`;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Hermes-Session-Id, X-Hermes-Session-Key, X-Hermes-Session-Token',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...CORS });
  res.end(body);
}

async function startStub() {
  const requests = [];
  const state = { speakMode: 'ok', speakDelayMs: 300, clipSeconds: 3 };
  const clip = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    requests.push({ method: req.method, path: url.pathname, search: url.search, body, token: req.headers['x-hermes-session-token'] || '' });
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (url.pathname === '/api/desktop/dashboard-candidates') { json(res, 200, { candidates: [req.socket.localPort] }); return; }
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html', ...CORS });
      res.end(`<!doctype html><script>window.__HERMES_SESSION_TOKEN__="${DASHBOARD_TOKEN}";</script>`);
      return;
    }
    if (url.pathname === '/api/audio/voice-config') {
      if (req.headers['x-hermes-session-token'] !== DASHBOARD_TOKEN) { json(res, 401, { detail: 'Unauthorized' }); return; }
      json(res, 200, { ok: true, stt: { mode: 'relay' }, tts: { mode: 'relay' } });
      return;
    }
    if (url.pathname === '/api/audio/speak' && req.method === 'POST') {
      if (req.headers['x-hermes-session-token'] !== DASHBOARD_TOKEN) { json(res, 401, { detail: 'Unauthorized' }); return; }
      await new Promise((resolve) => setTimeout(resolve, state.speakDelayMs));
      if (state.speakMode === 'fail') { json(res, 400, { detail: 'Speech synthesis failed' }); return; }
      if (!clip.has(state.clipSeconds)) clip.set(state.clipSeconds, wavDataUrl(state.clipSeconds));
      json(res, 200, { ok: true, data_url: clip.get(state.clipSeconds), mime_type: 'audio/wav', provider: 'qa-voice' });
      return;
    }
    if (url.pathname === '/health' || url.pathname === '/v1/health') { json(res, 200, { status: 'ok', platform: 'hermes-agent', version: 'qa' }); return; }
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
        features: { models: true, session_resources: true, session_chat: true, session_chat_streaming: false, audio_api: false },
      });
      return;
    }
    if (/\/v1\/chat\/completions$/.test(url.pathname) && req.method === 'POST') {
      if (body && body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', ...CORS });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: REPLY } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      json(res, 200, { choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }] });
      return;
    }
    if (/\/chat$/.test(url.pathname) && req.method === 'POST') { json(res, 200, { message: { role: 'assistant', content: REPLY } }); return; }
    if (url.pathname === '/api/sessions' && req.method === 'POST') { json(res, 200, { session: { id: (body && body.id) || 'hermes-browser-extension' } }); return; }
    if (url.pathname === '/api/sessions' && req.method === 'GET') { json(res, 200, { sessions: [], total: 0 }); return; }
    if (url.pathname === '/v1/models') { json(res, 200, { data: [{ id: 'e2e/test-model', object: 'model' }] }); return; }
    if (url.pathname === '/api/model/options') { json(res, 200, { models: [], providers: [] }); return; }
    json(res, 200, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests, state, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function waitFor(check, timeoutMs = 25_000, intervalMs = 120) {
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

class Cdp {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.events = []; }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.onmessage = (event) => {
      const payload = JSON.parse(String(event.data));
      if (!payload.id) { this.events.push(payload); return; }
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);
      if (payload.error) pending.reject(new Error(payload.error.message || 'CDP error')); else pending.resolve(payload.result || {});
    };
    await new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = () => reject(new Error('CDP connect failed')); });
  }
  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate failed');
    return result.result?.value;
  }
  close() { try { this.socket?.close(); } catch { /* best effort */ } }
}

async function shot(panel, name, { clip = '' } = {}) {
  await mkdir(SHOTS, { recursive: true });
  let params = { format: 'png', captureBeyondViewport: false };
  if (clip) {
    const rect = await panel.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(clip)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    assert.ok(rect, `no element for ${clip}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const again = await panel.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(clip)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    params = { ...params, clip: { x: 0, y: Math.max(0, again.y - 8), width: 420, height: again.height + 16, scale: 1 } };
  }
  const result = await panel.call('Page.captureScreenshot', params);
  const file = path.join(SHOTS, `${PREFIX}-${name}.png`);
  await writeFile(file, Buffer.from(result.data, 'base64'));
  console.log('[shot]', file);
  return file;
}

const speakerState = `(() => {
  const rows = Array.from(document.querySelectorAll('.message-row[data-role="assistant"]'));
  return rows.map((row) => {
    const button = row.querySelector('.message-action-speak');
    return {
      hasButton: Boolean(button),
      pressed: button?.getAttribute('aria-pressed') || null,
      busy: button?.getAttribute('aria-busy') || null,
      label: button?.getAttribute('aria-label') || null,
      marked: row.classList.contains('is-being-read'),
    };
  });
})()`;

async function send(panel, text) {
  await panel.evaluate(`(() => {
    const input = document.querySelector('#promptInput');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#composer').requestSubmit();
    return true;
  })()`);
}

async function clickSpeaker(panel, index = 0) {
  await panel.evaluate(`document.querySelectorAll('.message-row[data-role="assistant"] .message-action-speak')[${index}].click(); true`);
}

async function main() {
  assert.ok(existsSync(path.join(DIST, 'manifest.json')), `No extension at ${DIST}. Run npm run build.`);
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  const stub = await startStub();
  let chrome;
  let setup;
  let panel;
  const summary = {};
  try {
    const extensionId = unpackedExtensionId(DIST);
    chrome = launchChrome(resolveChromeExecutable(), [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--autoplay-policy=user-gesture-required',
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
      `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`,
      `chrome-extension://${extensionId}/request-permissions.html`,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    chrome.stderr.on('data', () => {});
    const activePort = path.join(PROFILE, 'DevToolsActivePort');
    let devtoolsPort = PORT;
    if (!devtoolsPort) {
      await waitFor(() => existsSync(activePort));
      [devtoolsPort] = (await readFile(activePort, 'utf8')).trim().split('\n').map(Number);
    }
    const devtools = `http://127.0.0.1:${devtoolsPort}`;
    await waitFor(() => fetch(`${devtools}/json/version`).then((response) => response.ok), 30_000);
    await ensureExtensionStartupPage(devtools, extensionId);

    const wake = (await (await fetch(`${devtools}/json/list`)).json()).find((t) => t.type === 'page' && String(t.url || '').startsWith(`chrome-extension://${extensionId}/`));
    if (wake) {
      const client = new Cdp(wake.webSocketDebuggerUrl);
      await client.connect();
      await client.call('Runtime.enable');
      await waitFor(() => client.evaluate('Boolean(globalThis.chrome?.runtime?.sendMessage)'));
      await client.evaluate("void chrome.runtime.sendMessage({ type: 'HERMES_INLINE_SESSION_STATUS' }).catch(() => null); true");
      client.close();
    }
    const worker = await waitFor(async () => {
      const targets = await (await fetch(`${devtools}/json/list`)).json();
      for (const target of targets.filter((t) => t.type === 'service_worker' && /\/background\.js$/.test(t.url || ''))) {
        const probe = new Cdp(target.webSocketDebuggerUrl);
        try {
          await probe.connect();
          await probe.call('Runtime.enable');
          if (await probe.evaluate("globalThis.chrome?.runtime?.getManifest?.()?.name === 'Hermes Browser Extension'")) return target;
        } catch { /* another worker */ } finally { probe.close(); }
      }
      return null;
    }, 45_000, 400);
    setup = new Cdp(worker.webSocketDebuggerUrl);
    await setup.connect();
    await setup.call('Runtime.enable');
    const settings = (colorMode) => ({
      connectionSchemaVersion: 1, connectionMode: 'local', connectionTransport: 'local-api', gatewayMode: 'local-api',
      gatewayUrl: stub.baseUrl, apiKey: TOKEN, tokenSource: 'qa', sessionId: 'hermes-browser-extension', sessionStartMode: 'fresh',
      model: 'e2e/test-model', appearanceTheme: 'mono', colorMode, activeProfile: 'default',
    });
    const store = (colorMode) => setup.evaluate(`chrome.storage.local.set({hermesBrowserSettings:${JSON.stringify(settings(colorMode))}, hermesBrowserIntroSeen: true}).then(() => true)`);
    await store('dark');

    const target = await (await fetch(`${devtools}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/sidepanel.html`)}`, { method: 'PUT' })).json();
    panel = new Cdp(target.webSocketDebuggerUrl);
    await panel.connect();
    await panel.call('Runtime.enable');
    await panel.call('Page.enable');
    await panel.call('Page.bringToFront');
    await panel.call('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: false });
    const ready = () => waitFor(() => panel.evaluate(`(() => { const s = document.querySelector('#startupScreen'); const i = document.querySelector('#promptInput'); return Boolean(s?.hidden && i && !i.disabled); })()`), 30_000);
    await ready();

    await send(panel, 'Give me the release plan.');
    await waitFor(() => panel.evaluate(`document.querySelectorAll('.message-row[data-role="assistant"] .message-action-copy').length === 1 && !document.querySelector('.message-row[data-role="assistant"] .message-action-copy').disabled`), 30_000).catch(async (error) => {
      console.error('[e2e] no reply:', JSON.stringify(await panel.evaluate('({ text: document.body.innerText.slice(0, 600), title: document.querySelector("#activeTitle")?.textContent, detail: document.querySelector("#activeUrl")?.textContent })')));
      console.error('[e2e] requests:', JSON.stringify(stub.requests.map((r) => `${r.method} ${r.path}`).slice(-12)));
      throw error;
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const idle = await panel.evaluate(speakerState);
    summary.idle = idle;
    summary.voiceRowAtIdle = await panel.evaluate(`document.querySelector('[data-capability="voiceOutput"]')?.dataset.voiceRoute || null`);
    console.log('[e2e] voice route at idle:', summary.voiceRowAtIdle);

    if (!EXPECT_BUTTON) {
      assert.equal(idle[0].hasButton, false, 'this build has no speaker button');
      await panel.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 120, y: 200 });
      await shot(panel, 'a-reply-idle', { clip: '.message-row[data-role="assistant"]' });
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    assert.equal(idle[0].hasButton, true, 'a finished reply has the speaker button');
    assert.deepEqual([idle[0].pressed, idle[0].label, idle[0].marked], ['false', 'Read aloud', false]);
    // Nothing is read on arrival.
    assert.equal(stub.requests.filter((r) => r.path === '/api/audio/speak').length, 0, 'no speech request before a click');

    // (a) the reply with the speaker idle; hover so the action rail is up.
    const rowRect = await panel.evaluate(`(() => { const r = document.querySelector('.message-row[data-role="assistant"] .message').getBoundingClientRect(); return { x: r.x + 40, y: r.y + 30 }; })()`);
    await panel.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowRect.x, y: rowRect.y });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await shot(panel, 'a-reply-idle', { clip: '.message-row[data-role="assistant"]' });

    // (b) read it through the gateway voice.
    await clickSpeaker(panel);
    const loading = await panel.evaluate(speakerState);
    summary.loading = loading[0];
    assert.equal(loading[0].pressed, 'true', 'pressed as soon as it is clicked');
    const speaking = await waitFor(async () => {
      const [row] = await panel.evaluate(speakerState);
      return row.pressed === 'true' && row.busy === null && row.marked ? row : null;
    }, 8000);
    summary.speaking = speaking;
    assert.equal(speaking.label, 'Stop reading aloud');
    const speak = stub.requests.filter((r) => r.path === '/api/audio/speak');
    if (!speak.length) console.error('[e2e] no speech request; requests:', JSON.stringify(stub.requests.map((r) => `${r.method} ${r.path}`)), 'speaking:', JSON.stringify(speaking));
    assert.equal(speak.length >= 1, true, 'the gateway was asked to speak');
    assert.equal(speak[0].token, DASHBOARD_TOKEN);
    assert.ok(!speak[0].search.includes(DASHBOARD_TOKEN), 'the token is a header, not in the URL');
    assert.equal(speak[0].body.text, SPOKEN_REPLY, 'only the prose is spoken: no code block, no link address');
    summary.spokenText = speak[0].body.text;
    await shot(panel, 'b-reply-reading-dark', { clip: '.message-row[data-role="assistant"]' });

    // Stop.
    await clickSpeaker(panel);
    const stopped = await panel.evaluate(speakerState);
    assert.deepEqual([stopped[0].pressed, stopped[0].marked], ['false', false], 'pressing again stops');

    // Audio that arrives after Stop never plays.
    stub.state.speakDelayMs = 1200;
    const before = stub.requests.filter((r) => r.path === '/api/audio/speak').length;
    await clickSpeaker(panel);
    await waitFor(() => stub.requests.filter((r) => r.path === '/api/audio/speak').length > before, 5000);
    await clickSpeaker(panel);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const late = await panel.evaluate(speakerState);
    assert.deepEqual([late[0].pressed, late[0].marked], ['false', false], 'late audio is discarded');
    stub.state.speakDelayMs = 300;

    // A new turn stops what is being read, and a second reply can be read in turn.
    await clickSpeaker(panel);
    await waitFor(async () => (await panel.evaluate(speakerState))[0].busy === null && (await panel.evaluate(speakerState))[0].pressed === 'true', 8000);
    await send(panel, 'And one more answer, please.');
    await waitFor(() => panel.evaluate(`document.querySelectorAll('.message-row[data-role="assistant"] .message-action-speak').length === 2`), 30_000);
    const afterTurn = await panel.evaluate(speakerState);
    assert.deepEqual(afterTurn.map((r) => r.pressed), ['false', 'false'], 'a new turn stopped the reading');
    await clickSpeaker(panel, 0);
    await waitFor(async () => (await panel.evaluate(speakerState))[0].pressed === 'true', 8000);
    await clickSpeaker(panel, 1);
    const switched = await panel.evaluate(speakerState);
    assert.deepEqual(switched.map((r) => r.pressed), ['false', 'true'], 'pressing another reply switches');
    await clickSpeaker(panel, 1);

    // The gateway cannot make audio: the browser's own voice reads, and Diagnostics says so.
    await panel.evaluate(`(() => {
      window.__spoken = [];
      const fake = { speak(u) { window.__spoken.push({ text: u.text, lang: u.lang }); setTimeout(() => u.onend && u.onend({}), 30); }, cancel() {}, getVoices() { return []; } };
      Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true });
      window.SpeechSynthesisUtterance = function (text) { this.text = text; };
      return true;
    })()`);
    stub.state.speakMode = 'fail';
    await clickSpeaker(panel, 0);
    const fallback = await waitFor(() => panel.evaluate('window.__spoken.length ? window.__spoken : null'), 8000);
    summary.browserSpoken = fallback;
    assert.equal(fallback.map((c) => c.text).join(' ').replace(/\s+/g, ' ').includes('Here is the plan for your release.'), true);
    assert.ok(fallback.every((c) => c.text.length <= 180), 'chunks stay short for Chrome');

    // (c) Settings > About & Diagnostics > Voice row.
    await panel.evaluate(`document.querySelector('#settingsButton').click(); true`);
    await waitFor(() => panel.evaluate("document.querySelector('#settingsDialog')?.hidden === false"));
    await panel.evaluate(`document.querySelector('[data-settings-category="about"]')?.click(); true`);
    await waitFor(() => panel.evaluate(`Boolean(document.querySelector('[data-capability="voiceOutput"]'))`));
    await panel.evaluate(`document.querySelector('#compatibilityPanel').open = true; true`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const voiceRow = await panel.evaluate(`(() => { const row = document.querySelector('[data-capability="voiceOutput"]'); return { route: row.dataset.voiceRoute, text: row.innerText }; })()`);
    summary.voiceRow = voiceRow;
    assert.equal(voiceRow.route, 'gateway');
    assert.match(voiceRow.text, /Gateway TTS/i);
    assert.match(voiceRow.text, /Speech synthesis failed/, 'the row says why the last read used the browser voice');
    await shot(panel, 'c-diagnostics-voice-row', { clip: '[data-capability="voiceOutput"]' });
    await panel.evaluate(`document.querySelector('[data-capability="voiceOutput"]').scrollIntoView({ block: 'end' }); true`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await shot(panel, 'c-diagnostics-panel');

    // The same reply while read, in Mono Light.
    await panel.evaluate(`document.querySelector('#settingsDialog')?.querySelector('[data-settings-back]')?.click(); true`);
    await store('light');
    await panel.call('Page.reload');
    await ready();
    stub.state.speakMode = 'ok';
    await send(panel, 'Show me the plan once more.');
    await waitFor(() => panel.evaluate(`document.querySelectorAll('.message-row[data-role="assistant"] .message-action-speak').length >= 1`), 30_000);
    await clickSpeaker(panel, 0);
    await waitFor(async () => (await panel.evaluate(speakerState))[0].pressed === 'true' && (await panel.evaluate(speakerState))[0].busy === null, 8000);
    await shot(panel, 'b-reply-reading-light', { clip: '.message-row[data-role="assistant"]' });
    await clickSpeaker(panel, 0);

    console.log(JSON.stringify(summary, null, 2));
    console.log('[e2e] read aloud ok');
  } finally {
    panel?.close();
    setup?.close();
    killProcessTree(chrome);
    await stub.close();
    await rm(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }).catch(() => {});
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
