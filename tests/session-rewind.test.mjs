import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  REWIND_OPERATION,
  buildRewindMutateParams,
  rewindFailureError,
  rewindSessionToMessage,
  usesAuthorityRewind,
} from '../extension/lib/session-rewind.mjs';
import { SESSION_MUTATE_METHOD, SESSION_RESUME_METHOD } from '../extension/lib/session-mutate.mjs';
import { isTruncateRejection, truncateSubmitParams } from '../extension/lib/message-rewind.mjs';
import { isDisplayTextRejection } from '../extension/lib/turn-recovery.mjs';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// Shapes follow hermes_state_mutations.py (_rewind: payload {target_message_id}, receipt
// rewound_count / target_message / new_head_id / replacement_message_id),
// gateway/session_tui_ops.py (_rewind_last_turn) and the CanonicalSnapshot read.
const READY = { session_authority: true };
const SESSION = 'S1';
const MUTATE_KEYS = ['expected_generation', 'expected_revision', 'operation', 'payload', 'request_id', 'session_id'];

function rpcError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  error.rpcCode = code;
  if (data !== undefined) error.data = data;
  return error;
}

function gateway({ revision = 7, generation = 2, executionState = 'idle', onMutate = null } = {}) {
  const calls = [];
  const state = { revision, generation, executionState };
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === SESSION_RESUME_METHOD) {
      return {
        session_id: SESSION,
        stored_session_id: SESSION,
        message_count: 12,
        revision: state.revision,
        execution_generation: state.generation,
        execution_state: state.executionState,
        running: state.executionState === 'running',
        info: { cwd: '/home/ana', title: 'Fix login' },
      };
    }
    if (method === SESSION_MUTATE_METHOD) {
      if (onMutate) {
        const handled = await onMutate({ params, state, calls });
        if (handled !== undefined) return handled;
      }
      state.revision += 1;
      state.generation += 1;
      return {
        session_id: SESSION,
        operation: 'rewind',
        revision: state.revision,
        execution_generation: state.generation,
        rewound_count: 4,
        target_message: { id: params.payload.target_message_id, role: 'user' },
        new_head_id: 40,
        replacement_message_id: null,
      };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { request, calls, state };
}

function run(gw, extra = {}) {
  return rewindSessionToMessage({
    request: gw.request,
    dashboardWs: true,
    getReadyPayload: () => READY,
    sessionId: SESSION,
    rowId: 41,
    newRequestId: () => 'rid-1',
    ...extra,
  });
}

test('the rewind request is exactly the keys session.mutate accepts', () => {
  const params = buildRewindMutateParams({
    sessionId: SESSION, requestId: 'rid', expectedRevision: 7, expectedGeneration: 2, targetMessageId: 41,
  });
  assert.deepEqual(Object.keys(params).sort(), MUTATE_KEYS);
  assert.deepEqual(params, {
    session_id: SESSION,
    request_id: 'rid',
    expected_revision: 7,
    operation: REWIND_OPERATION,
    payload: { target_message_id: 41 },
    expected_generation: 2,
  });
  assert.throws(() => buildRewindMutateParams({ sessionId: SESSION, requestId: 'r', expectedRevision: 1, expectedGeneration: 0, targetMessageId: 0 }), TypeError);
  assert.throws(() => buildRewindMutateParams({ sessionId: SESSION, requestId: 'r', expectedRevision: 1, targetMessageId: 5 }), TypeError);
});

test('on a session authority a rewind reads the session, then sends one fenced mutation', async () => {
  const gw = gateway();
  const result = await run(gw);
  assert.equal(result.status, 'rewound');
  assert.equal(result.rewoundCount, 4);
  assert.equal(gw.calls.length, 2);
  assert.deepEqual(gw.calls[0], { method: SESSION_RESUME_METHOD, params: { session_id: SESSION, omit_messages: true } });
  assert.equal(gw.calls[1].method, SESSION_MUTATE_METHOD);
  assert.deepEqual(gw.calls[1].params, {
    session_id: SESSION,
    request_id: 'rid-1',
    expected_revision: 7,
    operation: 'rewind',
    payload: { target_message_id: 41 },
    expected_generation: 2,
  });
  // The submit that follows carries no truncate keys: that is what the canonical submit refuses.
  assert.deepEqual(truncateSubmitParams({ rowId: undefined }), {});
});

