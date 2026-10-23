// A session-authority gateway does not serve session.status or session.activate (it answers -32601).
// The panel must still attach to a running session, keep it attached, show it as busy and Stop it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate } from 'node:timers';
import {
  readLiveAttachSnapshot, rosterStopTarget, sessionIsLiveFromStatus, shouldAttachLiveSession,
} from '../extension/lib/live-session-attach.mjs';
import {
  WS_EVENTS, WS_METHODS, interruptGatewaySession, isUnknownMethodError, normalizeGatewayHistoryMessages, readGatewaySessionStatus, readSessionExecutionGeneration,
} from '../extension/lib/gateway-ws.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const between = (a, b) => source.slice(source.indexOf(a), source.indexOf(b));
const attachSource = between('async function attachLiveSessionIfRunning(', 'async function fetchSessionMessagesQuietly(');
const reconcileSource = between('async function reconcileAttachedLiveSession()', 'async function loadAllHermesSessions()');
const stopSource = between('async function stopCurrentTurn()', '// Newer Hermes builds report the in-flight run');

const unknownMethod = (method) => Object.assign(new Error(`unknown method: ${method}`), { rpcCode: -32601, data: { reason: 'unknown_method' } });

// A fake authority gateway: no session.status, no session.activate; session.active_list, session.history,
// session.resume and session.interrupt are served.
function authorityHarness({ rowStatus = 'working', generation = 4 } = {}) {
  const state = { rowStatus, generation };
  const listeners = new Map();
  const calls = [];
  const client = {
    readyState: 1, readyPayload: { session_authority: true },
    on: (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'session.status' || method === 'session.activate') throw unknownMethod(method);
      if (method === 'session.active_list') {
        return { sessions: state.rowStatus ? [{ id: 'A', session_key: 'A', status: state.rowStatus, source: 'tui' }] : [] };
      }
      if (method === 'session.history') return { count: 2, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'partial' }] };
      if (method === 'session.resume') return { running: state.rowStatus !== 'idle', execution_state: state.rowStatus === 'idle' ? 'idle' : 'running', execution_generation: state.generation };
      if (method === 'session.interrupt') {
        if (params.execution_generation !== undefined && params.execution_generation !== state.generation) {
          throw Object.assign(new Error('stale_generation'), { rpcCode: 4001, data: { reason: 'stale_generation', execution_generation: state.generation } });
        }
        return { status: 'interrupted', execution_generation: params.execution_generation };
      }
      return {};
    },
  };
  const painted = [];
  const committed = [];
  const statuses = [];
  const context = vm.createContext({
    activeDashboardWsConnection: { client, wsSessionId: 'A', wsStoredSessionId: 'A' },
    activeConversationTransport: 'dashboard-ws', settings: { sessionId: 'A' }, sending: false,
    liveAttach: null, liveAttachGeneration: 0, sessionLoadRequestId: 1,
    liveSessionRows: new Map(), liveSessionRosterScope: 'scope', liveSessionScopeKey: () => 'scope',
    unsupportedActivateClients: new WeakSet(),
    messages: [], queuedTurn: null, pendingSteerText: '',
    completeAttachedRun: async () => {},
    scopeRevision: { current: () => 1, isCurrent: (id) => id === 1 },
    shouldAttachLiveSession, sessionIsLiveFromStatus, readLiveAttachSnapshot, rosterStopTarget, readGatewaySessionStatus,
    interruptGatewaySession, isUnknownMethodError, normalizeGatewayHistoryMessages, readSessionExecutionGeneration,
    THINKING_PLACEHOLDER: 'Thinking', addMessage: () => ({ node: {}, record: {} }), assistantMessageRoleLabel: () => 'Hermes',
    createStreamingMessageUpdater: () => ({ updateText: (v) => painted.push(v), updateTool: () => {}, flush: async (v) => painted.push(v), dispose: () => {} }),
    matchesDashboardSessionEvent: (event, ids) => ids.includes(event.sessionId),
    normalizeToolActivity: (value) => value, normalizeMessageTimestamp: (value) => value, messageDisplayText: (_r, c) => c,
    WS_METHODS, WS_EVENTS,
    setStatus: (...args) => statuses.push(args), renderSessionMenu: () => {}, updateComposerBusyState: () => {}, renderContextWindow: () => {},
    hydrateSubagentSnapshot: async () => {}, refreshSessionContextTelemetry: () => {},
    refreshActiveSessionHistoryQuietly: async () => {}, refreshLiveSessionRoster: async () => {},
    commitFetchedSessionMessages: async (payload) => { committed.push(payload); },
    safeActiveProfile: () => '', cancelBrowserControlAfterConfirmedStop: async () => '', announceControlCancellation: () => {},
    runControlRequestWithTimeout: (operation) => operation(), RUN_CONTROL_REQUEST_TIMEOUT_MS: 1000,
    renderQueueNotice: () => {}, localRunIsViewed: () => false,
  });
  vm.runInContext(attachSource + reconcileSource + stopSource, context);
  return {
    context, calls, painted, committed, statuses, state,
    attach: () => vm.runInContext("attachLiveSessionIfRunning('A')", context),
    reconcile: () => vm.runInContext('reconcileAttachedLiveSession()', context),
    stop: () => vm.runInContext('stopCurrentTurn()', context),
    emit: (type, payload) => { for (const fn of listeners.get(type) || []) fn({ sessionId: 'A', payload }); },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    rosterRow: (live = true) => context.liveSessionRows.set('A', { live, busy: live, state: live ? 'running' : 'idle', liveId: 'A', status: live ? 'working' : 'idle' }),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('attach proves liveness through the authority reader when session.status answers -32601', async () => {
  const h = authorityHarness();
  assert.equal(await h.attach(), true, 'attached');
  assert.equal(h.context.liveAttach?.sessionId, 'A');
  assert.ok(h.calls.some((call) => call.method === 'session.active_list'), 'read the roster row instead');
  assert.equal(h.calls.filter((call) => call.method === 'prompt.submit' || call.method === 'session.interrupt').length, 0, 'attach is read-only');
});

test('an authority session that reads idle is not attached', async () => {
  const h = authorityHarness({ rowStatus: 'idle' });
  assert.equal(await h.attach(), false);
  assert.equal(h.context.liveAttach, null);
});

test('a "starting" authority row is a running session to attach to', async () => {
  const h = authorityHarness({ rowStatus: 'starting' });
  assert.equal(await h.attach(), true);
});

test('an attached authority view stays attached across polls and finishes when the session goes idle', async () => {
  const h = authorityHarness();
  assert.equal(await h.attach(), true);
  await tick(); await tick(); // the reconcile started by attach
  assert.ok(h.context.liveAttach, 'a view that attached must not detach on the first reconcile');
  h.state.rowStatus = 'working';
  await h.reconcile();
  assert.ok(h.context.liveAttach, 'still attached while working');
  assert.equal(h.calls.filter((call) => call.method === 'session.activate').length, 1, 'session.activate is tried once per client, not on every poll');
  assert.equal(h.calls.filter((call) => call.method === 'session.history').length, 1, 'the transcript is read once, not on every 2 s poll');
  h.state.rowStatus = 'idle';
  await h.reconcile();
  await tick(); await tick();
  assert.equal(h.context.liveAttach, null, 'the run ended: the view releases its listeners');
  assert.equal(h.listenerCount(), 0);
});

test('Stop on a running session the roster lists, before any attach, interrupts that live session', async () => {
  const h = authorityHarness();
  h.rosterRow(true);
  assert.equal(h.context.liveAttach, null);
  assert.equal(await h.stop(), true);
  const interrupts = h.calls.filter((call) => call.method === 'session.interrupt');
  assert.equal(interrupts.length, 1);
  assert.equal(interrupts[0].params.session_id, 'A');
  assert.equal(interrupts[0].params.execution_generation, 4);
});

test('Stop does nothing for a viewed session the roster does not list as live', async () => {
  const h = authorityHarness();
  h.rosterRow(false);
  assert.equal(await h.stop(), false);
  assert.equal(h.calls.filter((call) => call.method === 'session.interrupt').length, 0);
});

test('rosterStopTarget: only a live row of the viewed session on a ready connection in the current scope', () => {
  const client = { readyState: 1 };
  const row = { live: true, liveId: 'live-A' };
  const base = { rows: new Map([['A', row]]), sessionId: 'A', client, scopeMatches: true };
  assert.deepEqual(rosterStopTarget(base), { client, liveId: 'live-A', sessionId: 'A' });
  assert.equal(rosterStopTarget({ ...base, scopeMatches: false }), null);
  assert.equal(rosterStopTarget({ ...base, sessionId: 'B' }), null);
  assert.equal(rosterStopTarget({ ...base, client: { readyState: 3 } }), null);
  assert.equal(rosterStopTarget({ ...base, rows: new Map([['A', { live: false, liveId: 'x' }]]) }), null);
  assert.equal(rosterStopTarget({ ...base, rows: new Map([['A', { live: true, liveId: '' }]]) }), null);
  assert.equal(rosterStopTarget({ ...base, rows: new Map([['A', { live: true, childrenOnly: true, liveId: 'live-A' }]]) }), null, 'only its subagents run: nothing of its own to Stop');
});

test('readLiveAttachSnapshot: legacy gateways keep using session.activate', async () => {
  const calls = [];
  const client = { readyPayload: {}, request: async (method) => { calls.push(method); return { running: true, inflight: { assistant: 'x' }, messages: [] }; } };
  const result = await readLiveAttachSnapshot({ client, liveId: 'live', storedId: 'S' });
  assert.deepEqual(calls, ['session.activate']);
  assert.equal(result.snapshot.running, true);
  assert.equal(result.activateUnsupported, false);
});

test('an attached view records the generation of the run it follows, and its Stop cannot land on a newer run', async () => {
  const h = authorityHarness();
  assert.equal(await h.attach(), true);
  await tick(); await tick();
  assert.equal(h.context.liveAttach.executionGeneration, 4);
  h.state.generation = 5; // the followed run ended and a newer one started
  assert.equal(await h.stop(), true);
  const interrupts = h.calls.filter((call) => call.method === 'session.interrupt');
  assert.deepEqual(interrupts.map((call) => call.params.execution_generation), [4], 'one interrupt, for the followed run');
  assert.match(h.statuses.at(-1)[1], /already ended/i);
});

test('a session authority that answered -32601 to session.status is not asked for it again', async () => {
  const h = authorityHarness();
  const client = h.context.activeDashboardWsConnection.client;
  await readGatewaySessionStatus(client, 'A', { storedSessionId: 'A' });
  await readGatewaySessionStatus(client, 'A', { storedSessionId: 'A' });
  await readGatewaySessionStatus(client, 'A', { storedSessionId: 'A' });
  assert.equal(h.calls.filter((call) => call.method === 'session.status').length, 1, 'asked once, then remembered');
  assert.equal(h.calls.filter((call) => call.method === 'session.active_list').length, 3);
});

test('a legacy gateway keeps being asked for session.status', async () => {
  const calls = [];
  const client = { readyPayload: {}, request: async (method) => { calls.push(method); return { output: 'Agent Running: Yes' }; } };
  await readGatewaySessionStatus(client, 'live-1');
  await readGatewaySessionStatus(client, 'live-1');
  assert.deepEqual(calls, ['session.status', 'session.status']);
});
