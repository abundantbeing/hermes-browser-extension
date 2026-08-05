import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isDelegationToolEvent,
  turnMentionsDelegation,
  delegationBatchSettled,
} from '../extension/lib/async-delegation.mjs';

test('delegation tool events are detected across event name shapes', () => {
  assert.equal(isDelegationToolEvent({ toolName: 'delegate_task' }), true);
  assert.equal(isDelegationToolEvent({ name: 'delegate_task' }), true);
  assert.equal(isDelegationToolEvent({ rawName: 'delegate_task' }), true);
  assert.equal(isDelegationToolEvent({ toolName: 'tools.subagent' }), true);
  assert.equal(isDelegationToolEvent({ toolName: 'mcp__delegate_task' }), true);
  assert.equal(isDelegationToolEvent({ toolName: 'subagent-run' }), true);
  assert.equal(isDelegationToolEvent({ toolName: 'todo' }), false);
  assert.equal(isDelegationToolEvent({ toolName: 'web_search' }), false);
  assert.equal(isDelegationToolEvent({}), false);
  assert.equal(isDelegationToolEvent(null), false);
});

test('turn answers that mention an async delegation are recognized', () => {
  assert.equal(turnMentionsDelegation('[ASYNC DELEGATION — deleg_abc123] Dispatched'), true);
  assert.equal(turnMentionsDelegation('dispatched a subagent to research pricing'), true);
  assert.equal(turnMentionsDelegation('Delegated to deleg_7f3c; waiting for results.'), true);
  assert.equal(turnMentionsDelegation('The delegation is complete.'), false);
  assert.equal(turnMentionsDelegation('Here is the answer to your question.'), false);
  assert.equal(turnMentionsDelegation(''), false);
});

test('delegation batch settles when the session grows past the turn baseline', () => {
  const baseline = 2;
  const now = Date.now();
  const settled = delegationBatchSettled(
    [
      { role: 'user', content: 'dispatch' },
      { role: 'assistant', content: 'Dispatched' },
      { role: 'assistant', content: 'Subagent batch result: done.' },
    ],
    baseline,
    now - 1000,
  );
  assert.equal(settled, true);
});

test('delegation batch settles on the gateway completion marker', () => {
  const baseline = 2;
  const settled = delegationBatchSettled(
    [
      { role: 'user', content: 'dispatch' },
      { role: 'assistant', content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_abc123]' },
    ],
    baseline,
    Date.now() - 1000,
  );
  assert.equal(settled, true);
});

test('delegation batch stays unsettled while the session is unchanged', () => {
  const baseline = 2;
  const settled = delegationBatchSettled(
    [
      { role: 'user', content: 'dispatch' },
      { role: 'assistant', content: 'Dispatched' },
    ],
    baseline,
    Date.now() - 1000,
  );
  assert.equal(settled, false);
});

test('delegation batch times out after the poll budget', () => {
  const baseline = 2;
  const settled = delegationBatchSettled(
    [
      { role: 'user', content: 'dispatch' },
      { role: 'assistant', content: 'Dispatched' },
    ],
    baseline,
    Date.now() - 601_000,
  );
  assert.equal(settled, true);
});

test('delegation batch is not settled with no messages until the timeout', () => {
  assert.equal(delegationBatchSettled([], 0, Date.now()), false);
  assert.equal(delegationBatchSettled([], 0, Date.now() - 601_000), true);
});
