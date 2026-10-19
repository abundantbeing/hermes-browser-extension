/**
 * Loaded-extension QA for the approval and clarify cards.
 *
 * Real Chrome for Testing, the real side panel, and a stub Hermes gateway that
 * pauses a streamed turn on an approval or clarify request and only continues
 * when the answer arrives on /v1/runs/{id}/approval or /clarify. Clicks and keys
 * are sent as trusted browser input (Input.dispatchMouseEvent / dispatchKeyEvent).
 *
 * Run: node tests/e2e-agent-prompt-cards.mjs
 * Screenshots: .hermes/qa/prompt-card-*.png (HERMES_E2E_SCREEN_DIR overrides the folder)
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { typeTrusted } from './e2e-assist-driver.mjs';
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

const PROFILE = path.join(ROOT, 'tmp', `e2e-agent-prompt-cards-${process.pid}`);
const QA_DIR = process.env.HERMES_E2E_SCREEN_DIR || path.join(ROOT, '.hermes', 'qa');
const TEST_TOKEN = 'hermes-prompt-card-token';
const SESSION_ID = 'hermes-browser-extension';

const HOSTILE_COMMAND = `echo '<img src=x onerror="document.title=1">' && rm -rf ./build-output`;

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

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// A scenario is one streamed turn that pauses on a prompt:
//   { runId, event: [name, data], control: pending_controls entry, answer: text }
async function startStubGateway() {
  const requests = [];
  const replies = [];
  const queue = [];
  const open = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const body = req.method === 'POST' ? await readBody(req) : null;
    requests.push({ method: req.method, path: url.pathname, body });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Hermes-Session-Id, X-Hermes-Session-Key, X-Hermes-Session-Token',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      });
      res.end();
      return;
    }
    if (url.pathname === '/health' || url.pathname === '/v1/health') {
      json(res, 200, { status: 'ok', platform: 'hermes-agent', version: 'qa' });
      return;
    }
    if (url.pathname === '/v1/capabilities') {
      json(res, 200, {
        object: 'hermes.api_server.capabilities',
        version: 'qa',
        endpoints: {
          health: { method: 'GET', path: '/health' },
          sessions: { method: 'GET', path: '/api/sessions' },
          session_create: { method: 'POST', path: '/api/sessions' },
          session_chat: { method: 'POST', path: '/api/sessions/{session_id}/chat' },
          run_status: { method: 'GET', path: '/v1/runs/{run_id}' },
          run_approval: { method: 'POST', path: '/v1/runs/{run_id}/approval' },
          run_clarify: { method: 'POST', path: '/v1/runs/{run_id}/clarify' },
        },
        features: {
          models: true,
          session_resources: true,
          session_chat: true,
          session_chat_streaming: true,
          run_status: true,
          run_approval: true,
          run_clarify: true,
          approval_events: true,
        },
      });
      return;
    }
    if (/\/chat\/stream$/.test(url.pathname) && req.method === 'POST') {
      const scenario = queue.shift();
      if (!scenario) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
        res.end(sse('assistant.completed', { content: 'plain answer' }) + sse('run.completed', {}));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      res.write(sse('run.started', { run_id: scenario.runId }));
      res.write(sse(scenario.event[0], scenario.event[1]));
      open.set(scenario.runId, { res, scenario, pending: true });
      return;
    }
    const runRoute = url.pathname.match(/^\/v1\/runs\/([^/]+)(?:\/(approval|clarify))?$/);
    if (runRoute) {
      const entry = open.get(decodeURIComponent(runRoute[1]));
      if (req.method === 'GET' && !runRoute[2]) {
        if (entry?.pending) {
          json(res, 200, { run_id: entry.scenario.runId, status: 'waiting_for_approval', pending_controls: [entry.scenario.control] });
        } else {
          json(res, 200, { run_id: runRoute[1], status: 'completed', pending_controls: [] });
        }
        return;
      }
      if (req.method === 'POST' && runRoute[2] && entry?.pending) {
        replies.push({ route: runRoute[2], runId: runRoute[1], body });
        entry.pending = false;
        json(res, 200, { ok: true });
        entry.res.write(sse('assistant.completed', { content: entry.scenario.answer }));
        entry.res.write(sse('run.completed', {}));
        entry.res.end();
        return;
      }
      json(res, 404, { error: { message: 'No such run.' } });
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      json(res, 200, { session: { id: (body && body.id) || SESSION_ID } });
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      json(res, 200, { sessions: [], total: 0 });
      return;
    }
    if (url.pathname === '/v1/models') {
      json(res, 200, { data: [{ id: 'e2e/test-model', object: 'model' }] });
      return;
    }
    if (url.pathname === '/api/model/options') {
      json(res, 200, { models: [], providers: [] });
      return;
    }
    json(res, 200, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    replies,
    queue: (scenario) => queue.push(scenario),
    close: () => new Promise((resolve) => {
      for (const { res } of open.values()) { try { res.destroy(); } catch { /* best effort */ } }
      server.close(resolve);
    }),
  };
}

