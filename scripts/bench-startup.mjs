#!/usr/bin/env node
/**
 * bench-startup.mjs — HBE side-panel startup latency benchmark (Train 1 Phase 0).
 *
 * Plan: docs/plans/2026-08-22-master-plan-pack/2026-08-22-startup-speed-instant-load-plan.md
 *
 * Measures ms from panel page creation -> composer focusable (`#promptInput`
 * enabled/visible) using performance marks injected by extension/sidepanel.js
 * (window.__HBE_BOOT_MARKS contract). Sample totals are hard assertions: every
 * run must produce exactly --opens measured samples or exit 1.
 *
 * Scenarios:
 *   default          embedded fixture gateway serves the readiness chain
 *                    (/health, /v1/capabilities, /v1/models, /api/model/options,
 *                    /v1/skills, /v1/profiles*404-by-design, /api/sessions CRUD)
 *   --gateway-down   same seeded credentials but gatewayUrl points at a
 *                    guaranteed-dead local port (127.0.0.1:9)
 *
 * Modes:
 *   cold             each open runs from a freshly CLONED pristine profile
 *                    (template built once by a seeding open, so every cold open
 *                    measures a realistic configured-client restart, not a blank slate)
 *   warm             same profile reused across opens; open 1 only seeds settings
 *                    and is discarded from aggregates
 *
 * Usage:
 *   node scripts/bench-startup.mjs --mode cold --opens 20 [--gateway-down] [--label NAME]
 *   node scripts/bench-startup.mjs --mode warm --opens 20 [--gateway-down] [--label NAME]
 *
 * Output: human table on stdout; JSON report under tmp/bench/results/.
 * Exit codes: 0 ok / 1 sample shortfall or chrome failure / 2 usage error.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_EXT = process.env.HBE_BENCH_EXT || path.join(ROOT, 'dist');
const DEFAULT_CHROME = process.env.CHROME_PATH || path.join(ROOT, 'tmp', 'bench', 'tools', 'chrome-win64', 'chrome.exe');
const BENCH_DIR = path.join(ROOT, 'tmp', 'bench');

const BENCH_TOKEN = 'bench-local-token';
const DEAD_URL = 'http://127.0.0.1:9';

const MARK_NAMES = [
  'panel:body-start',
  'panel:i18n-ready',
  'panel:settings-restored',
  'panel:messages-painted',
  'panel:interactive',
];

function parseArgs(argv) {
  const out = {
    mode: null,
    opens: NaN,
    gatewayDown: false,
    extDir: DEFAULT_EXT,
    chromeExe: DEFAULT_CHROME,
    label: 'bench',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return null;
    else if (arg === '--mode') out.mode = argv[++i];
    else if (arg === '--opens') out.opens = Number(argv[++i]);
    else if (arg === '--warm') out.mode = 'warm';
    else if (arg === '--cold') out.mode = 'cold';
    else if (arg === '--gateway-down') out.gatewayDown = true;
    else if (arg === '--ext') out.extDir = argv[++i];
    else if (arg === '--chrome') out.chromeExe = argv[++i];
    else if (arg === '--label') out.label = argv[++i];
    else return null;
  }
  if (!out.mode || (out.mode !== 'cold' && out.mode !== 'warm')) return null;
  if (!Number.isFinite(out.opens) || out.opens < 1) return null;
  return out;
}

const showHelp = process.argv.slice(2).includes('--help') || process.argv.slice(2).includes('-h');
const args = parseArgs(process.argv.slice(2));
if (!args) {
  console.error('usage: node scripts/bench-startup.mjs --mode cold|warm --opens N [--gateway-down] [--ext DIR] [--chrome PATH] [--label NAME]');
  process.exit(showHelp ? 0 : 2);
}
const { mode, opens, gatewayDown, extDir, chromeExe, label } = args;

if (!existsSync(extDir)) {
  console.error(`error: extension build dir not found: ${extDir} (run npm run build)`);
  process.exit(2);
}
if (!existsSync(chromeExe)) {
  console.error(`error: chrome executable not found: ${chromeExe} (set CHROME_PATH or pass --chrome)`);
  process.exit(2);
}

await mkdir(path.join(BENCH_DIR, 'profiles'), { recursive: true });
await mkdir(path.join(BENCH_DIR, 'results'), { recursive: true });

/** Deterministic unpacked-extension id (same algorithm as tests/e2e-loaded-extension.mjs). */
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
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

