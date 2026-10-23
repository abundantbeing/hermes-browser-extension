import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import { WS_METHODS, createGatewayClient, establishGatewaySession } from '../extension/lib/gateway-ws.mjs';
import {
  AUTHORITY_RESPOND_METHODS,
  authorityPromptsFromSnapshot,
  buildApprovalBody,
  buildAuthorityApprovalRequest,
  buildAuthorityClarifyRequest,
  isPromptActionable,
  isRunStatusTerminal,
  normalizeApprovalPrompt,
  promptFromAuthorityEvent,
} from '../extension/lib/gateway-prompts.mjs';
import { createPromptCard } from '../extension/lib/prompt-card.mjs';
import { createPendingControlsPoller, createPromptController } from '../extension/lib/prompt-controller.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const sidepanel = read('extension/sidepanel.js');
const app = read('extension/app.js');

// A browser closes a socket from the outside asynchronously: close() returns
// first, the 'close' event follows. A fake that emits it inline hides every
// ordering bug that depends on that.
class BrowserLikeSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    BrowserLikeSocket.all.push(this);
  }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }

  send(data) { this.sent.push(JSON.parse(data)); }

  close() {
    this.readyState = 2;
    setTimeout(() => this.emit('close', { code: 1000 }), 0);
  }

  emit(type, event) { for (const fn of this.listeners[type] || []) fn(event); }

  open() {
    this.readyState = 1;
    this.emit('open', {});
  }

  message(frame) { this.emit('message', { data: JSON.stringify(frame) }); }

  ready(payload = {}) { this.message({ method: 'event', params: { type: 'gateway.ready', payload } }); }

  event(type, sessionId, payload, seq) {
    this.message({ method: 'event', params: { type, session_id: sessionId, payload, ...(seq ? { seq } : {}) } });
  }

  // Answers the next request the client sent for `method`.
  reply(method, result) {
    const frame = this.sent.find((item) => item.method === method && !item.answered);
    assert.ok(frame, `no ${method} request was sent`);
    frame.answered = true;
    this.message({ jsonrpc: '2.0', id: frame.id, result });
  }

  fail(method, error) {
    const frame = this.sent.find((item) => item.method === method && !item.answered);
    assert.ok(frame, `no ${method} request was sent`);
    frame.answered = true;
    this.message({ jsonrpc: '2.0', id: frame.id, error });
  }
}
BrowserLikeSocket.all = [];

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---- a connection the owner closes takes its prompts with it ---------------------

function controllerFor(viewed = ['s1']) {
  const controller = createPromptController({ getViewedSessionIds: () => viewed });
  return controller;
}

test('closing a chat connection from this side withdraws the prompts it carried', async () => {
  BrowserLikeSocket.all = [];
  const controller = controllerFor();
  const client = createGatewayClient({
    WebSocketImpl: BrowserLikeSocket,
    serverRequests: {
      handle: (request, controls) => controller.ingestServerRequest(request, { ...controls, sessionId: 's1' }),
      cancel: () => {},
      closed: (closing) => controller.dropClient(closing),
    },
  });
  const connecting = client.connect('ws://host/api/ws');
  const socket = BrowserLikeSocket.all[0];
  socket.open();
  socket.ready();
  await connecting;
  socket.message({ jsonrpc: '2.0', id: 'srq-1', method: 'clarify', params: { session_id: 'live-1', questions: [{ qid: 'q0', question: 'Which?' }] } });
  assert.equal(controller.getSnapshot().visible.length, 1);

  client.close();
  assert.equal(controller.getSnapshot().total, 0, 'withdrawn immediately, not when the browser later reports the close');
  await tick();
  assert.equal(controller.getSnapshot().total, 0);
  controller.destroy();
});

test('a socket that drops tells the owner once, and a later close() does not repeat it', async () => {
  BrowserLikeSocket.all = [];
  let closed = 0;
  const client = createGatewayClient({
    WebSocketImpl: BrowserLikeSocket,
    serverRequests: { handle: () => false, closed: () => { closed += 1; } },
  });
  const connecting = client.connect('ws://host/api/ws');
  const socket = BrowserLikeSocket.all[0];
  socket.open();
  socket.ready();
  await connecting;
  socket.emit('close', { code: 1006 });
  assert.equal(closed, 1);
  client.close();
  assert.equal(closed, 1, 'close() on an already-dropped client has nothing left to withdraw');
});

