import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PROFILE = path.join(ROOT, 'tmp', `e2e-loaded-extension-${process.pid}`);
const FAILURE_SCREENSHOT = path.join(ROOT, 'tmp', 'e2e-loaded-extension-failure.png');
const QA_DIR = path.join(ROOT, '.hermes', 'qa');
const ASSIST_THEME = String(process.env.ASSIST_THEME || 'mono');
const ASSIST_MODE = String(process.env.ASSIST_MODE || 'dark');
const ASSIST_SCREENSHOT_SUFFIX = ASSIST_THEME === 'mono' && ASSIST_MODE === 'dark' ? '' : `-${ASSIST_THEME}-${ASSIST_MODE}`;
const TASK_PANEL_SCREENSHOT = path.join(QA_DIR, `feature-recovery-task-panel${ASSIST_SCREENSHOT_SUFFIX}.png`);
const TASK_WEB_SCREENSHOT = path.join(QA_DIR, `feature-recovery-task-web${ASSIST_SCREENSHOT_SUFFIX}.png`);
const INLINE_ROUTE_SCREENSHOT = path.join(QA_DIR, `feature-recovery-inline-routing${ASSIST_SCREENSHOT_SUFFIX}.png`);
const INLINE_RESULT_SCREENSHOT = path.join(QA_DIR, `feature-recovery-inline-result${ASSIST_SCREENSHOT_SUFFIX}.png`);
const INLINE_OPEN_SESSION_SCREENSHOT = path.join(QA_DIR, `feature-recovery-inline-open-session${ASSIST_SCREENSHOT_SUFFIX}.png`);
const INLINE_NO_SESSION_SCREENSHOT = path.join(QA_DIR, `feature-recovery-inline-no-session${ASSIST_SCREENSHOT_SUFFIX}.png`);
const INLINE_LAUNCHER_SCREENSHOT = path.join(QA_DIR, `inline-launcher-position${ASSIST_SCREENSHOT_SUFFIX}.png`);
const CHATGPT_LAUNCHER_SCREENSHOT = path.join(QA_DIR, `chatgpt-launcher-outside-composer${ASSIST_SCREENSHOT_SUFFIX}.png`);
const INLINE_TOGGLE_SCREENSHOT = path.join(QA_DIR, `inline-launcher-toggle-open${ASSIST_SCREENSHOT_SUFFIX}.png`);
const INLINE_SINGLE_COPY_SCREENSHOT = path.join(QA_DIR, `x-rich-single-copy${ASSIST_SCREENSHOT_SUFFIX}.png`);
const INLINE_DELETE_ALL_SCREENSHOT = path.join(QA_DIR, `x-rich-delete-all${ASSIST_SCREENSHOT_SUFFIX}.png`);
const ASSIST_SETTINGS_SCREENSHOT = path.join(QA_DIR, `assist-settings${ASSIST_SCREENSHOT_SUFFIX}.png`);
const ASSIST_RELEASED_GATEWAY_SCREENSHOT = path.join(QA_DIR, `assist-settings-released-gateway${ASSIST_SCREENSHOT_SUFFIX}.png`);
const MAIN_MODEL_PICKER_SCREENSHOT = path.join(QA_DIR, `main-model-picker${ASSIST_SCREENSHOT_SUFFIX}.png`);
const GPT56_CONTEXT_PICKER_SCREENSHOT = path.join(QA_DIR, `gpt56-context-picker${ASSIST_SCREENSHOT_SUFFIX}.png`);
const TEST_TOKEN = 'e2e-browser-token-not-a-secret';
const TEST_PROMPT = 'Verify the loaded Hermes Browser round trip.';
const TEST_REPLY = 'Loaded extension round trip confirmed.';
const INLINE_REPLY = 'Clearer, tighter, still your voice.';

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('System Chrome/Edge not found. Set CHROME_PATH.');
  return found;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Hermes-Session-Id, X-Hermes-Session-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  res.end(body);
}

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

async function startMockHermes() {
  const requests = [];
  const sessions = [];
  let chatRequest = null;
  let assistCreateAcknowledgement = 'direct';
  let assistChatAcknowledgement = 'direct';
  let assistCleanupStatus = 204;
  let assistSessionModelRouting = true;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const body = await requestBody(req);
    requests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization ?? '', body });

    if (url.pathname === '/qa-inline' && req.method === 'GET') {
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Hermes Assist QA</title><style>body{margin:0;min-height:180vh;background:#0505f5;color:#0505f5;font:16px Arial,sans-serif;padding:64px}main{max-width:980px;margin:auto;background:#f8f9ff;border:1px solid #0505f5;padding:32px;box-shadow:12px 12px 0 rgba(0,0,0,.28)}h1{font:700 36px Georgia,serif;margin:0 0 8px}p{color:#3030a5;margin:0 0 28px}textarea,[contenteditable="true"]{display:block;width:100%;min-height:180px;box-sizing:border-box;border:1px solid #0505f5;background:#fff;color:#111;padding:20px;font:18px/1.6 Arial,sans-serif}textarea{resize:none}[contenteditable="true"]{margin-top:28px;white-space:pre-wrap}label{display:block;margin:24px 0 10px;font-size:12px;letter-spacing:.14em;text-transform:uppercase}</style></head><body><main><h1>Example compose field</h1><p>Real loaded-extension QA surface. The text is intentionally messy so exact Undo can be verified.</p><label for="draft">Draft</label><textarea id="draft" aria-label="Example compose field">  I wanted   to follow up.  </textarea><label for="rich-draft">Rich draft</label><div id="rich-draft" role="textbox" aria-label="Rich example compose field" contenteditable="true">One   clear   sentence.</div></main><script>window.richInputEvents=0;window.richNormalizeLikeX=false;window.xPopupOutsideClicks=0;document.querySelector('#rich-draft').addEventListener('input',()=>{window.richInputEvents+=1;if(window.richNormalizeLikeX){const rich=document.querySelector('#rich-draft');rich.textContent=rich.textContent.trim()+'\\n';}});document.addEventListener('click',(event)=>{const host=document.querySelector('#hermes-inline-draft-host');if(!host||event.target!==host)return;window.xPopupOutsideClicks+=1;const field=document.querySelector('#draft');if(field)field.replaceWith(field.cloneNode(true));});</script></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      res.end(html);
      return;
    }

    if (url.pathname === '/qa-chatgpt' && req.method === 'GET') {
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT composer fixture</title><style>html,body{margin:0;min-height:100%;background:#f7f7f8;color:#0d0d0d;font:16px Arial,sans-serif}main{padding-top:155px}form{display:grid;grid-template-columns:42px minmax(0,1fr) auto;align-items:center;width:769px;height:53px;margin:0 auto;padding:0 5px;border:1px solid #d7d7dc;border-radius:26px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.08)}button{display:grid;place-items:center;width:36px;height:36px;padding:0;border:0;border-radius:50%;background:transparent;color:#111}#prompt-textarea{min-width:0;min-height:37px;padding:8px 10px;outline:none;white-space:pre-wrap}#native-rail{display:flex;align-items:center;gap:5px}#voice{background:#111;color:#fff}</style></head><body><main><form id="composer"><button aria-label="Add files and more">+</button><div id="prompt-textarea" contenteditable="true" role="textbox" aria-label="Chat with ChatGPT">Explain this architecture clearly.</div><div id="native-rail"><button aria-label="Start dictation">D</button><button id="voice" aria-label="Start Voice">V</button></div></form></main></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      res.end(html);
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Hermes-Session-Id, X-Hermes-Session-Key',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      });
      res.end();
      return;
    }

    if (url.pathname === '/health' || url.pathname === '/v1/health') {
      json(res, 200, { status: 'ok', platform: 'hermes-agent', version: 'e2e' });
      return;
    }
    if (req.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
      json(res, 401, { error: { message: 'Unauthorized', type: 'authentication_error' } });
      return;
    }
    if (url.pathname === '/v1/capabilities') {
      json(res, 200, {
        object: 'hermes.api_server.capabilities',
        platform: 'hermes-agent',
        auth: { type: 'bearer', required: true },
        features: {
          models_api: true,
          session_resources: true,
          session_chat: true,
          session_chat_streaming: true,
          session_model_routing: assistSessionModelRouting,
          skills_api: true,
        },
        endpoints: {
          health: { method: 'GET', path: '/health' },
          models: { method: 'GET', path: '/v1/models' },
          sessions: { method: 'GET', path: '/api/sessions' },
          session_create: { method: 'POST', path: '/api/sessions' },
          ...(assistSessionModelRouting ? {
            session_model: { method: 'POST', path: '/api/sessions/{session_id}/model' },
          } : {}),
          session_chat: { method: 'POST', path: '/api/sessions/{session_id}/chat' },
          session_chat_stream: { method: 'POST', path: '/api/sessions/{session_id}/chat/stream' },
          skills: { method: 'GET', path: '/v1/skills' },
        },
      });
      return;
    }
    if (url.pathname === '/api/model/options') {
      json(res, 200, {
        providers: [{
          slug: 'e2e',
          name: 'E2E Provider',
          authenticated: true,
          models: [
            { id: 'e2e/test-model', label: 'E2E Test Model', context_length: 32_000 },
            { id: 'e2e/alternate-model', label: 'E2E Alternate Model', context_length: 32_000 },
          ],
          capabilities: {
            'e2e/test-model': { reasoning: true, fast: true },
            'e2e/alternate-model': { reasoning: true, fast: true },
          },
        }, {
          slug: 'alternate',
          name: 'Alternate Provider',
          authenticated: true,
          models: [
            { id: 'alternate/provider-model', label: 'Provider Switch Model', context_length: 64_000 },
          ],
          capabilities: {
            'alternate/provider-model': { reasoning: false, fast: false },
          },
        }, {
          slug: 'openai-codex',
          name: 'OpenAI Codex',
          authenticated: true,
          models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
          capabilities: {
            'gpt-5.6-sol': { reasoning: true, fast: true },
            'gpt-5.6-terra': { reasoning: true, fast: true },
            'gpt-5.6-luna': { reasoning: true, fast: true },
          },
        }, {
          slug: 'portal',
          name: 'Nous Portal',
          authenticated: true,
          models: [{ id: 'portal/portal-model', label: 'Portal Model', context_length: 48_000 }],
          capabilities: { 'portal/portal-model': { reasoning: true, fast: true } },
        }, {
          slug: 'research',
          name: 'Research Cloud',
          authenticated: true,
          models: [{ id: 'research/research-model', label: 'Research Model', context_length: 48_000 }],
          capabilities: { 'research/research-model': { reasoning: true, fast: false } },
        }, {
          slug: 'local',
          name: 'Local Runtime',
          authenticated: true,
          models: [{ id: 'local/local-model', label: 'Local Model', context_length: 16_000 }],
          capabilities: { 'local/local-model': { reasoning: false, fast: true } },
        }, {
          slug: 'lab',
          name: 'Lab Provider',
          authenticated: true,
          models: [{ id: 'lab/lab-model', label: 'Lab Model', context_length: 24_000 }],
          capabilities: { 'lab/lab-model': { reasoning: false, fast: false } },
        }],
      });
      return;
    }
    if (url.pathname === '/v1/models') {
      json(res, 200, { object: 'list', data: [
        { id: 'e2e/test-model', provider: 'e2e', context_length: 32_000 },
        { id: 'e2e/alternate-model', provider: 'e2e', context_length: 32_000 },
        { id: 'alternate/provider-model', provider: 'alternate', context_length: 64_000 },
        { id: 'gpt-5.6-sol', provider: 'openai-codex', context_length: 0 },
        { id: 'gpt-5.6-terra', provider: 'openai-codex', context_length: 0 },
        { id: 'gpt-5.6-luna', provider: 'openai-codex', context_length: 0 },
        { id: 'portal/portal-model', provider: 'portal', context_length: 48_000 },
        { id: 'research/research-model', provider: 'research', context_length: 48_000 },
        { id: 'local/local-model', provider: 'local', context_length: 16_000 },
        { id: 'lab/lab-model', provider: 'lab', context_length: 24_000 },
      ] });
      return;
    }
    if (url.pathname === '/v1/skills' || url.pathname === '/v1/toolsets') {
      json(res, 200, { object: 'list', data: [] });
      return;
    }
    if (url.pathname === '/api/profiles' || url.pathname === '/api/profiles/active') {
      json(res, 404, { error: { message: 'Optional profile API unavailable' } });
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      json(res, 200, { object: 'list', data: sessions, total: sessions.length, has_more: false });
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      const requestedId = body?.id || body?.session_id || 'hermes-browser-extension-e2e';
      const session = {
        id: requestedId,
        session_id: requestedId,
        title: body?.title || 'Hermes Browser Extension',
        source: body?.source || 'hermes_browser_extension',
      };
      const acknowledgedModel = body?.model || 'e2e/test-model';
      const acknowledgedProvider = body?.provider || 'e2e';
      if (assistCreateAcknowledgement === 'runtime') {
        session.runtime = { effective_model: acknowledgedModel, effective_provider: acknowledgedProvider };
      } else if (assistCreateAcknowledgement === 'mismatch') {
        session.model = 'wrong-model';
        session.provider = 'wrong-provider';
      } else {
        session.model = acknowledgedModel;
        if (assistCreateAcknowledgement !== 'missing') session.provider = acknowledgedProvider;
      }
      sessions.splice(0, sessions.length, session);
      json(res, 201, session);
      return;
    }
    if (/^\/api\/sessions\/[^/]+\/messages$/.test(url.pathname) && req.method === 'GET') {
      json(res, 200, { object: 'list', data: [] });
      return;
    }
    if (/^\/api\/sessions\/[^/]+$/.test(url.pathname) && req.method === 'GET') {
      json(res, 200, sessions[0] || { id: 'hermes-browser-extension-e2e', source: 'hermes_browser_extension' });
      return;
    }
    if (/^\/api\/sessions\/[^/]+$/.test(url.pathname) && req.method === 'DELETE') {
      if (assistCleanupStatus !== 204) {
        json(res, assistCleanupStatus, { error: { message: 'Forced Assist cleanup failure' } });
        return;
      }
      sessions.splice(0, sessions.length);
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }
    if (/^\/api\/sessions\/[^/]+$/.test(url.pathname) && req.method === 'PATCH') {
      if (sessions[0] && body?.title) sessions[0].title = body.title;
      json(res, 200, sessions[0] || { id: 'hermes-browser-extension-e2e' });
      return;
    }
    if (/^\/api\/sessions\/[^/]+\/model$/.test(url.pathname) && req.method === 'POST') {
      const session = sessions[0] || { id: url.pathname.split('/')[3] || 'hermes-browser-extension-e2e' };
      session.model = body?.model || session.model || 'e2e/test-model';
      session.provider = body?.provider || session.provider || 'e2e';
      sessions.splice(0, sessions.length, session);
      json(res, 200, {
        object: 'hermes.session.model',
        session_id: session.id,
        runtime: {
          effective_model: session.model,
          effective_provider: session.provider,
          model_lock: 'enforced',
        },
      });
      return;
    }
    if (/^\/api\/sessions\/[^/]+\/chat\/stream$/.test(url.pathname) && req.method === 'POST') {
      chatRequest = body;
      const blocks = [
        ['run.started', { run_id: 'run-e2e' }],
        ['assistant.delta', { delta: TEST_REPLY }],
        ['assistant.completed', { content: TEST_REPLY }],
        ['run.completed', { run_id: 'run-e2e', status: 'completed', final_response: TEST_REPLY }],
      ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(blocks);
      return;
    }
    if (/^\/api\/sessions\/[^/]+\/chat$/.test(url.pathname) && req.method === 'POST') {
      chatRequest = body;
      const payload = {
        content: INLINE_REPLY,
        message: { role: 'assistant', content: INLINE_REPLY },
      };
      const acknowledgedModel = body?.model || 'e2e/test-model';
      const acknowledgedProvider = body?.provider || 'e2e';
      if (assistChatAcknowledgement === 'runtime') {
        payload.runtime = { effective_model: acknowledgedModel, effective_provider: acknowledgedProvider };
      } else if (assistChatAcknowledgement === 'mismatch') {
        payload.model = 'wrong-model';
        payload.provider = 'wrong-provider';
      } else {
        payload.model = acknowledgedModel;
        if (assistChatAcknowledgement !== 'missing') payload.provider = acknowledgedProvider;
      }
      json(res, 200, payload);
      return;
    }
    json(res, 404, { error: { message: `Unhandled E2E route: ${req.method} ${url.pathname}` } });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    getChatRequest: () => chatRequest,
    setAssistCreateAcknowledgement: (mode = 'direct') => { assistCreateAcknowledgement = mode; },
    setAssistChatAcknowledgement: (mode = 'direct') => { assistChatAcknowledgement = mode; },
    setAssistCleanupStatus: (status = 204) => { assistCleanupStatus = Number(status); },
    setAssistSessionModelRouting: (enabled = true) => { assistSessionModelRouting = Boolean(enabled); },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onmessage = (event) => {
      const payload = JSON.parse(String(event.data));
      if (!payload.id) return;
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);
      if (payload.error) pending.reject(new Error(payload.error.message || 'CDP error'));
      else pending.resolve(payload.result || {});
    };
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error(`Could not connect to CDP target ${this.url}`));
    });
  }

  call(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('CDP socket is not open.');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime evaluation failed.');
    }
    return result.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch { /* best-effort cleanup or diagnostics */ }
  }
}

