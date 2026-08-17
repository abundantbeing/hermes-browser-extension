import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_TAB_LEASES,
  TAB_LEASE_DEFAULT_TTL_MS,
  TAB_LEASE_KINDS,
  TAB_LEASE_OWNERSHIPS,
  TAB_LEASE_STORAGE_KEY,
  TAB_LEASE_VERSION,
  createTabLeaseStore,
} from '../extension/lib/tab-leases.mjs';

test('tab leases enforce exactly one lease per tab across every kind', () => {
  const store = createTabLeaseStore({ now: () => 1_000 });
  const first = store.acquire({ tabId: 11, kind: TAB_LEASE_KINDS.THIS_TAB, ownerId: 'controller-1' });
  assert.equal(first.ok, true);
  assert.equal(first.lease.tabId, 11);
  assert.equal(first.lease.kind, TAB_LEASE_KINDS.THIS_TAB);

  // A second lease for the same tab — even another kind — is rejected.
  const second = store.acquire({ tabId: 11, kind: TAB_LEASE_KINDS.TASK_SET, ownerId: 'controller-1', taskSetId: 'task-1' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'already-leased');

  // Different tabs lease independently.
  assert.equal(store.acquire({ tabId: 12, kind: TAB_LEASE_KINDS.SELECTED_TABS, ownerId: 'controller-1' }).ok, true);
  assert.equal(store.acquire({ tabId: 13, kind: TAB_LEASE_KINDS.SELECTED_TABS, ownerId: 'controller-1' }).ok, true);
  assert.deepEqual(store.leasedTabIds().sort((a, b) => a - b), [11, 12, 13]);
});

test('tab lease kinds require their exact parameters and reject unknown kinds', () => {
  const store = createTabLeaseStore({ now: () => 1_000 });
  assert.throws(() => store.acquire({ tabId: 1, kind: 'mystery', ownerId: 'c1' }), /kind/i);
  assert.throws(() => store.acquire({ tabId: 1, kind: TAB_LEASE_KINDS.TASK_SET, ownerId: 'c1' }), /task set id/i);
  assert.throws(() => store.acquire({ tabId: 1, kind: TAB_LEASE_KINDS.THIS_TAB, ownerId: 'c1', taskSetId: 't1' }), /task set id/i);
  assert.throws(() => store.acquire({ tabId: 1, kind: TAB_LEASE_KINDS.THIS_TAB }), /owner/i);
});

test('owned leases are released only by their owner; borrowed leases are reclaimable by the system', () => {
  const store = createTabLeaseStore({ now: () => 1_000 });
  store.acquire({ tabId: 21, kind: TAB_LEASE_KINDS.THIS_TAB, ownerId: 'controller-1', ownership: TAB_LEASE_OWNERSHIPS.OWNED });
  store.acquire({ tabId: 22, kind: TAB_LEASE_KINDS.THIS_TAB, ownerId: 'panel-1', ownership: TAB_LEASE_OWNERSHIPS.BORROWED });

  // A foreign owner cannot release an owned lease.
  const foreign = store.release({ tabId: 21, ownerId: 'intruder' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'not-owner');
  assert.ok(store.leaseForTab(21));

  // The owner releases its owned lease.
  assert.equal(store.release({ tabId: 21, ownerId: 'controller-1' }).ok, true);
  assert.equal(store.leaseForTab(21), null);

  // Borrowed leases are reclaimed wholesale when the borrower disconnects.
  assert.equal(store.reclaimBorrowed({ ownerId: 'panel-1' }), 1);
  assert.equal(store.leaseForTab(22), null);
});

test('tab leases expire after their TTL and are reclaimed', () => {
  let now = 0;
  const store = createTabLeaseStore({ now: () => now, ttlMs: 10_000 });
  store.acquire({ tabId: 31, kind: TAB_LEASE_KINDS.THIS_TAB, ownerId: 'controller-1' });
  store.acquire({ tabId: 32, kind: TAB_LEASE_KINDS.SELECTED_TABS, ownerId: 'controller-1' });
  now = 9_999;
  assert.equal(store.reclaimExpired(), 0);
  assert.equal(store.leaseForTab(31).tabId, 31);
  now = 10_001;
  assert.equal(store.reclaimExpired(), 2);
  assert.equal(store.leaseForTab(31), null);
  assert.equal(store.leaseForTab(32), null);
});

test('successful activity renews the idle TTL only for the exact live lease authority', () => {
  let now = 0;
  const store = createTabLeaseStore({ now: () => now, ttlMs: 10_000, generation: 3 });
  const acquired = store.acquire({
    tabId: 33,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownerId: 'controller-1',
  });

  now = 9_000;
  assert.deepEqual(store.renew({
    tabId: 33,
    ownerId: 'other-controller',
    leaseId: acquired.lease.leaseId,
    generation: acquired.lease.generation,
  }), { ok: false, error: 'not-owner' });
  assert.deepEqual(store.renew({
    tabId: 33,
    ownerId: acquired.lease.ownerId,
    leaseId: 'stale-lease',
    generation: acquired.lease.generation,
  }), { ok: false, error: 'stale-lease' });
  assert.deepEqual(store.renew({
    tabId: 33,
    ownerId: acquired.lease.ownerId,
    leaseId: acquired.lease.leaseId,
    generation: 2,
  }), { ok: false, error: 'stale-generation' });
  const renewed = store.renew({
    tabId: 33,
    ownerId: acquired.lease.ownerId,
    leaseId: acquired.lease.leaseId,
    generation: acquired.lease.generation,
  });

  assert.equal(renewed.ok, true);
  assert.equal(renewed.lease.acquiredAt, 0);
  assert.equal(renewed.lease.expiresAt, 19_000);
  now = 10_001;
  assert.equal(store.reclaimExpired(), 0, 'renewed activity keeps the lease alive past its original idle deadline');
  now = 19_000;
  assert.equal(store.reclaimExpired(), 1, 'the renewed lease still expires after a fresh idle TTL');
});

test('tab leases invalidate on restart generation and preserve generations across hydrate', () => {
  const store = createTabLeaseStore({ now: () => 1_000, generation: 5 });
  store.acquire({ tabId: 41, kind: TAB_LEASE_KINDS.THIS_TAB, ownerId: 'controller-1' });
  assert.equal(store.leaseForTab(41).generation, 5);

  // A new service-worker generation invalidates every older lease.
  assert.equal(store.invalidateGeneration({ generation: 6 }), 1);
  assert.equal(store.leaseForTab(41), null);

  // Hydrate preserves the persisted generation so a restart cannot resurrect
  // stale leases under a rolled-back generation.
  store.acquire({ tabId: 42, kind: TAB_LEASE_KINDS.THIS_TAB, ownerId: 'controller-1' });
  const snapshot = store.snapshot();
  const restored = createTabLeaseStore({ now: () => 1_000, generation: 5 });
  restored.hydrate(snapshot);
  assert.equal(restored.leaseForTab(42).generation, 5);

  // Corrupt / wrong-version / shape-mismatched hydrate fails closed.
  assert.deepEqual(restored.hydrate(null), []);
  assert.deepEqual(restored.hydrate({ version: 99, entries: [] }), []);
  assert.deepEqual(restored.hydrate({ version: TAB_LEASE_VERSION, entries: [{ tabId: 1 }] }), []);
});

test('a fresh worker adopts still-valid recovered leases into its monotonic generation', () => {
  const first = createTabLeaseStore({ now: () => 1_000, generation: 4 });
  first.acquire({ tabId: 43, kind: TAB_LEASE_KINDS.THIS_TAB, ownerId: 'controller-1' });
  const restored = createTabLeaseStore({ now: () => 2_000, generation: 5 });
  restored.hydrate(first.snapshot());

  assert.equal(restored.adoptGeneration({ generation: 5 }), 1);
  assert.equal(restored.leaseForTab(43).generation, 5);
  assert.equal(restored.adoptGeneration({ generation: 4 }), 0, 'generation may never roll back');
  assert.equal(restored.leaseForTab(43).generation, 5);
});

test('task-set leases group tabs internally when native tab groups are unavailable (Firefox fallback)', () => {
  const native = createTabLeaseStore({ now: () => 1_000, supportsTabGroups: true });
  native.acquire({ tabId: 51, kind: TAB_LEASE_KINDS.TASK_SET, ownerId: 'controller-1', taskSetId: 'task-a' });
  assert.equal(native.leaseForTab(51).groupSource, 'native');

  const firefox = createTabLeaseStore({ now: () => 1_000, supportsTabGroups: false });
  firefox.acquire({ tabId: 61, kind: TAB_LEASE_KINDS.TASK_SET, ownerId: 'controller-1', taskSetId: 'task-fx' });
  firefox.acquire({ tabId: 62, kind: TAB_LEASE_KINDS.TASK_SET, ownerId: 'controller-1', taskSetId: 'task-fx' });
  assert.equal(firefox.leaseForTab(61).groupSource, 'internal');
  assert.equal(firefox.usesNativeGroups(), false);
  assert.deepEqual(firefox.taskSetTabIds('task-fx').sort((a, b) => a - b), [61, 62]);

  // Releasing one tab of a task set keeps the rest of the set.
  firefox.release({ tabId: 61, ownerId: 'controller-1' });
  assert.deepEqual(firefox.taskSetTabIds('task-fx'), [62]);
  assert.equal(firefox.leaseForTab(62).kind, TAB_LEASE_KINDS.TASK_SET);
});

test('tab lease storage is bounded, versioned, minimal, and never carries page content', () => {
  const store = createTabLeaseStore({ now: () => 1_000 });
  for (let index = 0; index < 50; index += 1) {
    store.acquire({ tabId: 100 + index, kind: TAB_LEASE_KINDS.SELECTED_TABS, ownerId: 'controller-1' });
  }
  assert.ok(store.count() <= MAX_TAB_LEASES);

  const snapshot = store.snapshot();
  assert.equal(snapshot.version, TAB_LEASE_VERSION);
  assert.equal(snapshot.entries.length, MAX_TAB_LEASES);
  assert.deepEqual(Object.keys(snapshot.entries[0]).sort(), [
    'acquiredAt', 'expiresAt', 'generation', 'groupSource', 'kind', 'leaseId',
    'ownerId', 'ownership', 'tabId', 'taskSetId', 'windowId',
  ]);
  const json = JSON.stringify(snapshot);
  for (const forbidden of ['url', 'title', 'transcript', 'pageContext', '"text"']) {
    assert.equal(json.includes(forbidden), false, `lease snapshot must not contain ${forbidden}`);
  }
});

test('tab lease constants are stable and the default TTL is bounded', () => {
  assert.equal(TAB_LEASE_VERSION, 1);
  assert.equal(TAB_LEASE_STORAGE_KEY, 'hermesBrowserTabLeases');
  assert.equal(TAB_LEASE_DEFAULT_TTL_MS, 30 * 60_000);
  assert.deepEqual(TAB_LEASE_KINDS, { THIS_TAB: 'this-tab', SELECTED_TABS: 'selected-tabs', TASK_SET: 'task-set' });
  assert.deepEqual(TAB_LEASE_OWNERSHIPS, { OWNED: 'owned', BORROWED: 'borrowed' });
});
