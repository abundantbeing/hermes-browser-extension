import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import english from '../extension/lib/locales/en.mjs';
import { normalizeGatewayCapabilities } from '../extension/lib/capabilities.mjs';
import { encodeSessionId, normalizeHermesSessions } from '../extension/lib/common.mjs';
import { hermesRequestError } from '../extension/lib/turn-recovery.mjs';
import {
  LEGACY_FORKS_MAX,
  LEGACY_FORKS_STORAGE_KEY,
  continueInSessionCopy,
  createSessionRecoveryActions,
  isSessionSourceRefusal,
  legacySessionSource,
  planSourceRefusalRecovery,
  readLegacyForks,
  rememberLegacyFork,
  resolveLegacyFork,
  withLegacyFork,
} from '../extension/lib/legacy-session-fork.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

// ---- refusal detection -----------------------------------------------------

test('the stock refusal arrives as the bare permission_denied code and is recognised', () => {
  // SSE `error` event inside a 200 stream: the extension wraps data.message.
  const sse = Object.assign(new Error('permission_denied'), { requestRejected: true, streamError: true });
  assert.equal(isSessionSourceRefusal(sse), true);
  // The door-level 409 {error:{message,code}} wrapped by hermesRequestError.
  const http = hermesRequestError({
    status: 409,
    body: JSON.stringify({ error: { message: 'permission_denied', type: 'invalid_request_error', code: 'permission_denied' } }),
    operation: 'Hermes stream',
  });
  assert.equal(http.message, 'Hermes stream failed (409): permission_denied');
  assert.equal(isSessionSourceRefusal(http), true);
  assert.equal(isSessionSourceRefusal({ code: 'permission_denied' }), true);
  assert.equal(isSessionSourceRefusal({ payload: { error: { code: 'PERMISSION_DENIED' } } }), true);
});

test('other permission-shaped errors are not treated as the old-source refusal', () => {
  for (const message of [
    'Permission denied: terminal tool is not allowed',
    'Hermes stream failed (403): Forbidden',
    'Hermes stream failed (409): admission_conflict',
    'Hermes stream failed (500): permission_denied while reading the credentials file',
    'permission denied',
    'The tool reported permission_denied for /etc/shadow and stopped',
    '',
  ]) {
    assert.equal(isSessionSourceRefusal(new Error(message)), false, message);
  }
  assert.equal(isSessionSourceRefusal(null), false);
  assert.equal(isSessionSourceRefusal({ code: 'invalid_params' }), false);
});

// ---- recovery plan ---------------------------------------------------------

test('only a session stored under a source the gate refuses is offered a copy', () => {
  assert.equal(legacySessionSource({ session: { source: 'hermes_browser' } }), 'hermes_browser');
  assert.equal(legacySessionSource({ source: 'Hermes_Browser' }), 'hermes_browser');
  assert.equal(legacySessionSource({ session: { source: 'api_server' } }), '');
  assert.equal(legacySessionSource({ session: { source: 'bot_room' } }), '');
  assert.equal(legacySessionSource({ session: {} }), '');
  assert.equal(legacySessionSource(null), '');
  // Not this browser's older-build chat: a Bot Chat, or another surface's session.
  assert.equal(legacySessionSource({ session: { id: 'x', source: 'hermes_browser', title: 'Bot Chat' } }), '');
  assert.equal(legacySessionSource({ session: { id: 'x', source: 'hermes_browser', root_title: 'Bot Chat', title: 'Bot Chat #2' } }), '');
  assert.equal(legacySessionSource({ session: { id: 'desk-1', source: 'desktop' } }), '');
  assert.equal(legacySessionSource({ session: { id: 'hermes-browser-extension-old', source: 'cli' } }), 'cli');

  assert.deepEqual(planSourceRefusalRecovery({ session: { session: { source: 'hermes_browser' } }, forkAdvertised: true }), { kind: 'fork', source: 'hermes_browser' });
  assert.deepEqual(planSourceRefusalRecovery({ session: { session: { source: 'hermes_browser' } }, forkAdvertised: false }), { kind: 'new-chat', source: 'hermes_browser' });
  assert.equal(planSourceRefusalRecovery({ session: { session: { source: 'api_server' } }, forkAdvertised: true }).kind, 'unrelated');
  assert.equal(planSourceRefusalRecovery({ session: null, forkAdvertised: true }).kind, 'unrelated');
});

