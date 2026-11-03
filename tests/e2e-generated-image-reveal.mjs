/**
 * Loaded-extension QA for generated pictures in the side panel.
 *
 * Real Chrome for Testing, the real side panel, and a stub gateway that sends the
 * same tool events the gateway sends: tool.started, then tool.completed without the
 * image result (the gateway does not include it). Turn one starts three image
 * generations at once and names their pictures with MEDIA tags in the reply, which is
 * how Hermes reports generated images. Turn two names one picture.
 *
 * What the run checks:
 * - each generation reveals its own picture in its own card while the turn finishes;
 * - the reply then shows every picture inline, with no filename chip and no empty card;
 * - each picture is downloaded from the gateway once, though it is drawn twice.
 *
 * HERMES_E2E_MEDIA_ROUTE=off hides the media route from /v1/capabilities. That is the
 * state where the panel has not confirmed the route; the gateway still serves it.
 *
 * The run is synthetic: the tool events and the reply are fixtures, not a live image
 * provider. The Chrome build is the real unpacked extension.
 *
 * Run: npm run build && node tests/e2e-generated-image-reveal.mjs
 * Screenshots: .hermes/qa/image-reveal-<label>-turn-<n>.png
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

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

const SESSION_ID = 'hermes-browser-extension';
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'image-reveal');
const RUN_ROOT = path.join(ROOT, 'tmp', `e2e-image-reveal-${process.pid}`);
// The side panel treats only paths under .hermes/cache as Hermes-managed media, so the
// fixtures live there, as they do in a real install.
const MEDIA_DIR = path.join(RUN_ROOT, '.hermes', 'cache', 'images');
const PROFILE = path.join(ROOT, 'tmp', `e2e-image-reveal-profile-${process.pid}`);
const QA_DIR = process.env.HERMES_E2E_SCREEN_DIR || path.join(ROOT, '.hermes', 'qa');
const LABEL = process.env.HERMES_E2E_LABEL || 'run';
const MEDIA_ROUTE = process.env.HERMES_E2E_MEDIA_ROUTE === 'off' ? 'off' : 'on';
const FIXTURE_FILES = {
  a: 'option-a.png',
  b: 'option-b.png',
  c: 'option-c.png',
  d: 'option-d.png',
};
const mediaPath = (key) => path.join(MEDIA_DIR, FIXTURE_FILES[key]);
const step = (message) => process.stderr.write(`[image-reveal ${new Date().toISOString().slice(11, 19)}] ${message}\n`);

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The gateway's own shapes: tool.started carries the tool and its call id; tool.completed
// carries a duration and a short preview, not the generated image.
function imageStart(key) {
  return {
    afterMs: 250,
    event: 'tool.started',
    data: { tool: 'image_generate', tool_call_id: `call-${key}`, preview: '' },
  };
}

function imageDone(key, afterMs) {
  return {
    afterMs,
    event: 'tool.completed',
    data: { tool: 'image_generate', tool_call_id: `call-${key}`, duration: 1.2, error: false, preview: 'Image generated' },
  };
}

const TURNS = [
  {
    key: 'three',
    answer: [
      'Here are three options.',
      `MEDIA:${mediaPath('a')}`,
      `MEDIA:${mediaPath('b')}`,
      `MEDIA:${mediaPath('c')}`,
    ].join('\n'),
    steps: [
      imageStart('a'),
      imageStart('b'),
      imageStart('c'),
      imageDone('b', 900),
      imageDone('a', 500),
      imageDone('c', 700),
    ],
  },
  {
    key: 'tagged',
    answer: `Option D is ready.\nMEDIA:${mediaPath('d')}`,
    steps: [imageStart('d'), imageDone('d', 900)],
  },
];

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Hermes-Session-Id, X-Hermes-Session-Key, X-Hermes-Session-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  res.end(body);
}

async function startStubGateway() {
  const mediaRequests = [];
  const requestLog = [];
  const turnQueue = TURNS.map((turn) => ({ ...turn, steps: turn.steps.map((step) => ({ ...step })) }));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const route = url.pathname.replace(/^\/p\/[^/]+/, '');
    requestLog.push(`${req.method} ${route}`);
    if (requestLog.length > 400) requestLog.shift();
    if (route === '/health' || route === '/v1/health') {
      json(res, 200, { status: 'ok' });
      return;
    }
    if (route === '/v1/capabilities') {
      const mediaOn = MEDIA_ROUTE === 'on';
      json(res, 200, {
        object: 'hermes.api_server.capabilities',
        platform: 'hermes-agent',
        features: {
          models: true,
          session_resources: true,
          session_chat: true,
          session_chat_streaming: true,
          run_status: true,
          ...(mediaOn ? { media_api: true } : {}),
        },
        endpoints: {
          models: { method: 'GET', path: '/v1/models' },
          sessions: { method: 'GET', path: '/api/sessions' },
          session_create: { method: 'POST', path: '/api/sessions' },
          session_chat: { method: 'POST', path: '/api/sessions/{session_id}/chat' },
          session_chat_stream: { method: 'POST', path: '/api/sessions/{session_id}/chat/stream' },
          ...(mediaOn ? { media_read: { method: 'GET', path: '/api/media' } } : {}),
        },
      });
      return;
    }
    if (route === '/api/media' && req.method === 'GET') {
      const requested = path.resolve(url.searchParams.get('path') || '');
      mediaRequests.push(path.basename(requested));
      if (!requested.startsWith(MEDIA_DIR + path.sep) || !existsSync(requested)) {
        json(res, 403, { error: { message: 'Path outside media roots' } });
        return;
      }
      const bytes = await readFile(requested);
      json(res, 200, { data_url: `data:image/png;base64,${bytes.toString('base64')}` });
      return;
    }
    if (/\/chat\/stream$/.test(route) && req.method === 'POST') {
      await readBody(req);
      const turn = turnQueue.shift();
      if (!turn) {
        json(res, 409, { error: { message: 'No scripted turn left' } });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      res.write(sse('run.started', { run_id: `image-reveal-${turn.key}` }));
      for (const item of turn.steps) {
        if (item.afterMs) await delay(item.afterMs);
        res.write(sse(item.event, item.data));
      }
      res.write(sse('assistant.completed', { content: turn.answer }));
      res.write(sse('run.completed', {}));
      res.end();
      return;
    }
    if (route === '/api/sessions' && req.method === 'POST') {
      await readBody(req);
      json(res, 200, { session: { id: SESSION_ID } });
      return;
    }
    if (route === '/api/sessions' && req.method === 'GET') {
      json(res, 200, { sessions: [], total: 0 });
      return;
    }
    if (route === '/v1/models') {
      json(res, 200, { data: [{ id: 'e2e/test-model', object: 'model' }] });
      return;
    }
    if (route === '/api/model/options') {
      json(res, 200, { models: [], providers: [] });
      return;
    }
    json(res, 200, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    mediaRequests,
    requestLog,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
      setTimeout(resolve, 3000).unref();
    }),
  };
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

// What the newest assistant reply holds right now: its text, whether the turn still runs,
// and how many of its generations have a picture in the slot.
const turnProbe = `(() => {
  const rows = [...document.querySelectorAll('.message.assistant')];
  const last = rows[rows.length - 1];
  if (!last) return null;
  const slot = last.querySelector('.message-tool-activity');
  return {
    text: last.innerText || '',
    running: document.body.classList.contains('turn-running'),
    revealedInSlot: slot ? slot.querySelectorAll('.generated-image-reveal-source').length : 0,
    placeholdersInSlot: slot ? slot.querySelectorAll('.image-gen-placeholder').length : 0,
  };
})()`;

// Once a turn has settled: the pictures inline in its reply, filename chips, and whether
// the activity slot is still there.
const replyPictures = `(() => {
  const rows = [...document.querySelectorAll('.message.assistant')];
  const last = rows[rows.length - 1];
  if (!last) return null;
  const hash = (text) => {
    let h = 0;
    for (let i = 0; i < text.length; i += 1) h = (Math.imul(h, 31) + text.charCodeAt(i)) >>> 0;
    return h;
  };
  const inline = [...last.querySelectorAll('.message-content img')].map((img) => ({
    width: img.naturalWidth,
    hash: hash(img.src),
  }));
  return {
    inline,
    chips: last.querySelectorAll('.session-media').length,
    unavailable: last.querySelectorAll('.session-media.unavailable').length,
    slotExists: Boolean(last.querySelector('.message-tool-activity')),
  };
})()`;

async function runTurn(panel, prompt, expectText) {
  await submitPrompt(panel, prompt);
  const peaks = { revealedInSlot: 0, placeholdersInSlot: 0 };
  const deadline = Date.now() + 150_000;
  let probe = null;
  while (Date.now() < deadline) {
    probe = await panel.evaluate(turnProbe);
    if (probe) {
      peaks.revealedInSlot = Math.max(peaks.revealedInSlot, probe.revealedInSlot);
      peaks.placeholdersInSlot = Math.max(peaks.placeholdersInSlot, probe.placeholdersInSlot);
      if (probe.text.includes(expectText) && !probe.running) break;
    }
    await delay(150);
  }
  assert.ok(probe && probe.text.includes(expectText) && !probe.running, `turn did not settle: ${expectText}`);
  return peaks;
}

async function saveTurnScreenshot(panel, file) {
  const box = await panel.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.message.assistant')];
    const last = rows[rows.length - 1];
    if (!last) return null;
    const rect = last.getBoundingClientRect();
    return { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: Math.min(rect.width, innerWidth), height: Math.min(rect.height, innerHeight) };
  })()`);
  assert.ok(box && box.height > 0, 'assistant message box missing');
  await mkdir(QA_DIR, { recursive: true });
  const shot = await panel.call('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
  });
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  return file;
}

async function main() {
  assert.ok(existsSync(path.join(DIST, 'manifest.json')), 'Run npm run build before this QA script.');
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  await rm(RUN_ROOT, { recursive: true, force: true });
  await mkdir(MEDIA_DIR, { recursive: true });
  for (const name of Object.values(FIXTURE_FILES)) {
    await copyFile(path.join(FIXTURES, name), path.join(MEDIA_DIR, name));
  }
  await mkdir(QA_DIR, { recursive: true });

  const gateway = await startStubGateway();
  step(`stub gateway ${gateway.baseUrl} (media route ${MEDIA_ROUTE})`);
  let chrome;
  let setup;
  let panel;
  let chromeStderr = '';
  const results = { label: LABEL, mediaRoute: MEDIA_ROUTE, gateway: gateway.baseUrl };
  try {
    const extensionId = unpackedExtensionId(DIST);
    chrome = launchChrome(chromeExecutable(), [
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
    step('chrome devtools up');
    await ensureExtensionStartupPage(devtoolsBase, extensionId);
    step('extension startup page ready');

    const startup = (await fetchJson(`${devtoolsBase}/json/list`)).find((target) => (
      target.type === 'page' && String(target.url || '').startsWith(`chrome-extension://${extensionId}/`)
    ));
    setup = new CdpClient(startup.webSocketDebuggerUrl);
    await setup.connect();
    await setup.call('Runtime.enable');
    step('setup page connected');
    await waitFor(() => setup.evaluate('Boolean(globalThis.chrome?.storage?.local)'));
    step('storage ready');
    await setup.evaluate(`chrome.storage.local.set({hermesBrowserSettings:${JSON.stringify({
      connectionSchemaVersion: 1,
      connectionMode: 'local',
      connectionTransport: 'local-api',
      gatewayMode: 'local-api',
      gatewayUrl: gateway.baseUrl,
      apiKey: 'e2e-gateway-key',
      tokenSource: 'qa',
      sessionId: SESSION_ID,
      sessionStartMode: 'fresh',
      model: 'e2e/test-model',
      appearanceTheme: 'mono',
      colorMode: 'light',
    })}, hermesBrowserIntroSeen: true})`);

    const pageTarget = await fetchJson(
      `${devtoolsBase}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/sidepanel.html`)}`,
      { method: 'PUT' },
    );
    step('settings seeded; panel page opened');
    panel = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await panel.connect();
    {
      const previous = panel.socket.onmessage;
      panel.socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.method === 'Page.javascriptDialogOpening') {
          step(`dialog opened (${message.params.type}): ${String(message.params.message).slice(0, 120)}`);
          panel.socket.send(JSON.stringify({ id: 900001, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
        }
        previous(event);
      };
    }
    step('panel connected');
    // A stalled page should fail one call, not hang the whole run.
    const rawCall = panel.call.bind(panel);
    panel.call = (method, params) => Promise.race([
      rawCall(method, params),
      delay(15_000).then(() => { throw new Error(`CDP ${method} did not answer within 15s`); }),
    ]);
    await panel.call('Runtime.enable');
    await panel.call('Page.enable');
    step('panel domains enabled');
    await panel.call('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
    await panel.call('Page.bringToFront');
    step('panel in front');
    await waitFor(() => panel.evaluate(`document.visibilityState === 'visible'`));
    await waitFor(() => panel.evaluate(`(() => {
      const startup = document.querySelector('#startupScreen');
      const input = document.querySelector('#promptInput');
      return Boolean(startup?.hidden && input && !input.disabled);
    })()`), 30_000);
    step('panel ready; sending turn one');

    const peaksOne = await runTurn(panel, 'Make three options', 'Here are three options.');
    step('turn one settled');
    await delay(1500);
    results.turnOne = { peaks: peaksOne, ...(await panel.evaluate(replyPictures)) };
    results.turnOneScreenshot = await saveTurnScreenshot(panel, path.join(QA_DIR, `image-reveal-${LABEL}-turn-1.png`));

    step('sending turn two');
    const peaksTwo = await runTurn(panel, 'Make option D', 'Option D is ready.');
    step('turn two settled');
    await delay(1500);
    results.turnTwo = { peaks: peaksTwo, ...(await panel.evaluate(replyPictures)) };
    results.turnTwoScreenshot = await saveTurnScreenshot(panel, path.join(QA_DIR, `image-reveal-${LABEL}-turn-2.png`));

    results.mediaRequests = gateway.mediaRequests.length;
    const perFile = {};
    for (const name of gateway.mediaRequests) perFile[name] = (perFile[name] || 0) + 1;
    results.mediaRequestsPerFile = perFile;
    results.chromeStderrTail = chromeStderr.split('\n').slice(-3).join('\n');

    const one = results.turnOne;
    assert.equal(one.chips, 0, 'turn one shows no filename chip');
    assert.equal(one.unavailable, 0, 'turn one shows no unavailable picture');
    assert.equal(one.inline.length, 3, 'turn one shows its three pictures inline');
    assert.ok(one.inline.every((item) => item.width > 0), 'every picture decoded');
    assert.equal(new Set(one.inline.map((item) => item.hash)).size, 3, 'the three pictures are distinct');
    assert.equal(one.slotExists, false, 'the reply took over the pictures; no activity slot is left');
    assert.equal(peaksOne.revealedInSlot, 3, 'each generation revealed its own picture before the reply showed them');

    const two = results.turnTwo;
    assert.equal(two.chips, 0, 'turn two shows no filename chip');
    assert.equal(two.inline.length, 1, 'turn two shows its picture exactly once');
    assert.ok(two.inline[0].width > 0, 'turn two picture decoded');
    assert.equal(peaksTwo.revealedInSlot, 1, 'turn two revealed its picture in its generation');

    for (const name of Object.values(FIXTURE_FILES)) {
      assert.equal(perFile[name] || 0, 1, `${name} is downloaded once, though drawn twice`);
    }

    results.ok = true;
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    results.ok = false;
    results.error = String(error?.message || error);
    results.requests = [...new Set(gateway.requestLog)].slice(0, 60);
    if (panel) {
      results.startupScreen = await Promise.race([
        panel.evaluate("(() => { const s = document.querySelector('#startupScreen'); return { hidden: s?.hidden, text: (s?.innerText || '').replace(/\s+/g, ' ').slice(0, 300) }; })()"),
        delay(4000).then(() => 'timed out reading startup screen'),
      ]);
    }
    results.chromeStderrTail = chromeStderr.split('\n').slice(-3).join('\n');
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = 1;
  } finally {
    try { setup?.close?.(); } catch { /* best effort */ }
    try { panel?.close?.(); } catch { /* best effort */ }
    if (chrome) killChrome(chrome);
    await gateway.close();
    await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
    await rm(RUN_ROOT, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
