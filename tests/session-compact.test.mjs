import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPACT_REQUEST_TIMEOUT_MS,
  buildCompactMutateParams,
  compactSessionCanonical,
  describeCompactOutcome,
  reconcileCompaction,
} from '../extension/lib/session-compact.mjs';
import { SESSION_MUTATE_METHOD } from '../extension/lib/session-mutate.mjs';

// Shapes follow gateway/session_mutations.py + session_mutation_compress.py +
// hermes_state_mutation_compress.py (receipt: target_session_id,
// previous_target_session_id, execution_generation, message_count, summary),
// tui_gateway/contracts/canonical.py and the CanonicalSnapshot read-back.
const READY = { replay_epoch: 'ep1', change_events: true, heartbeat: true, session_authority: true };
const SESSION = 'S1';
const MUTATE_KEYS = ['expected_generation', 'expected_revision', 'operation', 'payload', 'request_id', 'session_id'];

function rpcError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  error.rpcCode = code;
  if (data !== undefined) error.data = data;
  return error;
}

function fakeGateway({ revision = 7, generation = 2, messages = 40, executionState = 'idle', rotate = false, noop = false } = {}) {
  const state = { revision, generation, messages, executionState, rotate, noop, receipts: new Map(), calls: [], connected: true, physical: SESSION };
  const hooks = { dropAnswer: 0, dropBeforeApply: 0, timeoutBeforeApply: 0, failResumeAfterMutate: false, refuse: null, conflictOnce: false, summary: null, receiptOverride: null };
  function snapshot() {
    return {
      session_id: SESSION,
      stored_session_id: SESSION,
      messages: [],
      message_count: state.messages,
      running: state.executionState === 'running',
      authority_epoch: 3,
      replay_epoch: 'ep1',
      last_sequence: 41,
      subscription_id: 'sub1',
      revision: state.revision,
      execution_generation: state.generation,
      execution_state: state.executionState,
      pending: [],
      prompts: [],
      info: { desktop_protocol: 'hermes-gateway-v1', cwd: '/home/ana', profile_name: 'work', title: 'Fix login' },
    };
  }
  function commit() {
    const previous = state.physical;
    if (state.rotate) state.physical = `${SESSION}-c${state.generation + 1}`;
    state.revision += 1;
    state.generation += 1;
    const before = state.messages;
    state.messages = 9;
    return {
      session_id: SESSION,
      operation: 'compress',
      revision: state.revision,
      target_session_id: state.physical,
      previous_target_session_id: previous,
      execution_generation: state.generation,
      message_count: state.messages,
      summary: hooks.summary || { noop: false, aborted: false, headline: `Compressed: ${before} → ${state.messages} messages`, token_line: 'Rough transcript estimate: ~31,000 → ~4,200 tokens' },
    };
  }
  const request = async (method, params, options) => {
    state.calls.push({ method, params: structuredClone(params), options });
    if (!state.connected) throw new Error('WebSocket is not open');
    if (method === 'session.resume') {
      if (hooks.failResumeAfterMutate && state.calls.some((call) => call.method === 'session.mutate')) {
        throw new Error('Gateway RPC session.resume timed out');
      }
      return snapshot();
    }
    if (method !== 'session.mutate') throw rpcError(-32601, 'method not found', { reason: 'unknown_method' });
    assert.deepEqual(Object.keys(params).sort(), MUTATE_KEYS, 'session.mutate takes exactly these fields');
    assert.equal(params.operation, 'compress');
    assert.ok(Number.isInteger(params.expected_generation), 'compress requires expected_generation');
    const replay = state.receipts.get(params.request_id);
    if (replay) return replay;
    if (hooks.refuse) throw rpcError(4000, 'refused', { reason: hooks.refuse.reason, ...(hooks.refuse.field ? { field: hooks.refuse.field } : {}) });
    if (hooks.timeoutBeforeApply > 0) {
      hooks.timeoutBeforeApply -= 1;
      throw new Error('Gateway RPC session.mutate timed out');
    }
    if (hooks.dropBeforeApply > 0) {
      hooks.dropBeforeApply -= 1;
      state.connected = false;
      throw new Error('WebSocket closed before the answer');
    }
    if (hooks.conflictOnce) {
      hooks.conflictOnce = false;
      state.revision += 1;
      throw rpcError(4000, 'revision conflict', { reason: 'revision_conflict', revision: state.revision, execution_generation: state.generation });
    }
    if (params.expected_revision !== state.revision) throw rpcError(4000, 'revision conflict', { reason: 'revision_conflict', revision: state.revision });
    if (params.expected_generation !== state.generation) throw rpcError(4000, 'stale generation', { reason: 'stale_generation', execution_generation: state.generation });
    if (state.executionState === 'running') throw rpcError(4000, 'busy', { reason: 'session_busy' });
    if (state.noop) {
      return { session_id: SESSION, operation: 'compress', status: 'noop', summary: { noop: true, aborted: false, headline: 'No changes from compression: 6 messages', token_line: '' } };
    }
    const receipt = hooks.receiptOverride ? hooks.receiptOverride(commit()) : commit();
    state.receipts.set(params.request_id, receipt);
    if (hooks.dropAnswer > 0) {
      hooks.dropAnswer -= 1;
      throw new Error('Gateway RPC session.mutate timed out');
    }
    return receipt;
  };
  return { state, hooks, request, mutates: () => state.calls.filter((call) => call.method === 'session.mutate') };
}

