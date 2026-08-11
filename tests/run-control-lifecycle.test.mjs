import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUN_CONTROL_PHASES,
  RUN_TERMINAL_STATUSES,
  acknowledgeStopRequest,
  beginRunControl,
  canFlushQueuedTurn,
  canSwitchActiveSession,
  dashboardTerminalStatus,
  markRunStreamClosed,
  markRunTerminal,
  markTerminalTimeout,
  requestRunStop,
  restTerminalStatus,
  runControlGenerationMatches,
  runStopFailureTerminalStatus,
  waitForTerminalStatus,
} from '../extension/lib/run-control-lifecycle.mjs';

test('accepted Stop remains stopping with the writer lease held', () => {
  const running = beginRunControl({ runId: 'run-1', transport: 'rest' });
  const stopping = acknowledgeStopRequest(requestRunStop(running), { status: 'stopping' });
  assert.equal(stopping.phase, RUN_CONTROL_PHASES.STOPPING);
  assert.equal(stopping.controlStatus, 'accepted');
  assert.equal(stopping.writerLease, 'held');
  assert.equal(canFlushQueuedTurn({ text: 'next', kind: 'queued' }, stopping), false);
});

test('stream closure cannot manufacture terminal cancellation after Stop', () => {
  const stopping = acknowledgeStopRequest(requestRunStop(beginRunControl({ runId: 'run-1', transport: 'rest' })));
  const closed = markRunStreamClosed(stopping);
  assert.equal(closed.streamOpen, false);
  assert.equal(closed.phase, RUN_CONTROL_PHASES.STOPPING);
  assert.equal(closed.writerLease, 'held');
  assert.equal(closed.terminalStatus, '');
});

test('terminal runtime status releases the writer lease and permits only real queued turns', () => {
  const stopping = acknowledgeStopRequest(requestRunStop(beginRunControl({ runId: 'run-1', transport: 'rest' })));
  const terminal = markRunTerminal(stopping, RUN_TERMINAL_STATUSES.CANCELLED);
  assert.equal(terminal.phase, RUN_CONTROL_PHASES.TERMINAL);
  assert.equal(terminal.writerLease, 'released');
  assert.equal(canFlushQueuedTurn({ text: 'next', kind: 'queued', autoSend: true }, terminal), true);
  assert.equal(canFlushQueuedTurn({ text: 'guidance', kind: 'steer-fallback', autoSend: false }, terminal), false);
  assert.equal(canFlushQueuedTurn(null, terminal), false);
});

test('terminal timeout stays unconfirmed and never releases the writer lease', () => {
  const stopping = acknowledgeStopRequest(requestRunStop(beginRunControl({ runId: 'run-1', transport: 'rest' })));
  const timedOut = markTerminalTimeout(stopping, 'terminal confirmation timed out');
  assert.equal(timedOut.phase, RUN_CONTROL_PHASES.UNCONFIRMED);
  assert.equal(timedOut.writerLease, 'held');
  assert.equal(canFlushQueuedTurn({ text: 'next', kind: 'queued' }, timedOut), false);
});

test('REST terminal status accepts only documented terminal states', () => {
  assert.equal(restTerminalStatus({ status: 'stopping' }), '');
  assert.equal(restTerminalStatus({ status: 'running' }), '');
  assert.equal(restTerminalStatus({ status: 'cancelled' }), RUN_TERMINAL_STATUSES.CANCELLED);
  assert.equal(restTerminalStatus({ data: { status: 'completed' } }), RUN_TERMINAL_STATUSES.COMPLETED);
  assert.equal(restTerminalStatus({ run: { status: 'failed' } }), RUN_TERMINAL_STATUSES.FAILED);
});

test('stale Stop failures resolve as terminal cancellation and generation matching is exact', () => {
  assert.equal(runStopFailureTerminalStatus({ httpStatus: 404, payload: { error: { code: 'run_not_found' } } }), RUN_TERMINAL_STATUSES.CANCELLED);
  assert.equal(runStopFailureTerminalStatus({ httpStatus: 409, payload: { code: 'run_not_running' } }), RUN_TERMINAL_STATUSES.CANCELLED);
  assert.equal(runStopFailureTerminalStatus({ httpStatus: 500, payload: { code: 'run_not_found' } }), '');
  assert.equal(runControlGenerationMatches(4, 4), true);
  assert.equal(runControlGenerationMatches(4, 5), false);
});

test('Dashboard terminal status reconciles session.status without treating unknown payloads as idle', () => {
  assert.equal(dashboardTerminalStatus({ status: 'running' }), '');
  assert.equal(dashboardTerminalStatus({ busy: true }), '');
  assert.equal(dashboardTerminalStatus({ status: 'idle' }, { stopRequested: true }), RUN_TERMINAL_STATUSES.CANCELLED);
  assert.equal(dashboardTerminalStatus({ running: false }, { stopRequested: true }), RUN_TERMINAL_STATUSES.CANCELLED);
  assert.equal(dashboardTerminalStatus({}), '');
});

test('terminal polling uses a distinct deadline and returns only a terminal runtime status', async () => {
  const rows = [{ status: 'stopping' }, { status: 'running' }, { status: 'cancelled' }];
  let clock = 0;
  const result = await waitForTerminalStatus({
    readStatus: async () => rows.shift(),
    terminalStatus: restTerminalStatus,
    timeoutMs: 100,
    pollMs: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(result.status, RUN_TERMINAL_STATUSES.CANCELLED);
  assert.equal(result.attempts, 3);
});

test('terminal polling times out rather than treating transport closure as completion', async () => {
  let clock = 0;
  await assert.rejects(() => waitForTerminalStatus({
    readStatus: async () => ({ status: 'stopping' }),
    terminalStatus: restTerminalStatus,
    timeoutMs: 20,
    pollMs: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  }), /terminal confirmation timed out/i);
});

test('session switching is denied while the current run owns the writer', () => {
  const running = beginRunControl({ runId: 'run-1', transport: 'rest' });
  const stopping = acknowledgeStopRequest(requestRunStop(running), { status: 'stopping' });
  const unconfirmed = markTerminalTimeout(stopping, 'still running');
  const terminal = markRunTerminal(stopping, RUN_TERMINAL_STATUSES.CANCELLED);

  assert.equal(canSwitchActiveSession({ sending: true, runControl: running }), false);
  assert.equal(canSwitchActiveSession({ sending: false, runControl: stopping }), false);
  assert.equal(canSwitchActiveSession({ sending: false, runControl: unconfirmed }), false);
  assert.equal(canSwitchActiveSession({ sending: false, runControl: terminal }), true);
  assert.equal(canSwitchActiveSession({ sending: false, runControl: null }), true);
});
