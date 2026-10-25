import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as lifecycle from '../extension/lib/run-control-lifecycle.mjs';
import {
  WS_METHODS,
  buildSessionCompressParams,
  executionGenerationFrom,
  interruptGatewaySession,
  isInvalidParamsError,
  isStaleGenerationError,
  isUnknownMethodError,
  normalizeSessionCompressResult,
  readSessionExecutionGeneration,
} from '../extension/lib/gateway-ws.mjs';
import { dashboardWsGatewayCapabilities, dashboardWsSupportsCompress } from '../extension/lib/capabilities.mjs';
import { sessionContextFailureRecovery } from '../extension/lib/turn-recovery.mjs';

const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function rpcError(message, { code = 4001, data } = {}) {
  const error = new Error(message);
  error.code = code;
  error.rpcCode = code;
  if (data !== undefined) error.data = data;
  return error;
}

// A scripted gateway client: `handlers[method]` is a function or a queue of
// results/errors consumed one request at a time.
function fakeClient(handlers = {}, { readyPayload = null } = {}) {
  const calls = [];
  const queues = new Map(Object.entries(handlers).map(([method, value]) => [method, Array.isArray(value) ? [...value] : value]));
  return {
    calls,
    readyPayload,
    async request(method, params) {
      calls.push({ method, params });
      const handler = queues.get(method);
      if (handler === undefined) throw rpcError('unknown method', { code: -32601, data: { reason: 'unknown_method' } });
      const next = Array.isArray(handler) ? handler.shift() : handler;
      const value = typeof next === 'function' ? await next(params) : next;
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

const interrupts = (client) => client.calls.filter((call) => call.method === WS_METHODS.sessionInterrupt);

test('markRunUnconfirmed holds the writer, is never terminal, and keeps queued turns held', () => {
  const running = lifecycle.requestRunStop(lifecycle.beginRunControl({ transport: 'rest' }));
  const unconfirmed = lifecycle.markRunUnconfirmed(running, lifecycle.RUN_UNCONFIRMED_REASONS.RUN_ID_UNKNOWN);
  assert.equal(unconfirmed.phase, lifecycle.RUN_CONTROL_PHASES.UNCONFIRMED);
  assert.equal(unconfirmed.writerLease, 'held');
  assert.equal(unconfirmed.controlStatus, 'unconfirmed');
  assert.match(unconfirmed.detail, /has not reported a run id/i);
  assert.equal(lifecycle.canFlushQueuedTurn({ autoSend: true }, unconfirmed), false);
  assert.equal(lifecycle.canSwitchActiveSession({ sending: false, runControl: unconfirmed }), false);
  assert.equal(lifecycle.markRunUnconfirmed(unconfirmed, 'run-id-unknown', 'custom detail').detail, 'custom detail');
});

test('markRunUnconfirmed never downgrades a terminal run and tolerates a missing state', () => {
  const terminal = lifecycle.markRunTerminal(lifecycle.beginRunControl(), 'completed');
  assert.equal(lifecycle.markRunUnconfirmed(terminal, 'run-id-unknown'), terminal);
  assert.equal(lifecycle.markRunUnconfirmed(null, 'run-id-unknown'), null);
});

test('a session payload can name its in-flight run, and junk ids are ignored', () => {
  assert.equal(lifecycle.activeRunIdFromSessionPayload({ active_run_id: 'run_abc-1' }), 'run_abc-1');
  assert.equal(lifecycle.activeRunIdFromSessionPayload({ session: { active_run_id: 'run-2' } }), 'run-2');
  assert.equal(lifecycle.activeRunIdFromSessionPayload({ active_run_id: 'bad id/../x' }), '');
  assert.equal(lifecycle.activeRunIdFromSessionPayload({}), '');
  assert.equal(lifecycle.activeRunIdFromSessionPayload(null), '');
});

test('controllerStopSummary reports how many commands the controller cancelled', () => {
  assert.deepEqual(lifecycle.controllerStopSummary({ ok: true, cancelled: 3, pendingCommands: 0 }), { ok: true, cancelled: 3 });
  assert.deepEqual(lifecycle.controllerStopSummary({ ok: true, cancelled: 0 }), { ok: true, cancelled: 0 });
  assert.deepEqual(lifecycle.controllerStopSummary({ ok: false, error: 'controller_unavailable' }), { ok: false, cancelled: 0 });
  assert.deepEqual(lifecycle.controllerStopSummary(null), { ok: false, cancelled: 0 });
});

test('execution generation is read from the canonical handle shapes only', () => {
  assert.equal(executionGenerationFrom({ execution_generation: 7 }), 7);
  assert.equal(executionGenerationFrom({ handle: { execution_generation: 0 } }), 0);
  assert.equal(executionGenerationFrom({ execution_generation: '7' }), null);
  assert.equal(executionGenerationFrom({ output: 'Agent Running: Yes' }), null);
  assert.equal(executionGenerationFrom(null), null);
});

test('gateway refusals are classified by reason', () => {
  assert.equal(isStaleGenerationError(rpcError('stale_generation', { data: { reason: 'stale_generation' } })), true);
  assert.equal(isStaleGenerationError(rpcError('session_busy')), false);
  assert.equal(isInvalidParamsError(rpcError('invalid_params', { data: { reason: 'invalid_params', fields: ['execution_generation'] } })), true);
  assert.equal(isInvalidParamsError(rpcError('Invalid params', { code: -32602 })), true);
  assert.equal(isInvalidParamsError(rpcError('permission_denied')), false);
  assert.equal(isUnknownMethodError(rpcError('unknown method: session.compress', { code: -32601 })), true);
  assert.equal(isUnknownMethodError(rpcError('boom', { code: 5000 })), false);
});

test('generation is read from session.status when structured, else from the authority snapshot', async () => {
  const structured = fakeClient({ [WS_METHODS.sessionStatus]: { execution_generation: 4, output: '' } });
  assert.equal(await readSessionExecutionGeneration(structured, 'live-1'), 4);
  assert.equal(structured.calls.some((call) => call.method === WS_METHODS.sessionResume), false);

  const authority = fakeClient({
    [WS_METHODS.sessionStatus]: { output: 'Agent Running: Yes' },
    [WS_METHODS.sessionResume]: { session_id: 's-1', execution_generation: 9 },
  }, { readyPayload: { session_authority: true } });
  assert.equal(await readSessionExecutionGeneration(authority, 's-1', { storedSessionId: 's-1' }), 9);
  const resume = authority.calls.find((call) => call.method === WS_METHODS.sessionResume);
  assert.deepEqual(resume.params, { session_id: 's-1', omit_messages: true });
});

test('a gateway without a session authority is never resumed just to read a generation', async () => {
  const legacy = fakeClient({ [WS_METHODS.sessionStatus]: { output: 'Agent Running: Yes' }, [WS_METHODS.sessionResume]: { execution_generation: 1 } });
  assert.equal(await readSessionExecutionGeneration(legacy, 'live-1'), null);
  assert.equal(legacy.calls.some((call) => call.method === WS_METHODS.sessionResume), false);
});

test('Stop sends the execution generation with session.interrupt', async () => {
  const client = fakeClient({
    [WS_METHODS.sessionStatus]: { output: 'x' },
    [WS_METHODS.sessionResume]: { execution_generation: 12 },
    [WS_METHODS.sessionInterrupt]: { execution_state: 'running' },
  }, { readyPayload: { session_authority: true } });
  const outcome = await interruptGatewaySession({ client, sessionId: 's-1' });
  assert.equal(outcome.via, 'ws');
  assert.equal(outcome.generation, 12);
  assert.equal(outcome.retried, false);
  assert.deepEqual(interrupts(client).map((call) => call.params), [{ session_id: 's-1', execution_generation: 12 }]);
});

test('a legacy gateway still gets the plain session.interrupt it understands', async () => {
  const client = fakeClient({
    [WS_METHODS.sessionStatus]: { output: 'x' },
    [WS_METHODS.sessionInterrupt]: { status: 'interrupted' },
  });
  const outcome = await interruptGatewaySession({ client, sessionId: 'live-1' });
  assert.equal(outcome.generation, null);
  assert.deepEqual(interrupts(client).map((call) => call.params), [{ session_id: 'live-1' }]);
});

test('stale_generation re-reads the generation once and retries with the fresh value', async () => {
  const client = fakeClient({
    [WS_METHODS.sessionStatus]: { output: 'x' },
    [WS_METHODS.sessionResume]: [{ execution_generation: 3 }, { execution_generation: 4 }],
    [WS_METHODS.sessionInterrupt]: [rpcError('stale_generation', { data: { reason: 'stale_generation' } }), { execution_state: 'running' }],
  }, { readyPayload: { session_authority: true } });
  const outcome = await interruptGatewaySession({ client, sessionId: 's-1' });
  assert.equal(outcome.retried, true);
  assert.equal(outcome.generation, 4);
  assert.deepEqual(interrupts(client).map((call) => call.params.execution_generation), [3, 4]);
});

test('a second stale_generation is not retried again and the failure reaches the caller', async () => {
  const stale = () => rpcError('stale_generation', { data: { reason: 'stale_generation' } });
  const client = fakeClient({
    [WS_METHODS.sessionStatus]: { output: 'x' },
    [WS_METHODS.sessionResume]: [{ execution_generation: 3 }, { execution_generation: 4 }, { execution_generation: 5 }],
    [WS_METHODS.sessionInterrupt]: [stale(), stale(), { execution_state: 'running' }],
  }, { readyPayload: { session_authority: true } });
  await assert.rejects(interruptGatewaySession({ client, sessionId: 's-1' }), /stale_generation/);
  assert.equal(interrupts(client).length, 2);
});

test('invalid params fall back to REST stop by run id when the run id is known', async () => {
  const client = fakeClient({
    [WS_METHODS.sessionStatus]: { output: 'x' },
    [WS_METHODS.sessionInterrupt]: rpcError('invalid_params', { data: { reason: 'invalid_params' } }),
  });
  let restCalls = 0;
  const outcome = await interruptGatewaySession({
    client,
    sessionId: 'live-1',
    restFallback: async () => { restCalls += 1; return { ok: true }; },
  });
  assert.equal(outcome.via, 'rest');
  assert.equal(restCalls, 1);
});

test('invalid params without a known run id surface as a failure instead of a silent success', async () => {
  const client = fakeClient({
    [WS_METHODS.sessionStatus]: { output: 'x' },
    [WS_METHODS.sessionInterrupt]: rpcError('invalid_params', { data: { reason: 'invalid_params' } }),
  });
  await assert.rejects(interruptGatewaySession({ client, sessionId: 'live-1' }), /invalid_params/);
});

test('other interrupt failures never trigger the REST fallback', async () => {
  const client = fakeClient({
    [WS_METHODS.sessionStatus]: { output: 'x' },
    [WS_METHODS.sessionInterrupt]: rpcError('permission_denied', { data: { reason: 'permission_denied' } }),
  });
  let restCalls = 0;
  await assert.rejects(
    interruptGatewaySession({ client, sessionId: 'live-1', restFallback: async () => { restCalls += 1; } }),
    /permission_denied/,
  );
  assert.equal(restCalls, 0);
});

test('the generation read and the interrupt request both go through the supplied timeout wrapper', async () => {
  const client = fakeClient({ [WS_METHODS.sessionStatus]: { output: 'x' }, [WS_METHODS.sessionInterrupt]: { status: 'interrupted' } });
  let wrapped = 0;
  await interruptGatewaySession({ client, sessionId: 'live-1', withTimeout: (operation) => { wrapped += 1; return operation(); } });
  assert.equal(wrapped, 2);
});

test('compaction params and results follow the session.compress contract', () => {
  assert.deepEqual(buildSessionCompressParams({ sessionId: ' live-1 ' }), { session_id: 'live-1' });
  assert.deepEqual(buildSessionCompressParams({ sessionId: 'live-1', focusTopic: ' auth ' }), { session_id: 'live-1', focus_topic: 'auth' });
  assert.throws(() => buildSessionCompressParams({ sessionId: '' }), /live Hermes session/);
  assert.equal(normalizeSessionCompressResult({ status: 'compressed', summary: { headline: 'Compressed: 40 -> 12 messages' } }).ok, true);
  assert.equal(normalizeSessionCompressResult({ status: 'compressed', summary: { headline: 'Compressed: 40 -> 12 messages' } }).detail, 'Compressed: 40 -> 12 messages');
  assert.equal(normalizeSessionCompressResult({ compressed: false, lock_held: true, message: 'Another compression is running.' }).reason, 'busy');
  assert.equal(normalizeSessionCompressResult({ status: 'aborted' }).reason, 'aborted');
  assert.equal(normalizeSessionCompressResult({ status: 'pending' }).reason, 'pending');
  assert.equal(normalizeSessionCompressResult({ status: 'compressed', summary: { aborted: true } }).ok, false);
});

test('dashboard WebSocket advertises compaction only when the gateway routes session.compress', () => {
  assert.equal(dashboardWsSupportsCompress({ skin: {}, heartbeat: true }), true);
  assert.equal(dashboardWsSupportsCompress({ session_authority: true }), false);
  assert.equal(dashboardWsSupportsCompress(null), false);
  assert.equal(dashboardWsGatewayCapabilities({ health: true, readyPayload: { heartbeat: true } }).sessionCompress, true);
  assert.equal(dashboardWsGatewayCapabilities({ health: true, readyPayload: { session_authority: true } }).sessionCompress, false);
  assert.equal(dashboardWsGatewayCapabilities({ health: true }).sessionCompress, false);
});

test('compression-ceiling recovery compacts on the dashboard transport instead of forcing a new session', () => {
  const capabilities = dashboardWsGatewayCapabilities({ health: true, readyPayload: { heartbeat: true } });
  const recovery = sessionContextFailureRecovery(
    'Context length exceeded; max compression attempts reached',
    capabilities,
  );
  assert.equal(recovery?.action, 'compact');
  const authority = dashboardWsGatewayCapabilities({ health: true, readyPayload: { session_authority: true } });
  assert.equal(
    sessionContextFailureRecovery('Context length exceeded; max compression attempts reached', authority)?.action,
    'new-session',
  );
});

test('the side panel compacts over session.compress on the dashboard transport', () => {
  const panelCompact = panel.match(/async function compactCurrentSessionContext\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(panelCompact, /usesDashboardWsChatTransport\(\)\) return compactDashboardSessionContext/);
  for (const source of [panel]) {
    const dashboardCompact = source.match(/async function compactDashboardSessionContext\([\s\S]*?\n\}/)?.[0] || '';
    assert.match(dashboardCompact, /WS_METHODS\.sessionCompress/);
    assert.match(dashboardCompact, /normalizeSessionCompressResult/);
    assert.match(dashboardCompact, /isUnknownMethodError/);
  }
  assert.match(panel, /readyPayload: connection\?\.client\?\.readyPayload/);
});

function stopHarness({ runId = '', sessionLookup = async () => ({ ok: false, status: 404 }), controllerResult = { ok: true, cancelled: 2 }, browserControlEnabled = true } = {}) {
  const calls = [];
  const statuses = [];
  const sandbox = {
    ...lifecycle,
    liveAttach: null,
    settings: { sessionId: 'sess-1', browserControlEnabled },
    sending: true,
    queuedTurn: { text: 'next', autoSend: true, sessionId: 'sess-1' },
    activeRunId: runId,
    activeRunControl: null,
    runControlGeneration: 1,
    sessionLoadRequestId: 1,
    activeAbortController: { abort: () => { calls.push('abort'); } },
    gatewayCapabilities: { runStop: true, runStatus: true },
    browserControlStatus: null,
    localRunIsViewed: () => true,
    usesDashboardWsChatTransport: () => false,
    encodeSessionId: encodeURIComponent,
    t: (key, params = {}) => `${key}${params.count !== undefined ? `:${params.count}` : ''}`,
    setStatus: (kind, title, detail) => statuses.push({ kind, title, detail }),
    updateComposerBusyState: () => {},
    renderRunControlRecovery: () => {},
    refreshBrowserControlStatus: async () => null,
    settleActiveRunTerminal: async () => { calls.push('settle'); return true; },
    reconcileActiveRunTerminal: async () => {
      sandbox.activeRunControl = lifecycle.markRunTerminal(sandbox.activeRunControl, 'cancelled');
    },
    readJsonResponse: async (response) => response.payload ?? {},
    apiFetch: async (path, options = {}) => {
      calls.push(`${options.method || 'GET'} ${path}`);
      if (path.startsWith('/api/sessions/')) return sessionLookup();
      return { ok: true, status: 200, payload: {} };
    },
    browserControlMessage: async (type) => {
      calls.push(type);
      if (controllerResult instanceof Error) throw controllerResult;
      return controllerResult;
    },
  };
  const context = vm.createContext(sandbox);
  const functions = ['stopCurrentTurn', 'resolveActiveRunIdFromSession', 'cancelBrowserControlAfterConfirmedStop']
    .map((name) => panel.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n\\}`))?.[0])
    .join('\n');
  vm.runInContext(functions, context);
  return { context, sandbox, calls, statuses, stop: () => vm.runInContext('stopCurrentTurn()', context) };
}

test('REST Stop before Hermes publishes a run id is unconfirmed, not "stopped", and keeps everything held', async () => {
  const h = stopHarness();
  const result = await h.stop();
  assert.equal(result, false);
  assert.equal(h.sandbox.activeRunControl.phase, lifecycle.RUN_CONTROL_PHASES.UNCONFIRMED);
  assert.equal(h.sandbox.activeRunControl.writerLease, 'held');
  assert.equal(h.sandbox.sending, true);
  assert.equal(h.sandbox.queuedTurn.text, 'next');
  assert.ok(h.calls.includes('abort'));
  assert.equal(h.calls.includes('settle'), false);
  assert.equal(h.calls.some((call) => call.startsWith('POST /v1/runs/')), false);
  const last = h.statuses.at(-1);
  assert.equal(last.kind, 'warn');
  assert.equal(last.title, 'run.stop_unconfirmed_title');
  assert.ok(h.statuses.every((entry) => !/Hermes stopped/.test(entry.title)));
});

test('REST Stop resolves the run id from the session when Hermes reports it, then stops by id', async () => {
  const h = stopHarness({ sessionLookup: async () => ({ ok: true, status: 200, payload: { active_run_id: 'run-77' } }) });
  const result = await h.stop();
  assert.equal(result, true);
  assert.equal(h.sandbox.activeRunId, 'run-77');
  assert.ok(h.calls.includes('POST /v1/runs/run-77/stop'));
  assert.ok(h.calls.includes('settle'));
});

test('a confirmed Stop cancels pending browser-control commands and reports how many', async () => {
  const h = stopHarness({
    runId: 'run-1',
    controllerResult: { ok: true, cancelled: 2, pendingCommands: 0 },
  });
  assert.equal(await h.stop(), true);
  assert.ok(h.calls.includes('HERMES_CONTROLLER_STOP'));
  assert.ok(h.calls.indexOf('HERMES_CONTROLLER_STOP') < h.calls.indexOf('settle'));
  const last = h.statuses.at(-1);
  assert.equal(last.title, 'Hermes stopped');
  assert.match(last.detail, /run\.stop_cancelled_commands:2/);
});

test('a Stop Hermes never confirmed does not touch the controller', async () => {
  const h = stopHarness();
  await h.stop();
  assert.equal(h.calls.includes('HERMES_CONTROLLER_STOP'), false);
});

test('an unreachable controller is reported honestly after a confirmed Stop', async () => {
  const h = stopHarness({ runId: 'run-1', controllerResult: new Error('no receiver') });
  assert.equal(await h.stop(), true);
  assert.match(h.statuses.at(-1).detail, /run\.stop_controller_unreachable/);
});

test('without browser control there is nothing to cancel and nothing extra is said', async () => {
  const h = stopHarness({ runId: 'run-1', browserControlEnabled: false });
  assert.equal(await h.stop(), true);
  assert.equal(h.calls.includes('HERMES_CONTROLLER_STOP'), false);
  assert.doesNotMatch(h.statuses.at(-1).detail, /run\.stop_/);
});

test('the attached-session Stop routes through the fenced interrupt', () => {
  const attached = panel.match(/async function stopCurrentTurn\(\) \{[\s\S]*?\n[ ]{2}\}\n[ ]{2}if \(!sending/)?.[0] || '';
  assert.match(attached, /interruptGatewaySession\(/);
  assert.match(attached, /attach\.userStopped = true/);
  assert.match(panel, /if \(attach\?\.userStopped\) void cancelBrowserControlAfterConfirmedStop\(\)/);
});
