import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import english from '../extension/lib/locales/en.mjs';
import { SUPPORTED_LOCALES, loadLocaleMessages } from '../extension/lib/i18n-registry.mjs';
import { WS_EVENTS, WS_METHODS } from '../extension/lib/gateway-ws.mjs';
import { createUserInputFetchGuard, userInputWriteIsOwned } from '../extension/lib/user-input-race.mjs';
import {
  USER_INPUT_STRINGS,
  classifyUserInputResult,
  pendingUserInputRecords,
  userInputAnswerPayload,
  userInputText,
} from '../extension/lib/user-input.mjs';

// Native asynchronous user input (hermes-agent #103136) in the side panel: how it is wired,
// that it activates only where the gateway proves the feature, and that a gateway without it is
// never asked anything. The panel's functions run from the real source with stubbed externals.

const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function sliceBetween(start, end) {
  const from = panel.indexOf(start);
  const to = panel.indexOf(end, from);
  assert.ok(from > 0 && to > from, `${start} .. ${end}`);
  return panel.slice(from, to);
}

function body(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} exists`);
  const open = panel.indexOf('{', panel.indexOf(')', start));
  let depth = 0;
  for (let at = open; at < panel.length; at += 1) {
    if (panel[at] === '{') depth += 1;
    if (panel[at] === '}' && --depth === 0) return panel.slice(start, at + 1);
  }
  throw new Error(`${name} does not close`);
}

async function loadBlock(env) {
  const source = sliceBetween('// ---- Native asynchronous user input (hermes-agent #103136) ----', 'const userInputController = createUserInputController({')
    .replace(/\bactiveDashboardWsConnection\b/g, 'env.activeDashboardWsConnection')
    .replace(/\bremoteWsConnection\b/g, 'env.remoteWsConnection')
    .replace(/\bsessionRoutesAvailable\b/g, 'env.sessionRoutesAvailable');
  const code = `export default function make(env) {
    const { settings, gatewayCapabilities } = env;
    const isRemoteWsMode = () => env.remote;
    const usesDashboardWsChatTransport = () => env.ws;
    const normalizeGatewayMode = (mode) => String(mode || '');
    const t = (key) => key;
    const encodeSessionId = encodeURIComponent;
    const readJsonResponse = async (response) => response.json();
    const apiFetch = (...args) => env.apiFetch(...args);
    const hermesGatewayKey = () => env.key;
    const ensureActiveDashboardWsConnection = async () => env.connection;
    const ensureRemoteWsSession = async (connection) => connection.wsSessionId;
    const { WS_EVENTS, WS_METHODS, createUserInputFetchGuard, userInputWriteIsOwned, classifyUserInputResult, userInputAnswerPayload, userInputText, pendingUserInputRecords } = env.lib;
    const userInputController = env.controller;
    ${source}
    return { handleUserInputEvent, refreshPendingUserInputs, sendUserInputAnswer, userInputProven, activeUserInputSessionId };
  }`;
  const { default: make } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  return make(env);
}

function makeEnv(overrides = {}) {
  const calls = { upsert: [], clear: [], replace: [], active: [], fetch: [], request: [] };
  const env = {
    remote: false,
    ws: false,
    key: 'gateway-key',
    settings: { sessionId: 'sess-1', gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', activeProfile: '' },
    gatewayCapabilities: { sessionUserInput: false },
    sessionRoutesAvailable: true,
    activeDashboardWsConnection: null,
    remoteWsConnection: null,
    connection: null,
    calls,
    lib: { WS_EVENTS, WS_METHODS, createUserInputFetchGuard, userInputWriteIsOwned, classifyUserInputResult, userInputAnswerPayload, userInputText, pendingUserInputRecords },
    controller: {
      setActiveSession: (id) => calls.active.push(id),
      upsert: (payload, id) => calls.upsert.push([payload, id]),
      clear: (requestId, id) => calls.clear.push([requestId, id]),
      replace: (id, rows) => calls.replace.push([id, rows]),
    },
    pending: { object: 'list', data: [{ request_id: 'r1', session_id: 'sess-1', questions: [{ id: 'q', text: 'Pick' }] }] },
    apiFetch: async (path, init = {}) => {
      calls.fetch.push({ path, init });
      if (init.method === 'POST') return { ok: true, status: 200, json: async () => ({ accepted: true, status: 'answered', delivery: 'steered' }) };
      return { ok: true, status: 200, json: async () => env.pending };
    },
    ...overrides,
  };
  return env;
}

function socket(env, { sessionId = 'live-1', ready = 1 } = {}) {
  const client = {
    readyState: ready,
    request: async (method, params) => {
      env.calls.request.push({ method, params });
      if (method === WS_METHODS.userInputPending) return { requests: env.pending.data };
      return { accepted: true, status: 'answered', delivery: 'queued' };
    },
  };
  const connection = { client, wsSessionId: sessionId, baseUrl: 'ws://dashboard' };
  env.ws = true;
  env.activeDashboardWsConnection = connection;
  env.connection = connection;
  return { client, connection };
}

test('a REST gateway that does not advertise native user input is never asked for pending requests', async () => {
  const env = makeEnv();
  const panelBlock = await loadBlock(env);
  await panelBlock.refreshPendingUserInputs();
  assert.equal(env.calls.fetch.length, 0);
  assert.equal(env.calls.replace.length, 0);
  assert.equal(panelBlock.userInputProven(null), false);
});

test('an advertised REST gateway replays the pending requests of the session on screen', async () => {
  const env = makeEnv({ gatewayCapabilities: { sessionUserInput: true } });
  const panelBlock = await loadBlock(env);
  await panelBlock.refreshPendingUserInputs();
  assert.equal(env.calls.fetch.length, 1);
  assert.equal(env.calls.fetch[0].path, '/api/sessions/sess-1/user-input/pending');
  assert.equal(env.calls.fetch[0].init.method, 'GET');
  assert.equal(env.calls.replace.length, 1);
  assert.equal(env.calls.replace[0][0], 'sess-1');
  assert.deepEqual(env.calls.replace[0][1].map((row) => row.requestId), ['r1']);
});

test('without a key, without session routes or without a session nothing is asked even when advertised', async () => {
  for (const patch of [{ key: '' }, { sessionRoutesAvailable: false }, { settings: { sessionId: '', gatewayMode: 'local-api', gatewayUrl: 'x', activeProfile: '' } }]) {
    const env = makeEnv({ gatewayCapabilities: { sessionUserInput: true }, ...patch });
    const panelBlock = await loadBlock(env);
    await panelBlock.refreshPendingUserInputs();
    assert.equal(env.calls.fetch.length, 0, JSON.stringify(Object.keys(patch)));
  }
});

test('a replay that finishes after the person moved to another session is dropped', async () => {
  const env = makeEnv({ gatewayCapabilities: { sessionUserInput: true } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  env.apiFetch = async (path) => {
    env.calls.fetch.push({ path });
    await gate;
    return { ok: true, status: 200, json: async () => env.pending };
  };
  const panelBlock = await loadBlock(env);
  const running = panelBlock.refreshPendingUserInputs();
  env.settings.sessionId = 'sess-2';
  release();
  await running;
  assert.equal(env.calls.replace.length, 0);
});

test('a REST request event is evidence enough to show the card and to replay, advertised or not', async () => {
  const env = makeEnv();
  const panelBlock = await loadBlock(env);
  const payload = { request_id: 'r9', questions: [{ id: 'q', text: 'Pick' }] };
  panelBlock.handleUserInputEvent('user_input.request', payload, { sessionId: 'sess-1' });
  assert.deepEqual(env.calls.upsert, [[payload, 'sess-1']]);
  assert.equal(panelBlock.userInputProven(null), true);
  await panelBlock.refreshPendingUserInputs();
  assert.equal(env.calls.fetch.length, 1);
  // The answer event clears exactly that request in exactly that session.
  panelBlock.handleUserInputEvent('user_input.answer', { request_id: 'r9' }, { sessionId: 'sess-1' });
  assert.deepEqual(env.calls.clear, [['r9', 'sess-1']]);
  // An event with no session id is ignored rather than guessed.
  panelBlock.handleUserInputEvent('user_input.request', payload, { sessionId: '' });
  assert.equal(env.calls.upsert.length, 1);
});

test('a dashboard socket is asked for pending requests only after it has delivered a request event', async () => {
  const env = makeEnv();
  const { client } = socket(env);
  const panelBlock = await loadBlock(env);
  assert.equal(panelBlock.activeUserInputSessionId(), 'live-1', 'keyed by the live session id');
  await panelBlock.refreshPendingUserInputs();
  assert.equal(env.calls.request.length, 0, 'no speculative call to a socket that never said it supports this');
  panelBlock.handleUserInputEvent('user_input.request', { request_id: 'r1', questions: [{ id: 'q', text: 'Pick' }] }, { sessionId: 'live-1', client });
  assert.equal(panelBlock.userInputProven(client), true);
  await panelBlock.refreshPendingUserInputs();
  assert.deepEqual(env.calls.request, [{ method: 'user_input.pending', params: { session_id: 'live-1' } }]);
  assert.equal(env.calls.replace.at(-1)[0], 'live-1');
});

test('a socket that answers method-not-found to the replay is not asked again', async () => {
  const env = makeEnv();
  const { client } = socket(env);
  client.request = async (method) => {
    env.calls.request.push({ method });
    throw Object.assign(new Error('method not found'), { code: -32601 });
  };
  const panelBlock = await loadBlock(env);
  panelBlock.handleUserInputEvent('user_input.request', { request_id: 'r1', questions: [{ id: 'q', text: 'Pick' }] }, { sessionId: 'live-1', client });
  await assert.rejects(panelBlock.refreshPendingUserInputs());
  await panelBlock.refreshPendingUserInputs();
  assert.equal(env.calls.request.length, 1);
  // A closed socket is not asked at all.
  const closed = makeEnv();
  const { client: shut } = socket(closed, { ready: 3 });
  const shutBlock = await loadBlock(closed);
  shutBlock.handleUserInputEvent('user_input.request', { request_id: 'r1', questions: [{ id: 'q', text: 'x' }] }, { sessionId: 'live-1', client: shut });
  await shutBlock.refreshPendingUserInputs();
  assert.equal(closed.calls.request.length, 0);
});

test('an answer goes to the session-scoped REST route with its turn, and an accepted answer is classified as recorded', async () => {
  const env = makeEnv();
  const panelBlock = await loadBlock(env);
  const request = { requestId: 'r1', sessionId: 'sess-1', turnId: 'turn-7', questions: [{ id: 'q', text: 'Pick', options: ['a'], allowFreeText: false }] };
  const result = await panelBlock.sendUserInputAnswer(request, { q: 'a' });
  assert.equal(env.calls.fetch[0].path, '/api/sessions/sess-1/user-input/r1/answer');
  assert.equal(env.calls.fetch[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(env.calls.fetch[0].init.body), { answers: { q: 'a' }, turn_id: 'turn-7' });
  assert.equal(result.kind, 'accepted');
  assert.equal(result.clear, true);
  assert.equal(result.delivery, 'steered');
});

test('an answer over the dashboard socket uses user_input.respond with the live id, and a changed session is refused', async () => {
  const env = makeEnv();
  const { connection } = socket(env);
  const panelBlock = await loadBlock(env);
  const request = { requestId: 'r1', sessionId: 'live-1', turnId: '', questions: [{ id: 'q', text: 'Pick' }] };
  const result = await panelBlock.sendUserInputAnswer(request, { q: 'yes' });
  assert.deepEqual(env.calls.request, [{ method: 'user_input.respond', params: { answers: { q: 'yes' }, request_id: 'r1', session_id: 'live-1' } }]);
  assert.equal(result.kind, 'accepted');
  // The person moved to another live session before the answer was sent.
  connection.wsSessionId = 'live-2';
  await assert.rejects(panelBlock.sendUserInputAnswer(request, { q: 'yes' }), /session changed|session_changed/);
  assert.equal(env.calls.request.length, 1, 'nothing was sent for the wrong session');
});

test('the REST stream hands user-input events to the panel and leaves every other event alone', () => {
  const reader = body('readSseResponse');
  assert.match(reader, /event\.type === WS_EVENTS\.userInputRequest \|\| event\.type === WS_EVENTS\.userInputAnswer\) \{\s*onUserInput\?\.\(event\.type, data\);/);
  assert.ok(reader.indexOf('isPromptEventName(event.type)') < reader.indexOf('WS_EVENTS.userInputRequest'), 'approval and clarify prompts keep their branch');
  const transport = body('streamSessionChat');
  assert.match(transport, /onUserInput = null/);
  assert.match(transport, /streamSessionChatRest\(prompt, onDelta, onTool, \{[^}]*onUserInput/);
  assert.match(body('streamSessionChatRest'), /readSseResponse\(response, onDelta, onTool, \{[^}]*onUserInput/);
  assert.match(panel, /onUserInput: \(type, data\) => handleUserInputEvent\(type, data, \{ sessionId: runSessionId \}\),/);
});

test('every chat socket listens for request and answer events, and the panel replays after a session opens, on focus and on capability load', () => {
  const create = body('createChatGatewayClient');
  assert.match(create, /gatewayClient\.on\(WS_EVENTS\.userInputRequest,/);
  assert.match(create, /gatewayClient\.on\(WS_EVENTS\.userInputAnswer,/);
  assert.match(body('openHermesSession'), /refreshPendingUserInputsQuietly\(\);/);
  assert.match(body('loadGatewayCapabilities'), /refreshPendingUserInputsQuietly\(\);/);
  assert.match(body('updateSessionLabel'), /syncUserInputSession\(\);/);
  assert.match(panel, /globalThis\.addEventListener\('focus', refreshPendingUserInputsQuietly\);/);
});

test('the request mount is the first child of the bottom dock, bounded and hidden until there is a request', () => {
  const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const dock = html.indexOf('class="bottom-dock"');
  const mount = html.indexOf('id="userInputRequests"');
  assert.ok(dock > 0 && mount > dock, 'mounted after the dock opens');
  assert.ok(mount < html.indexOf('id="taskStack"'), 'above the task stack and the composer');
  assert.match(html, /<section id="userInputRequests" class="user-input-requests" aria-live="polite" hidden><\/section>/);
  const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
  assert.match(css, /\.user-input-requests \{[^}]*max-height: min\(50vh, 360px\);[^}]*overflow-y: auto;/s);
  assert.match(css, /\.user-input-requests\[hidden\] \{ display: none; \}/);
});

test('the capability is declared, advertised-or-not, and shown as a row with a localized label', () => {
  assert.match(readFileSync(new URL('../extension/lib/capabilities.mjs', import.meta.url), 'utf8'), /sessionUserInput: completeUserInputCapability\(features, endpoints\)/);
  assert.ok(english['capability.feature.sessionUserInput']);
});

test('every user-input string has an English catalog entry equal to the built-in wording, in every locale', async () => {
  for (const [key, text] of Object.entries(USER_INPUT_STRINGS)) assert.equal(english[key], text, key);
  for (const locale of SUPPORTED_LOCALES) {
    const messages = await loadLocaleMessages(locale.id);
    for (const key of [...Object.keys(USER_INPUT_STRINGS), 'capability.feature.sessionUserInput']) {
      assert.ok(String(messages[key] ?? '').trim(), `${locale.id} has ${key}`);
    }
    // Placeholders survive translation.
    for (const key of Object.keys(USER_INPUT_STRINGS)) {
      const wanted = [...USER_INPUT_STRINGS[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      const have = [...String(messages[key]).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      assert.deepEqual(have, wanted, `${locale.id} ${key} keeps its placeholders`);
    }
  }
});

test('the panel passes its translator, so a default message follows the locale', () => {
  const translate = (key, params) => (key === 'user_input.invalid' ? `fr:${key}` : (key === 'user_input.http_failed' ? `fr:${params.status}` : key));
  assert.equal(userInputText('user_input.invalid', {}, translate), 'fr:user_input.invalid');
  assert.equal(userInputText('user_input.title', {}, translate), 'Hermes needs your input', 'a key the translator does not know falls back to English');
  const invalid = classifyUserInputResult({ accepted: false, status: 'invalid' });
  assert.equal(invalid.messageKey, 'user_input.invalid');
  const gatewayText = classifyUserInputResult({ accepted: false, status: 'invalid', error: { message: 'Pick a or b.' } });
  assert.equal(gatewayText.messageKey, undefined, 'the gateway\'s own sentence is shown as sent');
  assert.equal(gatewayText.message, 'Pick a or b.');
  const http = classifyUserInputResult({}, { httpStatus: 502 });
  assert.equal(http.messageKey, 'user_input.http_failed');
  assert.deepEqual(http.messageParams, { status: 502 });
});

test('the answer payload and pending rows follow the contract (kept from the original client)', () => {
  assert.deepEqual(userInputAnswerPayload({
    requestId: 'r', sessionId: 's', turnId: 't', questions: [{ id: 'q', text: 'Q', options: [], allowFreeText: true }],
  }, { q: 'x' }), { answers: { q: 'x' }, request_id: 'r', session_id: 's', turn_id: 't' });
  assert.equal(pendingUserInputRecords({ data: [{ request_id: 'r', questions: [{ id: 'q', text: 'Q' }] }] }, 's').length, 1);
});
