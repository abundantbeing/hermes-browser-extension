// A browser that resumes a chat written before the gateway owned sessions is
// refused by the session authority (rpc 4001, reason not_found, no field or
// detail). The panel shows that reason and the adopt hint, keeps the draft, and
// never resends.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  PRE_GATEWAY_ADOPT_HINT,
  isLegacyLocalSessionId,
  preGatewayChatError,
  preGatewayChatFailureState,
  preGatewayChatRefusal,
} from '../extension/lib/pre-gateway-chat.mjs';
import { isStaleLiveSessionRefusal } from '../extension/lib/gateway-refusal.mjs';

const LEGACY_ID = '20260415_093000_ab12cd';

function rpcError(reason, extra = {}) {
  const error = new Error(reason);
  error.code = 4001;
  error.rpcCode = 4001;
  error.data = { reason, ...extra };
  return error;
}

test('legacy local row ids are told apart from canonical and extension ids', () => {
  assert.equal(isLegacyLocalSessionId(LEGACY_ID), true);
  assert.equal(isLegacyLocalSessionId('20260415_093000'), true);
  assert.equal(isLegacyLocalSessionId('local-0123456789abcdef'), false);
  assert.equal(isLegacyLocalSessionId('hermes-browser-extension-1'), false);
  assert.equal(isLegacyLocalSessionId(''), false);
});

test('the real refusal shape (4001, not_found, no field) on a legacy id is the pre-gateway case', () => {
  const refusal = preGatewayChatRefusal(rpcError('not_found'), LEGACY_ID);
  assert.deepEqual({ ...refusal }, { sessionId: LEGACY_ID, reason: 'not_found', field: '', detail: '' });
});

test('not_found on a canonical or unknown id stays an ordinary gone session', () => {
  assert.equal(preGatewayChatRefusal(rpcError('not_found'), 'local-0123456789abcdef'), null);
  assert.equal(preGatewayChatRefusal(rpcError('not_found'), ''), null);
  assert.equal(isStaleLiveSessionRefusal(rpcError('not_found')), true, 'the stale-id path still sees it first');
});

test('other reasons are never mistaken for it', () => {
  for (const reason of ['session_busy', 'invalid_params', 'session_read_only', 'storage_unavailable']) {
    assert.equal(preGatewayChatRefusal(rpcError(reason), LEGACY_ID), null, reason);
  }
  assert.equal(preGatewayChatRefusal(new Error('boom'), LEGACY_ID), null);
  const wrongCode = rpcError('not_found');
  wrongCode.code = wrongCode.rpcCode = 5001;
  assert.equal(preGatewayChatRefusal(wrongCode, LEGACY_ID), null);
});

test('permission_denied on a resume counts for any id, and carries the gateway field and detail', () => {
  const refusal = preGatewayChatRefusal(rpcError('permission_denied', { field: 'session_id', detail: 'no native claim' }), 'whatever');
  assert.equal(refusal.reason, 'permission_denied');
  assert.equal(refusal.field, 'session_id');
  assert.equal(refusal.detail, 'no native claim');
});

test('the failure state names the gateway reason, gives the hint, keeps the draft, and leaves the gateway connected', () => {
  const error = preGatewayChatError(rpcError('not_found'), LEGACY_ID);
  assert.ok(error);
  const state = preGatewayChatFailureState(error);
  assert.equal(state.kind, 'pre-gateway-chat');
  assert.match(state.detail, /Hermes answered not_found\./);
  assert.ok(state.detail.includes('hermes sessions adopt'));
  assert.ok(state.detail.includes('hermes -p <profile> sessions adopt'));
  assert.ok(state.detail.includes('Desktop app'));
  assert.ok(state.detail.includes(PRE_GATEWAY_ADOPT_HINT));
  assert.equal(state.preserveDraft, true);
  assert.equal(state.gatewayStatus, 'connected');
  assert.equal(preGatewayChatFailureState(new Error('x')), null);
});

test('the panel routes both the prepare step and the turn through it and never resends', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(source, /throw preGatewayChatError\(resumeError, [^)]*\) \|\| sessionGoneError\(resumeError\)/);
  assert.match(source, /const requestFailure = preGatewayChatFailureState\(error\) \|\| turnRequestFailureState\(error\)/);
  const prepare = source.slice(source.indexOf('const preGatewayChat = dashboardTransport'));
  const block = prepare.slice(0, prepare.indexOf('return false;') + 14);
  assert.match(block, /preGatewayChatFailureState\(preGatewayChat\)/);
  assert.doesNotMatch(block, /askHermes\(|sendPrompt\(|streamSessionChat\(/);
});