/**
 * Embedded fixture gateway. Route shapes mirror tests/e2e-loaded-extension.mjs,
 * whose assertions prove they satisfy the readiness chain end to end.
 */
function createFixtureGateway() {
  const sessions = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        handle(req, res, url, body ? JSON.parse(body) : {});
      } catch {
        json(res, 400, { error: { message: 'bad fixture request' } });
      }
    });

    function handle(req2, res2, parsed, bodyJson) {
      if (parsed.pathname === '/health' || parsed.pathname === '/v1/health') {
        json(res2, 200, { status: 'ok', platform: 'hermes-agent', version: 'bench-fixture' });
        return;
      }
      if (req2.headers.authorization !== `Bearer ${BENCH_TOKEN}`) {
        json(res2, 401, { error: { message: 'Unauthorized', type: 'authentication_error' } });
        return;
      }
      if (parsed.pathname === '/v1/capabilities') {
        json(res2, 200, {
          object: 'hermes.api_server.capabilities',
          platform: 'hermes-agent',
          auth: { type: 'bearer', required: true },
          features: {
            models_api: true,
            session_resources: true,
            session_chat: true,
            session_chat_streaming: true,
            skills_api: true,
          },
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
        return;
      }
      if (parsed.pathname === '/api/model/options') {
        json(res2, 200, {
          providers: [{
            slug: 'bench',
            name: 'Bench Provider',
            authenticated: true,
            models: [{ id: 'bench/test-model', label: 'Bench Test Model', context_length: 32_000 }],
            capabilities: { 'bench/test-model': { reasoning: true, fast: true } },
          }],
        });
        return;
      }
      if (parsed.pathname === '/v1/models') {
        json(res2, 200, { object: 'list', data: [
          { id: 'bench-gateway', object: 'model', owned_by: 'hermes', root: 'bench-gateway', parent: null },
          { id: 'bench/test-model', provider: 'bench', context_length: 32_000 },
        ] });
        return;
      }
      if (parsed.pathname === '/v1/skills' || parsed.pathname === '/v1/toolsets') {
        json(res2, 200, { object: 'list', data: [] });
        return;
      }
      if (parsed.pathname === '/api/profiles' || parsed.pathname === '/api/profiles/active') {
        // Profiles are an optional route; e2e proves readiness tolerates its absence.
        json(res2, 404, { error: { message: 'Optional profile API unavailable' } });
        return;
      }
      if (parsed.pathname === '/api/sessions' && req2.method === 'GET') {
        json(res2, 200, { object: 'list', data: sessions, total: sessions.length, has_more: false });
        return;
      }
      if (parsed.pathname === '/api/sessions' && req2.method === 'POST') {
        const requestedId = bodyJson?.id || bodyJson?.session_id || 'hermes-browser-extension-bench';
        const acknowledgedModel = bodyJson?.model || 'bench/test-model';
        const acknowledgedProvider = bodyJson?.provider || 'bench';
        const session = {
          id: requestedId,
          session_id: requestedId,
          title: bodyJson?.title || 'Hermes Browser Extension',
          source: bodyJson?.source || 'hermes_browser_extension',
          model: acknowledgedModel,
          provider: acknowledgedProvider,
        };
        sessions.splice(0, sessions.length, session);
        json(res2, 201, session);
        return;
      }
      const messagesMatch = parsed.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (messagesMatch && req2.method === 'GET') {
        json(res2, 200, { object: 'list', data: [] });
        return;
      }
      const sessionMatch = parsed.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch && req2.method === 'GET') {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        json(res2, 200, sessions.find((s) => s.id === sessionId) || {
          id: sessionId,
          session_id: sessionId,
          title: 'Hermes Browser Extension',
          source: 'hermes_browser_extension',
        });
        return;
      }
      json(res2, 404, { error: { message: `fixture: no route for ${parsed.pathname}` } });
    }
  });
  return {
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function httpJson(url, timeoutMs = 5000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).then((r) => r.json());
}

async function waitUntil(fn, timeoutMs = 15000, intervalMs = 100) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError || new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

function killTree(pid) {
  if (process.platform !== 'win32') {
    try { process.kill(pid); } catch { /* already gone */ }
    return;
  }
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
}

class SimpleCdpSocket {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('ws connect failed')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || 'cdp error'));
        else resolve(message.result);
      }
    });
  }
  call(method, params = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify({ id, method, params }));
    return promise;
  }
  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed');
    return result?.result?.value;
  }
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

