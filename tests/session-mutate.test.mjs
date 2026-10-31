import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_WORKSPACE_MOVE_METHOD,
  SESSION_MUTATE_METHOD,
  buildWorkspaceMutateParams,
  createMutationRequestId,
  moveSessionToWorkspace,
  normalizeCanonicalSession,
  reconcileWorkspaceMove,
} from '../extension/lib/session-mutate.mjs';

// Shapes below follow tui_gateway/contracts/canonical_sessions.py
// (CanonicalSnapshot, validated against the installed pydantic model),
// canonical.py (SessionMutateParams / SessionMutateResult) and the refusal
// frames gateway/session_controls.py builds (error.data.reason, plus the fresh
// revision / execution_generation on a revision_conflict or stale_generation).
const READY = { replay_epoch: 'ep1', change_events: true, heartbeat: true, session_authority: true };
const SESSION = 'S1';
const SCRATCH = '/home/ana/scratch';
const ATLAS = '/home/ana/code/atlas';

function rpcError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  error.rpcCode = code;
  if (data !== undefined) error.data = data;
  return error;
}

const MUTATE_KEYS = ['expected_generation', 'expected_revision', 'operation', 'payload', 'request_id', 'session_id'];

// A gateway that enforces what the real one does for `workspace`: the exact
// param keys, both fences, a receipt per request_id that is replayed on an exact
// retry, `session_busy` mid-turn and `invalid_params` for a folder that is not a
// directory. Failure hooks model a lost answer and a dropped socket.
function fakeGateway({ cwd = SCRATCH, revision = 7, generation = 2, executionState = 'idle', dirs = [ATLAS, SCRATCH, '/home/ana/code/beta'] } = {}) {
  const state = { cwd, revision, generation, executionState, dirs: new Set(dirs), receipts: new Map(), calls: [], connected: true };
  const hooks = {
    beforeMutate: null,
    dropAnswer: 0,
    dropBeforeApply: 0,
    failResumeAfterMutate: false,
    receiptOverride: null,
  };
  function snapshot() {
    return {
      session_id: SESSION,
      stored_session_id: SESSION,
      messages: [],
      message_count: 6,
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
      info: { desktop_protocol: 'hermes-gateway-v1', cwd: state.cwd, profile_name: 'work', title: 'Fix login' },
    };
  }
  const request = async (method, params) => {
    state.calls.push({ method, params: structuredClone(params) });
    if (!state.connected) throw new Error('WebSocket is not open');
    if (method === 'session.resume') {
      if (hooks.failResumeAfterMutate && state.calls.some((call) => call.method === 'session.mutate')) {
        throw new Error('Gateway RPC session.resume timed out');
      }
      return snapshot();
    }
    if (method !== 'session.mutate') throw rpcError(-32601, 'method not found', { reason: 'unknown_method' });
    if (hooks.beforeMutate) hooks.beforeMutate(state);
    assert.deepEqual(Object.keys(params).sort(), MUTATE_KEYS, 'session.mutate takes exactly these fields');
    const replay = state.receipts.get(params.request_id);
    if (replay) return replay;
    if (hooks.dropBeforeApply > 0) {
      hooks.dropBeforeApply -= 1;
      state.connected = false;
      throw new Error('WebSocket is not open');
    }
    if (params.expected_revision !== state.revision) {
      throw rpcError(4090, 'revision_conflict', { reason: 'revision_conflict', revision: state.revision, execution_generation: state.generation });
    }
    if (params.expected_generation !== state.generation) {
      throw rpcError(4090, 'stale_generation', { reason: 'stale_generation', revision: state.revision, execution_generation: state.generation });
    }
    if (state.executionState === 'running' || state.executionState === 'waiting') {
      throw rpcError(4090, 'session_busy', { reason: 'session_busy' });
    }
    // prepare_workspace normalizes the path (abspath) and refuses a non-directory.
    const folder = params.payload.cwd.replace(/\/+$/, '') || '/';
    if (!state.dirs.has(folder)) {
      throw rpcError(4001, 'invalid_params', { reason: 'invalid_params' });
    }
    state.revision += 1;
    state.cwd = folder;
    const receipt = hooks.receiptOverride
      ? hooks.receiptOverride(state, params)
      : { session_id: SESSION, operation: 'workspace', revision: state.revision, execution_generation: state.generation };
    state.receipts.set(params.request_id, receipt);
    if (hooks.dropAnswer > 0) {
      hooks.dropAnswer -= 1;
      state.connected = false;
      throw new Error('WebSocket is not open');
    }
    return receipt;
  };
  return { state, hooks, request };
}

