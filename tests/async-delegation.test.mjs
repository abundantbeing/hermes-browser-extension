import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DELEGATION_WATCH_STORAGE_KEY,
  delegationCompletionState,
  delegationDispatchFromToolEvent,
  delegationDispatchesFromMessages,
  delegationScopeKey,
  isDelegationCompletionMarkerMessage,
  isDelegationToolEvent,
  mergeDelegationWatchStores,
  normalizeDelegationId,
  normalizeDelegationWatchStore,
  pollDelayForAttempt,
} from '../extension/lib/async-delegation.mjs';

const DISPATCH = {
  status: 'dispatched',
  mode: 'background',
  count: 1,
  delegation_id: 'deleg_abc12345',
};

const completionRows = (id = 'deleg_abc12345', marker = 'ASYNC DELEGATION BATCH COMPLETE') => [
  { role: 'assistant', content: `Dispatched background work as ${id}. Results will arrive later.` },
  { role: 'user', content: `[${marker} — ${id}]\nStatus: completed` },
  { role: 'assistant', content: 'The delegated result has been integrated.' },
];

test('delegation watch storage key is versioned and stable', () => {
  assert.equal(DELEGATION_WATCH_STORAGE_KEY, 'hermesAsyncDelegationWatchesV1');
});

test('only exact internal completion turns are hidden from transcript renderers', () => {
  assert.equal(isDelegationCompletionMarkerMessage({
    role: 'user',
    content: '[ASYNC DELEGATION COMPLETE — deleg_abc12345]\nStatus: completed',
  }), true);
  assert.equal(isDelegationCompletionMarkerMessage({
    role: 'user',
    content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_abc12345]\nStatus: failed',
  }), true);
  assert.equal(isDelegationCompletionMarkerMessage({
    role: 'user',
    content: ['[ASYNC DELEGATION COMPLETE — deleg_abc12345]', 'Status: completed'].join(String.fromCharCode(13, 10)),
  }), true);
  assert.equal(isDelegationCompletionMarkerMessage({ role: 'assistant', content: '[ASYNC DELEGATION COMPLETE — deleg_abc12345]' }), false);
  assert.equal(isDelegationCompletionMarkerMessage({ role: 'user', content: 'Mentioning deleg_abc12345 is ordinary user text.' }), false);
  assert.equal(isDelegationCompletionMarkerMessage({ role: 'user', content: '[ASYNC DELEGATION COMPLETE — malformed]' }), false);
});

test('normalizeDelegationId accepts bounded canonical ids only', () => {
  assert.equal(normalizeDelegationId(' deleg_abc12345 '), 'deleg_abc12345');
  assert.equal(normalizeDelegationId('deleg_short'), '');
  assert.equal(normalizeDelegationId(`deleg_${'a'.repeat(129)}`), '');
  assert.equal(normalizeDelegationId('other_abc12345'), '');
});

test('delegation tool detection covers normalized and dashboard shapes', () => {
  assert.equal(isDelegationToolEvent({ toolName: 'delegate_task' }), true);
  assert.equal(isDelegationToolEvent({ tool_name: 'delegate_task' }), true);
  assert.equal(isDelegationToolEvent({ data: { tool: 'delegate_task' } }), true);
  assert.equal(isDelegationToolEvent({ name: 'mcp__delegate_task' }), true);
  assert.equal(isDelegationToolEvent({ toolName: 'tools.subagent' }), true);
  assert.equal(isDelegationToolEvent({ toolName: 'todo' }), false);
});

test('successful terminal tool result starts an exact delegation watch', () => {
  const dispatch = delegationDispatchFromToolEvent({
    name: 'tool.complete',
    status: 'complete',
    toolName: 'delegate_task',
    data: { result: JSON.stringify(DISPATCH) },
  });
  assert.deepEqual(dispatch, {
    delegationId: 'deleg_abc12345',
    count: 1,
    mode: 'background',
  });
});

test('dashboard tool.complete payload result starts a watch', () => {
  const dispatch = delegationDispatchFromToolEvent({
    type: 'tool.complete',
    tool_name: 'delegate_task',
    result: DISPATCH,
  });
  assert.equal(dispatch?.delegationId, 'deleg_abc12345');
});

test('tool start, failure, malformed results, and inline fallback never start a watch', () => {
  assert.equal(delegationDispatchFromToolEvent({ type: 'tool.start', tool_name: 'delegate_task', result: DISPATCH }), null);
  assert.equal(delegationDispatchFromToolEvent({ type: 'tool.complete', tool_name: 'delegate_task', result: { status: 'error', delegation_id: 'deleg_abc12345' } }), null);
  assert.equal(delegationDispatchFromToolEvent({ type: 'tool.complete', tool_name: 'delegate_task', result: '{bad json' }), null);
  assert.equal(delegationDispatchFromToolEvent({ type: 'tool.complete', tool_name: 'delegate_task', result: { results: [{ status: 'completed' }], note: 'inline fallback' } }), null);
});