async function waitFor(check, timeoutMs = 25_000, intervalMs = 150) {
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

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} failed (${response.status})`);
  return response.json();
}

function killChrome(child) {
  if (!child?.pid) return;
  try {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch { /* best-effort cleanup or diagnostics */ }
}

async function saveScreenshot(client, filePath, { captureBeyondViewport = true } = {}) {
  const shot = await client.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport });
  assert.ok(shot.data, `Screenshot data missing for ${filePath}`);
  await writeFile(filePath, Buffer.from(shot.data, 'base64'));
}

async function clickInlineLauncher(client) {
  const point = await client.evaluate(`(() => {
    const launcher = document.querySelector('#hermes-inline-draft-host')?.shadowRoot?.querySelector('.launcher');
    if (!launcher || launcher.hidden) return null;
    const rect = launcher.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(point, 'Inline launcher was not available for a real pointer click.');
  await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
}

async function main() {
  assert.ok(existsSync(path.join(DIST, 'manifest.json')), 'Run npm run build before loaded-extension E2E.');
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  await mkdir(path.dirname(FAILURE_SCREENSHOT), { recursive: true });
  await mkdir(QA_DIR, { recursive: true });

  const mock = await startMockHermes();
  let chrome;
  let setup;
  let panel;
  let web;
  let fixture;
  let chatgptFixture;
  let chromeStderr = '';
  try {
    chrome = spawn(chromeExecutable(), [
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
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    chrome.stderr.on('data', (chunk) => { chromeStderr += String(chunk); });

    const activePort = path.join(PROFILE, 'DevToolsActivePort');
    await waitFor(() => existsSync(activePort));
    const [portLine] = (await readFile(activePort, 'utf8')).trim().split(/\r?\n/);
    const devtoolsBase = `http://127.0.0.1:${Number(portLine)}`;

    const workerTarget = await waitFor(async () => {
      const targets = await fetchJson(`${devtoolsBase}/json/list`);
      return targets.find((target) => {
        if (target.type !== 'service_worker') return false;
        try { return new URL(String(target.url || '')).pathname === '/background.js'; }
        catch { return false; }
      });
    });
    const extensionId = new URL(workerTarget.url).hostname;
    // Use the existing extension service worker for storage and tab control.
    // Opening a second sidepanel just for setup runs the full startup lifecycle
    // and can race the real panel by creating another fresh Browser session.
    setup = new CdpClient(workerTarget.webSocketDebuggerUrl);
    await setup.connect();
    await setup.call('Runtime.enable');
    await waitFor(() => setup.evaluate(`Boolean(globalThis.chrome?.storage?.local)`));
    await setup.evaluate(`chrome.storage.local.set({hermesBrowserSettings:${JSON.stringify({
      connectionSchemaVersion: 1,
      connectionMode: 'local',
      connectionTransport: 'local-api',
      gatewayMode: 'local-api',
      gatewayUrl: mock.baseUrl,
      apiKey: TEST_TOKEN,
      tokenSource: 'e2e',
      sessionId: 'hermes-browser-extension',
      sessionStartMode: 'fresh',
      model: 'e2e/test-model',
      appearanceTheme: ASSIST_THEME,
      colorMode: ASSIST_MODE,
      inlineAssistEnabled: true,
      inlineAssistDefaultRoute: 'ask',
      inlineAssistModel: 'e2e/test-model',
      inlineAssistSessionRetention: 'keep',
      inlineAssistThinkingEnabled: true,
      inlineAssistReasoningEffort: 'low',
      inlineAssistFastMode: false,
      contextMenuDefaultRoute: 'ask',
    })}, hermesBrowserIntroSeen: true})`);

    const pageTarget = await fetchJson(
      `${devtoolsBase}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/sidepanel.html`)}`,
      { method: 'PUT' },
    );
    panel = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await panel.connect();
    await panel.call('Runtime.enable');
    await panel.call('Page.enable');

    await waitFor(() => panel.evaluate(`(() => {
      const startup = document.querySelector('#startupScreen');
      const input = document.querySelector('#promptInput');
      return Boolean(startup?.hidden && input && !input.disabled);
    })()`));

    const panelAccessibility = await panel.evaluate(`(() => {
      const visible = (node) => {
        if (!node || node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const name = (node) => {
        const labelledBy = String(node.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent?.trim() || '').filter(Boolean).join(' ');
        const label = node.id ? document.querySelector('label[for="' + CSS.escape(node.id) + '"]')?.textContent?.trim() || '' : '';
        return String(node.getAttribute('aria-label') || labelledBy || label || node.getAttribute('title') || node.getAttribute('alt') || node.textContent || node.value || node.getAttribute('placeholder') || '').trim();
      };
      const controls = [...document.querySelectorAll('button,a[href],input:not([type="hidden"]),select,textarea,[role="button"],[tabindex]')]
        .filter((node) => visible(node) && !node.disabled);
      const ids = [...document.querySelectorAll('[id]')].map((node) => node.id).filter(Boolean);
      const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
      return {
        visibleControls: controls.length,
        unnamed: controls.filter((node) => !name(node)).map((node) => node.id || node.outerHTML.slice(0, 120)),
        duplicateIds: duplicates,
        positiveTabindex: controls.filter((node) => Number(node.getAttribute('tabindex')) > 0).map((node) => node.id || node.tagName),
        missingImageAlt: [...document.querySelectorAll('img')].filter((node) => visible(node) && !node.hasAttribute('alt')).map((node) => node.id || node.src),
      };
    })()`);
    assert.ok(panelAccessibility.visibleControls > 0);
    assert.deepEqual(panelAccessibility.unnamed, []);
    assert.deepEqual(panelAccessibility.duplicateIds, []);
    assert.deepEqual(panelAccessibility.positiveTabindex, []);
    assert.deepEqual(panelAccessibility.missingImageAlt, []);

    await panel.evaluate(`(() => { document.body.tabIndex = -1; document.body.focus(); })()`);
    await panel.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await panel.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    const panelKeyboardFocus = await panel.evaluate(`(() => {
      const node = document.activeElement;
      const label = String(node?.getAttribute('aria-label') || node?.getAttribute('title') || node?.textContent || node?.value || '').trim();
      const result = { tag: node?.tagName || '', id: node?.id || '', label, focusVisible: Boolean(node?.matches?.(':focus-visible')) };
      document.body.removeAttribute('tabindex');
      return result;
    })()`);
    assert.notEqual(panelKeyboardFocus.tag, 'BODY');
    assert.ok(panelKeyboardFocus.label || panelKeyboardFocus.id, JSON.stringify(panelKeyboardFocus));
    assert.equal(panelKeyboardFocus.focusVisible, true);

    await panel.call('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const panelMotionViolations = await panel.evaluate(`(() => {
      const seconds = (part) => {
        const value = String(part || '').trim();
        const number = Number.parseFloat(value) || 0;
        return value.endsWith('ms') ? number / 1000 : number;
      };
      const active = (value) => String(value || '').split(',').some((part) => seconds(part) > 0.02);
      return [...document.querySelectorAll('*')].filter((node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (active(style.animationDuration) || active(style.transitionDuration));
      }).map((node) => node.id || node.className || node.tagName).slice(0, 20);
    })()`);
    assert.deepEqual(panelMotionViolations, []);
    await panel.call('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

    const storedBeforeSend = await waitFor(async () => {
      const first = await setup.evaluate(`chrome.storage.local.get('hermesBrowserSettings')`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const second = await setup.evaluate(`chrome.storage.local.get('hermesBrowserSettings')`);
      return first?.hermesBrowserSettings?.sessionId === second?.hermesBrowserSettings?.sessionId ? second : null;
    });
    assert.match(storedBeforeSend.hermesBrowserSettings.sessionId, /^hermes-browser-extension-/);
    assert.equal(storedBeforeSend.hermesBrowserSettings.inlineAssistModel, 'e2e::e2e/test-model');
    assert.equal(storedBeforeSend.hermesBrowserSettings.inlineAssistRawModel, 'e2e/test-model');
    assert.equal(storedBeforeSend.hermesBrowserSettings.inlineAssistProvider, 'e2e');

    const introBeforeFirstTurn = await panel.evaluate(`(() => {
      const hero = document.querySelector('#browserIntroHero');
      return { exists: Boolean(hero), hidden: Boolean(hero?.hidden) };
    })()`);
    assert.deepEqual(introBeforeFirstTurn, { exists: true, hidden: false });

    await panel.evaluate(`(() => {
      const input = document.querySelector('#promptInput');
      input.value = ${JSON.stringify(TEST_PROMPT)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#composer').requestSubmit();
      return true;
    })()`);

    await waitFor(() => panel.evaluate(`Array.from(document.querySelectorAll('.message-content')).some((node) => node.textContent.includes(${JSON.stringify(TEST_REPLY)}))`));
    await waitFor(() => panel.evaluate(`document.querySelector('#browserIntroHero')?.hidden === true`));
    if (ASSIST_THEME === 'nous' && ASSIST_MODE === 'light') {
      const panelCardState = await panel.evaluate(`(() => {
        const assistant = document.querySelector('.message.assistant');
        const user = document.querySelector('.message.user');
        const assistantStyle = assistant ? getComputedStyle(assistant) : null;
        const userStyle = user ? getComputedStyle(user) : null;
        return assistantStyle && userStyle ? {
          background: assistantStyle.backgroundColor,
          backdrop: assistantStyle.backdropFilter || assistantStyle.webkitBackdropFilter,
          opacity: assistantStyle.opacity,
          assistantColor: assistantStyle.color,
          userColor: userStyle.color,
          userContextColor: getComputedStyle(user.querySelector('.context-receipt summary')).color,
        } : null;
      })()`);
      assert.deepEqual(panelCardState, {
        background: 'rgb(255, 255, 255)',
        backdrop: 'none',
        opacity: '1',
        assistantColor: 'rgb(5, 5, 232)',
        userColor: 'rgb(5, 5, 232)',
        userContextColor: 'rgba(5, 5, 232, 0.84)',
      });
      const panelSelection = await panel.evaluate(`(() => {
        const probe = document.createElement('span');
        probe.textContent = 'selection-probe';
        probe.style.position = 'absolute';
        probe.style.left = '-9999px';
        document.body.appendChild(probe);
        const range = document.createRange();
        range.selectNodeContents(probe);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const styles = getComputedStyle(probe, '::selection');
        const result = { background: styles.backgroundColor, color: styles.color };
        sel.removeAllRanges();
        probe.remove();
        return result;
      })()`);
      assert.deepEqual(panelSelection, { background: 'rgb(237, 255, 69)', color: 'rgb(5, 5, 232)' });
    }
    const storedAfterSend = await setup.evaluate(`chrome.storage.local.get('hermesBrowserSettings')`);
    assert.match(storedAfterSend.hermesBrowserSettings.sessionId, /^hermes-browser-extension-/);

    const chat = mock.getChatRequest();
    assert.ok(chat, 'Mock Hermes did not receive a session chat request.');
    assert.equal(typeof chat.message, 'string');
    const envelope = JSON.parse(chat.message);
    assert.equal(envelope.protocol, 'hermes.browser.turn.v2');
    assert.equal(envelope.human_input.source, 'composer');
    assert.equal(envelope.human_input.text, TEST_PROMPT);
    assert.ok(envelope.browser_context);
    assert.ok(envelope.attachment_context);
    assert.ok(envelope.source_receipt);
    assert.ok(mock.requests.some((request) => request.path === `/api/sessions/${storedAfterSend.hermesBrowserSettings.sessionId}/chat/stream` && request.method === 'POST'));
    assert.ok(mock.requests.filter((request) => request.path !== '/health' && request.path !== '/v1/health').every((request) => request.authorization === `Bearer ${TEST_TOKEN}`));

    const taskPayload = {
      [storedAfterSend.hermesBrowserSettings.sessionId]: {
        updatedAt: Date.now(),
        tasks: [
          { id: 'recover', content: 'Recover last-night Browser feature contract', status: 'completed' },
          { id: 'wire', content: 'Wire branded Assist and background return', status: 'completed' },
          { id: 'verify', content: 'Verify the real loaded extension', status: 'in_progress' },
        ],
      },
    };
    await setup.evaluate(`chrome.storage.local.set({hermesBrowserTaskStacks:${JSON.stringify(taskPayload)}})`);
    const taskPanelState = await waitFor(() => panel.evaluate(`(() => {
      const stack = document.querySelector('#taskStack');
      const rows = Array.from(document.querySelectorAll('#taskStackList .task-stack-item'));
      return !stack?.hidden && rows.length === 3 ? {
        summary: document.querySelector('#taskStackSummary')?.textContent || '',
        rows: rows.map((row) => row.textContent.trim()),
      } : null;
    })()`));
    assert.match(taskPanelState.summary, /2\/3 complete · 1 active/i);
    await panel.call('Emulation.setDeviceMetricsOverride', { width: 520, height: 900, deviceScaleFactor: 1, mobile: false });
    await saveScreenshot(panel, TASK_PANEL_SCREENSHOT);

    await setup.evaluate(`(async () => {
      const stored = await chrome.storage.local.get('hermesBrowserSettings');
      await chrome.storage.local.set({hermesBrowserSettings:{...stored.hermesBrowserSettings,webSessionId:${JSON.stringify(storedAfterSend.hermesBrowserSettings.sessionId)},webSessionTitle:'Loaded extension QA'}});
    })()`);
    const webTarget = await fetchJson(
      `${devtoolsBase}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/app.html`)}`,
      { method: 'PUT' },
    );
    web = new CdpClient(webTarget.webSocketDebuggerUrl);
    await web.connect();
    await web.call('Runtime.enable');
    await web.call('Page.enable');
    await web.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    const taskWebState = await waitFor(() => web.evaluate(`(() => {
      const stack = document.querySelector('#taskStack');
      const rows = Array.from(document.querySelectorAll('#taskStackList .task-stack-item'));
      return !stack?.hidden && rows.length === 3 ? document.querySelector('#taskStackSummary')?.textContent || '' : '';
    })()`));
    assert.match(taskWebState, /2\/3 complete · 1 active/i);
    if (ASSIST_THEME === 'nous' && ASSIST_MODE === 'light') {
      const nousLightSurfaces = await waitFor(() => web.evaluate(`(() => {
        const list = document.querySelector('#messageList');
        const composer = document.querySelector('.fulltab-composer');
        const html = document.documentElement;
        if (!list || !composer || html.dataset.hermesTheme !== 'nous' || html.dataset.hermesMode !== 'light') return null;
        list.hidden = false;
        list.innerHTML = '<article class="web-message assistant"><div class="web-message-role">Hermes</div><div class="web-message-content">Surface QA</div></article><article class="web-message user"><div class="web-message-content">User QA</div><div class="web-message-role">User</div></article>';
        const style = (selector) => {
          const node = document.querySelector(selector);
          return node ? getComputedStyle(node) : null;
        };
        const result = {
          assistant: style('.web-message.assistant')?.backgroundColor || '',
          user: style('.web-message.user')?.backgroundColor || '',
          composer: style('.fulltab-composer')?.backgroundColor || '',
          assistantLayer: style('.web-message.assistant')?.zIndex || '',
          composerLayer: style('.fulltab-composer')?.zIndex || '',
          assistantColor: style('.web-message.assistant')?.color || '',
          userColor: style('.web-message.user')?.color || '',
        };
        return result.assistant === 'rgb(255, 255, 255)' && result.composer === 'rgb(255, 255, 255)' ? result : null;
      })()`));
      assert.equal(nousLightSurfaces.assistant, 'rgb(255, 255, 255)');
      assert.equal(nousLightSurfaces.user, 'rgb(255, 255, 255)');
      assert.equal(nousLightSurfaces.composer, 'rgb(255, 255, 255)');
      assert.equal(nousLightSurfaces.assistantLayer, '61');
      assert.equal(nousLightSurfaces.composerLayer, '61');
      assert.equal(nousLightSurfaces.assistantColor, 'rgb(5, 5, 232)');
      assert.equal(nousLightSurfaces.userColor, 'rgb(5, 5, 232)');
      const selectionColor = await web.evaluate(`(() => {
        const probe = document.createElement('span');
        probe.textContent = 'selection-probe';
        probe.style.position = 'absolute';
        probe.style.left = '-9999px';
        document.body.appendChild(probe);
        const range = document.createRange();
        range.selectNodeContents(probe);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const styles = getComputedStyle(probe, '::selection');
        const result = { background: styles.backgroundColor, color: styles.color };
        sel.removeAllRanges();
        probe.remove();
        return result;
      })()`);
      assert.deepEqual(selectionColor, { background: 'rgb(237, 255, 69)', color: 'rgb(5, 5, 232)' });
    }
    await saveScreenshot(web, TASK_WEB_SCREENSHOT);

    const fixtureTarget = await fetchJson(
      `${devtoolsBase}/json/new?${encodeURIComponent(`${mock.baseUrl}/qa-inline`)}`,
      { method: 'PUT' },
    );
    fixture = new CdpClient(fixtureTarget.webSocketDebuggerUrl);
    await fixture.connect();
    await fixture.call('Runtime.enable');
    await fixture.call('Page.enable');
    await fixture.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await waitFor(() => fixture.evaluate(`Boolean(document.querySelector('#draft'))`));
    const scriptedTabId = await setup.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((item) => item.url === ${JSON.stringify(`${mock.baseUrl}/qa-inline`)});
      if (!tab) return 0;
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content-extractor.js', 'content.js', 'content-inline-helper.js'],
      });
      return tab.id;
    })()`);
    assert.ok(Number.isInteger(scriptedTabId) && scriptedTabId > 0, 'Could not inject the packaged content scripts into the QA tab.');
    const inlineRuntimeState = await setup.evaluate(`(async () => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: ${scriptedTabId} },
        func: () => {
          const field = document.querySelector('#draft');
          field?.blur();
          field?.focus();
          return {
            policy: Boolean(globalThis.HermesInlineDraft),
            helper: typeof globalThis.__HERMES_INLINE_HELPER_CLEANUP__ === 'function',
            host: Boolean(document.querySelector('#hermes-inline-draft-host')),
          };
        },
      });
      return result?.result || null;
    })()`);
    assert.deepEqual(inlineRuntimeState, { policy: true, helper: true, host: true });
    await waitFor(() => fixture.evaluate(`Boolean(document.querySelector('#hermes-inline-draft-host')?.shadowRoot?.querySelector('.launcher'))`));
    const logoState = await fixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host').shadowRoot;
      const launcher = root.querySelector('.launcher');
      const logo = root.querySelector('.launcher-logo');
      const host = document.querySelector('#hermes-inline-draft-host');
      return {
        color: getComputedStyle(host).getPropertyValue('--hb-logo').trim(),
        background: getComputedStyle(launcher).backgroundColor,
        mask: getComputedStyle(logo).maskImage || getComputedStyle(logo).webkitMaskImage,
        launcher: [launcher.getBoundingClientRect().width, launcher.getBoundingClientRect().height],
        logo: [logo.getBoundingClientRect().width, logo.getBoundingClientRect().height],
      };
    })()`);
    assert.equal(logoState.color, ASSIST_THEME === 'nous' ? '#0505e8' : '#111111');
    assert.equal(logoState.background, 'rgb(255, 255, 255)');
    assert.match(logoState.mask, /hermes-browser-extension-icon-ink\.png/);
    assert.doesNotMatch(logoState.mask, /icon-box-white/);
    assert.deepEqual(logoState.launcher, [32, 32]);
    assert.deepEqual(logoState.logo, [30, 30]);

    const launcherPlacementBeforeShift = await fixture.evaluate(`(() => {
      const field = document.querySelector('#draft').getBoundingClientRect();
      const launcher = document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.launcher').getBoundingClientRect();
      const element = document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.launcher');
      return { rightGap: field.right - launcher.right, bottomGap: field.bottom - launcher.bottom, top: launcher.top, strategy: element.dataset.placement };
    })()`);
    assert.equal(launcherPlacementBeforeShift.strategy, 'inside-end');
    assert.ok(Math.abs(launcherPlacementBeforeShift.rightGap - 6) <= 1, `Launcher right gap was ${launcherPlacementBeforeShift.rightGap}px.`);
    assert.ok(Math.abs(launcherPlacementBeforeShift.bottomGap - 6) <= 1, `Launcher bottom gap was ${launcherPlacementBeforeShift.bottomGap}px.`);
    await fixture.evaluate(`(() => {
      const field = document.querySelector('#draft');
      field.style.minHeight = '240px';
      const shift = document.createElement('div');
      shift.id = 'qa-layout-shift';
      shift.style.height = '44px';
      shift.setAttribute('aria-hidden', 'true');
      field.parentElement.insertBefore(shift, field.previousElementSibling);
    })()`);
    const launcherPlacementAfterShift = await waitFor(() => fixture.evaluate(`(() => {
      const field = document.querySelector('#draft').getBoundingClientRect();
      const launcher = document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.launcher').getBoundingClientRect();
      const element = document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.launcher');
      const state = { rightGap: field.right - launcher.right, bottomGap: field.bottom - launcher.bottom, top: launcher.top, strategy: element.dataset.placement };
      return Math.abs(state.rightGap - 6) <= 1 && Math.abs(state.bottomGap - 6) <= 1 ? state : null;
    })()`));
    assert.ok(launcherPlacementAfterShift.top > launcherPlacementBeforeShift.top + 80, 'Launcher did not follow the shifted/resized editor.');
    await saveScreenshot(fixture, INLINE_LAUNCHER_SCREENSHOT, { captureBeyondViewport: false });
    await fixture.evaluate(`(() => {
      document.querySelector('#qa-layout-shift')?.remove();
      document.querySelector('#draft').style.minHeight = '';
    })()`);
    await waitFor(() => fixture.evaluate(`(() => {
      const field = document.querySelector('#draft').getBoundingClientRect();
      const launcher = document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.launcher').getBoundingClientRect();
      return Math.abs((field.bottom - launcher.bottom) - 6) <= 1;
    })()`));

    const chatgptUrl = `${mock.baseUrl}/qa-chatgpt`;
    const chatgptTarget = await fetchJson(
      `${devtoolsBase}/json/new?${encodeURIComponent(chatgptUrl)}`,
      { method: 'PUT' },
    );
    chatgptFixture = new CdpClient(chatgptTarget.webSocketDebuggerUrl);
    await chatgptFixture.connect();
    await chatgptFixture.call('Runtime.enable');
    await chatgptFixture.call('Page.enable');
    await chatgptFixture.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await waitFor(() => chatgptFixture.evaluate(`Boolean(document.querySelector('#prompt-textarea'))`));
    const chatgptTabId = await setup.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((item) => item.url === ${JSON.stringify(`${mock.baseUrl}/qa-chatgpt`)});
      if (!tab) return 0;
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content-extractor.js', 'content.js', 'content-inline-helper.js'],
      });
      return tab.id;
    })()`);
    assert.ok(chatgptTabId > 0, 'Could not inject the packaged content scripts into the ChatGPT composer fixture.');
    await chatgptFixture.evaluate(`document.querySelector('#prompt-textarea').focus()`);
    const chatgptPlacement = await waitFor(() => chatgptFixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      const launcher = root?.querySelector('.launcher');
      if (!launcher || launcher.hidden) return null;
      const composer = document.querySelector('#composer').getBoundingClientRect();
      const launcherRect = launcher.getBoundingClientRect();
      const obstacles = [...document.querySelectorAll('#composer button')].map((button) => button.getBoundingClientRect());
      const overlaps = obstacles.some((rect) => launcherRect.left < rect.right && launcherRect.right > rect.left && launcherRect.top < rect.bottom && launcherRect.bottom > rect.top);
      return {
        strategy: launcher.dataset.placement,
        gap: launcherRect.left - composer.right,
        outside: launcherRect.left > composer.right,
        overlaps,
      };
    })()`));
    assert.equal(chatgptPlacement.strategy, 'outside-end');
    assert.equal(chatgptPlacement.outside, true);
    assert.equal(chatgptPlacement.overlaps, false);
    assert.ok(Math.abs(chatgptPlacement.gap - 8) <= 1, JSON.stringify(chatgptPlacement));
    await clickInlineLauncher(chatgptFixture);
    const assistScrollbarState = await chatgptFixture.evaluate(`(() => {
      const host = document.querySelector('#hermes-inline-draft-host');
      const panel = host?.shadowRoot?.querySelector('.panel');
      const panelStyle = getComputedStyle(panel);
      const scrollbarStyle = getComputedStyle(panel, '::-webkit-scrollbar');
      const thumbStyle = getComputedStyle(panel, '::-webkit-scrollbar-thumb');
      return {
        gutter: panelStyle.scrollbarGutter,
        width: scrollbarStyle.width,
        thumbBackground: thumbStyle.backgroundColor,
        thumbBorderWidth: thumbStyle.borderTopWidth,
        thumbBorderRadius: thumbStyle.borderRadius,
        foregroundRgb: getComputedStyle(host).getPropertyValue('--hermes-fg-rgb').trim(),
        lineStrong: getComputedStyle(host).getPropertyValue('--hermes-line-strong').trim(),
      };
    })()`);
    assert.equal(assistScrollbarState.gutter, 'stable');
    assert.equal(assistScrollbarState.width, '8px');
    assert.match(assistScrollbarState.thumbBackground, /rgba\([^)]*, 0\.45\)/);
    assert.equal(assistScrollbarState.thumbBorderWidth, '1px');
    assert.equal(assistScrollbarState.thumbBorderRadius, '0px');
    assert.match(assistScrollbarState.foregroundRgb, /^\d+,\d+,\d+$/);
    assert.match(assistScrollbarState.lineStrong, /rgba\([^)]*,\s*0\.78\)/);
    const chatgptAssistState = await waitFor(() => chatgptFixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      const promptAction = root?.querySelector('[data-action-id="chatgpt-prompt"]');
      if (!promptAction) return null;
      const settingLabels = [...root.querySelectorAll('.setting strong')].map((node) => node.textContent.trim());
      const contextToggle = root.querySelector('input[aria-label="Use visible ChatGPT context"]');
      const actionLabels = [...root.querySelectorAll('.actions .action')].map((button) => button.firstChild?.textContent?.trim() || '');
      return {
        contextState: root.querySelector('.context .secure')?.textContent || '',
        promptAction: promptAction.textContent.trim(),
        actionLabels,
        contextOptedIn: contextToggle?.checked,
        previewCopyOnly: settingLabels.includes('Preview + copy only'),
        applyToggleDisabled: [...root.querySelectorAll('.setting')].some((setting) => setting.textContent.includes('Preview + copy only') && setting.querySelector('input')?.disabled),
      };
    })()`));
    assert.deepEqual(chatgptAssistState, {
      contextState: 'DRAFT ONLY',
      promptAction: 'Improve ChatGPT promptClarify the objective, context, constraints, and desired output.',
      actionLabels: ['Improve ChatGPT prompt', 'Add constraints and checks', 'Turn into research brief'],
      contextOptedIn: false,
      previewCopyOnly: true,
      applyToggleDisabled: true,
    });
    const assistAccessibility = await chatgptFixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      if (!root) return null;
      const visible = (node) => {
        if (!node || node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const name = (node) => {
        const labelledBy = String(node.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
          .map((id) => root.getElementById(id)?.textContent?.trim() || '').filter(Boolean).join(' ');
        const label = node.id ? root.querySelector('label[for="' + CSS.escape(node.id) + '"]')?.textContent?.trim() || '' : '';
        return String(node.getAttribute('aria-label') || labelledBy || label || node.getAttribute('title') || node.textContent || node.value || node.getAttribute('placeholder') || '').trim();
      };
      const controls = [...root.querySelectorAll('button,a[href],input:not([type="hidden"]),select,textarea,[role="button"],[tabindex]')]
        .filter((node) => visible(node) && !node.disabled);
      const ids = [...root.querySelectorAll('[id]')].map((node) => node.id).filter(Boolean);
      return {
        visibleControls: controls.length,
        unnamed: controls.filter((node) => !name(node)).map((node) => node.id || node.outerHTML.slice(0, 120)),
        duplicateIds: [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))],
        positiveTabindex: controls.filter((node) => Number(node.getAttribute('tabindex')) > 0).map((node) => node.id || node.tagName),
      };
    })()`);
    assert.ok(assistAccessibility.visibleControls > 0);
    assert.deepEqual(assistAccessibility.unnamed, []);
    assert.deepEqual(assistAccessibility.duplicateIds, []);
    assert.deepEqual(assistAccessibility.positiveTabindex, []);
    await chatgptFixture.call('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const assistMotionViolations = await chatgptFixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      const seconds = (part) => {
        const value = String(part || '').trim();
        const number = Number.parseFloat(value) || 0;
        return value.endsWith('ms') ? number / 1000 : number;
      };
      const active = (value) => String(value || '').split(',').some((part) => seconds(part) > 0.02);
      return [...(root?.querySelectorAll('*') || [])].filter((node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (active(style.animationDuration) || active(style.transitionDuration));
      }).map((node) => node.id || node.className || node.tagName).slice(0, 20);
    })()`);
    assert.deepEqual(assistMotionViolations, []);
    await chatgptFixture.call('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await saveScreenshot(chatgptFixture, CHATGPT_LAUNCHER_SCREENSHOT, { captureBeyondViewport: false });
    await chatgptFixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('input[aria-label="Use visible ChatGPT context"]').click()`);
    const chatgptVisibleContext = await waitFor(() => chatgptFixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      const toggle = root?.querySelector('input[aria-label="Use visible ChatGPT context"]');
      const warningShown = root?.textContent?.includes('Visible ChatGPT context may be sent to your selected Hermes model.') || false;
      return toggle?.checked && root?.querySelector('.context .secure')?.textContent === 'BOUNDED'
        ? { checked: true, state: 'BOUNDED', warningShown }
        : null;
    })()`));
    assert.equal(chatgptVisibleContext.warningShown, true);
    const storedContextPreferences = await setup.evaluate(`chrome.storage.local.get('hermesInlineSiteContextPreferences')`);
    assert.equal(storedContextPreferences.hermesInlineSiteContextPreferences.chatgpt, 'visible');
    await chatgptFixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('input[aria-label="Use visible ChatGPT context"]').click()`);
    await waitFor(() => chatgptFixture.evaluate(`document.querySelector('#hermes-inline-draft-host')?.shadowRoot?.querySelector('.context .secure')?.textContent === 'DRAFT ONLY'`));

    await fixture.evaluate(`window.xPopupBoundField = document.querySelector('#draft')`);
    await clickInlineLauncher(fixture);
    const xPopupOpenState = await waitFor(() => fixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      const field = document.querySelector('#draft');
      if (root?.querySelector('.panel')?.hidden !== false || !root.querySelector('[data-action-id="clean-formatting"]')) return null;
      return {
        activeField: document.activeElement === field,
        sameField: window.xPopupBoundField === field && field.isConnected,
        outsideClicks: window.xPopupOutsideClicks,
      };
    })()`));
    assert.deepEqual(xPopupOpenState, { activeField: true, sameField: true, outsideClicks: 0 });
    await clickInlineLauncher(fixture);
    const xPopupToggleClosed = await waitFor(() => fixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      const field = document.querySelector('#draft');
      return root?.querySelector('.panel')?.hidden === true && document.activeElement === field && window.xPopupOutsideClicks === 0;
    })()`));
    assert.equal(xPopupToggleClosed, true);
    await clickInlineLauncher(fixture);
    await waitFor(() => fixture.evaluate(`Boolean(document.querySelector('#hermes-inline-draft-host')?.shadowRoot?.querySelector('[data-action-id="clean-formatting"]'))`));
    await saveScreenshot(fixture, INLINE_TOGGLE_SCREENSHOT, { captureBeyondViewport: false });
    await fixture.evaluate(`(() => {
      window.hermesAssistLeakedKeyboardEvents = [];
      for (const type of ['keydown', 'keypress', 'keyup']) {
        document.addEventListener(type, (event) => {
          window.hermesAssistLeakedKeyboardEvents.push({ type, key: event.key });
        });
      }
      const custom = document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('textarea.custom');
      custom.value = '';
      custom.focus();
    })()`);
    for (const [key, code, windowsVirtualKeyCode] of [
      ['T', 'KeyT', 84],
      ['h', 'KeyH', 72],
      ['i', 'KeyI', 73],
      ['s', 'KeyS', 83],
    ]) {
      await fixture.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: key, unmodifiedText: key, windowsVirtualKeyCode });
      await fixture.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
    }
    const assistKeyboardContainment = await fixture.evaluate(`(() => {
      const host = document.querySelector('#hermes-inline-draft-host');
      const custom = host.shadowRoot.querySelector('textarea.custom');
      return {
        value: custom.value,
        shadowFocus: host.shadowRoot.activeElement === custom,
        leaked: window.hermesAssistLeakedKeyboardEvents,
      };
    })()`);
    assert.deepEqual(assistKeyboardContainment, { value: 'This', shadowFocus: true, leaked: [] });
    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('[data-action-id="clean-formatting"]').click()`);
    await waitFor(() => fixture.evaluate(`document.querySelector('#draft').value === 'I wanted to follow up.'`));
    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.result-actions button:nth-child(2)').click()`);
    await waitFor(() => fixture.evaluate(`document.querySelector('#draft').value === '  I wanted   to follow up.  '`));
    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.close').click()`);

    await fixture.evaluate(`(() => {
      const rich = document.querySelector('#rich-draft');
      window.richNormalizeLikeX = true;
      rich.focus();
      document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.launcher').click();
      document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('[data-action-id="clean-formatting"]').click();
    })()`);
    const richApplyState = await waitFor(() => fixture.evaluate(`(() => {
      const rich = document.querySelector('#rich-draft');
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      if (root?.querySelector('.context span:last-child')?.textContent !== 'COMPLETE') return null;
      return {
        text: rich.textContent.trim(),
        copies: rich.textContent.split('One clear sentence.').length - 1,
        inputEvents: window.richInputEvents,
        primary: root.querySelector('.result-actions .main')?.textContent || '',
      };
    })()`));
    assert.deepEqual(richApplyState, { text: 'One clear sentence.', copies: 1, inputEvents: 1, primary: 'Keep replacement' });
    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.result-actions button:nth-child(2)').click()`);
    const richUndoState = await fixture.evaluate(`(() => {
      const rich = document.querySelector('#rich-draft');
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      return {
        text: rich.textContent.trim(),
        copies: rich.textContent.split('One   clear   sentence.').length - 1,
        inputEvents: window.richInputEvents,
        state: root?.querySelector('.context span:last-child')?.textContent || '',
        status: root?.querySelector('.status')?.textContent || '',
      };
    })()`);
    assert.deepEqual(richUndoState, { text: 'One   clear   sentence.', copies: 1, inputEvents: 2, state: 'COMPLETE', status: '' });
    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.result-actions .main').click()`);
    await waitFor(() => fixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      return root?.querySelector('.panel')?.hidden === true && document.querySelector('#rich-draft')?.textContent.trim() === 'One clear sentence.' && window.richInputEvents === 3;
    })()`));
    await saveScreenshot(fixture, INLINE_SINGLE_COPY_SCREENSHOT, { captureBeyondViewport: false });
    const xRichDeleteState = await fixture.evaluate(`(() => {
      const rich = document.querySelector('#rich-draft');
      rich.replaceChildren();
      rich.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
      return {
        empty: rich.textContent.trim() === '',
        copies: rich.textContent.includes('One clear sentence.') ? 1 : 0,
        inputEvents: window.richInputEvents,
      };
    })()`);
    assert.deepEqual(xRichDeleteState, { empty: true, copies: 0, inputEvents: 4 });
    await saveScreenshot(fixture, INLINE_DELETE_ALL_SCREENSHOT, { captureBeyondViewport: false });

    await fixture.evaluate(`(() => {
      const field = document.createElement('div');
      field.id = 'x-managed-draft';
      field.setAttribute('data-testid', 'tweetTextarea_0');
      field.setAttribute('contenteditable', 'true');
      field.setAttribute('role', 'textbox');
      field.setAttribute('aria-label', 'Post your reply');
      field.dataset.frameworkState = '';
      field.dataset.pasteEvents = '0';
      document.body.appendChild(field);
      const render = () => {
        field.replaceChildren();
        if (!field.dataset.frameworkState) return;
        const managed = document.createElement('span');
        managed.dataset.frameworkOwned = 'true';
        managed.textContent = field.dataset.frameworkState;
        field.appendChild(managed);
      };
      field.addEventListener('paste', (event) => {
        field.dataset.pasteEvents = String(Number(field.dataset.pasteEvents || 0) + 1);
        event.preventDefault();
        field.dataset.frameworkState = event.clipboardData.getData('text/plain');
        render();
      });
      field.addEventListener('beforeinput', (event) => {
        if (event.inputType !== 'deleteContentBackward') return;
        event.preventDefault();
        field.dataset.frameworkState = '';
        render();
      });
      return true;
    })()`);
    const xManagedApplyState = await setup.evaluate(`(async () => {
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: ${scriptedTabId} },
        func: () => {
          const field = document.querySelector('#x-managed-draft');
          const originalExecCommand = document.execCommand;
          let commandCalls = 0;
          document.execCommand = (...args) => {
            commandCalls += 1;
            return originalExecCommand?.apply(document, args) || false;
          };
          const applied = globalThis.HermesInlineDraft.applyResult(field, {
            adapterId: 'x',
            draftText: '',
            resultText: 'One framework-owned X reply.',
          });
          document.execCommand = originalExecCommand;
          return {
            ok: applied.ok,
            reason: applied.reason || '',
            text: field.textContent,
            copies: field.textContent.split('One framework-owned X reply.').length - 1,
            pasteEvents: Number(field.dataset.pasteEvents || 0),
            commandCalls,
            frameworkChildren: field.querySelectorAll('[data-framework-owned="true"]').length,
          };
        },
      });
      return execution?.result || null;
    })()`);
    assert.deepEqual(xManagedApplyState, {
      ok: true,
      reason: '',
      text: 'One framework-owned X reply.',
      copies: 1,
      pasteEvents: 1,
      commandCalls: 0,
      frameworkChildren: 1,
    });
    const xManagedDeleteState = await fixture.evaluate(`(() => {
      const field = document.querySelector('#x-managed-draft');
      const event = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: 'deleteContentBackward',
      });
      field.dispatchEvent(event);
      const result = {
        stateText: field.dataset.frameworkState,
        domText: field.textContent,
        childNodes: field.childNodes.length,
      };
      field.remove();
      return result;
    })()`);
    assert.deepEqual(xManagedDeleteState, { stateText: '', domText: '', childNodes: 0 });

    await fixture.evaluate(`(() => {
      document.querySelector('#draft').focus();
      const root = document.querySelector('#hermes-inline-draft-host').shadowRoot;
      root.querySelector('.close').click();
      root.querySelector('.launcher').click();
      root.querySelector('[data-action-id="improve"]').click();
    })()`);
    const routeState = await waitFor(() => fixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      const routes = Array.from(root?.querySelectorAll('.route') || []);
      return routes.length === 3 ? {
        title: root.querySelector('.route-title')?.textContent || '',
        labels: routes.map((route) => route.textContent.trim()),
      } : null;
    })()`));
    assert.equal(routeState.title, 'Where should Hermes work?');
    assert.ok(routeState.labels.some((label) => label.includes('Continue current chat')));
    assert.ok(routeState.labels.some((label) => label.includes('Start new Assist session')));
    assert.ok(routeState.labels.some((label) => label.includes('Run in background')));
    await saveScreenshot(fixture, INLINE_ROUTE_SCREENSHOT, { captureBeyondViewport: false });

    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('[data-route="background"]').click()`);
    const inlineResultState = await waitFor(() => fixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      const value = document.querySelector('#draft')?.value || '';
      if (value === ${JSON.stringify(INLINE_REPLY)}) return {
        title: root?.querySelector('.run-title')?.textContent || '',
        result: root?.querySelector('.preview')?.textContent || '',
        session: root?.querySelector('.run-row strong')?.textContent || '',
        error: '',
      };
      const state = root?.querySelector('.context span:last-child')?.textContent || '';
      if (state === 'BLOCKED') return {
        title: '',
        result: '',
        session: '',
        error: root?.querySelector('.status')?.textContent || 'Assist blocked without a reason.',
      };
      return null;
    })()`));
    assert.equal(inlineResultState.error, '');
    assert.equal(inlineResultState.title, 'Draft ready. Still your decision.');
    assert.equal(inlineResultState.result, INLINE_REPLY);
    assert.match(inlineResultState.session, /Hermes Assist/i);
    const afterBackground = await setup.evaluate(`chrome.storage.local.get('hermesBrowserSettings')`);
    assert.equal(afterBackground.hermesBrowserSettings.sessionId, storedAfterSend.hermesBrowserSettings.sessionId);
    await saveScreenshot(fixture, INLINE_RESULT_SCREENSHOT, { captureBeyondViewport: false });
    const retainedAssistCreate = mock.requests.filter((request) => request.method === 'POST' && request.path === '/api/sessions' && request.body?.source === 'hermes_assist').at(-1);
    const retainedAssistSessionId = retainedAssistCreate?.body?.id || retainedAssistCreate?.body?.session_id || '';
    assert.match(retainedAssistSessionId, /^hermes-assist-/);
    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.result-actions button:last-child').click()`);
    const openDestinationState = await waitFor(() => fixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      const choices = [...(root?.querySelectorAll('[data-session-surface]') || [])];
      return choices.length === 2 ? { title: root.querySelector('.route-title')?.textContent || '', labels: choices.map((button) => button.textContent.trim()) } : null;
    })()`));
    assert.equal(openDestinationState.title, 'Where should this session open?');
    assert.ok(openDestinationState.labels.some((label) => label.includes('Browser Extension')));
    assert.ok(openDestinationState.labels.some((label) => label.includes('Hermes Web')));
    await saveScreenshot(fixture, INLINE_OPEN_SESSION_SCREENSHOT, { captureBeyondViewport: false });
    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('[data-session-surface="web"]').click()`);
    const openedWebSession = await waitFor(() => setup.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((item) => String(item.url || '').includes('sourceSurfaceId=inline-assist'));
      if (!tab) return null;
      const parsed = new URL(tab.url);
      return { sessionId: parsed.searchParams.get('sessionId'), path: parsed.pathname };
    })()`));
    assert.equal(openedWebSession.sessionId, retainedAssistSessionId);
    assert.match(openedWebSession.path, /\/app\.html$/);
    await waitFor(() => fixture.evaluate(`document.querySelector('#hermes-inline-draft-host')?.shadowRoot?.querySelector('.panel')?.hidden === true`));

    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.close').click()`);
    await setup.evaluate(`(async () => {
      const stored = await chrome.storage.local.get('hermesBrowserSettings');
      await chrome.storage.local.set({ hermesBrowserSettings: {
        ...stored.hermesBrowserSettings,
        inlineAssistEnabled: true,
        inlineAssistDefaultRoute: 'background',
        inlineAssistSessionRetention: 'delete',
      }});
    })()`);
    await fixture.evaluate(`(() => {
      const field = document.querySelector('#draft');
      field.value = '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.focus();
      document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.launcher').click();
    })()`);
    await waitFor(() => fixture.evaluate(`Boolean(document.querySelector('#hermes-inline-draft-host')?.shadowRoot?.querySelector('[data-action-id="draft-for-context"]'))`));
    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('[data-action-id="draft-for-context"]').click()`);
    const smartStart = await waitFor(() => fixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      const state = root?.querySelector('.context span:last-child')?.textContent || '';
      if (root?.querySelector('.working') || state === 'COMPLETE') return { direct: root.querySelectorAll('.route').length === 0, error: '' };
      if (state === 'BLOCKED') {
        return { direct: false, error: root.querySelector('.status')?.textContent || 'Smart draft blocked.' };
      }
      return null;
    })()`));
    assert.equal(smartStart.error, '');
    assert.equal(smartStart.direct, true);
    const smartResult = await waitFor(() => fixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      if (root?.querySelector('.context span:last-child')?.textContent !== 'COMPLETE') return null;
      return {
        field: document.querySelector('#draft')?.value || '',
        preview: root.querySelector('.preview')?.textContent || '',
        applyStatus: root.querySelector('.secure')?.textContent || '',
        buttons: [...root.querySelectorAll('.result-actions button')].map((button) => button.textContent.trim()),
        lastGridColumn: getComputedStyle(root.querySelector('.result-actions button:last-child')).gridColumn,
        hasOpenSession: [...root.querySelectorAll('.result-actions button')].some((button) => button.textContent === 'Open session'),
      };
    })()`));
    assert.equal(smartResult.preview, INLINE_REPLY);
    assert.equal(smartResult.field, INLINE_REPLY, `Smart draft did not apply automatically: ${smartResult.applyStatus}`);
    assert.deepEqual(smartResult.buttons, ['Use draft', 'Undo', 'Copy']);
    assert.match(smartResult.lastGridColumn, /1\s*\/\s*-1/);
    assert.equal(smartResult.hasOpenSession, false);
    await saveScreenshot(fixture, INLINE_NO_SESSION_SCREENSHOT, { captureBeyondViewport: false });
    const emptyDraftApplyState = await fixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host').shadowRoot;
      const field = document.querySelector('#draft');
      const primary = root.querySelector('.result-actions .main');
      const before = { label: primary?.textContent || '', disabled: field.disabled, readOnly: field.readOnly };
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
      field.setRangeText('!', field.value.length, field.value.length, 'end');
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '!' }));
      return { ...before, edited: field.value };
    })()`);
    assert.equal(emptyDraftApplyState.label, 'Use draft');
    assert.equal(emptyDraftApplyState.disabled, false);
    assert.equal(emptyDraftApplyState.readOnly, false);
    assert.equal(emptyDraftApplyState.edited, `${INLINE_REPLY}!`);
    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.result-actions .main').click()`);
    await waitFor(() => fixture.evaluate(`document.querySelector('#hermes-inline-draft-host')?.shadowRoot?.querySelector('.panel')?.hidden === true`));
    const smartRequest = mock.getChatRequest();
    assert.match(String(smartRequest?.message || ''), /Draft the text that belongs in the focused field/);
    assert.match(String(smartRequest?.message || ''), /"page_context":"[^"]+/);
    const assistCreates = mock.requests.filter((request) => request.method === 'POST' && request.path === '/api/sessions' && request.body?.source === 'hermes_assist');
    assert.ok(assistCreates.length >= 2);
    assert.equal(new Set(assistCreates.map((request) => request.body.title)).size, assistCreates.length);
    for (const request of assistCreates) {
      assert.match(request.body.title, /^Hermes Assist ·/);
      assert.equal(request.body.model, 'e2e/test-model');
      assert.equal(request.body.provider, 'e2e');
    }
    const assistChats = mock.requests.filter((request) => request.method === 'POST' && /^\/api\/sessions\/[^/]+\/chat$/.test(request.path) && request.body?.model === 'e2e/test-model');
    assert.ok(assistChats.length >= 2);
    assert.ok(assistChats.every((request) => request.body.fast === false && request.body.model_options?.fast === false && request.body.reasoning_effort === 'low'));
    assert.equal(mock.requests.filter((request) => request.method === 'DELETE' && /^\/api\/sessions\//.test(request.path)).length, 1);

    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.close').click()`);
    await setup.evaluate(`(async () => {
      const stored = await chrome.storage.local.get('hermesBrowserSettings');
      await chrome.storage.local.set({ hermesBrowserSettings: {
        ...stored.hermesBrowserSettings,
        inlineAssistEnabled: false,
        inlineAssistDefaultRoute: 'ask',
      }});
    })()`);
    await waitFor(() => fixture.evaluate(`document.querySelector('#hermes-inline-draft-host')?.shadowRoot?.querySelector('.launcher')?.hidden === true`));
    await setup.evaluate(`(async () => {
      const stored = await chrome.storage.local.get('hermesBrowserSettings');
      await chrome.storage.local.set({ hermesBrowserSettings: { ...stored.hermesBrowserSettings, inlineAssistEnabled: true }});
    })()`);
    await fixture.evaluate(`document.querySelector('#draft').focus()`);
    await waitFor(() => fixture.evaluate(`document.querySelector('#hermes-inline-draft-host')?.shadowRoot?.querySelector('.launcher')?.hidden === false`));

    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.launcher').click()`);
    const beforeScrollPanel = await waitFor(() => fixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      const panel = root?.querySelector('.panel');
      return panel && !panel.hidden ? root.querySelector('.body')?.textContent || '' : '';
    })()`));
    const scrolledToBottom = await fixture.evaluate(`(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      window.dispatchEvent(new Event('scroll'));
      return window.scrollY;
    })()`);
    assert.ok(scrolledToBottom > 0);
    const suspendedPanel = await waitFor(() => fixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      const panel = root?.querySelector('.panel');
      return root?.querySelector('.launcher')?.hidden === true && panel?.hidden === false && panel?.style.visibility === 'hidden';
    })()`));
    assert.equal(suspendedPanel, true);
    await fixture.evaluate(`(() => { window.scrollTo(0, 0); window.dispatchEvent(new Event('scroll')); document.querySelector('#draft').focus(); })()`);
    const restoredPanel = await waitFor(() => fixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      const panel = root?.querySelector('.panel');
      if (root?.querySelector('.launcher')?.hidden || panel?.hidden || panel?.style.visibility === 'hidden') return null;
      return root.querySelector('.body')?.textContent || '';
    })()`));
    assert.equal(restoredPanel, beforeScrollPanel);
    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.close').click()`);

    await setup.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((item) => item.url === ${JSON.stringify(`${mock.baseUrl}/qa-inline`)});
      if (!tab) return { ok: false, reason: 'fixture-tab-missing' };
      return chrome.tabs.sendMessage(tab.id, { type: 'HERMES_INLINE_CONTEXT_ACTION', actionId: 'draft-reply' });
    })()`);
    const contextRouteTitle = await waitFor(() => fixture.evaluate(`(() => {
      const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
      return root?.querySelectorAll('.route').length === 3 ? root.querySelector('.route-title')?.textContent || '' : '';
    })()`));
    assert.equal(contextRouteTitle, 'Where should Hermes work?');

    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.close').click()`);
    await panel.evaluate(`document.querySelector('#newSessionButton').click()`);
    await waitFor(() => panel.evaluate(`document.querySelector('#browserIntroHero')?.hidden === true && document.querySelector('#messages')?.textContent === ''`));

    const rightClickMarker = 'RIGHT_CLICK_E2E_SELECTION_73f9';
    await setup.evaluate(`chrome.storage.session.set({ hermesBrowserContextMenuRequest: {
      prompt: 'Summarize this selected text concisely:',
      selection: ${JSON.stringify('RIGHT_CLICK_E2E_SELECTION_73f9')},
      pageUrl: ${JSON.stringify(`${mock.baseUrl}/qa-inline`)},
      tabId: 1,
      route: 'ask',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60000,
    }})`);
    const rightClickChooser = await waitFor(() => panel.evaluate(`(() => {
      const notice = document.querySelector('#contextMenuRouteNotice');
      if (!notice || notice.hidden) return null;
      return [...notice.querySelectorAll('[data-context-menu-route]')].map((button) => button.textContent.trim());
    })()`));
    assert.deepEqual(rightClickChooser, ['Current session', 'New session', 'Background']);
    await panel.evaluate(`document.querySelector('[data-context-menu-route="current"]').click()`);
    await waitFor(() => JSON.stringify(mock.getChatRequest() || {}).includes(rightClickMarker) ? true : null);

    await panel.evaluate(`document.querySelector('#settingsButton').click()`);
    const assistSettingsState = await waitFor(() => panel.evaluate(`(() => {
      const dialog = document.querySelector('#settingsDialog');
      return dialog && !dialog.hidden ? {
        modelLabel: document.querySelector('#inlineAssistModelLabel')?.textContent || '',
        rightClickRoute: document.querySelector('#contextMenuDefaultRoute')?.value || '',
      } : null;
    })()`));
    assert.match(assistSettingsState.modelLabel, /test.?model/i);
    await panel.evaluate(`document.querySelector('#inlineAssistModelButton').click()`);
    const sharedPickerState = await waitFor(() => panel.evaluate(`(() => {
      const picker = document.querySelector('#modelMenu');
      return picker && !picker.hidden ? {
        search: Boolean(picker.querySelector('#modelSearchInput')),
        providers: picker.querySelectorAll('.model-provider-option').length,
        providerLabels: [...picker.querySelectorAll('.model-provider-option')].map((button) => button.textContent.trim()),
        selectedProvider: picker.querySelector('.model-provider-option.selected')?.textContent?.trim() || '',
        models: picker.querySelectorAll('.model-option').length,
        heading: picker.querySelector('.model-options-heading')?.textContent || '',
        efforts: [...picker.querySelectorAll('[data-effort]')].map((button) => button.querySelector('span')?.textContent?.trim() || ''),
        thinking: picker.querySelector('[data-toggle="thinking"]')?.getAttribute('aria-pressed'),
        fast: picker.querySelector('[data-toggle="fast"]')?.getAttribute('aria-pressed'),
        close: Boolean(picker.querySelector('#modelMenuCloseButton')),
        parentIsSettings: Boolean(picker.closest('#settingsForm')),
        rect: (() => { const rect = picker.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height }; })(),
        viewportHeight: innerHeight,
        buttonFont: getComputedStyle(document.querySelector('#inlineAssistModelButton')).fontFamily,
        selectFont: getComputedStyle(document.querySelector('#inlineAssistDefaultRoute')).fontFamily,
        buttonAlign: getComputedStyle(document.querySelector('#inlineAssistModelButton')).textAlign,
      } : null;
    })()`));
    assert.equal(sharedPickerState.search, true);
    assert.ok(sharedPickerState.providers >= 2);
    assert.ok(sharedPickerState.providerLabels.some((label) => label.includes('E2E Provider')));
    assert.ok(sharedPickerState.providerLabels.some((label) => label.includes('Alternate Provider')));
    assert.match(sharedPickerState.selectedProvider, /E2E Provider/);
    assert.ok(sharedPickerState.models >= 1);
    assert.equal(sharedPickerState.heading, 'Hermes Assist options');
    assert.deepEqual(sharedPickerState.efforts, ['Minimal', 'Low', 'Medium', 'High', 'Extra High', 'Max', 'Ultra']);
    assert.equal(sharedPickerState.thinking, 'true');
    assert.equal(sharedPickerState.fast, 'false');
    assert.equal(sharedPickerState.close, true);
    assert.equal(sharedPickerState.parentIsSettings, false);
    assert.ok(sharedPickerState.rect.height < 500, JSON.stringify(sharedPickerState));
    assert.ok(sharedPickerState.rect.top >= 0 && sharedPickerState.rect.bottom <= sharedPickerState.viewportHeight, JSON.stringify(sharedPickerState));
    assert.equal(sharedPickerState.buttonFont, sharedPickerState.selectFont);
    assert.equal(sharedPickerState.buttonAlign, 'left');
    await saveScreenshot(panel, ASSIST_SETTINGS_SCREENSHOT, { captureBeyondViewport: false });
    await panel.evaluate(`document.querySelector('#modelMenuCloseButton').click()`);
    await waitFor(() => panel.evaluate(`document.querySelector('#modelMenu')?.hidden === true`));
    await panel.evaluate(`document.querySelector('#inlineAssistModelButton').click()`);
    await waitFor(() => panel.evaluate(`document.querySelector('#modelMenu')?.hidden === false`));
    const beforeAssistPickerChange = await setup.evaluate(`chrome.storage.local.get('hermesBrowserSettings')`);
    await panel.evaluate(`document.querySelector('#modelOptionsList [data-toggle="fast"]').click()`);
    await waitFor(async () => {
      const stored = await setup.evaluate(`chrome.storage.local.get('hermesBrowserSettings')`);
      return stored.hermesBrowserSettings.inlineAssistFastMode === true ? stored : null;
    });
    await panel.evaluate(`(() => {
      const provider = [...document.querySelectorAll('#modelMenu .model-provider-option')]
        .find((button) => button.textContent.includes('Alternate Provider'));
      provider?.click();
    })()`);
    await waitFor(() => panel.evaluate(`(() => {
      const selected = document.querySelector('#modelMenu .model-provider-option.selected')?.textContent || '';
      const model = [...document.querySelectorAll('#modelMenu .model-option:not([disabled])')]
        .find((button) => button.dataset.modelId.includes('provider-model'));
      return selected.includes('Alternate Provider') && Boolean(model);
    })()`));
    await panel.evaluate(`(() => {
      const next = [...document.querySelectorAll('#modelMenu .model-option:not([disabled])')]
        .find((button) => button.dataset.modelId.includes('provider-model'));
      next?.click();
    })()`);
    const afterAssistPickerChange = await waitFor(async () => {
      const stored = await setup.evaluate(`chrome.storage.local.get('hermesBrowserSettings')`);
      const settings = stored.hermesBrowserSettings;
      return settings.inlineAssistProvider === 'alternate' && settings.inlineAssistRawModel === 'alternate/provider-model' ? stored : null;
    });
    assert.equal(afterAssistPickerChange.hermesBrowserSettings.model, beforeAssistPickerChange.hermesBrowserSettings.model);
    assert.equal(Boolean(afterAssistPickerChange.hermesBrowserSettings.fastMode), Boolean(beforeAssistPickerChange.hermesBrowserSettings.fastMode));
    assert.equal(afterAssistPickerChange.hermesBrowserSettings.inlineAssistProvider, 'alternate');
    assert.equal(afterAssistPickerChange.hermesBrowserSettings.inlineAssistRawModel, 'alternate/provider-model');

    await panel.evaluate(`document.querySelector('#closeSettingsButton').click()`);

    mock.setAssistCreateAcknowledgement('runtime');
    mock.setAssistChatAcknowledgement('runtime');
    const switchedAssistRequestStart = mock.requests.length;
    await setup.evaluate(`(async () => {
      const stored = await chrome.storage.local.get('hermesBrowserSettings');
      await chrome.storage.local.set({ hermesBrowserSettings: {
        ...stored.hermesBrowserSettings,
        inlineAssistDefaultRoute: 'background',
        inlineAssistSessionRetention: 'keep',
      }});
    })()`);
    await fixture.evaluate(`(() => {
      const field = document.querySelector('#draft');
      field.value = 'Route this draft with the newly selected model.';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.focus();
      const root = document.querySelector('#hermes-inline-draft-host').shadowRoot;
      if (!root.querySelector('.panel').hidden) root.querySelector('.close').click();
      root.querySelector('.launcher').click();
      root.querySelector('[data-action-id="improve"]').click();
    })()`);
    const switchedAssistRequests = await waitFor(() => {
      const recent = mock.requests.slice(switchedAssistRequestStart);
      const create = recent.find((request) => request.method === 'POST' && request.path === '/api/sessions' && request.body?.source === 'hermes_assist');
      const chat = recent.find((request) => request.method === 'POST' && /^\/api\/sessions\/[^/]+\/chat$/.test(request.path));
      return create && chat ? { create, chat } : null;
    });
    assert.equal(switchedAssistRequests.create.body.model, 'alternate/provider-model');
    assert.equal(switchedAssistRequests.create.body.provider, 'alternate');
    assert.equal(switchedAssistRequests.chat.body.model, 'alternate/provider-model');
    assert.equal(switchedAssistRequests.chat.body.provider, 'alternate');
    await waitFor(() => fixture.evaluate(`document.querySelector('#hermes-inline-draft-host')?.shadowRoot?.querySelector('.context span:last-child')?.textContent === 'COMPLETE'`));
    mock.setAssistCreateAcknowledgement('direct');
    mock.setAssistChatAcknowledgement('direct');
    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.close').click()`);

    mock.setAssistCreateAcknowledgement('missing');
    const rejectedAssistRequestStart = mock.requests.length;
    await fixture.evaluate(`(() => {
      const field = document.querySelector('#draft');
      field.focus();
      const root = document.querySelector('#hermes-inline-draft-host').shadowRoot;
      root.querySelector('.launcher').click();
      root.querySelector('[data-action-id="improve"]').click();
    })()`);
    const rejectedAssistState = await waitFor(async () => {
      const recent = mock.requests.slice(rejectedAssistRequestStart);
      const creates = recent.filter((request) => request.method === 'POST' && request.path === '/api/sessions');
      const cleanup = recent.find((request) => request.method === 'DELETE' && /^\/api\/sessions\/[^/]+$/.test(request.path));
      const chat = recent.find((request) => request.method === 'POST' && /\/chat$/.test(request.path));
      const ui = await fixture.evaluate(`(() => {
        const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
        return {
          state: root?.querySelector('.context span:last-child')?.textContent || '',
          status: root?.querySelector('.status')?.textContent || '',
          routing: [...(root?.querySelectorAll('.privacy') || [])].map((node) => node.textContent).join(' '),
        };
      })()`);
      return creates.length >= 2 && cleanup && chat && ui.state === 'COMPLETE' ? { creates, cleanup, chat, ui } : null;
    });
    assert.equal(rejectedAssistState.creates[0].body.model, 'alternate/provider-model');
    assert.equal(Object.hasOwn(rejectedAssistState.creates[1].body, 'model'), false);
    assert.equal(Object.hasOwn(rejectedAssistState.chat.body, 'model'), false);
    assert.match(rejectedAssistState.ui.routing, /Model routing.*gateway default model instead/i);
    mock.setAssistCreateAcknowledgement('direct');
    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.close').click()`);

    mock.setAssistCreateAcknowledgement('missing');
    mock.setAssistCleanupStatus(503);
    const cleanupFailureRequestStart = mock.requests.length;
    await fixture.evaluate(`(() => {
      const field = document.querySelector('#draft');
      field.focus();
      const root = document.querySelector('#hermes-inline-draft-host').shadowRoot;
      root.querySelector('.launcher').click();
      root.querySelector('[data-action-id="improve"]').click();
    })()`);
    const cleanupFailureState = await waitFor(async () => {
      const recent = mock.requests.slice(cleanupFailureRequestStart);
      const create = recent.find((request) => request.method === 'POST' && request.path === '/api/sessions');
      const cleanup = recent.find((request) => request.method === 'DELETE' && /^\/api\/sessions\/[^/]+$/.test(request.path));
      const chat = recent.find((request) => request.method === 'POST' && /\/chat$/.test(request.path));
      const ui = await fixture.evaluate(`(() => {
        const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
        return {
          state: root?.querySelector('.context span:last-child')?.textContent || '',
          status: root?.querySelector('.status')?.textContent || '',
        };
      })()`);
      return create && cleanup && ui.state === 'BLOCKED' ? { chat, ui } : null;
    });
    assert.equal(cleanupFailureState.chat, undefined);
    assert.match(cleanupFailureState.ui.status, /Cleanup also failed.*503/i);
    mock.setAssistCleanupStatus(204);
    mock.setAssistCreateAcknowledgement('direct');
    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.close').click()`);

    mock.setAssistChatAcknowledgement('mismatch');
    const chatMismatchRequestStart = mock.requests.length;
    await fixture.evaluate(`(() => {
      const field = document.querySelector('#draft');
      field.value = ${JSON.stringify('Keep this text when chat acknowledgement mismatches.')};
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.focus();
      const root = document.querySelector('#hermes-inline-draft-host').shadowRoot;
      root.querySelector('.launcher').click();
      root.querySelector('[data-action-id="improve"]').click();
    })()`);
    const chatMismatchState = await waitFor(async () => {
      const recent = mock.requests.slice(chatMismatchRequestStart);
      const create = recent.find((request) => request.method === 'POST' && request.path === '/api/sessions');
      const chat = recent.find((request) => request.method === 'POST' && /\/chat$/.test(request.path));
      const ui = await fixture.evaluate(`(() => {
        const root = document.querySelector('#hermes-inline-draft-host')?.shadowRoot;
        return {
          state: root?.querySelector('.context span:last-child')?.textContent || '',
          status: root?.querySelector('.status')?.textContent || '',
          fieldValue: document.querySelector('#draft')?.value || '',
          routing: [...(root?.querySelectorAll('.privacy') || [])].map((node) => node.textContent).join(' '),
        };
      })()`);
      return create && chat && ui.state === 'COMPLETE' ? { ui } : null;
    });
    assert.match(chatMismatchState.ui.routing, /Model routing.*without acknowledging the selected model.*gateway default model instead/i);
    assert.notEqual(chatMismatchState.ui.fieldValue, '');
    mock.setAssistChatAcknowledgement('direct');
    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.close').click()`);

    mock.setAssistSessionModelRouting(false);
    mock.setAssistCreateAcknowledgement('missing');
    mock.setAssistChatAcknowledgement('missing');
    const releasedGatewayRequestStart = mock.requests.length;
    await fixture.evaluate(`(() => {
      const field = document.querySelector('#draft');
      field.value = 'Draft through an unmodified released Hermes gateway.';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.focus();
      const root = document.querySelector('#hermes-inline-draft-host').shadowRoot;
      root.querySelector('.launcher').click();
      root.querySelector('[data-action-id="improve"]').click();
    })()`);
    const releasedGatewayState = await waitFor(async () => {
      const recent = mock.requests.slice(releasedGatewayRequestStart);
      const create = recent.find((request) => request.method === 'POST' && request.path === '/api/sessions' && request.body?.source === 'hermes_assist');
      const chat = recent.find((request) => request.method === 'POST' && /\/chat$/.test(request.path));
      const state = await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host')?.shadowRoot?.querySelector('.context span:last-child')?.textContent || ''`);
      return create && chat && state === 'COMPLETE' ? { create, chat } : null;
    });
    for (const request of [releasedGatewayState.create.body, releasedGatewayState.chat.body]) {
      assert.equal(Object.hasOwn(request, 'model'), false);
      assert.equal(Object.hasOwn(request, 'provider'), false);
      assert.equal(Object.hasOwn(request, 'require_model_lock'), false);
      assert.equal(Object.hasOwn(request, 'model_options'), false);
      assert.equal(Object.hasOwn(request, 'reasoning_effort'), false);
      assert.equal(Object.hasOwn(request, 'fast'), false);
    }
    assert.equal(releasedGatewayState.create.body.source, 'hermes_assist');
    assert.match(releasedGatewayState.chat.body.message, /Draft through an unmodified released Hermes gateway/);

    await panel.call('Page.reload', { ignoreCache: true });
    await waitFor(() => panel.evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('#settingsButton'))`));
    await waitFor(() => panel.evaluate(`document.querySelector('#inlineAssistModelButton')?.disabled === false && document.querySelector('#inlineAssistModelLabel')?.textContent === 'Provider Switch Model'`));
    await panel.evaluate(`document.querySelector('#settingsButton').click()`);
    const releasedGatewaySettingsState = await waitFor(() => panel.evaluate(`(() => {
      const dialog = document.querySelector('#settingsDialog');
      const button = document.querySelector('#inlineAssistModelButton');
      if (!dialog || dialog.hidden || !button) return null;
      return {
        label: document.querySelector('#inlineAssistModelLabel')?.textContent || '',
        disabled: button.disabled,
        title: button.title,
        hint: document.querySelector('#assistModelCapabilityHint')?.textContent || '',
      };
    })()`));
    assert.equal(releasedGatewaySettingsState.label, 'Provider Switch Model');
    assert.equal(releasedGatewaySettingsState.disabled, false);
    assert.match(releasedGatewaySettingsState.title, /Falls back to the gateway default/i);
    assert.match(releasedGatewaySettingsState.hint, /choice stays saved.*gateway default.*labels every fallback/i);
    await panel.evaluate(`document.querySelector('#inlineAssistModelButton').scrollIntoView({ block: 'center', inline: 'nearest' })`);
    await saveScreenshot(panel, ASSIST_RELEASED_GATEWAY_SCREENSHOT, { captureBeyondViewport: false });
    await panel.evaluate(`document.querySelector('#closeSettingsButton').click()`);

    mock.setAssistSessionModelRouting(true);
    mock.setAssistCreateAcknowledgement('direct');
    mock.setAssistChatAcknowledgement('direct');
    await fixture.evaluate(`document.querySelector('#hermes-inline-draft-host').shadowRoot.querySelector('.close').click()`);
    await panel.call('Page.reload', { ignoreCache: true });
    await waitFor(() => panel.evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('#modelMenuButton'))`));
    await waitFor(() => panel.evaluate(`document.querySelector('#inlineAssistModelButton')?.disabled === false`));
    await waitFor(() => panel.evaluate(`document.querySelector('#modelMenuButton')?.disabled === false`));

    await panel.evaluate(`document.querySelector('#modelMenuButton').click()`);
    const mainPickerState = await waitFor(() => panel.evaluate(`(() => {
      const picker = document.querySelector('#modelMenu');
      if (!picker || picker.hidden || picker.dataset.selectionTarget === 'assist') return null;
      return {
        providers: [...picker.querySelectorAll('.model-provider-option')].map((button) => button.textContent.trim()),
        selected: picker.querySelector('.model-provider-option.selected')?.textContent?.trim() || '',
        models: [...picker.querySelectorAll('.model-option')].map((button) => button.textContent.trim()),
        providerStrip: (() => {
          const strip = picker.querySelector('.model-provider-list');
          const rect = strip.getBoundingClientRect();
          return { height: rect.height, clientWidth: strip.clientWidth, scrollWidth: strip.scrollWidth };
        })(),
        providerButtons: [...picker.querySelectorAll('.model-provider-option')].map((button) => {
          const rect = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          return { label: button.textContent.trim(), height: rect.height, color: style.color, background: style.backgroundColor };
        }),
        effortColumns: getComputedStyle(picker.querySelector('.model-effort-list')).gridTemplateColumns.split(' ').length,
      };
    })()`));
    assert.ok(mainPickerState.providers.some((label) => label.includes('E2E Provider')));
    assert.ok(mainPickerState.providers.some((label) => label.includes('Alternate Provider')));
    assert.equal(mainPickerState.providers.length, 7);
    assert.match(mainPickerState.selected, /E2E Provider/);
    assert.ok(mainPickerState.providerStrip.height >= 58, JSON.stringify(mainPickerState.providerStrip));
    assert.ok(mainPickerState.providerStrip.scrollWidth > mainPickerState.providerStrip.clientWidth, JSON.stringify(mainPickerState.providerStrip));
    assert.ok(mainPickerState.providerButtons.every((button) => button.height >= 30 && button.color !== 'rgba(0, 0, 0, 0)'), JSON.stringify(mainPickerState.providerButtons));
    assert.equal(mainPickerState.effortColumns, 4);
    if (ASSIST_THEME === 'nous' && ASSIST_MODE === 'light') {
      const selectedProviderButton = mainPickerState.providerButtons.find((button) => button.label.includes('E2E Provider'));
      assert.equal(selectedProviderButton?.background, 'rgb(255, 255, 255)');
      assert.equal(selectedProviderButton?.color, 'rgb(5, 5, 232)');
    }
    await saveScreenshot(panel, MAIN_MODEL_PICKER_SCREENSHOT, { captureBeyondViewport: false });
    await panel.evaluate(`[...document.querySelectorAll('#modelProviderList .model-provider-option')].find((button) => button.textContent.includes('OpenAI Codex'))?.click()`);
    const gpt56ContextState = await waitFor(() => panel.evaluate(`(() => {
      const selected = document.querySelector('#modelProviderList .model-provider-option.selected')?.textContent?.trim() || '';
      const models = [...document.querySelectorAll('#modelMenuList .model-option')].map((button) => button.textContent.trim());
      return selected.includes('OpenAI Codex') && models.length === 3 ? { selected, models } : null;
    })()`));
    assert.deepEqual(gpt56ContextState.models.map((label) => label.match(/gpt-5\.6-(?:sol|terra|luna)/)?.[0]), [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    assert.ok(gpt56ContextState.models.every((label) => label.includes('272k')), JSON.stringify(gpt56ContextState));
    assert.ok(gpt56ContextState.models.every((label) => !label.includes('400k')), JSON.stringify(gpt56ContextState));
    await saveScreenshot(panel, GPT56_CONTEXT_PICKER_SCREENSHOT, { captureBeyondViewport: false });
    await panel.evaluate(`[...document.querySelectorAll('#modelProviderList .model-provider-option')].find((button) => button.textContent.includes('Alternate Provider'))?.click()`);
    const switchedProviderState = await waitFor(() => panel.evaluate(`(() => {
      const selected = document.querySelector('#modelProviderList .model-provider-option.selected')?.textContent?.trim() || '';
      const models = [...document.querySelectorAll('#modelMenuList .model-option')].map((button) => button.textContent.trim());
      return selected.includes('Alternate Provider') && models.some((label) => label.includes('Provider Switch Model')) ? { selected, models } : null;
    })()`));
    assert.match(switchedProviderState.selected, /Alternate Provider/);
    assert.ok(switchedProviderState.models.some((label) => label.includes('Provider Switch Model')));

    console.log(JSON.stringify({
      verdict: 'PASS',
      appearance: `${ASSIST_THEME}:${ASSIST_MODE}`,
      extensionId,
      gatewayUrl: mock.baseUrl,
      sessionId: storedAfterSend.hermesBrowserSettings.sessionId,
      protocol: envelope.protocol,
      accessibility: {
        panel: panelAccessibility,
        panelKeyboardFocus,
        panelReducedMotionViolations: panelMotionViolations,
        assist: assistAccessibility,
        assistReducedMotionViolations: assistMotionViolations,
      },
      requestCount: mock.requests.length,
      renderedReply: TEST_REPLY,
      taskSummary: taskPanelState.summary,
      inlineRoute: routeState.labels,
      inlineBackgroundResult: inlineResultState.result,
      exactUndoRestored: true,
      richTextSingleInsertEvents: richApplyState.inputEvents,
      xRichSingleCopy: richApplyState.copies,
      xRichDeleteAll: xRichDeleteState,
      xManagedSingleCopy: xManagedApplyState,
      xManagedDeleteAll: xManagedDeleteState,
      inlineLauncherShift: launcherPlacementAfterShift,
      chatgptLauncherPlacement: chatgptPlacement,
      assistScrollbar: assistScrollbarState,
      xPopupContainment: xPopupOpenState,
      launcherToggleClosed: xPopupToggleClosed,
      retainedSessionOpenedInWeb: openedWebSession.sessionId,
      contextMenuHandoff: contextRouteTitle,
      rightClickAutoStarted: true,
      assistEfforts: sharedPickerState.efforts,
      gpt56ContextRows: gpt56ContextState.models,
      mainProviderSwitch: switchedProviderState.selected,
      screenshots: [TASK_PANEL_SCREENSHOT, TASK_WEB_SCREENSHOT, INLINE_ROUTE_SCREENSHOT, INLINE_RESULT_SCREENSHOT, INLINE_OPEN_SESSION_SCREENSHOT, INLINE_NO_SESSION_SCREENSHOT, INLINE_LAUNCHER_SCREENSHOT, CHATGPT_LAUNCHER_SCREENSHOT, INLINE_TOGGLE_SCREENSHOT, INLINE_SINGLE_COPY_SCREENSHOT, INLINE_DELETE_ALL_SCREENSHOT, ASSIST_SETTINGS_SCREENSHOT, ASSIST_RELEASED_GATEWAY_SCREENSHOT, MAIN_MODEL_PICKER_SCREENSHOT, GPT56_CONTEXT_PICKER_SCREENSHOT],
    }, null, 2));
  } catch (error) {
    const diagnostics = {};
    if (fixture) {
      try {
        diagnostics.fixture = await fixture.evaluate(`(() => {
          const host = document.querySelector('#hermes-inline-draft-host');
          const root = host?.shadowRoot;
          return {
            hostCount: document.querySelectorAll('#hermes-inline-draft-host').length,
            panelHidden: root?.querySelector('.panel')?.hidden,
            launcherHidden: root?.querySelector('.launcher')?.hidden,
            state: root?.querySelector('.context span:last-child')?.textContent || '',
            status: root?.querySelector('.status')?.textContent || '',
            field: document.querySelector('#draft')?.value || '',
            helper: typeof globalThis.__HERMES_INLINE_HELPER_CLEANUP__ === 'function',
          };
        })()`);
      } catch { /* best-effort cleanup or diagnostics */ }
    }
    if (setup) {
      try {
        diagnostics.storage = await setup.evaluate(`(async () => {
          const session = await chrome.storage.session.get(null);
          return { keys: Object.keys(session), hasInlineRequest: Boolean(session.hermesBrowserInlineDraftRequest) };
        })()`);
      } catch { /* best-effort cleanup or diagnostics */ }
    }
    diagnostics.requests = mock?.requests?.map((request) => `${request.method} ${request.path}`) || [];
    error.message = `${error.message}\nE2E diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`;
    const failureClient = fixture || panel;
    if (failureClient) {
      try {
        const shot = await failureClient.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        if (shot.data) await writeFile(FAILURE_SCREENSHOT, Buffer.from(shot.data, 'base64'));
      } catch { /* best-effort cleanup or diagnostics */ }
    }
    error.message = `${error.message}\nChrome stderr tail:\n${chromeStderr.slice(-3000)}`;
    throw error;
  } finally {
    chatgptFixture?.close();
    fixture?.close();
    web?.close();
    panel?.close();
    setup?.close();
    killChrome(chrome);
    await mock.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

await main();