test('fork support comes from the gateway capabilities, not a guess', () => {
  const stock = normalizeGatewayCapabilities({
    object: 'hermes.api_server.capabilities',
    features: { session_resources: true, session_chat: true, session_fork: true },
    endpoints: { session_fork: { method: 'POST', path: '/api/sessions/{session_id}/fork' } },
  }, { healthOk: true, hasApiKey: true });
  assert.equal(stock.sessionFork, true);
  const without = normalizeGatewayCapabilities({
    object: 'hermes.api_server.capabilities',
    features: { session_resources: true, session_chat: true },
    endpoints: {},
  }, { healthOk: true, hasApiKey: true });
  assert.equal(without.sessionFork, false);
  assert.equal(normalizeGatewayCapabilities(null, { healthOk: true, hasApiKey: true }).sessionFork, false);
});

// ---- fork and resend sequence ---------------------------------------------

function sequenceHarness({ fork = { ok: true, status: 201, payload: { object: 'hermes.session', session: { id: 'copy-1', title: 'Chat fork', source: 'api_server' } } }, forkThrows = false, opens = true } = {}) {
  const log = [];
  const options = {
    sessionId: 'hermes-browser-extension-old',
    makeCopyId: () => 'copy-1',
    fetchJson: async (path, init) => {
      log.push(['fetch', init.method, path, init.body]);
      if (forkThrows) throw new TypeError('network down');
      return fork;
    },
    remember: async (from, copy) => { log.push(['remember', from, copy.id]); },
    openCopy: async (copy) => { log.push(['open', copy.id]); return opens; },
    resend: async (copyId) => { log.push(['resend', copyId]); return true; },
  };
  return { log, options };
}

test('Continue in a copy forks, opens the copy, resends once, and remembers the mapping', async () => {
  const { log, options } = sequenceHarness();
  const result = await continueInSessionCopy(options);
  assert.deepEqual(result, { ok: true, copyId: 'copy-1', resent: true });
  assert.deepEqual(log, [
    ['fetch', 'POST', '/api/sessions/hermes-browser-extension-old/fork', JSON.stringify({ id: 'copy-1' })],
    ['remember', 'hermes-browser-extension-old', 'copy-1'],
    ['open', 'copy-1'],
    ['resend', 'copy-1'],
  ]);
  assert.equal(log.filter((entry) => entry[0] === 'resend').length, 1, 'the message is resent exactly once');
});

test('fork not supported by the gateway stops before opening or resending', async () => {
  const { log, options } = sequenceHarness({ fork: { ok: false, status: 404, payload: { error: { code: 'not_found' } } } });
  const result = await continueInSessionCopy(options);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'fork');
  assert.equal(result.reason, 'fork-unsupported');
  assert.deepEqual(log.map((entry) => entry[0]), ['fetch']);
});

test('a failed fork never opens a copy, remembers a mapping or resends', async () => {
  for (const fork of [
    { ok: false, status: 500, payload: null },
    { ok: false, status: 409, payload: { error: { code: 'session_exists' } } },
    { ok: true, status: 201, payload: {} },
  ]) {
    const { log, options } = sequenceHarness({ fork });
    options.makeCopyId = () => '';
    const result = await continueInSessionCopy(options);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'fork-failed');
    assert.deepEqual(log.map((entry) => entry[0]), ['fetch']);
  }
  const { log, options } = sequenceHarness({ forkThrows: true });
  const thrown = await continueInSessionCopy(options);
  assert.equal(thrown.reason, 'fork-failed');
  assert.deepEqual(log.map((entry) => entry[0]), ['fetch']);
});

