// Stop is scoped to the run the person chose: the execution generation the panel saw when that run
// started travels with session.interrupt, and a refusal as stale means that run already ended. It is
// never re-fenced onto whatever run is current.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { interruptGatewaySession, executionGenerationFrom, WS_METHODS } from '../extension/lib/gateway-ws.mjs';
import {
  RUN_CONTROL_PHASES, acknowledgeStopRequest, beginRunControl, markRunTerminal, markStopRequestFailed, requestRunStop, withRunGeneration,
} from '../extension/lib/run-control-lifecycle.mjs';

const stale = (current) => Object.assign(new Error('stale_generation'), { rpcCode: 4001, data: { reason: 'stale_generation', execution_generation: current } });

// A session authority whose current run generation is `current`. It refuses an interrupt that names any
// other generation, as the installed authority does.
function authority({ current, statusServed = false } = {}) {
  const calls = [];
  const client = {
    readyPayload: { session_authority: true },
    request: async (method, params) => {
      calls.push({ method, params: { ...params } });
      if (method === 'session.status' && !statusServed) throw Object.assign(new Error('unknown method'), { rpcCode: -32601, data: { reason: 'unknown_method' } });
      if (method === 'session.resume') return { execution_generation: current };
      if (method === 'session.interrupt') {
        if (params.execution_generation !== undefined && params.execution_generation !== current) throw stale(current);
        return { status: 'interrupted', execution_generation: current };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { client, calls, interrupts: () => calls.filter((call) => call.method === 'session.interrupt') };
}

test('a Stop for run N after run N+1 started sends N and is not retried onto N+1', async () => {
  const gw = authority({ current: 4 });
  const outcome = await interruptGatewaySession({ client: gw.client, sessionId: 'S', storedSessionId: 'S', expectedGeneration: 3 });
  assert.deepEqual(gw.interrupts().map((call) => call.params.execution_generation), [3], 'one interrupt, for the run that was chosen');
  assert.equal(outcome.ended, true, 'the chosen run already ended');
  assert.equal(outcome.retried, false);
  assert.equal(outcome.generation, 3);
  assert.equal(gw.calls.some((call) => call.method === 'session.resume' || call.method === 'session.status'), false, 'no read of the current generation');
});

test('a Stop for the run that is still current is delivered once with its generation', async () => {
  const gw = authority({ current: 4 });
  const outcome = await interruptGatewaySession({ client: gw.client, sessionId: 'S', expectedGeneration: 4 });
  assert.deepEqual(gw.interrupts().map((call) => call.params.execution_generation), [4]);
  assert.equal(outcome.ended, false);
  assert.equal(outcome.bestEffort, false);
});

test('a generation of 0 is a generation, not "unknown"', async () => {
  const gw = authority({ current: 0 });
  await interruptGatewaySession({ client: gw.client, sessionId: 'S', expectedGeneration: 0 });
  assert.deepEqual(gw.interrupts().map((call) => call.params.execution_generation), [0]);
});

test('without a known generation Stop reads the current one and is labelled best-effort (unchanged behavior)', async () => {
  const gw = authority({ current: 4 });
  const outcome = await interruptGatewaySession({ client: gw.client, sessionId: 'S', storedSessionId: 'S' });
  assert.deepEqual(gw.interrupts().map((call) => call.params.execution_generation), [4]);
  assert.equal(outcome.bestEffort, true);
  assert.equal(outcome.ended, undefined);
});

test('other refusals with a known generation still reach the caller', async () => {
  const client = { readyPayload: { session_authority: true }, request: async () => { throw Object.assign(new Error('permission_denied'), { data: { reason: 'permission_denied' } }); } };
  await assert.rejects(interruptGatewaySession({ client, sessionId: 'S', expectedGeneration: 2 }), /permission_denied/);
});

test('run control records the generation once and keeps it through Stop', () => {
  let state = beginRunControl({ transport: 'dashboard-ws' });
  assert.equal(state.executionGeneration, null);
  state = withRunGeneration(state, 3);
  assert.equal(state.executionGeneration, 3);
  assert.equal(withRunGeneration(state, 'x').executionGeneration, 3, 'not an integer: ignored');
  assert.equal(withRunGeneration(state, null).executionGeneration, 3);
  assert.equal(withRunGeneration(state, 9).executionGeneration, 3, 'the run keeps the generation it started with');
  assert.equal(requestRunStop(state).executionGeneration, 3);
  assert.equal(withRunGeneration(null, 3), null);
  assert.equal(executionGenerationFrom({ execution_generation: 5, status: 'started' }), 5);
});

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const stopSource = source.slice(source.indexOf('async function stopCurrentTurn()'), source.indexOf('// Newer Hermes builds report the in-flight run'));

// stopCurrentTurn for this panel's own dashboard run, on an authority whose current generation is `current`.
function localStopHarness({ runGeneration, current }) {
  const gw = authority({ current });
  const statuses = [];
  const context = vm.createContext({
    liveAttach: null, liveSessionRows: new Map(), liveSessionRosterScope: '', liveSessionScopeKey: () => '', activeDashboardWsConnection: null,
    rosterStopTarget: () => null,
    settings: { sessionId: 'S' }, sending: true, localRunIsViewed: () => true, usesDashboardWsChatTransport: () => true,
    activeRunControl: withRunGeneration(beginRunControl({ transport: 'dashboard-ws' }), runGeneration),
    activeRunId: '', sessionLoadRequestId: 1, runControlGeneration: 1, runControlGenerationMatches: (a, b) => a === b,
    ensureActiveDashboardWsConnection: async () => ({ client: gw.client, wsStoredSessionId: 'S', wsSessionId: 'S' }),
    ensureRemoteWsSession: async () => 'S',
    interruptGatewaySession,
    runControlRequestWithTimeout: (operation) => operation(), RUN_CONTROL_REQUEST_TIMEOUT_MS: 1000,
    requestRunStop, acknowledgeStopRequest, markStopRequestFailed, markRunTerminal, RUN_CONTROL_PHASES,
    reconcileActiveRunTerminal: async () => { throw new Error('must not wait on a newer run'); },
    cancelBrowserControlAfterConfirmedStop: async () => '',
    settleActiveRunTerminal: async () => true,
    setStatus: (kind, title, detail) => statuses.push({ kind, title, detail }),
    updateComposerBusyState: () => {}, renderQueueNotice: () => {}, queuedTurn: null,
    t: (key) => key,
  });
  vm.runInContext(stopSource, context);
  return { gw, statuses, context, stop: () => vm.runInContext('stopCurrentTurn()', context) };
}

test('the panel Stop for run N sends N, and when N already ended it does not stop or wait on N+1', async () => {
  const h = localStopHarness({ runGeneration: 3, current: 4 });
  assert.equal(await h.stop(), true);
  assert.deepEqual(h.gw.interrupts().map((call) => call.params.execution_generation), [3]);
  assert.equal(h.context.activeRunControl.phase, 'terminal', 'run N is over; the writer is released');
  assert.match(h.statuses.at(-1).title, /Hermes stopped/);
});

test('the panel Stop for the current run is delivered with that run\'s generation, then confirmed as before', async () => {
  const h = localStopHarness({ runGeneration: 4, current: 4 });
  h.context.reconcileActiveRunTerminal = async () => { h.context.activeRunControl = markRunTerminal(h.context.activeRunControl, 'cancelled'); return { status: 'cancelled' }; };
  assert.equal(await h.stop(), true);
  assert.deepEqual(h.gw.interrupts().map((call) => call.params.execution_generation), [4]);
});

test('the run start records the generation the gateway admitted it under', () => {
  assert.match(source, /onSubmitResponse: \(response\) => \{[\s\S]{0,400}executionGenerationFrom\(response\)[\s\S]{0,200}withRunGeneration\(activeRunControl, generation\)/);
});

test('an unused WS method name stays defined for the interrupt', () => {
  assert.equal(WS_METHODS.sessionInterrupt, 'session.interrupt');
});