test('both surfaces hand their connections a closed() hook, so closing from this side withdraws the cards', () => {
  for (const source of [sidepanel, app]) {
    assert.match(source, /closed: \(client\) => promptController\.dropClient\(client\),/);
    assert.match(source, /event: \(type, event, client\) => promptController\.ingestAuthorityEvent\(type, event, \{ client \}\),/);
    assert.match(source, /prompts: \(prompts, context\) => promptController\.ingestAuthorityPrompts\(prompts, context\),/);
  }
});

// ---- prompts: generation and run status ------------------------------------------------------

test('a missing or null generation stays unknown and is never sent as generation 0', () => {
  for (const execution_generation of [null, undefined, '', 'x', -1, 1.5, {}]) {
    const entry = normalizeApprovalPrompt({ request_id: 'r1', command: 'ls', execution_generation }, { scope: 'run-1' });
    assert.equal(entry.executionGeneration, null, String(execution_generation));
    assert.deepEqual(buildApprovalBody(entry, 'once'), { choice: 'once', request_id: 'r1' });
  }
  const zero = normalizeApprovalPrompt({ request_id: 'r1', execution_generation: 0 }, { scope: 'run-1' });
  assert.equal(zero.executionGeneration, 0);
  assert.deepEqual(buildApprovalBody(zero, 'once'), { request_id: 'r1', execution_generation: 0, choice: 'once' });
  assert.equal(normalizeApprovalPrompt({ request_id: 'r1', execution_generation: '7' }, { scope: 'run-1' }).executionGeneration, 7);
});

test('run status ends the poll once the run is over', async () => {
  assert.equal(isRunStatusTerminal({ status: 'completed' }), true);
  assert.equal(isRunStatusTerminal({ status: 'Interrupted' }), true);
  assert.equal(isRunStatusTerminal({ status: 'waiting_for_approval' }), false);
  assert.equal(isRunStatusTerminal(null), false);

  const timers = [];
  let reads = 0;
  const poller = createPendingControlsPoller({
    fetchStatus: async () => {
      reads += 1;
      return { status: reads >= 2 ? 'completed' : 'running' };
    },
    onStatus: () => {},
    isTerminal: isRunStatusTerminal,
    setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
  });
  poller.start();
  await timers.shift()();
  assert.equal(poller.active, true);
  assert.equal(timers.length, 1, 'still running: the next read is scheduled');
  await timers.shift()();
  assert.equal(poller.active, false, 'a finished run is not polled again');
  assert.equal(timers.length, 0);
  assert.equal(reads, 2);
});

test('both surfaces stop their prompt poll on a terminal run status', () => {
  for (const source of [sidepanel, app]) assert.match(source, /isTerminal: isRunStatusTerminal,/);
});

// ---- session-authority prompts ----------------------------------------------------------------

const authorityApproval = (extra = {}) => ({
  kind: 'approval', prompt_id: 'p-1', execution_generation: 4, command: 'rm -rf build', description: 'delete', choices: ['once', 'deny'], ...extra,
});
const authorityClarify = (extra = {}) => ({
  kind: 'clarify', prompt_id: 'c-1', execution_generation: 4, question: 'Which branch?', choices: ['main', 'dev'], multi_select: false, ...extra,
});

test('an authority event becomes a prompt keyed by session and prompt id', () => {
  const entry = promptFromAuthorityEvent('approval.request', { sessionId: 'sess-1', payload: authorityApproval() });
  assert.equal(entry.key, 'ws-authority:sess-1:p-1');
  assert.equal(entry.scope, 'sess-1');
  assert.equal(entry.requestId, 'p-1');
  assert.equal(entry.executionGeneration, 4);
  assert.deepEqual(entry.choices, ['once', 'deny']);
  assert.equal(promptFromAuthorityEvent('approval.request', { sessionId: '', payload: authorityApproval() }), null);
  assert.equal(promptFromAuthorityEvent('approval.request', { sessionId: 'sess-1', payload: null }), null);
  assert.equal(promptFromAuthorityEvent('tool.start', { sessionId: 'sess-1', payload: authorityApproval() }), null);
  const clarify = promptFromAuthorityEvent('clarify.request', { sessionId: 'sess-1', payload: authorityClarify() });
  assert.equal(clarify.questions[0].question, 'Which branch?');
});