test('a copy that will not open is kept for next time but the message is not resent', async () => {
  const { log, options } = sequenceHarness({ opens: false });
  const result = await continueInSessionCopy(options);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'open');
  assert.equal(result.copyId, 'copy-1');
  assert.deepEqual(log.map((entry) => entry[0]), ['fetch', 'remember', 'open']);
});

test('the copy id the gateway returns wins over the one asked for, and a failing mapping write is tolerated', async () => {
  const { log, options } = sequenceHarness({ fork: { ok: true, status: 201, payload: { session: { id: 'gateway-chose' } } } });
  options.remember = async () => { throw new Error('storage full'); };
  const result = await continueInSessionCopy(options);
  assert.equal(result.copyId, 'gateway-chose');
  assert.deepEqual(log.map((entry) => entry[0]), ['fetch', 'open', 'resend']);
});

// ---- remembered mapping ----------------------------------------------------

test('the old chat resolves to its copy, through chains, without looping', () => {
  let map = withLegacyFork({}, 'old', { id: 'copy', title: 'Copy' }, 10);
  assert.deepEqual(resolveLegacyFork(map, 'old'), { id: 'copy', title: 'Copy' });
  assert.equal(resolveLegacyFork(map, 'copy'), null);
  assert.equal(resolveLegacyFork(map, 'other'), null);
  map = withLegacyFork(map, 'copy', { id: 'copy-2', title: 'Copy 2' }, 20);
  assert.equal(resolveLegacyFork(map, 'old').id, 'copy-2');
  const loop = { a: { id: 'b' }, b: { id: 'a' } };
  assert.ok(resolveLegacyFork(loop, 'a'), 'a cycle ends instead of hanging');
  assert.deepEqual(withLegacyFork({}, 'same', { id: 'same' }), {});
});

test('the mapping is bounded and persists through the storage area', async () => {
  let map = {};
  for (let index = 0; index < LEGACY_FORKS_MAX + 20; index += 1) map = withLegacyFork(map, `old-${index}`, { id: `copy-${index}` }, index);
  assert.equal(Object.keys(map).length, LEGACY_FORKS_MAX);
  assert.equal(map['old-0'], undefined, 'the oldest entries go first');
  assert.ok(map[`old-${LEGACY_FORKS_MAX + 19}`]);

  const store = {};
  const area = {
    get: async (key) => ({ [key]: store[key] }),
    set: async (value) => { Object.assign(store, value); },
  };
  await rememberLegacyFork(area, 'old', { id: 'copy', title: 'T' }, 5);
  assert.deepEqual(store[LEGACY_FORKS_STORAGE_KEY], { old: { id: 'copy', title: 'T', at: 5 } });
  assert.equal(resolveLegacyFork(await readLegacyForks(area), 'old').id, 'copy');
  assert.deepEqual(await readLegacyForks({ get: async () => { throw new Error('no storage'); } }), {});
});

// ---- recovery buttons ------------------------------------------------------

test('recovery buttons lock while one runs and unlock when it reports failure', async () => {
  const { document } = parseHTML('<body></body>');
  const runs = [];
  let outcome = false;
  const root = createSessionRecoveryActions({
    document,
    actions: [
      { id: 'continue-copy', label: 'Continue in a copy', busyLabel: 'Copying chat…', run: async () => { runs.push('copy'); return outcome; } },
      { id: 'new-chat', label: 'Start a new chat', run: async () => { runs.push('new'); return true; } },
    ],
  });
  document.body.append(root);
  const [copy, fresh] = root.querySelectorAll('button');
  assert.equal(copy.textContent, 'Continue in a copy');
  const click = (button) => button.dispatchEvent(new document.defaultView.Event('click'));
  click(copy);
  assert.equal(copy.disabled, true);
  assert.equal(fresh.disabled, true);
  assert.equal(copy.textContent, 'Copying chat…');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(copy.disabled, false, 'a failed copy can be retried');
  assert.equal(copy.textContent, 'Continue in a copy');
  assert.equal(root.hidden, false);
  outcome = true;
  click(copy);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(root.hidden, true, 'a finished action clears the offer');
  assert.deepEqual(runs, ['copy', 'copy']);
});

// ---- panel wiring: refused turn -> offer -> copy -> resend -----------------