const EXT_ID = unpackedExtensionId(extDir);
const SCENARIO_TAG = `${label}-${mode}${gatewayDown ? '-gwdown' : '-gwup'}`;
const WARM_PROFILE = path.join(BENCH_DIR, 'profiles', `${SCENARIO_TAG}-warm`);
const TEMPLATE_PROFILE = path.join(BENCH_DIR, 'profiles', `${SCENARIO_TAG}-template`);

function seededSettings() {
  return {
    connectionMode: 'local',
    connectionTransport: 'local-api',
    gatewayUrl: gatewayDown ? DEAD_URL : `http://127.0.0.1:${GATEWAY_PORT}`,
    apiKey: BENCH_TOKEN,
  };
}

async function launchChrome(profileDir) {
  // Reused profiles carry a stale DevToolsActivePort from the previous instance;
  // the authoritative source is chrome's own stderr announcement.
  await rm(path.join(profileDir, 'DevToolsActivePort'), { force: true });
  const child = spawn(chromeExe, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    `chrome-extension://${EXT_ID}/sidepanel.html`,
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderrTail = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('chrome devtools never announced')), 30000);
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-1500);
      const match = String(chunk).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${Number(match[1])}`);
      }
    });
  });
  child.stderrTail = () => stderrTail;
  const devtoolsBase = await ready;
  return { child, devtoolsBase };
}

async function findPanelTarget(devtoolsBase) {
  return waitUntil(async () => {
    const list = await httpJson(`${devtoolsBase}/json/list`);
    return list.find((t) => t.type === 'page' && String(t.url || '').includes(`${EXT_ID}/sidepanel.html`)) || null;
  }, 30000);
}

async function connectPanelSocket(devtoolsBase) {
  const target = await findPanelTarget(devtoolsBase);
  assert(target, 'no sidepanel.html target found');
  assert(target.webSocketDebuggerUrl, 'panel target lacks webSocketDebuggerUrl');
  const sock = new SimpleCdpSocket(target.webSocketDebuggerUrl);
  await sock.ready;
  return sock;
}

/**
 * Open 1 of a warm scenario (and the template-builder pass): boot the panel
 * unconfigured, write the scenario's settings while it idles at the gate, quit.
 * Result: storage.local holds credentials + connection config for later opens.
 */
async function prepareProfileWithSeedOpen(profileDir) {
  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });
  const { child, devtoolsBase } = await launchChrome(profileDir);
  try {
    const sock = await connectPanelSocket(devtoolsBase);
    const seededOk = await sock.evaluate(`(() => {
      const api = (globalThis.browserApi && globalThis.browserApi.storage)
        ? globalThis.browserApi.storage.local
        : (globalThis.chrome && globalThis.chrome.storage ? globalThis.chrome.storage.local : null);
      if (!api) return false;
      return api.get('hermesBrowserSettings').then((stored) =>
        api.set({ hermesBrowserSettings: { ...(stored?.hermesBrowserSettings || {}), ...${JSON.stringify(seededSettings())} } }),
      ).then(() => true).catch(() => false);
    })()`);
    assert.equal(seededOk, true, 'failed to preseed hermesBrowserSettings (browserApi bridge unavailable?)');
    sock.close();
  } finally {
    killTree(child.pid);
    if (process.platform === 'win32') await new Promise((r) => setTimeout(r, 300));
  }
}

async function openAndMeasure({ runIndex, profileDir }) {
  let sock = null;
  const { child, devtoolsBase } = await launchChrome(profileDir);
  try {
    sock = await connectPanelSocket(devtoolsBase);

    const interactiveAt = await waitUntil(async () => {
      return sock.evaluate(`(() => {
        const marks = Array.isArray(window.__HBE_BOOT_MARKS) ? window.__HBE_BOOT_MARKS : null;
        if (!marks) return null;
        if (!marks.some((m) => m.measure === 'panel:interactive')) return null;
        const el = document.querySelector('#promptInput');
        return {
          marks,
          composerReady: !!(el && !el.disabled && el.offsetParent !== null),
          url: location.href,
        };
      })()`);
    }, 60000);

    assert.equal(interactiveAt.composerReady, true, 'composer not focusable after panel:interactive mark');
    assert.equal(interactiveAt.marks.some((m) => m.mark === 'panel:body-start'), true, 'missing panel:body-start mark');

    const marks = interactiveAt.marks;
    const measureInteractive = marks.find((m) => m.measure === 'panel:interactive');
    const measurePaint = marks.find((m) => m.measure === 'panel:messages-painted');
    return {
      open: runIndex,
      mode: mode,
      ms_to_interactive: Math.round(measureInteractive.dur),
      ms_to_messages_painted: measurePaint ? Math.round(measurePaint.dur) : null,
      stage_settles_ms: Object.fromEntries(
        marks.filter((m) => m.measure === 'panel:stage-settle').map((m) => [m.stage, Math.round(m.dur)]),
      ),
    };
  } catch (error) {
    console.error(`[open ${runIndex}] failed: ${error.message}\n${child.stderrTail()}`);
    return null;
  } finally {
    if (sock) sock.close();
    killTree(child.pid);
  }
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return NaN;
  const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, idx)];
}

let GATEWAY_PORT = 0;
const gateway = createFixtureGateway();

console.log(`bench-startup: mode=${mode}${gatewayDown ? ' +gateway-down (dead 127.0.0.1:9)' : ' +embedded fixture gateway'} opens=${opens}`);
console.log(`extension=${path.basename(extDir)} chrome=${path.basename(chromeExe)}`);

// ---- embedded gateway lifecycle -------------------------------------------
if (!gatewayDown) {
  GATEWAY_PORT = await gateway.listen();
  console.log(`fixture gateway listening on http://127.0.0.1:${GATEWAY_PORT} (token ${BENCH_TOKEN})`);
}