test('a running turn is refused before anything is sent', async () => {
  const gw = gateway({ executionState: 'running' });
  const result = await run(gw);
  assert.equal(result.status, 'busy');
  assert.equal(gw.calls.filter((call) => call.method === SESSION_MUTATE_METHOD).length, 0);
});

test('a socket that is not a session authority sends nothing and says it is unavailable', async () => {
  const gw = gateway();
  const result = await run(gw, { getReadyPayload: () => ({ session_authority: false }) });
  assert.equal(result.status, 'unavailable');
  assert.equal(gw.calls.length, 0);
  assert.equal(usesAuthorityRewind({ readyPayload: { session_authority: false } }), false);
  assert.equal(usesAuthorityRewind({ readyPayload: null }), false);
  assert.equal(usesAuthorityRewind({ readyPayload: READY }), true);
});

test('a missing row id never reaches the gateway', async () => {
  const gw = gateway();
  const result = await run(gw, { rowId: undefined });
  assert.equal(result.status, 'invalid');
  assert.equal(gw.calls.length, 0);
});

test('a stale fence is re-read once with a new request id, then reported as stale', async () => {
  let ids = 0;
  const gw = gateway({
    onMutate: ({ state }) => {
      if (state.revision === 7) {
        state.revision = 8;
        throw rpcError(4001, 'revision_conflict', { reason: 'revision_conflict', revision: 8 });
      }
      return undefined;
    },
  });
  const ok = await run(gw, { newRequestId: () => `rid-${(ids += 1)}` });
  assert.equal(ok.status, 'rewound');
  const mutates = gw.calls.filter((call) => call.method === SESSION_MUTATE_METHOD);
  assert.equal(mutates.length, 2);
  assert.equal(mutates[1].params.expected_revision, 8);
  assert.notEqual(mutates[0].params.request_id, mutates[1].params.request_id);

  const always = gateway({ onMutate: () => { throw rpcError(4001, 'stale', { reason: 'stale_generation' }); } });
  const stale = await run(always);
  assert.equal(stale.status, 'stale');
});

test('refusals are typed and change nothing', async () => {
  const cases = [
    [{ reason: 'session_busy' }, 'busy'],
    [{ reason: 'invalid_params', field: 'target_message_id', detail: 'target user message is no longer in session history' }, 'invalid'],
    [{ reason: 'invalid_params', field: 'target_message_id', detail: 'compacted: target user message was summarized when the session was compressed' }, 'compacted'],
    [{ reason: 'permission_denied' }, 'denied'],
    [{ reason: 'runtime_coordination_required' }, 'failed'],
  ];
  for (const [data, status] of cases) {
    const gw = gateway({ onMutate: () => { throw rpcError(4001, data.reason, data); } });
    const result = await run(gw);
    assert.equal(result.status, status, data.reason + (data.detail || ''));
    assert.equal(gw.calls.filter((call) => call.method === SESSION_MUTATE_METHOD).length, 1);
  }
});

test('method not found marks session.mutate unsupported and sends nothing more', async () => {
  const unsupported = new Set();
  const gw = gateway({ onMutate: () => { throw rpcError(-32601, 'method not found'); } });
  const result = await run(gw, { unsupportedMethods: unsupported });
  assert.equal(result.status, 'unavailable');
  assert.ok(unsupported.has(SESSION_MUTATE_METHOD));
});

test('a lost answer is settled by sending the identical request again, never a new one', async () => {
  let attempts = 0;
  const gw = gateway({
    onMutate: ({ state }) => {
      attempts += 1;
      if (attempts === 1) {
        // The write landed but the answer never arrived.
        state.revision += 1;
        state.generation += 1;
        throw new Error('Hermes request timed out');
      }
      // The identical request id and fences replay the committed receipt.
      return {
        session_id: SESSION, operation: 'rewind', revision: state.revision, execution_generation: state.generation, rewound_count: 4,
      };
    },
  });
  const result = await run(gw);
  assert.equal(result.status, 'rewound');
  const mutates = gw.calls.filter((call) => call.method === SESSION_MUTATE_METHOD);
  assert.equal(mutates.length, 2);
  assert.deepEqual(mutates[0].params, mutates[1].params);
});