test('an authority answer is a method call with exactly four keys, and never a blind one', () => {
  const approval = promptFromAuthorityEvent('approval.request', { sessionId: 'sess-1', payload: authorityApproval() });
  assert.deepEqual(buildAuthorityApprovalRequest(approval, 'once'), {
    method: AUTHORITY_RESPOND_METHODS.approval,
    params: { session_id: 'sess-1', execution_generation: 4, prompt_id: 'p-1', choice: 'once' },
  });
  assert.equal(buildAuthorityApprovalRequest(approval, 'always'), null, 'a grant the gateway did not offer is never sent');
  assert.equal(buildAuthorityApprovalRequest(approval, 'approve'), null);
  const blind = promptFromAuthorityEvent('approval.request', { sessionId: 'sess-1', payload: authorityApproval({ execution_generation: null }) });
  assert.equal(buildAuthorityApprovalRequest(blind, 'once'), null);

  const clarify = promptFromAuthorityEvent('clarify.request', { sessionId: 'sess-1', payload: authorityClarify() });
  assert.deepEqual(buildAuthorityClarifyRequest(clarify, 'main'), {
    method: AUTHORITY_RESPOND_METHODS.clarify,
    params: { session_id: 'sess-1', execution_generation: 4, prompt_id: 'c-1', answer: 'main' },
  });
  assert.equal(buildAuthorityClarifyRequest(clarify, 'x'.repeat(16_385)), null);
  assert.equal(buildAuthorityClarifyRequest(approval, 'main'), null);
  assert.equal(buildAuthorityApprovalRequest({ ...approval, transport: 'rest' }, 'once'), null, 'REST prompts keep their REST body');
});

test('authority prompts are always actionable, like the other WebSocket prompts', () => {
  assert.equal(isPromptActionable({ transport: 'ws-authority', capabilities: { source: 'api-server', runApproval: false } }), true);
});

test('the resume snapshot lists open prompts of both kinds, and skips what it cannot read', () => {
  const entries = authorityPromptsFromSnapshot(
    [authorityApproval(), authorityClarify(), { kind: 'secret', prompt_id: 's' }, null, 'x'],
    { sessionId: 'sess-1', storedSessionId: 'stored-1' },
  );
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.key, entry.sessionId]), [
    ['approval', 'ws-authority:sess-1:p-1', 'stored-1'],
    ['clarify', 'ws-authority:sess-1:c-1', 'stored-1'],
  ]);
  assert.deepEqual(authorityPromptsFromSnapshot(null, { sessionId: 'sess-1' }), []);
  assert.deepEqual(authorityPromptsFromSnapshot([authorityApproval()], { sessionId: '' }), []);
});

function authorityWorld({ viewed = ['sess-1'] } = {}) {
  BrowserLikeSocket.all = [];
  const notices = [];
  const controller = createPromptController({ getViewedSessionIds: () => viewed, onNotice: (notice) => notices.push(notice) });
  const handler = {
    handle: (request, controls) => controller.ingestServerRequest(request, controls),
    cancel: (payload) => controller.cancelServerRequest(payload?.id, { reason: payload?.reason }),
    event: (type, event, client) => controller.ingestAuthorityEvent(type, event, { client }),
    prompts: (prompts, context) => controller.ingestAuthorityPrompts(prompts, context),
    closed: (client) => controller.dropClient(client),
  };
  const client = createGatewayClient({ WebSocketImpl: BrowserLikeSocket, serverRequests: handler, requestTimeoutMs: 200 });
  return { controller, notices, client };
}