function move(gateway, overrides = {}) {
  let counter = 0;
  return moveSessionToWorkspace({
    request: gateway.request,
    dashboardWs: true,
    getReadyPayload: () => READY,
    sessionId: SESSION,
    cwd: ATLAS,
    newRequestId: () => `req-${(counter += 1)}-${overrides.idSeed || 'a'}`,
    ...overrides,
  });
}

const methodsOf = (gateway) => gateway.state.calls.map((call) => call.method);
const mutateCalls = (gateway) => gateway.state.calls.filter((call) => call.method === SESSION_MUTATE_METHOD);

// ---- Happy path -----------------------------------------------------------

test('a move reads fences, sends the exact contract params and reports success only after read-back', async () => {
  const gateway = fakeGateway();
  const result = await move(gateway);

  assert.deepEqual(methodsOf(gateway), ['session.resume', 'session.mutate', 'session.resume']);
  assert.deepEqual(gateway.state.calls[0].params, { session_id: SESSION, omit_messages: true });
  assert.deepEqual(gateway.state.calls[1].params, {
    session_id: SESSION,
    request_id: 'req-1-a',
    expected_revision: 7,
    operation: 'workspace',
    payload: { cwd: ATLAS },
    expected_generation: 2,
  });
  assert.equal(result.status, 'moved');
  assert.equal(result.cwd, ATLAS);
  assert.equal(result.previousCwd, SCRATCH);
  assert.equal(result.revision, 8);
  assert.equal(result.requestId, 'req-1-a');
  assert.equal(result.noop, false);
  assert.equal(result.receipt.operation, 'workspace');
  assert.ok(!methodsOf(gateway).includes(LEGACY_WORKSPACE_MOVE_METHOD));
});

test('every move gets a fresh request id', async () => {
  const a = fakeGateway();
  const b = fakeGateway();
  const first = await moveSessionToWorkspace({ request: a.request, dashboardWs: true, getReadyPayload: () => READY, sessionId: SESSION, cwd: ATLAS });
  const second = await moveSessionToWorkspace({ request: b.request, dashboardWs: true, getReadyPayload: () => READY, sessionId: SESSION, cwd: ATLAS });
  assert.match(first.requestId, /^hbe-workspace-/);
  assert.notEqual(first.requestId, second.requestId);
  assert.notEqual(createMutationRequestId(), createMutationRequestId());
});

test('the canonical path wins when the gateway normalized what was sent', async () => {
  const gateway = fakeGateway();
  const result = await move(gateway, { cwd: `${ATLAS}/` });
  assert.equal(result.status, 'moved');
  assert.equal(mutateCalls(gateway)[0].params.payload.cwd, `${ATLAS}/`, 'the request carries what the user gave');
  assert.equal(result.cwd, ATLAS, 'the result carries what the gateway stored');
});

test('a move to the folder the session is already in sends nothing', async () => {
  const gateway = fakeGateway({ cwd: ATLAS });
  const result = await move(gateway);
  assert.equal(result.status, 'moved');
  assert.equal(result.noop, true);
  assert.equal(mutateCalls(gateway).length, 0);
});

// ---- Capability gate and the legacy method --------------------------------

test('REST-only, non-authority and not-yet-connected sockets send nothing', async () => {
  for (const [options, reason] of [
    [{ dashboardWs: false }, 'rest-only'],
    [{ getReadyPayload: () => ({ replay_epoch: 'ep1' }) }, 'no-session-authority'],
    [{ getReadyPayload: () => null }, 'not-connected'],
  ]) {
    const gateway = fakeGateway();
    const result = await move(gateway, options);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, reason);
    assert.ok(result.message.length > 20);
    assert.equal(gateway.state.calls.length, 0, `${reason}: no request of any kind, least of all the legacy move`);
  }
});

