import test from 'node:test';
import assert from 'node:assert/strict';

import { createDelegationWatchManager } from '../extension/lib/async-delegation.mjs';

const SCOPE = 'local|http://127.0.0.1:8642|default';

function watch(overrides = {}) {
  return {
    scopeKey: SCOPE,
    durableSessionId: 'session-a',
    liveSessionId: '',
    delegationId: 'deleg_abc12345',
    transport: 'rest',
    ...overrides,
  };
}

function completeHistory(id = 'deleg_abc12345') {
  return [
    { role: 'assistant', content: `Dispatched ${id}.` },
    { role: 'user', content: `[ASYNC DELEGATION BATCH COMPLETE — ${id}]\nStatus: completed` },
    { role: 'assistant', content: `Integrated ${id}.` },
  ];
}

function createHarness(overrides = {}) {
  let now = 1_000_000;
  let activeScope = SCOPE;
  let activeSession = 'session-a';
  let busy = false;
  const persisted = [];
  const states = [];
  const completed = [];
  const scheduled = new Map();
  let nextTimer = 1;
  let loadHistory = async () => ({ messages: [] });
  const manager = createDelegationWatchManager({
    now: () => now,
    maxPollMs: 60_000,
    isBusy: () => busy,
    isActive: (candidate) => candidate.scopeKey === activeScope && candidate.durableSessionId === activeSession,
    loadHistory: (candidate) => loadHistory(candidate),
    onComplete: async (candidate, result) => completed.push({ candidate, result }),
    onState: (candidate) => states.push({ ...candidate }),
    persist: async (rows) => persisted.push(rows.map((row) => ({ ...row }))),
    setTimer: (fn, delay) => {
      const id = nextTimer++;
      scheduled.set(id, { fn, delay });
      return id;
    },
    clearTimer: (id) => scheduled.delete(id),
    ...overrides,
  });
  return {
    manager,
    persisted,
    states,
    completed,
    scheduled,
    setNow: (value) => { now = value; },
    advance: (value) => { now += value; },
    setBusy: (value) => { busy = value; },
    setActive: (scope, session) => { activeScope = scope; activeSession = session; },
    setLoadHistory: (fn) => { loadHistory = fn; },
  };
}

test('manager starts and deduplicates one watch per scope, session, and delegation id', async () => {
  const harness = createHarness();
  await harness.manager.start(watch());
  await harness.manager.start(watch({ liveSessionId: 'live-a' }));
  const rows = harness.manager.snapshot();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].liveSessionId, 'live-a');
  assert.equal(rows[0].state, 'pending');
});

test('busy reconciliation reschedules without loading or losing the watch', async () => {
  const harness = createHarness();
  let loads = 0;
  harness.setLoadHistory(async () => { loads += 1; return { messages: [] }; });
  await harness.manager.start(watch());
  harness.setBusy(true);
  await harness.manager.reconcile(watch());
  assert.equal(loads, 0);
  assert.equal(harness.manager.snapshot()[0].state, 'pending');
  assert.ok(harness.scheduled.size >= 1);
});

test('transient history failure records load_failed and remains scheduled', async () => {
  const harness = createHarness();
  harness.setLoadHistory(async () => { throw new Error('temporary'); });
  await harness.manager.start(watch());
  await harness.manager.reconcile(watch());
  const row = harness.manager.snapshot()[0];
  assert.equal(row.state, 'load_failed');
  assert.match(row.lastError, /temporary/);
  assert.ok(harness.scheduled.size >= 1);
});

test('exact completion refreshes once and becomes terminal', async () => {
  const harness = createHarness();
  harness.setLoadHistory(async () => ({ messages: completeHistory() }));
  await harness.manager.start(watch());
  await harness.manager.reconcile(watch());
  await harness.manager.reconcile(watch());
  assert.equal(harness.completed.length, 1);
  assert.equal(harness.manager.snapshot()[0].state, 'completed');
});

test('two delegations complete independently in reverse order', async () => {
  const harness = createHarness();
  const second = watch({ delegationId: 'deleg_def67890' });
  harness.setLoadHistory(async (candidate) => ({ messages: completeHistory(candidate.delegationId) }));
  await harness.manager.start(watch());
  await harness.manager.start(second);
  await harness.manager.reconcile(second);
  assert.equal(harness.manager.snapshot().find((row) => row.delegationId === 'deleg_abc12345').state, 'pending');
  await harness.manager.reconcile(watch());
  assert.deepEqual(harness.completed.map((entry) => entry.candidate.delegationId), ['deleg_def67890', 'deleg_abc12345']);
});