async function connectAuthority(world, readyPayload = { session_authority: true }) {
  const connecting = world.client.connect('ws://host/api/ws');
  const socket = BrowserLikeSocket.all.at(-1);
  socket.open();
  socket.ready(readyPayload);
  await connecting;
  return socket;
}

test('an approval raised as an authority event shows a card and is answered with approval.respond', async () => {
  const world = authorityWorld();
  const socket = await connectAuthority(world);
  socket.event('approval.request', 'sess-1', authorityApproval(), 1);
  const [card] = world.controller.getSnapshot().visible;
  assert.equal(card.kind, 'approval');
  assert.equal(card.command, 'rm -rf build');
  assert.equal(card.actionable, true);

  const answering = world.controller.answerApproval(card.key, 'deny');
  await tick();
  const sent = socket.sent.find((frame) => frame.method === 'approval.respond');
  assert.deepEqual(sent.params, { session_id: 'sess-1', execution_generation: 4, prompt_id: 'p-1', choice: 'deny' });
  assert.equal(world.controller.getSnapshot().visible[0].status, 'answering');
  socket.reply('approval.respond', { status: 'resolved', prompt_id: 'p-1' });
  assert.deepEqual(await answering, { ok: true, retired: false });
  assert.equal(world.controller.getSnapshot().total, 0);
  assert.equal(world.notices.at(-1).type, 'sent');

  // The same event replayed after a reconnect does not bring the card back.
  socket.event('approval.request', 'sess-1', authorityApproval(), 2);
  assert.equal(world.controller.getSnapshot().total, 0);
  world.controller.destroy();
});

test('a clarify question raised as an authority event is answered with clarify.respond', async () => {
  const world = authorityWorld();
  const socket = await connectAuthority(world);
  socket.event('clarify.request', 'sess-1', authorityClarify(), 1);
  const [card] = world.controller.getSnapshot().visible;
  const answering = world.controller.answerClarify(card.key, { '': 'dev' });
  await tick();
  const sent = socket.sent.find((frame) => frame.method === 'clarify.respond');
  assert.deepEqual(sent.params, { session_id: 'sess-1', execution_generation: 4, prompt_id: 'c-1', answer: 'dev' });
  socket.reply('clarify.respond', { status: 'resolved', prompt_id: 'c-1' });
  assert.equal((await answering).ok, true);
  assert.equal(world.controller.getSnapshot().total, 0);
  world.controller.destroy();
});

test('a stale or already-answered prompt closes instead of offering a retry, and other refusals keep the card', async () => {
  for (const [error, retired] of [
    [{ code: 4001, message: 'stale_generation', data: { reason: 'stale_generation' } }, true],
    [{ code: 4001, message: 'approval_not_pending', data: { reason: 'approval_not_pending' } }, true],
    [{ code: 4001, message: 'permission_denied', data: { reason: 'permission_denied' } }, false],
  ]) {
    const world = authorityWorld();
    const socket = await connectAuthority(world);
    socket.event('approval.request', 'sess-1', authorityApproval(), 1);
    const key = world.controller.getSnapshot().visible[0].key;
    const answering = world.controller.answerApproval(key, 'once');
    await tick();
    socket.fail('approval.respond', error);
    const result = await answering;
    assert.equal(result.ok, false);
    assert.equal(Boolean(result.retired), retired);
    assert.equal(world.controller.getSnapshot().total, retired ? 0 : 1, error.message);
    if (!retired) assert.equal(world.controller.getSnapshot().visible[0].status, 'pending', 'answerable again');
    world.controller.destroy();
  }

  const world = authorityWorld();
  const socket = await connectAuthority(world);
  socket.event('clarify.request', 'sess-1', authorityClarify(), 1);
  const answering = world.controller.answerClarify(world.controller.getSnapshot().visible[0].key, { '': 'main' });
  await tick();
  socket.reply('clarify.respond', { status: 'already_resolved', prompt_id: 'c-1' });
  assert.deepEqual(await answering, { ok: true, retired: true });
  assert.equal(world.notices.at(-1).type, 'retired');
  world.controller.destroy();
});

