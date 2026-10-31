import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate } from 'node:timers';
import { sessionIsLiveFromStatus, shouldAttachLiveSession } from '../extension/lib/live-session-attach.mjs';
import { readGatewaySessionStatus } from '../extension/lib/gateway-ws.mjs';
import { emptyTurnReasoning, formatTurnDuration, liveTurnStartedAt, reduceTurnReasoning, replyTextAfterCommentary, turnReasoningFromRestEvent } from '../extension/lib/turn-activity.mjs';
import { bindDashboardReasoning, ensureSessionShowsReasoning } from '../extension/lib/turn-reasoning-socket.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const attachSource = source.slice(source.indexOf('async function attachLiveSessionIfRunning('), source.indexOf('async function fetchSessionMessagesQuietly('));
function harness(statusRequest = async () => ({ output: 'Agent Running: Yes' })) {
  const listeners = new Map();
  const paints = [];
  const calls = [];
  let refreshes = 0;
  const restores = [];
  const client = { readyState: 1, request: async (method, params) => { calls.push({ method, params }); return statusRequest(); },
    on: (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); } };
  const context = vm.createContext({
    activeDashboardWsConnection: { client, wsSessionId: 'runtime-1', wsStoredSessionId: 'stored-1' },
    activeConversationTransport: 'dashboard-ws', settings: { sessionId: 'stored-1' }, sending: false,
    liveAttach: null, liveAttachGeneration: 0, sessionLoadRequestId: 1, liveSessionRows: new Map(),
    completeAttachedRun: async () => { refreshes += 1; },
    scopeRevision: { current: () => 1, isCurrent: id => id === 1 },
    shouldAttachLiveSession, sessionIsLiveFromStatus, readGatewaySessionStatus, bindDashboardReasoning, liveTurnStartedAt, messages: [],
    THINKING_PLACEHOLDER: 'Thinking', addMessage: () => ({ node: {} }), assistantMessageRoleLabel: () => 'Hermes',
    createStreamingMessageUpdater: () => ({ updateText: value => paints.push(value), updateTool: value => paints.push(value), flush: async value => paints.push(value), dispose: () => {} }),
    matchesDashboardSessionEvent: (event, ids) => ids.includes(event.sessionId),
    normalizeToolActivity: value => value,
    WS_METHODS: { sessionStatus: 'session.status' },
    WS_EVENTS: { messageDelta: 'message.delta', messageComplete: 'message.complete', error: 'error' },
    setStatus: () => {}, renderSessionMenu: () => {}, updateComposerBusyState: () => {}, renderContextWindow: () => {},
    reconcileAttachedLiveSession: async () => {},
    hydrateSubagentSnapshot: async (_client, sessionId) => { restores.push(['subagents', sessionId]); },
    refreshSessionContextTelemetry: (options) => { restores.push(['context', options]); },
    refreshActiveSessionHistoryQuietly: async () => { refreshes += 1; },
  });
  vm.runInContext(attachSource, context);
  return { context, calls, paints, listeners, restores,
    attach: () => vm.runInContext("attachLiveSessionIfRunning('runtime-1')", context),
    emit: (type, sessionId, payload) => { for (const listener of listeners.get(type) || []) listener({ sessionId, payload }); },
    refreshes: () => refreshes,
    count: () => [...listeners.values()].reduce((n, list) => n + list.size, 0),
  };
}

test('real attachment addresses the live ID, but binds the view to the durable ID', async () => {
  const h = harness();
  assert.equal(await h.attach(), true);
  assert.equal(h.calls[0].params.session_id, 'runtime-1');
  assert.equal(h.context.liveAttach.sessionId, 'stored-1');
  h.emit('message.delta', 'unrelated-runtime', { text: 'wrong chat' });
  assert.equal(h.paints.length, 0);
  h.emit('message.delta', 'runtime-1', { text: 'right chat' });
  h.emit('tool.start', 'runtime-1', { name: 'terminal', context: 'npm test' });
  assert.equal(h.paints[0], 'right chat');
  assert.equal(h.paints[1].tool_name, 'terminal');
  h.emit('message.complete', 'runtime-1', { text: 'done' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.count(), 0);
  assert.equal(h.context.liveAttach, null);
  assert.equal(h.refreshes(), 1);
});

test('attaching to a live run restores its subagents and context from the gateway at once', async () => {
  const h = harness();
  assert.equal(await h.attach(), true);
  assert.equal(JSON.stringify(h.restores), JSON.stringify([['subagents', 'runtime-1'], ['context', { force: true }]]),
    'subagent.list goes to the live id; the context is re-read even if a recent reading exists');
});

test('navigation invalidates an attachment still awaiting status, including an A-B-A switch', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  const pending = h.attach();
  vm.runInContext("detachLiveSession(); sessionLoadRequestId += 1; settings.sessionId='stored-1'", h.context);
  resolve({ output: 'Agent Running: Yes' });
  assert.equal(await pending, false);
  assert.equal(h.count(), 0);
  assert.equal(h.context.liveAttach, null);
});

test('leaving a followed run unsubscribes without submitting or interrupting it', async () => {
  const h = harness();
  await h.attach();
  vm.runInContext("detachLiveSession(); settings.sessionId='new-draft'", h.context);
  h.emit('message.delta', 'runtime-1', { text: 'must not leak' });
  assert.equal(h.count(), 0);
  assert.equal(h.paints.length, 0);
  assert.equal(h.calls.filter(call => ['prompt.submit', 'session.interrupt'].includes(call.method)).length, 0);
});