test('session.mutate answering -32601 is unavailable, remembered, and never falls back to the legacy move', async () => {
  const gateway = fakeGateway();
  const unsupported = new Set();
  const request = async (method, params) => {
    gateway.state.calls.push({ method, params });
    if (method === 'session.resume') return gateway.request('session.resume', params);
    throw rpcError(-32601, 'method not found');
  };
  const result = await move({ request, state: gateway.state }, { unsupportedMethods: unsupported });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'method-not-found');
  assert.match(result.message, /session\.mutate/);
  assert.ok(unsupported.has('session.mutate'));
  assert.ok(!gateway.state.calls.some((call) => call.method === LEGACY_WORKSPACE_MOVE_METHOD));

  const before = gateway.state.calls.length;
  const again = await move({ request, state: gateway.state }, { unsupportedMethods: unsupported });
  assert.equal(again.reason, 'method-not-found');
  assert.equal(gateway.state.calls.length, before, 'a remembered refusal is not asked again');
});

// ---- A turn in progress ---------------------------------------------------

test('a running turn returns a typed live_turn result and sends nothing', async () => {
  for (const executionState of ['running', 'waiting']) {
    const gateway = fakeGateway({ executionState });
    const result = await move(gateway);
    assert.equal(result.status, 'live_turn');
    assert.equal(result.confirmationRequired, true);
    assert.equal(result.executionState, executionState);
    assert.equal(result.cwd, SCRATCH);
    assert.deepEqual(methodsOf(gateway), ['session.resume']);
  }
  const unknown = fakeGateway({ executionState: 'unknown' });
  assert.equal((await move(unknown)).status, 'live_turn');
});

test('a confirmed move during a turn is still decided by the gateway, which refuses', async () => {
  const gateway = fakeGateway({ executionState: 'running' });
  const result = await move(gateway, { confirmLiveTurn: true });
  assert.equal(result.status, 'busy');
  assert.equal(result.reason, 'session_busy');
  assert.equal(result.compressing, false);
  assert.equal(mutateCalls(gateway).length, 1);
  assert.equal(gateway.state.cwd, SCRATCH, 'the session did not move');
});

test('a compression lock and a lost turn are reported as busy with their own reason', async () => {
  const compressing = fakeGateway();
  compressing.hooks.beforeMutate = () => { throw rpcError(4090, 'session_busy', { reason: 'session_busy', field: 'compression' }); };
  const busy = await move(compressing);
  assert.equal(busy.status, 'busy');
  assert.equal(busy.compressing, true);

  const lost = fakeGateway();
  lost.hooks.beforeMutate = () => { throw rpcError(4090, 'unknown_execution', { reason: 'unknown_execution' }); };
  const unknownTurn = await move(lost);
  assert.equal(unknownTurn.status, 'busy');
  assert.equal(unknownTurn.reason, 'unknown_execution');
});

// ---- Stale fences ---------------------------------------------------------

test('a stale revision is re-read and sent once more under a new request id', async () => {
  const gateway = fakeGateway();
  let bumped = false;
  gateway.hooks.beforeMutate = (state) => {
    if (!bumped) { bumped = true; state.revision += 1; } // another surface touched the session
  };
  const result = await move(gateway);
  assert.equal(result.status, 'moved');
  const sent = mutateCalls(gateway);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].params.expected_revision, 7);
  assert.equal(sent[1].params.expected_revision, 8);
  assert.notEqual(sent[0].params.request_id, sent[1].params.request_id);
  assert.equal(result.revision, 9);
});

test('a revision that keeps moving ends as stale with the gateway fences, not as success', async () => {
  const gateway = fakeGateway();
  gateway.hooks.beforeMutate = (state) => { state.revision += 1; };
  const result = await move(gateway);
  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'revision_conflict');
  assert.equal(result.revision, gateway.state.revision);
  assert.equal(result.generation, 2);
  assert.equal(mutateCalls(gateway).length, 2, 'one retry, then it stops');
  assert.equal(gateway.state.cwd, SCRATCH);

  const noRetry = fakeGateway();
  noRetry.hooks.beforeMutate = (state) => { state.revision += 1; };
  const first = await move(noRetry, { maxConflictRetries: 0 });
  assert.equal(first.status, 'stale');
  assert.equal(mutateCalls(noRetry).length, 1);
});