test('REST run.completed tool messages recover all structured dispatch ids', () => {
  const dispatches = delegationDispatchesFromMessages([
    { role: 'tool', tool_name: 'delegate_task', content: JSON.stringify(DISPATCH) },
    { role: 'tool', name: 'delegate_task', content: { ...DISPATCH, delegation_id: 'deleg_def67890' } },
    { role: 'assistant', content: 'Dispatched deleg_fake123 in prose.' },
  ]);
  assert.deepEqual(dispatches.map((row) => row.delegationId), ['deleg_abc12345', 'deleg_def67890']);
});

test('dispatch acknowledgement containing the real id remains pending', () => {
  const rows = [{ role: 'assistant', content: 'Dispatched background work as deleg_abc12345. Results will arrive later.' }];
  assert.deepEqual(delegationCompletionState(rows, 'deleg_abc12345'), { state: 'pending' });
});

test('exact single and batch markers require a later assistant response', () => {
  for (const marker of ['ASYNC DELEGATION COMPLETE', 'ASYNC DELEGATION BATCH COMPLETE']) {
    const markerOnly = completionRows('deleg_abc12345', marker).slice(0, 2);
    assert.deepEqual(delegationCompletionState(markerOnly, 'deleg_abc12345'), { state: 'pending', markerIndex: 1 });
    assert.deepEqual(delegationCompletionState(completionRows('deleg_abc12345', marker), 'deleg_abc12345'), {
      state: 'completed',
      markerIndex: 1,
      assistantIndex: 2,
    });
  }
});

test('unrelated history growth, loader errors, and bare id mentions never settle', () => {
  const rows = [
    { role: 'assistant', content: 'Dispatched deleg_abc12345.' },
    { role: 'system', content: 'Could not load session messages: temporary network failure' },
    { role: 'user', content: 'Another user turn' },
    { role: 'assistant', content: 'Still waiting for deleg_abc12345' },
  ];
  assert.deepEqual(delegationCompletionState(rows, 'deleg_abc12345'), { state: 'pending' });
});

test('marker correlation is exact across concurrent delegations', () => {
  const rows = completionRows('deleg_def67890');
  assert.deepEqual(delegationCompletionState(rows, 'deleg_abc12345'), { state: 'pending' });
  assert.equal(delegationCompletionState(rows, 'deleg_def67890').state, 'completed');
});

test('scope key strips credentials, query, and fragments while preserving profile isolation', () => {
  const left = delegationScopeKey({ mode: 'remote-dashboard', gatewayUrl: 'https://user:pass@example.com/path?ticket=secret#x', profile: 'alpha' });
  const right = delegationScopeKey({ mode: 'remote-dashboard', gatewayUrl: 'https://example.com/path', profile: 'beta' });
  assert.equal(left, 'remote-dashboard|https://example.com/path|alpha');
  assert.equal(right, 'remote-dashboard|https://example.com/path|beta');
});

test('poll backoff is bounded', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 99].map(pollDelayForAttempt), [2_000, 4_000, 8_000, 15_000, 30_000, 30_000]);
});

test('watch storage is bounded, credential-free, and prunes expired rows', () => {
  const now = 10_000_000;
  const valid = {
    scopeKey: 'local|http://127.0.0.1:8642|default',
    durableSessionId: 'session-a',
    liveSessionId: 'live-a',
    delegationId: 'deleg_abc12345',
    transport: 'rest',
    state: 'pending',
    dispatchedAt: now - 1_000,
    updatedAt: now - 1_000,
    apiKey: 'must-not-survive',
  };
  const expired = { ...valid, delegationId: 'deleg_def67890', updatedAt: now - (8 * 24 * 60 * 60 * 1000) };
  const rows = normalizeDelegationWatchStore([valid, expired], { now });
  assert.equal(rows.length, 1);
  assert.equal('apiKey' in rows[0], false);
  assert.equal(rows[0].delegationId, 'deleg_abc12345');
});

test('completed state wins over a later stale pending write', () => {
  const base = {
    scopeKey: 'local|http://127.0.0.1:8642|default',
    durableSessionId: 'session-a',
    liveSessionId: '',
    delegationId: 'deleg_abc12345',
    transport: 'rest',
    dispatchedAt: 100,
  };
  const merged = mergeDelegationWatchStores(
    [{ ...base, state: 'completed', updatedAt: 200 }],
    [{ ...base, state: 'pending', updatedAt: 300 }],
    { now: 400 },
  );
  assert.equal(merged[0].state, 'completed');
});

test('newer resumed pending state replaces timeout and transient failure records', () => {
  const base = {
    scopeKey: 'local|http://127.0.0.1:8642|default',
    durableSessionId: 'session-a',
    liveSessionId: '',
    delegationId: 'deleg_abc12345',
    transport: 'rest',
    dispatchedAt: 100,
  };
  for (const state of ['timed_out', 'load_failed']) {
    const merged = mergeDelegationWatchStores(
      [{ ...base, state, updatedAt: 200 }],
      [{ ...base, state: 'pending', updatedAt: 300 }],
      { now: 400 },
    );
    assert.equal(merged[0].state, 'pending');
  }
});