function compact(gateway, over = {}) {
  return compactSessionCanonical({
    request: gateway.request,
    dashboardWs: true,
    getReadyPayload: () => READY,
    sessionId: SESSION,
    ...over,
  });
}

test('the request is exactly what session.mutate takes for compress, with both fences', () => {
  assert.deepEqual(buildCompactMutateParams({ sessionId: SESSION, requestId: 'r1', expectedRevision: 7, expectedGeneration: 2 }), {
    session_id: SESSION,
    request_id: 'r1',
    expected_revision: 7,
    operation: 'compress',
    payload: {},
    expected_generation: 2,
  });
  assert.deepEqual(buildCompactMutateParams({ sessionId: SESSION, requestId: 'r1', expectedRevision: 7, expectedGeneration: 2, focus: ' the login bug ' }).payload, { focus: 'the login bug' });
  assert.throws(() => buildCompactMutateParams({ sessionId: SESSION, requestId: 'r1', expectedRevision: 7 }), /expected_generation/);
  assert.throws(() => buildCompactMutateParams({ sessionId: SESSION, requestId: 'r1', expectedGeneration: 2 }), /expected_revision/);
  assert.throws(() => buildCompactMutateParams({ requestId: 'r1', expectedRevision: 7, expectedGeneration: 2 }), /session id/);
});

test('a compaction reads the session, writes with its fences, and reports success only after reading it back', async () => {
  const gateway = fakeGateway();
  const result = await compact(gateway);
  assert.equal(result.status, 'compacted');
  assert.equal(result.sessionId, SESSION);
  assert.equal(result.rotated, false);
  assert.equal(result.targetSessionId, SESSION);
  assert.equal(result.revision, 8);
  assert.equal(result.generation, 3);
  assert.equal(result.messageCountBefore, 40);
  assert.equal(result.messageCountAfter, 9);
  assert.match(result.summary.headline, /Compressed: 40 → 9 messages/);
  const sequence = gateway.state.calls.map((call) => call.method);
  assert.deepEqual(sequence, ['session.resume', 'session.mutate', 'session.resume'], 'read, write, read back');
  const [mutate] = gateway.mutates();
  assert.equal(mutate.params.expected_revision, 7);
  assert.equal(mutate.params.expected_generation, 2);
  assert.equal(mutate.options.timeoutMs, COMPACT_REQUEST_TIMEOUT_MS, 'the summary gets a deadline longer than the default 30 s');
  assert.ok(!gateway.state.calls.some((call) => call.method === 'session.compress'), 'the legacy verb is never sent');
});

test('a rotating compaction keeps the durable session id and says the physical target moved', async () => {
  const gateway = fakeGateway({ rotate: true });
  const result = await compact(gateway);
  assert.equal(result.status, 'compacted');
  assert.equal(result.sessionId, SESSION, 'the key the client holds survives compression');
  assert.equal(result.rotated, true);
  assert.equal(result.previousTargetSessionId, SESSION);
  assert.notEqual(result.targetSessionId, SESSION);
  assert.equal(gateway.mutates()[0].params.session_id, SESSION, 'the request still names the durable id');
});

test('a compaction that removes nothing is a report, not a write', async () => {
  const gateway = fakeGateway({ noop: true });
  const result = await compact(gateway);
  assert.equal(result.status, 'noop');
  assert.match(result.summary.headline, /No changes from compression/);
  assert.equal(gateway.state.calls.filter((call) => call.method === 'session.resume').length, 1, 'no read-back for a write that did not happen');
  assert.equal(gateway.state.revision, 7);
});