test('a settled event, the end of the turn, or a closed connection clears the card; nothing else does', async () => {
  const world = authorityWorld();
  const socket = await connectAuthority(world);
  socket.event('approval.request', 'sess-1', authorityApproval(), 1);
  socket.event('clarify.request', 'sess-1', authorityClarify(), 2);
  assert.equal(world.controller.getSnapshot().total, 2);
  socket.event('tool.start', 'sess-1', { name: 'x' }, 3);
  assert.equal(world.controller.getSnapshot().total, 2);
  socket.event('approval.settled', 'sess-1', { prompt_id: 'p-1', execution_generation: 4 }, 4);
  assert.deepEqual(world.controller.getSnapshot().visible.map((card) => card.kind), ['clarify']);
  socket.event('message.complete', 'other-session', { text: 'x' }, 1);
  assert.equal(world.controller.getSnapshot().total, 1, 'another session finishing does not touch this prompt');
  socket.event('message.complete', 'sess-1', { text: 'done' }, 5);
  assert.equal(world.controller.getSnapshot().total, 0);

  socket.event('approval.request', 'sess-1', authorityApproval({ prompt_id: 'p-2' }), 6);
  assert.equal(world.controller.getSnapshot().total, 1);
  socket.emit('close', { code: 1006 });
  assert.equal(world.controller.getSnapshot().total, 0);
  world.controller.destroy();
});

test('authority events are believed only from a connection that said it is a session authority', async () => {
  const world = authorityWorld();
  const socket = await connectAuthority(world, { heartbeat: true });
  socket.event('approval.request', 'sess-1', authorityApproval(), 1);
  assert.equal(world.controller.getSnapshot().total, 0, 'a legacy gateway raises server requests, not events');
  world.controller.destroy();
});

test('a prompt for a session that is not on screen is held, and shows when that session is viewed', async () => {
  const viewed = ['sess-2'];
  const world = authorityWorld({ viewed });
  const socket = await connectAuthority(world);
  socket.event('approval.request', 'sess-1', authorityApproval(), 1);
  assert.equal(world.controller.getSnapshot().visible.length, 0);
  assert.equal(world.controller.getSnapshot().hiddenCount, 1);
  assert.equal(world.notices[0].viewed, false);
  viewed[0] = 'sess-1';
  assert.equal(world.controller.getSnapshot().visible.length, 1);
  world.controller.destroy();
});

test('resuming a session lists its open prompts as cards, and a socket without authority adds none', async () => {
  const world = authorityWorld();
  const socket = await connectAuthority(world);
  const establishing = establishGatewaySession({ client: world.client, storedSessionId: 'sess-1' });
  socket.reply(WS_METHODS.sessionResume, {
    session_id: 'sess-1', stored_session_id: 'sess-1', execution_generation: 4, prompts: [authorityApproval(), authorityClarify()],
  });
  await establishing;
  assert.deepEqual(world.controller.getSnapshot().visible.map((card) => card.kind), ['approval', 'clarify']);
  // A second resume of the same session is one prompt, not two.
  const again = establishGatewaySession({ client: world.client, storedSessionId: 'sess-1' });
  socket.reply(WS_METHODS.sessionResume, { session_id: 'sess-1', stored_session_id: 'sess-1', prompts: [authorityApproval()] });
  await again;
  assert.equal(world.controller.getSnapshot().total, 2);
  world.controller.destroy();

  const legacyWorld = authorityWorld();
  const legacySocket = await connectAuthority(legacyWorld, { heartbeat: true });
  const legacy = establishGatewaySession({ client: legacyWorld.client, storedSessionId: 'sess-1' });
  legacySocket.reply(WS_METHODS.sessionResume, { session_id: 'live-1', stored_session_id: 'sess-1', prompts: [authorityApproval()] });
  await legacy;
  assert.equal(legacyWorld.controller.getSnapshot().total, 0);
  legacyWorld.controller.destroy();
});