test('a stale generation (owner restarted) is re-read and retried the same way', async () => {
  const gateway = fakeGateway();
  let bumped = false;
  gateway.hooks.beforeMutate = (state) => {
    if (!bumped) { bumped = true; state.generation += 1; }
  };
  const result = await move(gateway);
  assert.equal(result.status, 'moved');
  assert.equal(mutateCalls(gateway)[1].params.expected_generation, 3);

  const stuck = fakeGateway();
  stuck.hooks.beforeMutate = (state) => { state.generation += 1; };
  const stale = await move(stuck);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.reason, 'stale_generation');
});

// ---- Refusals -------------------------------------------------------------

test('a folder the gateway host does not have is reported as invalid, not moved', async () => {
  const gateway = fakeGateway();
  const result = await move(gateway, { cwd: '/nope/missing' });
  assert.equal(result.status, 'invalid');
  assert.match(result.message, /gateway host/);
  assert.equal(gateway.state.cwd, SCRATCH);
});

test('permission and profile refusals are typed as denied', async () => {
  for (const reason of ['permission_denied', 'profile_mismatch']) {
    const gateway = fakeGateway();
    gateway.hooks.beforeMutate = () => { throw rpcError(4030, reason, { reason }); };
    const result = await move(gateway);
    assert.equal(result.status, 'denied');
    assert.equal(result.reason, reason);
  }
  const odd = fakeGateway();
  odd.hooks.beforeMutate = () => { throw rpcError(4999, 'something else', { reason: 'brand_new_reason' }); };
  const failed = await move(odd);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'brand_new_reason');
});

test('an unreadable session before the write sends no write', async () => {
  const gateway = fakeGateway();
  gateway.state.connected = false;
  const result = await move(gateway);
  assert.equal(result.status, 'not_sent');
  assert.equal(result.reason, 'disconnected');
  assert.equal(mutateCalls(gateway).length, 0);

  const malformed = await move({ request: async () => ({ revision: 'x' }), state: { calls: [] } });
  assert.equal(malformed.status, 'not_sent');
});

// ---- Disconnect during the write -----------------------------------------

test('a lost answer for a write that landed is settled by reading, with no second write', async () => {
  const gateway = fakeGateway();
  gateway.hooks.dropAnswer = 1;
  // The receipt was committed but the socket dropped. The same socket object
  // recovers, as after an automatic reconnect inside one request function.
  const original = gateway.request;
  gateway.request = async (method, params) => {
    try {
      return await original(method, params);
    } finally {
      if (method === 'session.mutate') gateway.state.connected = true;
    }
  };
  const result = await move(gateway);
  assert.equal(result.status, 'moved');
  assert.equal(result.cwd, ATLAS);
  assert.equal(result.requestId, 'req-1-a');
  assert.equal(mutateCalls(gateway).length, 1, 'reconcile read the state; it did not resend');
});

test('a lost answer with the socket still down is indeterminate and carries what is needed to reconcile', async () => {
  const gateway = fakeGateway();
  gateway.hooks.dropAnswer = 1;
  const result = await move(gateway);
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.reason, 'disconnected');
  assert.deepEqual(result.pending, {
    sessionId: SESSION,
    requestId: 'req-1-a',
    expectedRevision: 7,
    expectedGeneration: 2,
    cwd: ATLAS,
    previousCwd: SCRATCH,
  });
  assert.equal(mutateCalls(gateway).length, 1, 'no blind resend');

  // After reconnecting, the write is found to have landed: reported moved, still one write.
  gateway.state.connected = true;
  const resumed = await move(gateway, { pending: result.pending });
  assert.equal(resumed.status, 'moved');
  assert.equal(resumed.cwd, ATLAS);
  assert.equal(resumed.requestId, 'req-1-a');
  assert.equal(mutateCalls(gateway).length, 1);
});

test('a write that never reached the gateway is resent as the identical request, once proven absent', async () => {
  const gateway = fakeGateway();
  gateway.hooks.dropBeforeApply = 1;
  const lost = await move(gateway);
  assert.equal(lost.status, 'indeterminate');
  assert.equal(gateway.state.cwd, SCRATCH);

  gateway.state.connected = true;
  const resumed = await move(gateway, { pending: lost.pending, idSeed: 'b' });
  assert.equal(resumed.status, 'moved');
  const sent = mutateCalls(gateway);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].params, sent[0].params, 'same request id, same fences, same payload');
  assert.equal(resumed.previousCwd, SCRATCH);
});