async function saveScreenshot(client, name) {
  await mkdir(QA_DIR, { recursive: true });
  const shot = await client.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  assert.ok(shot.data, `Screenshot data missing for ${name}`);
  const file = path.join(QA_DIR, name);
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  return file;
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

async function trustedClick(panel, selector) {
  const point = await panel.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    node.scrollIntoView({ block: 'center' });
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`);
  assert.ok(point, `${selector} is not showing`);
  await panel.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
  await panel.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await panel.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
}

// The next prompt would be queued behind a turn that is still finishing, so wait
// for the reply of the turn that was just answered.
async function waitForReply(panel, text) {
  await waitFor(() => panel.evaluate(`document.querySelector('#messages').textContent.includes(${JSON.stringify(text)})`), 20_000);
  await waitFor(() => panel.evaluate(`document.querySelector('#stopButton')?.hidden === true`), 20_000);
}

async function pressEnter(panel) {
  await panel.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await panel.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}

const cardState = (panel) => panel.evaluate(`(() => {
  const card = document.querySelector('#agentPromptCard');
  const rect = card.getBoundingClientRect();
  const active = document.activeElement;
  return {
    showing: !card.hidden && rect.width > 0 && rect.height > 0,
    kind: card.dataset.kind || '',
    text: card.textContent.replace(/\\s+/g, ' ').trim(),
    command: card.querySelector('.agent-prompt-command')?.textContent || '',
    choices: [...card.querySelectorAll('[data-choice]')].map((node) => node.dataset.choice),
    choiceLabels: [...card.querySelectorAll('[data-choice]')].map((node) => node.textContent.trim()),
    answerChoices: [...card.querySelectorAll('.agent-prompt-choice')].map((node) => node.textContent.trim()),
    focusedChoice: card.contains(active) ? (active.dataset?.choice || active.className || '') : '',
    countdown: card.querySelector('.agent-prompt-countdown')?.textContent || '',
    injectedElements: card.querySelectorAll('img, script, iframe').length,
    docTitle: document.title,
    width: rect.width,
  };
})()`);

async function main() {
  assert.ok(existsSync(path.join(DIST, 'manifest.json')), 'Run npm run build before this QA script.');
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  await mkdir(QA_DIR, { recursive: true });

  const gateway = await startStubGateway();
  let chrome;
  let setup;
  let panel;
  let chromeStderr = '';
  try {
    const extensionId = unpackedExtensionId(DIST);
    chrome = spawn(chromeExecutable(), [
      '--headless=new',
      // A test browser never makes noise. A page with a video stays silent.
      '--mute-audio',
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
    await ensureExtensionStartupPage(devtoolsBase, extensionId);

    const startup = (await fetchJson(`${devtoolsBase}/json/list`)).find((target) => (
      target.type === 'page' && String(target.url || '').startsWith(`chrome-extension://${extensionId}/`)
    ));
    setup = new CdpClient(startup.webSocketDebuggerUrl);
    await setup.connect();
    await setup.call('Runtime.enable');
    await waitFor(() => setup.evaluate('Boolean(globalThis.chrome?.storage?.local)'));
    await setup.evaluate(`chrome.storage.local.set({hermesBrowserSettings:${JSON.stringify({
      connectionSchemaVersion: 1,
      connectionMode: 'local',
      connectionTransport: 'local-api',
      gatewayMode: 'local-api',
      gatewayUrl: gateway.baseUrl,
      apiKey: TEST_TOKEN,
      tokenSource: 'qa',
      sessionId: SESSION_ID,
      sessionStartMode: 'fresh',
      model: 'e2e/test-model',
      appearanceTheme: 'mono',
      colorMode: 'dark',
    })}, hermesBrowserIntroSeen: true})`);

    const pageTarget = await fetchJson(
      `${devtoolsBase}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/sidepanel.html`)}`,
      { method: 'PUT' },
    );
    panel = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await panel.connect();
    await panel.call('Runtime.enable');
    await panel.call('Page.enable');
    await panel.call('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 1, mobile: false });
    await panel.call('Page.bringToFront');
    await waitFor(() => panel.evaluate(`document.visibilityState === 'visible'`));
    await waitFor(() => panel.evaluate(`(() => {
      const startup = document.querySelector('#startupScreen');
      const input = document.querySelector('#promptInput');
      return Boolean(startup?.hidden && input && !input.disabled);
    })()`), 30_000);

    const results = {};

    // ---- Approval: allow once -------------------------------------------------
    gateway.queue({
      runId: 'run-approval-once',
      event: ['approval.request', {
        request_id: 'req-once',
        execution_generation: 3,
        command: HOSTILE_COMMAND,
        description: 'Deletes the build output folder.',
        choices: ['once', 'session', 'always', 'deny'],
        timeout_s: 300,
      }],
      control: {
        kind: 'approval', prompt_id: 'req-once', execution_generation: 3, command: HOSTILE_COMMAND,
        description: 'Deletes the build output folder.', choices: ['once', 'session', 'always', 'deny'], timeout_s: 300,
      },
      answer: 'Approved, the build output was removed.',
    });
    await submitPrompt(panel, 'Clean the build output.');
    const approval = await waitFor(async () => {
      const state = await cardState(panel);
      return state.showing && state.kind === 'approval' ? state : null;
    }, 20_000);
    assert.equal(approval.command, HOSTILE_COMMAND, 'the command is shown exactly as the gateway sent it');
    assert.equal(approval.injectedElements, 0, 'gateway text must be set as text, never parsed as markup');
    assert.equal(approval.docTitle === '1', false, 'a hostile command must not run script in the panel');
    assert.deepEqual(approval.choices, ['once', 'session', 'always', 'deny']);
    assert.equal(approval.focusedChoice, 'deny', 'Deny holds focus so a stray Enter refuses');
    assert.match(approval.countdown, /\d/);
    assert.ok(approval.width > 0 && approval.width <= 420, `card fits the panel (${approval.width}px)`);
    assert.equal(gateway.replies.length, 0, 'nothing is sent before the user answers');
    results.approvalCard = await saveScreenshot(panel, 'prompt-card-approval.png');

    await trustedClick(panel, '#agentPromptCard [data-choice="once"]');
    await waitFor(() => gateway.replies.length === 1);
    assert.deepEqual(gateway.replies[0], {
      route: 'approval',
      runId: 'run-approval-once',
      body: { request_id: 'req-once', execution_generation: 3, choice: 'once' },
    });
    await waitFor(async () => !(await cardState(panel)).showing);
    await waitForReply(panel, 'Approved, the build output was removed.');

    // ---- Approval: deny -------------------------------------------------------
    gateway.queue({
      runId: 'run-approval-deny',
      event: ['approval.request', {
        request_id: 'req-deny', execution_generation: 1, command: 'sudo shutdown now', description: 'Shuts the machine down.',
        choices: ['once', 'deny'], timeout_s: 300,
      }],
      control: { kind: 'approval', prompt_id: 'req-deny', execution_generation: 1, command: 'sudo shutdown now', choices: ['once', 'deny'], timeout_s: 300 },
      answer: 'Understood, I did not run it.',
    });
    await submitPrompt(panel, 'Shut it down.');
    const narrow = await waitFor(async () => {
      const state = await cardState(panel);
      return state.showing && /shutdown/.test(state.command) ? state : null;
    }, 20_000);
    assert.deepEqual(narrow.choices, ['once', 'deny'], 'only the choices the gateway offered are rendered');
    await trustedClick(panel, '#agentPromptCard [data-choice="deny"]');
    await waitFor(() => gateway.replies.length === 2);
    assert.deepEqual(gateway.replies[1].body, { request_id: 'req-deny', execution_generation: 1, choice: 'deny' });
    await waitFor(async () => !(await cardState(panel)).showing);
    await waitForReply(panel, 'Understood, I did not run it.');

    // ---- File edit approval: diff, one-time consent only ----------------------
    gateway.queue({
      runId: 'run-edit',
      event: ['approval.request', {
        request_id: 'req-edit', execution_generation: 2, timeout_s: 300, choices: ['once', 'session', 'always', 'deny'],
        edit: { path: 'src/config.json', tool_name: 'patch', old_text: 'port: 80\nmode: dev', new_text: 'port: 8080\nmode: dev' },
      }],
      control: {
        kind: 'approval', prompt_id: 'req-edit', execution_generation: 2, timeout_s: 300,
        edit: { path: 'src/config.json', old_text: 'port: 80\nmode: dev', new_text: 'port: 8080\nmode: dev' },
      },
      answer: 'Edit applied.',
    });
    await submitPrompt(panel, 'Change the port.');
    const edit = await waitFor(async () => {
      const state = await cardState(panel);
      return state.showing && /src\/config\.json/.test(state.text) ? state : null;
    }, 20_000);
    assert.deepEqual(edit.choices, ['once', 'deny'], 'an edit is a one-time consent, never a session or permanent grant');
    assert.match(edit.text, /port: 8080/);
    results.editCard = await saveScreenshot(panel, 'prompt-card-edit.png');
    await trustedClick(panel, '#agentPromptCard [data-choice="once"]');
    await waitFor(() => gateway.replies.length === 3);
    assert.equal(gateway.replies[2].body.choice, 'once');
    await waitFor(async () => !(await cardState(panel)).showing);
    await waitForReply(panel, 'Edit applied.');

    // ---- Clarify with choices: a click answers --------------------------------
    gateway.queue({
      runId: 'run-clarify-choice',
      event: ['clarify.request', {
        prompt_id: 'clar-choice', execution_generation: 4, question: 'Which environment should I deploy to?',
        choices: ['staging', 'production'], timeout_s: 120,
      }],
      control: {
        kind: 'clarify', prompt_id: 'clar-choice', execution_generation: 4, question: 'Which environment should I deploy to?',
        choices: ['staging', 'production'], timeout_s: 120,
      },
      answer: 'Deploying to staging.',
    });
    await submitPrompt(panel, 'Deploy it.');
    const clarify = await waitFor(async () => {
      const state = await cardState(panel);
      return state.showing && state.kind === 'clarify' ? state : null;
    }, 20_000);
    assert.match(clarify.text, /Which environment should I deploy to\?/);
    assert.deepEqual(clarify.answerChoices, ['staging', 'production']);
    results.clarifyCard = await saveScreenshot(panel, 'prompt-card-clarify.png');
    await trustedClick(panel, '#agentPromptCard .agent-prompt-choice:nth-of-type(1)');
    await waitFor(() => gateway.replies.length === 4);
    assert.deepEqual(gateway.replies[3], {
      route: 'clarify',
      runId: 'run-clarify-choice',
      body: { request_id: 'clar-choice', answer: 'staging', execution_generation: 4 },
    });
    await waitFor(async () => !(await cardState(panel)).showing);
    await waitForReply(panel, 'Deploying to staging.');

    // ---- Clarify with free text typed with real key events --------------------
    gateway.queue({
      runId: 'run-clarify-text',
      event: ['clarify.request', { prompt_id: 'clar-text', question: 'What should the release be called?', timeout_s: 120 }],
      control: { kind: 'clarify', prompt_id: 'clar-text', question: 'What should the release be called?', timeout_s: 120 },
      answer: 'Named it.',
    });
    await submitPrompt(panel, 'Cut a release.');
    await waitFor(async () => {
      const state = await cardState(panel);
      return state.showing && /release be called/.test(state.text) ? state : null;
    }, 20_000);
    await trustedClick(panel, '#agentPromptCard .agent-prompt-input');
    await typeTrusted(panel, 'spring');
    assert.equal(await panel.evaluate(`document.querySelector('#agentPromptCard .agent-prompt-input').value`), 'spring');
    assert.equal(gateway.replies.length, 4, 'typing alone sends nothing');
    await pressEnter(panel);
    await waitFor(() => gateway.replies.length === 5);
    assert.deepEqual(gateway.replies[4].body, { request_id: 'clar-text', answer: 'spring' });
    await waitFor(async () => !(await cardState(panel)).showing);
    await waitForReply(panel, 'Named it.');

    const pageErrors = panel.events.filter((event) => event.method === 'Runtime.exceptionThrown');
    assert.deepEqual(pageErrors, []);

    console.log(JSON.stringify({
      verdict: 'PASS',
      extensionId,
      replies: gateway.replies.map((reply) => ({ route: reply.route, body: reply.body })),
      screenshots: results,
    }, null, 2));
  } catch (error) {
    error.message = `${error.message}\nChrome stderr tail:\n${chromeStderr.slice(-2000)}`;
    throw error;
  } finally {
    panel?.close();
    setup?.close();
    killChrome(chrome);
    await gateway.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await rm(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

await main();
process.exit(0);