try {
  const samples = [];

  if (mode === 'warm') {
    console.log('seeding warm profile (open A: unconfigured boot + settings write, discarded)...');
    await prepareProfileWithSeedOpen(WARM_PROFILE);
    for (let i = 1; i <= opens; i++) {
      const sample = await openAndMeasure({ runIndex: i, profileDir: WARM_PROFILE });
      if (!sample) continue;
      samples.push(sample);
      console.log(`open ${String(i).padStart(3)} | interactive=${sample.ms_to_interactive}ms painted=${sample.ms_to_messages_painted ?? 'n/a'}ms`);
    }
  } else {
    console.log('building cold template profile (one seeding open, reused read-only)...');
    await prepareProfileWithSeedOpen(TEMPLATE_PROFILE);
    for (let i = 1; i <= opens; i++) {
      const cloneDir = path.join(BENCH_DIR, 'profiles', `${SCENARIO_TAG}-cold-${i}`);
      await rm(cloneDir, { recursive: true, force: true });
      await cp(TEMPLATE_PROFILE, cloneDir, { recursive: true });
      // Stale debug artifacts would poison the next boot's port discovery.
      for (const staleName of ['DevToolsActivePort']) {
        await rm(path.join(cloneDir, staleName), { force: true });
      }
      const sample = await openAndMeasure({ runIndex: i, profileDir: cloneDir });
      if (!sample) continue;
      samples.push(sample);
      console.log(`open ${String(i).padStart(3)} | interactive=${sample.ms_to_interactive}ms painted=${sample.ms_to_messages_painted ?? 'n/a'}ms`);
    }
  }

  if (samples.length !== opens) {
    console.error(`FAIL: collected ${samples.length}/${opens} measured samples (hard assertion)`);
    await writeFile(
      path.join(BENCH_DIR, 'results', `incomplete-${SCENARIO_TAG}.json`),
      JSON.stringify({ status: 'incomplete', expected: opens, got: samples.length }, null, 2),
    );
    process.exitCode = 1;
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const interactions = samples.map((s) => s.ms_to_interactive).sort((a, b) => a - b);
    const paints = samples.map((s) => s.ms_to_messages_painted).filter((v) => v != null).sort((a, b) => a - b);
    const report = {
      stamp,
      label,
      scenario: `${mode}${gatewayDown ? '+gateway-down' : '+fixture-gateway-up'}`,
      gateway_up: !gatewayDown,
      opens,
      extension: extDir,
      chrome: chromeExe,
      marks_contract: MARK_NAMES,
      p50_interactive: percentile(interactions, 50),
      p90_interactive: percentile(interactions, 90),
      p50_painted: paints.length ? percentile(paints, 50) : null,
      p90_painted: paints.length ? percentile(paints, 90) : null,
      samples,
    };
    report.summary = `${report.scenario}: n=${opens} p50=${report.p50_interactive}ms p90=${report.p90_interactive}ms`;
    const resultsFile = path.join(BENCH_DIR, 'results', `${stamp}-${SCENARIO_TAG}.json`);
    await writeFile(resultsFile, JSON.stringify(report, null, 2));
    console.log(report.summary);
    console.log(`json: ${resultsFile}`);
  }
} finally {
  if (!gatewayDown) await gateway.close();
}