test('a running turn is refused before anything is sent', async () => {
  const gateway = fakeGateway({ executionState: 'running' });
  const result = await compact(gateway);
  assert.equal(result.status, 'busy');
  assert.equal(result.reason, 'turn-running');
  assert.equal(gateway.mutates().length, 0);
  assert.match(describeCompactOutcome(result), /Nothing was sent/);
});

test('the gateway saying session_busy during compression is told apart from a busy turn', async () => {
  const gateway = fakeGateway();
  gateway.hooks.refuse = { reason: 'session_busy', field: 'compression' };
  const result = await compact(gateway);
  assert.equal(result.status, 'busy');
  assert.equal(result.compressing, true);
  assert.match(describeCompactOutcome(result), /already compacting/);
});

test('refusals that no retry fixes come back blocked with the gateway reason', async () => {
  for (const reason of ['compression_checkpoint_required', 'runtime_coordination_required', 'unsupported_compress_options']) {
    const gateway = fakeGateway();
    gateway.hooks.refuse = { reason };
    const result = await compact(gateway);
    assert.equal(result.status, 'blocked', reason);
    assert.equal(result.reason, reason);
    assert.equal(gateway.mutates().length, 1, 'no retry');
  }
  const denied = fakeGateway();
  denied.hooks.refuse = { reason: 'permission_denied' };
  assert.equal((await compact(denied)).status, 'denied');
});

test('REST-only, missing authority, not-ready and an observed -32601 each give their exact reason and send nothing', async () => {
  const gateway = fakeGateway();
  const rest = await compact(gateway, { dashboardWs: false });
  assert.equal(rest.status, 'unavailable');
  assert.equal(rest.reason, 'rest-only');
  const noAuthority = await compact(gateway, { getReadyPayload: () => ({ heartbeat: true }) });
  assert.equal(noAuthority.reason, 'no-session-authority');
  const notReady = await compact(gateway, { getReadyPayload: () => null });
  assert.equal(notReady.reason, 'not-connected');
  assert.equal(gateway.state.calls.length, 0, 'nothing was read or sent');

  const unsupportedMethods = new Set();
  const missing = fakeGateway();
  const original = missing.request;
  missing.request = async (method, params, options) => {
    if (method === 'session.mutate') throw rpcError(-32601, 'method not found', { reason: 'unknown_method' });
    return original(method, params, options);
  };
  const result = await compact(missing, { unsupportedMethods });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'method-not-found');
  assert.ok(unsupportedMethods.has('session.mutate'), 'the miss is remembered for this connection');
  const again = await compact(missing, { unsupportedMethods });
  assert.equal(again.reason, 'method-not-found');
  assert.equal(missing.state.calls.filter((call) => call.method === 'session.mutate').length, 0, 'asked once, then known');
});

test('a fence refusal re-reads and retries once with a new request id, then reports stale', async () => {
  const gateway = fakeGateway();
  gateway.hooks.conflictOnce = true;
  let ids = 0;
  const result = await compact(gateway, { newRequestId: () => `req-${++ids}` });
  assert.equal(result.status, 'compacted');
  const mutates = gateway.mutates();
  assert.equal(mutates.length, 2);
  assert.notEqual(mutates[0].params.request_id, mutates[1].params.request_id);
  assert.equal(mutates[1].params.expected_revision, 8, 'the retry carries the fresh fences');

  const stubborn = fakeGateway();
  const base = stubborn.request;
  stubborn.request = async (method, params, options) => {
    if (method === 'session.mutate') throw rpcError(4000, 'stale', { reason: 'stale_generation' });
    return base(method, params, options);
  };
  assert.equal((await compact(stubborn)).status, 'stale');
});

test('a lost answer with the session untouched is not_committed, and resuming resends the identical request', async () => {
  const gateway = fakeGateway();
  gateway.hooks.timeoutBeforeApply = 1;
  const first = await compact(gateway);
  assert.equal(first.status, 'not_committed');
  assert.equal(first.pending.expectedRevision, 7);
  assert.equal(gateway.mutates().length, 1);

  const second = await compact(gateway, { pending: first.pending });
  assert.equal(second.status, 'compacted');
  const [a, b] = gateway.mutates();
  assert.equal(b.params.request_id, a.params.request_id, 'same id');
  assert.equal(b.params.expected_revision, a.params.expected_revision, 'same fences');
});