test('a timed-out write that the gateway has not committed yet reports not_committed instead of resending', async () => {
  const gateway = fakeGateway();
  const original = gateway.request;
  gateway.request = async (method, params) => {
    if (method === 'session.mutate') {
      gateway.state.calls.push({ method, params });
      throw new Error('Gateway RPC session.mutate timed out');
    }
    return original(method, params);
  };
  const result = await move(gateway);
  assert.equal(result.status, 'not_committed');
  assert.equal(result.sameRequest, true);
  assert.equal(result.pending.requestId, 'req-1-a');
  assert.equal(mutateCalls(gateway).length, 1);
});

test('when the owner restarted before the write landed, the retry takes a new id and new fences', async () => {
  const gateway = fakeGateway();
  gateway.hooks.dropBeforeApply = 1;
  const lost = await move(gateway);
  assert.equal(lost.status, 'indeterminate');

  gateway.state.connected = true;
  gateway.state.generation = 3; // the owner restarted: the old fences can never commit
  const resumed = await move(gateway, { pending: lost.pending, idSeed: 'c' });
  assert.equal(resumed.status, 'moved');
  const sent = mutateCalls(gateway);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[1].params.request_id, sent[0].params.request_id);
  assert.equal(sent[1].params.expected_generation, 3);
});

test('reconcile never writes and tells apart applied, not committed, conflict and unreadable', async () => {
  const pending = { sessionId: SESSION, requestId: 'req-x', expectedRevision: 7, expectedGeneration: 2, cwd: ATLAS, previousCwd: SCRATCH };

  const applied = fakeGateway({ cwd: ATLAS, revision: 8 });
  assert.equal((await reconcileWorkspaceMove({ request: applied.request, pending })).outcome, 'applied');

  // A changed folder is not proof that an alias expanded to that folder.
  const expanded = fakeGateway({ cwd: '/srv/atlas', revision: 8 });
  assert.equal((await reconcileWorkspaceMove({ request: expanded.request, pending: { ...pending, cwd: '~/code/atlas' } })).outcome, 'conflict');

  const absent = fakeGateway();
  const notCommitted = await reconcileWorkspaceMove({ request: absent.request, pending });
  assert.equal(notCommitted.outcome, 'not_committed');
  assert.equal(notCommitted.sameRequest, true);

  const someoneElse = fakeGateway({ cwd: '/home/ana/code/beta', revision: 9 });
  assert.equal((await reconcileWorkspaceMove({ request: someoneElse.request, pending })).outcome, 'conflict');

  const renamed = fakeGateway({ cwd: SCRATCH, revision: 8 });
  assert.equal((await reconcileWorkspaceMove({ request: renamed.request, pending })).outcome, 'conflict', 'revision moved but not onto our folder');

  const down = fakeGateway();
  down.state.connected = false;
  assert.equal((await reconcileWorkspaceMove({ request: down.request, pending })).outcome, 'unreadable');

  for (const gateway of [applied, absent, someoneElse, renamed]) assert.equal(mutateCalls(gateway).length, 0);
});

test('a resumed move that finds the session changed by someone else reports a conflict and does not write', async () => {
  const gateway = fakeGateway();
  gateway.hooks.dropBeforeApply = 1;
  const lost = await move(gateway);
  gateway.state.connected = true;
  gateway.state.revision = 9;
  gateway.state.cwd = '/home/ana/code/beta';
  const resumed = await move(gateway, { pending: lost.pending });
  assert.equal(resumed.status, 'conflict');
  assert.equal(mutateCalls(gateway).length, 1);
});

test('a pending move belonging to another session or folder is refused', async () => {
  const gateway = fakeGateway();
  const pending = { sessionId: 'other', requestId: 'req-x', expectedRevision: 7, expectedGeneration: 2, cwd: ATLAS, previousCwd: SCRATCH };
  await assert.rejects(() => move(gateway, { pending }), TypeError);
  await assert.rejects(() => move(gateway, { pending: { ...pending, sessionId: SESSION, cwd: '/elsewhere' } }), TypeError);
  assert.equal(gateway.state.calls.length, 0);
});

// ---- Receipt without proof ------------------------------------------------

test('a receipt whose read-back disagrees is unconfirmed, not success', async () => {
  const gateway = fakeGateway();
  // The receipt is issued, then another surface puts the session back before the read-back.
  const original = gateway.request;
  gateway.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'session.mutate') { gateway.state.revision = 7; gateway.state.cwd = SCRATCH; }
    return result;
  };
  const result = await move(gateway);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.committed, true);
  assert.equal(result.reason, 'readback-mismatch');
  assert.equal(result.receipt.revision, 8);
});

