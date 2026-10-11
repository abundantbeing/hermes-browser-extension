import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXEC_APPROVAL_CHOICES,
  normalizeExecApprovalChoices,
  execApprovalRequestPayload,
  isExecApprovalRetired,
} from '../extension/lib/exec-approval.mjs';

test('unknown choice values never map to a button', () => {
  assert.deepEqual(
    normalizeExecApprovalChoices(['once', 'DENY', 'reboot', '', null, undefined]),
    ['once', 'deny'],
  );
});

test('smart-denied requests offer only once and deny', () => {
  assert.deepEqual(normalizeExecApprovalChoices(['once', 'deny']), ['once', 'deny']);
});

test('a choices array with no known values renders no buttons', () => {
  assert.deepEqual(normalizeExecApprovalChoices(['rm', 'please', 42]), []);
});

test('a missing or empty choices array falls back to the full set', () => {
  assert.deepEqual(normalizeExecApprovalChoices(undefined), EXEC_APPROVAL_CHOICES);
  assert.deepEqual(normalizeExecApprovalChoices([]), EXEC_APPROVAL_CHOICES);
  assert.deepEqual(normalizeExecApprovalChoices('once'), EXEC_APPROVAL_CHOICES);
});

test('the decision payload only carries allowlisted choices', () => {
  assert.deepEqual(execApprovalRequestPayload('once', 'req-1'), { choice: 'once', request_id: 'req-1' });
  assert.deepEqual(execApprovalRequestPayload('deny'), { choice: 'deny' });
  assert.deepEqual(execApprovalRequestPayload('session'), { choice: 'session' });
});

test('arbitrary strings are refused as decisions', () => {
  assert.equal(execApprovalRequestPayload('reboot'), null);
  assert.equal(execApprovalRequestPayload('ALWAYS'), null);
  assert.equal(execApprovalRequestPayload(''), null);
  assert.equal(execApprovalRequestPayload(null), null);
});

test('409 or an explicit no-pending message retires the card', () => {
  assert.equal(isExecApprovalRetired(409), true);
  assert.equal(isExecApprovalRetired(409, 'anything'), true);
  assert.equal(isExecApprovalRetired(undefined, 'Run has no pending approval: abc'), true);
  assert.equal(isExecApprovalRetired(undefined, 'Run has no active approval session: run-7'), true);
});

test('other statuses and messages are send failures, not retirement', () => {
  assert.equal(isExecApprovalRetired(400, 'Invalid approval choice'), false);
  assert.equal(isExecApprovalRetired(500, 'internal error'), false);
  assert.equal(isExecApprovalRetired(undefined, 'network unreachable'), false);
});

test('the payload echoes the request id when present and omits it when not', () => {
  assert.equal(Object.hasOwn(execApprovalRequestPayload('once', 'req-1'), 'request_id'), true);
  assert.equal(Object.hasOwn(execApprovalRequestPayload('once', ''), 'request_id'), false);
  assert.equal(Object.hasOwn(execApprovalRequestPayload('once', '  '), 'request_id'), false);
});