test('session switch prevents stale in-flight completion from mutating the active surface', async () => {
  const harness = createHarness();
  let resolveHistory;
  harness.setLoadHistory(() => new Promise((resolve) => { resolveHistory = resolve; }));
  await harness.manager.start(watch());
  const pending = harness.manager.reconcile(watch());
  harness.setActive(SCOPE, 'session-b');
  resolveHistory({ messages: completeHistory() });
  await pending;
  assert.equal(harness.completed.length, 0);
  assert.equal(harness.manager.snapshot()[0].state, 'pending');
});

test('inactive session remains persisted and resumes when activated', async () => {
  const harness = createHarness();
  harness.setActive(SCOPE, 'session-b');
  let loads = 0;
  harness.setLoadHistory(async () => { loads += 1; return { messages: completeHistory() }; });
  await harness.manager.start(watch());
  await harness.manager.reconcile(watch());
  assert.equal(loads, 0);
  harness.setActive(SCOPE, 'session-a');
  await harness.manager.activate({ scopeKey: SCOPE, durableSessionId: 'session-a', liveSessionId: '' });
  await harness.manager.reconcile(watch());
  assert.equal(harness.completed.length, 1);
});

test('timeout is distinct from completion and never calls completion renderer', async () => {
  const harness = createHarness();
  await harness.manager.start(watch());
  harness.advance(61_000);
  await harness.manager.reconcile(watch());
  assert.equal(harness.manager.snapshot()[0].state, 'timed_out');
  assert.equal(harness.completed.length, 0);
});

test('reactivating a timed-out watch grants a fresh completion probe budget', async () => {
  const harness = createHarness();
  await harness.manager.start(watch());
  harness.advance(61_000);
  await harness.manager.reconcile(watch());
  assert.equal(harness.manager.snapshot()[0].state, 'timed_out');

  harness.setLoadHistory(async () => ({ messages: completeHistory() }));
  await harness.manager.activate({ scopeKey: SCOPE, durableSessionId: 'session-a', liveSessionId: '' });
  await harness.manager.reconcile(watch());

  assert.equal(harness.completed.length, 1);
  assert.equal(harness.manager.snapshot()[0].state, 'completed');
});

test('transient persistence rejection never stops scheduling or startup hydration', async () => {
  let persistCalls = 0;
  const harness = createHarness({
    persist: async () => {
      persistCalls += 1;
      if (persistCalls <= 2) throw new Error('storage temporarily unavailable');
    },
  });

  await assert.doesNotReject(() => harness.manager.start(watch()));
  assert.ok(harness.scheduled.size >= 1, 'start must schedule despite failed persistence');
  await assert.doesNotReject(() => harness.manager.hydrate([
    { ...watch(), state: 'pending', dispatchedAt: 999_000, updatedAt: 999_000 },
  ]));
  assert.ok(harness.scheduled.size >= 1, 'hydrate must preserve an active schedule despite failed persistence');
});

test('hydrate restores pending watches and drops invalid rows', async () => {
  const harness = createHarness();
  await harness.manager.hydrate([
    { ...watch(), state: 'pending', dispatchedAt: 999_000, updatedAt: 999_000 },
    { ...watch({ delegationId: 'bad' }), state: 'pending', dispatchedAt: 999_000, updatedAt: 999_000 },
  ]);
  assert.equal(harness.manager.snapshot().length, 1);
  assert.ok(harness.scheduled.size >= 1);
});

test('activating dashboard session replaces transient live id without changing durable identity', async () => {
  const harness = createHarness();
  await harness.manager.start(watch({ transport: 'dashboard-ws', liveSessionId: 'live-old' }));
  await harness.manager.activate({ scopeKey: SCOPE, durableSessionId: 'session-a', liveSessionId: 'live-new' });
  const row = harness.manager.snapshot()[0];
  assert.equal(row.durableSessionId, 'session-a');
  assert.equal(row.liveSessionId, 'live-new');
});