test('a different folder at one revision after a lost answer is a conflict', async () => {
  const gateway = fakeGateway({ cwd: '/home/ana/code/beta', revision: 8 });
  const pending = { sessionId: SESSION, requestId: 'lost', expectedRevision: 7, expectedGeneration: 2, cwd: ATLAS, previousCwd: SCRATCH };
  assert.equal((await reconcileWorkspaceMove({ request: gateway.request, pending })).outcome, 'conflict');
});

test('a later move to a third folder after a receipt is unconfirmed', async () => {
  const gateway = fakeGateway();
  const original = gateway.request;
  gateway.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'session.mutate') { gateway.state.revision += 1; gateway.state.cwd = '/home/ana/code/beta'; }
    return result;
  };
  const result = await move(gateway);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.reason, 'readback-mismatch');
});

test('a receipt whose read-back cannot be fetched is unconfirmed with the committed flag', async () => {
  const gateway = fakeGateway();
  gateway.hooks.failResumeAfterMutate = true;
  const result = await move(gateway);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.committed, true);
  assert.equal(result.reason, 'readback-failed');
  assert.equal(result.receipt.revision, 8);
  assert.equal(mutateCalls(gateway).length, 1);
});

test('an answer that is not a receipt is reconciled by reading instead of trusted', async () => {
  const gateway = fakeGateway();
  gateway.hooks.receiptOverride = () => ({ ok: true });
  const result = await move(gateway);
  assert.equal(result.status, 'moved', 'the canonical state shows the move landed');
  assert.equal(mutateCalls(gateway).length, 1);
});

// ---- Builders and validation ----------------------------------------------

test('param builder requires canonical fences and a gateway-host path', () => {
  const base = { sessionId: SESSION, requestId: 'r', expectedRevision: 1, expectedGeneration: 0, cwd: ATLAS };
  assert.deepEqual(Object.keys(buildWorkspaceMutateParams(base)).sort(), MUTATE_KEYS);
  assert.throws(() => buildWorkspaceMutateParams({ ...base, expectedRevision: undefined }), TypeError);
  assert.throws(() => buildWorkspaceMutateParams({ ...base, expectedGeneration: '2' }), TypeError);
  assert.throws(() => buildWorkspaceMutateParams({ ...base, requestId: ' ' }), TypeError);
  assert.throws(() => buildWorkspaceMutateParams({ ...base, cwd: 'relative/dir' }), TypeError);
  assert.throws(() => buildWorkspaceMutateParams({ ...base, cwd: '' }), TypeError);
  assert.throws(() => buildWorkspaceMutateParams({ ...base, cwd: '/a\0b' }), TypeError);
  for (const cwd of ['/srv/app', '~/code', '~', 'C:\\Users\\ana\\code', 'c:/code', '\\\\host\\share\\code']) {
    assert.equal(buildWorkspaceMutateParams({ ...base, cwd }).payload.cwd, cwd);
  }
});

test('invalid input throws before anything is read or sent', async () => {
  const gateway = fakeGateway();
  await assert.rejects(() => move(gateway, { cwd: 'relative' }), TypeError);
  await assert.rejects(() => move(gateway, { sessionId: '' }), TypeError);
  await assert.rejects(() => moveSessionToWorkspace({ sessionId: SESSION, cwd: ATLAS }), TypeError);
  assert.equal(gateway.state.calls.length, 0);
});

test('canonical session normalization needs both fences and flags a live turn', () => {
  const base = {
    session_id: SESSION, stored_session_id: SESSION, revision: 7, execution_generation: 2,
    execution_state: 'idle', running: false, info: { cwd: SCRATCH },
  };
  assert.equal(normalizeCanonicalSession(base).running, false);
  assert.equal(normalizeCanonicalSession({ ...base, execution_state: 'waiting' }).running, true);
  assert.equal(normalizeCanonicalSession({ ...base, running: true }).running, true);
  assert.equal(normalizeCanonicalSession({ ...base, revision: undefined }), null);
  assert.equal(normalizeCanonicalSession({ ...base, execution_generation: null }), null);
  assert.equal(normalizeCanonicalSession(null), null);
});