const helperSource = source.slice(
  source.indexOf('async function offerLegacySessionRecovery('),
  source.indexOf("// A gateway still running pre-update code cannot be fixed from the panel's own"),
);

function panelHarness({ sessionRow, forkAdvertised = true, forkStatus = 201 }) {
  const { document } = parseHTML('<body><div id="bubble"></div><textarea id="input"></textarea></body>');
  const calls = { fetch: [], opened: [], asked: [], drafts: 0, statuses: [], messages: [] };
  const bubble = document.getElementById('bubble');
  const input = document.getElementById('input');
  input.value = 'my question';
  const context = {
    document,
    gatewayCapabilities: { sessionFork: forkAdvertised },
    els: { input },
    attachments: [{ name: 'a.png' }],
    encodeSessionId,
    normalizeHermesSessions,
    makeBrowserSessionId: () => 'hermes-browser-extension-new',
    safeActiveProfile: () => '',
    browserApi: { storage: { local: { _data: {}, async get(key) { return { [key]: this._data[key] }; }, async set(value) { Object.assign(this._data, value); } } } },
    readJsonResponse: async (response) => response.json(),
    apiFetch: async (path, init = {}) => {
      calls.fetch.push([init.method || 'GET', path, init.body || '']);
      if (path.endsWith('/fork')) {
        const id = JSON.parse(init.body).id;
        return { ok: forkStatus < 400, status: forkStatus, json: async () => ({ object: 'hermes.session', session: { id, title: 'Old chat fork', source: 'api_server' } }) };
      }
      return { ok: Boolean(sessionRow), status: sessionRow ? 200 : 404, json: async () => sessionRow };
    },
    openHermesSession: async (session) => { calls.opened.push(session); return true; },
    askHermes: async (text, files, options) => { calls.asked.push([text, files, options]); return true; },
    beginHermesBrowserDraft: async () => { calls.drafts += 1; return true; },
    loadSessions: async () => {},
    renderAttachments() {},
    persistCurrentComposerDraft() {},
    scrollMessageStreamToBottom() {},
    addMessage: (role, text) => calls.messages.push([role, text]),
    setStatus: (...args) => calls.statuses.push(args),
    t: (key) => english[key] || key,
    createSessionRecoveryActions,
    planSourceRefusalRecovery,
    continueInSessionCopy,
    rememberLegacyFork,
  };
  vm.createContext(context);
  vm.runInContext(`${helperSource}\nthis.offer = offerLegacySessionRecovery;`, context);
  const streamView = { node: bubble, updated: '', update(text) { this.updated = text; } };
  return { context, calls, bubble, input, streamView };
}