test('an answer for a prompt whose connection is gone is refused, not sent anywhere else', async () => {
  const world = authorityWorld();
  const socket = await connectAuthority(world);
  socket.event('approval.request', 'sess-1', authorityApproval(), 1);
  const key = world.controller.getSnapshot().visible[0].key;
  world.client.close();
  assert.equal((await world.controller.answerApproval(key, 'once')).ok, false);
  assert.equal(socket.sent.some((frame) => frame.method === 'approval.respond'), false);
  world.controller.destroy();
});

test('a turn that ends, by Stop or otherwise, withdraws the authority prompts it left open', () => {
  const panelSettle = sidepanel.match(/async function settleActiveRunTerminal\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(panelSettle, /promptController\.settleScope\('ws-authority', endedLiveSessionId\)/);
  // The run's own session, not whichever session is selected when it settles (D11).
  assert.match(panelSettle, /liveIdForRunSettle\(settledRunControl, activeDashboardWsConnection\)/);
  const webSettle = app.match(/async function settleWebRunTerminal\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(webSettle, /promptController\.settleScope\('ws-authority', endedLiveSessionId\)/);
  assert.match(webSettle, /dashboardLiveSessionId/);
  // Settling comes after the terminal guard: a run still being confirmed keeps its prompts.
  assert.ok(panelSettle.indexOf('RUN_CONTROL_PHASES.TERMINAL') < panelSettle.indexOf('settleScope'));
  assert.ok(webSettle.indexOf('RUN_CONTROL_PHASES.TERMINAL') < webSettle.indexOf('settleScope'));
});

// ---- what is approved is what is shown ---------------------------------------------------------

function cardFor(entries) {
  const { document } = parseHTML('<html><body><section id="card" hidden></section></body></html>');
  let listener = null;
  const controller = {
    subscribe(fn) { listener = fn; return () => {}; },
    answerApproval: () => Promise.resolve({ ok: true }),
    answerClarify: () => Promise.resolve({ ok: true }),
    dismiss: () => {},
  };
  const container = document.getElementById('card');
  createPromptCard({ container, t: (key) => key, controller });
  listener({ visible: entries.map((entry) => ({ ...entry, actionable: true })), hiddenCount: 0, total: entries.length, now: Date.now() });
  return container;
}

test('a command longer than the card keeps says so instead of looking complete', () => {
  const long = `echo start ${'x'.repeat(25_000)} && rm -rf /`;
  const entry = normalizeApprovalPrompt({ request_id: 'r1', execution_generation: 1, command: long, choices: ['once', 'deny'] }, { scope: 'run-1' });
  assert.equal(entry.commandTruncated, true);
  assert.equal(entry.command.length, 20_000);
  const truncated = cardFor([entry]);
  assert.equal(truncated.querySelector('.agent-prompt-command').textContent.length, 20_000);
  assert.match(truncated.textContent, /exec_approval\.command_truncated/);

  const short = normalizeApprovalPrompt({ request_id: 'r1', execution_generation: 1, command: 'ls', choices: ['once', 'deny'] }, { scope: 'run-1' });
  assert.equal(short.commandTruncated, false);
  assert.doesNotMatch(cardFor([short]).textContent, /command_truncated/);
});

test('an edit longer than the card keeps says so, even when its diff fits the line budget', () => {
  const edit = { path: 'a.txt', old_text: 'a\n', new_text: `b${'y'.repeat(250_000)}` };
  const entry = normalizeApprovalPrompt({ request_id: 'r1', execution_generation: 1, edit }, { scope: 'run-1' });
  assert.equal(entry.edit.truncated, true);
  assert.match(cardFor([entry]).textContent, /exec_approval\.edit_truncated/);
  const small = normalizeApprovalPrompt({ request_id: 'r1', execution_generation: 1, edit: { path: 'a.txt', old_text: 'a\n', new_text: 'b\n' } }, { scope: 'run-1' });
  assert.equal(small.edit.truncated, false);
  assert.doesNotMatch(cardFor([small]).textContent, /edit_truncated/);
});

test('a run that stays quiet is read less and less often, and any stream activity starts over', async () => {
  const delays = [];
  const timers = [];
  const poller = createPendingControlsPoller({
    fetchStatus: async () => ({ status: 'running', pending_controls: [] }),
    onStatus: () => {},
    quietMs: 8_000,
    pollMs: 4_000,
    maxPollMs: 12_000,
    backoffEvery: 2,
    setTimeoutFn: (fn, delay) => { delays.push(delay); timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
  });
  poller.start();
  for (let read = 0; read < 7; read += 1) await timers.pop()();
  // The quiet period first, then each wait grows by one poll interval every
  // `backoffEvery` reads until it reaches the cap.
  assert.deepEqual(delays, [8_000, 4_000, 8_000, 8_000, 12_000, 12_000, 12_000, 12_000]);
  poller.activity();
  assert.equal(delays.at(-1), 8_000, 'activity waits out the quiet period again');
  await timers.pop()();
  assert.equal(delays.at(-1), 4_000, 'and the next reads are frequent again');
  poller.stop();
});

// ---- a slow status read ------------------------------------------------------------------------

function restWorld() {
  const clock = { now: 0 };
  const controller = createPromptController({
    now: () => clock.now,
    getViewedSessionIds: () => ['sess-a'],
    getCapabilities: () => ({ source: 'api-server', runApproval: true }),
  });
  const approval = { run_id: 'run-1', request_id: 'r1', execution_generation: 1, command: 'ls', choices: ['once', 'deny'] };
  return { clock, controller, approval };
}

test('a status answer that was sent before a prompt existed cannot withdraw it, however late it is processed', () => {
  const { clock, controller, approval } = restWorld();
  clock.now = 600;
  controller.ingestRestEvent('approval.request', approval, { sessionId: 'sess-a' });
  clock.now = 4_000; // the answer to a read sent at t=0 only now arrives
  controller.ingestRunStatus('run-1', { run_id: 'run-1', status: 'running', pending_controls: [] }, { sessionId: 'sess-a', requestedAt: 0 });
  assert.equal(controller.getSnapshot().visible.length, 1, 'the prompt is still answerable');
  // Seen again, it is still one prompt: it was never settled, so it is not blocked from returning either.
  controller.ingestRestEvent('approval.request', approval, { sessionId: 'sess-a' });
  assert.equal(controller.getSnapshot().total, 1);
  controller.destroy();
});

test('a prompt the status no longer lists is still withdrawn once a read sent after it says so', () => {
  const { clock, controller, approval } = restWorld();
  clock.now = 600;
  controller.ingestRestEvent('approval.request', approval, { sessionId: 'sess-a' });
  clock.now = 10_000;
  controller.ingestRunStatus('run-1', { run_id: 'run-1', status: 'running', pending_controls: [] }, { sessionId: 'sess-a', requestedAt: 9_900 });
  assert.equal(controller.getSnapshot().total, 0, 'answered elsewhere: the card closes');
  // A status without a request time keeps the old behaviour: judged as of now.
  clock.now = 20_000;
  controller.ingestRestEvent('approval.request', { ...approval, request_id: 'r2' }, { sessionId: 'sess-a' });
  clock.now = 30_000;
  controller.ingestRunStatus('run-1', { run_id: 'run-1', status: 'running', pending_controls: [] }, { sessionId: 'sess-a' });
  assert.equal(controller.getSnapshot().total, 0);
  controller.destroy();
});

test('the poll tells its reader when each read was sent', async () => {
  const stamps = [];
  const timers = [];
  let clock = 1_000;
  const poller = createPendingControlsPoller({
    fetchStatus: async () => {
      clock += 2_500; // a slow read
      return { status: 'running', pending_controls: [] };
    },
    onStatus: (payload, meta) => stamps.push(meta.requestedAt),
    now: () => clock,
    setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
  });
  poller.start();
  await timers.pop()();
  assert.deepEqual(stamps, [1_000], 'stamped before the read, not when its answer came back');
  poller.stop();
});

test('both surfaces pass the read time on to the controller', () => {
  for (const source of [sidepanel, app]) {
    assert.match(source, /onStatus: \(payload, \{ requestedAt \} = \{\}\) => \{\s*if \(isCurrent\(\)\) promptController\.ingestRunStatus\(getRunId\(\), payload, \{ sessionId, requestedAt \}\);/);
  }
});