test('a lost answer after the write landed is indeterminate and is never sent again', async () => {
  const gateway = fakeGateway();
  gateway.hooks.dropAnswer = 1;
  const result = await compact(gateway);
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.reason, 'session-moved');
  assert.equal(gateway.mutates().length, 1, 'no blind resend');
  assert.equal(gateway.state.revision, 8, 'it did commit exactly once');
  const resumed = await compact(gateway, { pending: result.pending });
  assert.equal(resumed.status, 'indeterminate');
  assert.equal(gateway.mutates().length, 1, 'still not resent');
});

test('a lost answer while the socket is down reports unreadable without guessing', async () => {
  const gateway = fakeGateway();
  gateway.hooks.dropBeforeApply = 1;
  const original = gateway.request;
  gateway.request = async (method, params, options) => {
    if (method === 'session.resume' && gateway.state.calls.some((call) => call.method === 'session.mutate')) throw new Error('WebSocket is not open');
    return original(method, params, options);
  };
  const result = await compact(gateway);
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.reason, 'disconnected');
});

test('if the first read fails nothing is sent', async () => {
  const gateway = fakeGateway();
  gateway.state.connected = false;
  const result = await compact(gateway);
  assert.equal(result.status, 'not_sent');
  assert.equal(gateway.mutates().length, 0);
});

test('an accepted receipt that the read-back cannot confirm is unconfirmed, not success', async () => {
  const failing = fakeGateway();
  failing.hooks.failResumeAfterMutate = true;
  const result = await compact(failing);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.committed, true);
  assert.equal(result.reason, 'readback-failed');

  const mismatched = fakeGateway();
  mismatched.hooks.receiptOverride = (receipt) => ({ ...receipt, revision: receipt.revision + 5, execution_generation: receipt.execution_generation + 5 });
  const mismatch = await compact(mismatched);
  assert.equal(mismatch.status, 'unconfirmed');
  assert.equal(mismatch.reason, 'readback-mismatch');
});

test('a receipt with disconnected readback is reconciled without a second compression', async () => {
  const gateway = fakeGateway();
  gateway.hooks.failResumeAfterMutate = true;
  const first = await compact(gateway);
  assert.equal(first.status, 'unconfirmed');
  assert.ok(first.pending?.receipt);
  gateway.hooks.failResumeAfterMutate = false;
  const second = await compact(gateway, { pending: first.pending });
  assert.equal(second.status, 'compacted');
  assert.equal(gateway.mutates().length, 1);
  assert.equal(second.requestId, first.requestId);
});

test('a summary the gateway aborted is not reported as compacted', async () => {
  const gateway = fakeGateway();
  gateway.hooks.summary = { noop: false, aborted: true, headline: 'Summary failed', token_line: '' };
  const result = await compact(gateway);
  assert.equal(result.status, 'aborted');
  assert.match(describeCompactOutcome(result), /nothing was replaced/);
});

test('a malformed receipt is indeterminate with the pending request kept', async () => {
  const gateway = fakeGateway();
  gateway.hooks.receiptOverride = () => ({ ok: true });
  const result = await compact(gateway);
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.reason, 'receipt-malformed');
  assert.ok(result.pending.requestId);
});

test('reconcileCompaction reads and never writes', async () => {
  const gateway = fakeGateway();
  const pending = { sessionId: SESSION, requestId: 'r', expectedRevision: 7, expectedGeneration: 2, focus: '' };
  assert.equal((await reconcileCompaction({ request: gateway.request, pending })).outcome, 'not_committed');
  gateway.state.revision = 8;
  gateway.state.generation = 3;
  assert.equal((await reconcileCompaction({ request: gateway.request, pending })).outcome, 'moved');
  assert.equal(gateway.mutates().length, 0);
});

test('every outcome has an English sentence the panel can fall back to', () => {
  for (const status of ['compacted', 'noop', 'busy', 'blocked', 'stale', 'denied', 'unavailable', 'not_sent', 'indeterminate', 'not_committed', 'unconfirmed', 'aborted', 'failed']) {
    assert.ok(describeCompactOutcome({ status, reason: 'x', summary: {} }).length > 10, status);
  }
  assert.equal(SESSION_MUTATE_METHOD, 'session.mutate');
});