const args = (streamView) => ({
  sessionId: 'hermes-browser-extension-old',
  resendText: 'my question',
  resendAttachments: [{ name: 'a.png' }],
  streamView,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('an old-source refusal on a fork-capable gateway offers a copy and then resends once in it', async () => {
  const h = panelHarness({ sessionRow: { object: 'hermes.session', session: { id: 'hermes-browser-extension-old', source: 'hermes_browser' } } });
  assert.equal(await h.context.offer(args(h.streamView)), true);
  assert.equal(h.streamView.updated, english['session.legacy_source_fork']);
  const buttons = [...h.bubble.querySelectorAll('button')];
  assert.deepEqual(buttons.map((button) => button.textContent), ['Continue in a copy', 'Start a new chat']);
  assert.deepEqual(h.calls.fetch, [['GET', '/api/sessions/hermes-browser-extension-old', '']], 'only the session row is read until the person chooses');

  buttons[0].dispatchEvent(new h.context.document.defaultView.Event('click'));
  await settle();
  const forkCall = h.calls.fetch.find((call) => call[1].endsWith('/fork'));
  assert.deepEqual(forkCall.slice(0, 2), ['POST', '/api/sessions/hermes-browser-extension-old/fork']);
  assert.equal(JSON.parse(forkCall[2]).id, 'hermes-browser-extension-new', 'the copy keeps a browser-owned id so no foreign-chat prompt appears');
  assert.equal(h.calls.opened.length, 1);
  assert.equal(h.calls.opened[0].id, 'hermes-browser-extension-new');
  assert.equal(h.calls.opened[0].transport, 'rest');
  assert.equal(h.calls.asked.length, 1, 'the message is sent once');
  assert.equal(h.calls.asked[0][0], 'my question');
  assert.equal(h.calls.asked[0][2].preserveComposer, true);
  assert.equal(h.input.value, '', 'the restored draft is cleared once it is sent');
  const saved = h.context.browserApi.storage.local._data[LEGACY_FORKS_STORAGE_KEY];
  assert.equal(saved['hermes-browser-extension-old'].id, 'hermes-browser-extension-new', 'the mapping is remembered');
});

test('without an advertised fork the person is told the chat is old and offered a new chat only', async () => {
  const h = panelHarness({ sessionRow: { session: { id: 'x', source: 'hermes_browser' } }, forkAdvertised: false });
  assert.equal(await h.context.offer(args(h.streamView)), true);
  assert.equal(h.streamView.updated, english['session.legacy_source_no_fork']);
  assert.match(h.streamView.updated, /older version of Hermes Browser/);
  const buttons = [...h.bubble.querySelectorAll('button')];
  assert.deepEqual(buttons.map((button) => button.textContent), ['Start a new chat']);
  buttons[0].dispatchEvent(new h.context.document.defaultView.Event('click'));
  await settle();
  assert.equal(h.calls.drafts, 1);
  assert.equal(h.calls.fetch.some((call) => call[1].endsWith('/fork')), false, 'no fork is attempted');
  assert.equal(h.calls.asked.length, 0);
});

test('a failed fork says so, sends nothing and leaves the offer available', async () => {
  const h = panelHarness({ sessionRow: { session: { id: 'x', source: 'hermes_browser' } }, forkStatus: 500 });
  await h.context.offer(args(h.streamView));
  const copyButton = h.bubble.querySelector('button');
  copyButton.dispatchEvent(new h.context.document.defaultView.Event('click'));
  await settle();
  assert.equal(h.calls.opened.length, 0);
  assert.equal(h.calls.asked.length, 0);
  assert.deepEqual(h.calls.messages.at(-1), ['system', english['session.legacy_copy_failed']]);
  assert.equal(h.calls.statuses.at(-1)[0], 'error');
  assert.equal(copyButton.disabled, false);
  assert.equal(h.input.value, 'my question', 'the draft stays in the box');
});

test('a permission_denied on a session the gate admits, or one that cannot be read, is not forked', async () => {
  for (const sessionRow of [{ session: { id: 'x', source: 'api_server' } }, { session: { id: 'x', source: 'bot_room' } }, null]) {
    const h = panelHarness({ sessionRow });
    assert.equal(await h.context.offer(args(h.streamView)), false);
    assert.equal(h.bubble.querySelector('button'), null);
    assert.equal(h.streamView.updated, '');
    assert.equal(h.calls.fetch.some((call) => call[1].endsWith('/fork')), false);
  }
});

test('the send path routes only the exact refusal into the offer, before the generic failure text', () => {
  const catchStart = source.indexOf('if (isSessionSourceRefusal(error)) {');
  assert.ok(catchStart > 0);
  assert.ok(catchStart < source.indexOf('if (error?.originRefused) {', catchStart));
  assert.ok(catchStart < source.indexOf('const requestFailure = preGatewayChatFailureState(error)', catchStart));
  const block = source.slice(catchStart, source.indexOf('if (error?.originRefused) {', catchStart));
  assert.match(block, /offerLegacySessionRecovery\(\{ sessionId: runSessionId/);
  assert.match(block, /return didSend;/);
});

test('opening a chat that was continued in a copy opens the copy', () => {
  const openStart = source.indexOf('async function openHermesSession(');
  const redirect = source.indexOf('resolveLegacyFork(await readLegacyForks(browserApi.storage.local), session.id)', openStart);
  assert.ok(redirect > openStart && redirect < source.indexOf('renderSessionHistoryLoading(session);', openStart));
});