test('an answer lost twice is indeterminate and the caller must read the gateway', async () => {
  const gw = gateway({ onMutate: () => { throw new Error('Hermes dashboard closed'); } });
  const result = await run(gw);
  assert.equal(result.status, 'indeterminate');
  assert.equal(rewindFailureError(result).rewindMaybeApplied, true);
  assert.equal(rewindFailureError({ status: 'busy' }).rewindMaybeApplied, false);
});

test('a canonical read that fails sends nothing', async () => {
  const gw = gateway();
  const request = async (method, params) => {
    if (method === SESSION_RESUME_METHOD) throw new Error('Hermes dashboard closed');
    return gw.request(method, params);
  };
  const result = await run({ request });
  assert.equal(result.status, 'not_sent');
});

test('a truncate-key refusal is never read as a display_text refusal', () => {
  // What a session authority answers when prompt.submit still carries the legacy keys.
  const refusal = rpcError(4001, 'invalid params for prompt.submit', {
    reason: 'invalid_params',
    fields: ['display_text', 'confirm_truncate', 'truncate_before_row_id', 'confirm_empty_truncate'],
  });
  assert.equal(isTruncateRejection(refusal), true);
  const onlyTruncate = rpcError(4001, 'invalid_params', {
    reason: 'invalid_params',
    fields: ['confirm_truncate', 'truncate_before_row_id', 'confirm_empty_truncate'],
  });
  assert.equal(isTruncateRejection(onlyTruncate), true);
  assert.equal(isDisplayTextRejection(onlyTruncate), false);
  assert.equal(isTruncateRejection(new Error('invalid params for prompt.submit: truncate_before_row_id: Extra inputs')), true);
  // A plain display_text refusal stays a display_text refusal.
  const displayOnly = rpcError(4001, 'invalid_params', { reason: 'invalid_params', fields: ['display_text'] });
  assert.equal(isDisplayTextRejection(displayOnly), true);
  assert.equal(isTruncateRejection(displayOnly), false);
});

test('the panel rewinds through the mutation on an authority and keeps the legacy truncate keys otherwise', async () => {
  const panel = await read('extension/sidepanel.js');
  const fn = panel.slice(panel.indexOf('async function submitRewind('), panel.indexOf('function addMessage('));
  // The mutation runs before any local change or submit.
  assert.ok(fn.indexOf('await rewindOnSessionAuthority(rowId, rewindScope)') > 0);
  assert.ok(fn.indexOf('await rewindOnSessionAuthority(rowId, rewindScope)') < fn.indexOf('applyRewindLocally('));
  assert.ok(fn.indexOf('await rewindOnSessionAuthority(rowId, rewindScope)') < fn.indexOf('await askHermes(plan.text'));
  // A plain submit after an authority rewind; the legacy socket keeps the truncate param.
  assert.match(fn, /\.\.\.\(rewind \? \{\} : \{ truncate: \{ rowId \} \}\)/);
  // A failed rewind leaves the transcript alone and uses the existing message.
  assert.match(fn, /if \(rewind && !authorityRewound\) \{[\s\S]{0,400}Edit failed\. Your conversation was not changed\./);
  // After a rewind that did land, a failed submit settles from the gateway, never from the snapshot.
  assert.match(fn, /!accepted && authorityRewound/);
  assert.match(fn, /bindRowIdsFromHistory\(messages, Array\.isArray\(history\?\.messages\)/);
  // The submit never adds truncate keys of its own.
  assert.match(panel, /\.\.\.truncateSubmitParams\(\{ rowId: truncate\?\.rowId \}\)/);
  // The truncate refusal is not blamed on display_text.
  assert.match(panel, /isDisplayTextRejection\(error\) \|\| isTruncateRejection\(error\)\) throw error/);
});
