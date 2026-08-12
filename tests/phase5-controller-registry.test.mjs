import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROLLER_DEFAULT_EXPIRY_MS,
  CONTROLLER_DEFAULT_HEARTBEAT_MS,
  CONTROLLER_REGISTRY_STORAGE_KEY,
  CONTROLLER_REGISTRY_VERSION,
  MAX_CONTROLLER_REGISTRY_ENTRIES,
  createControllerRegistry,
} from '../extension/lib/controller-registry.mjs';

const IDENTITY = Object.freeze({
  controllerId: 'controller-fixture',
  browserProfileId: 'browser-profile-fixture',
  product: { id: 'chromium', engine: 'chromium', label: 'Chromium browser' },
});

test('controller registry registers only complete durable controller/profile identity', () => {
  const registry = createControllerRegistry({ now: () => 1_000 });
  assert.throws(() => registry.register({}), /controller id/i);
  assert.throws(() => registry.register({ controllerId: 'c1' }), /browser profile id/i);
  assert.throws(() => registry.register({ controllerId: 'c1', browserProfileId: 'p1' }), /product/i);
  const record = registry.register({ ...IDENTITY, hermesSessionId: 'session-1' });
  assert.equal(record.controllerId, 'controller-fixture');
  assert.equal(record.browserProfileId, 'browser-profile-fixture');
  assert.equal(record.generation, 1);
  assert.equal(registry.get('controller-fixture').controllerId, 'controller-fixture');
});

test('controller registry binds an exact Hermes session and bumps generation monotonically', () => {
  const registry = createControllerRegistry({ now: () => 1_000 });
  registry.register({ ...IDENTITY, hermesSessionId: 'session-1' });
  assert.equal(registry.generation('controller-fixture'), 1);

  const bound = registry.bindSession({ controllerId: 'controller-fixture', hermesSessionId: 'session-1' });
  assert.equal(bound.hermesSessionId, 'session-1');
  assert.equal(bound.generation, 2);

  // Rebinding to a different session is a new epoch — generation never repeats.
  registry.bindSession({ controllerId: 'controller-fixture', hermesSessionId: 'session-2' });
  assert.equal(registry.generation('controller-fixture'), 3);

  // Binding an unknown controller or an empty session fails closed.
  assert.throws(() => registry.bindSession({ controllerId: 'missing', hermesSessionId: 'session-1' }), /not registered/i);
  assert.throws(() => registry.bindSession({ controllerId: 'controller-fixture', hermesSessionId: '' }), /hermes session/i);
});

test('controller registry direct re-registration treats a changed Hermes session as a new epoch', () => {
  const registry = createControllerRegistry({ now: () => 1_000 });
  const first = registry.register({ ...IDENTITY, hermesSessionId: 'session-1' });
  const same = registry.register({ ...IDENTITY, hermesSessionId: 'session-1' });
  const rebound = registry.register({ ...IDENTITY, hermesSessionId: 'session-2' });
  assert.equal(same.generation, first.generation, 'same durable session registration is a heartbeat refresh');
  assert.ok(rebound.generation > same.generation, 'changed session binding must advance the controller epoch');
  assert.equal(rebound.hermesSessionId, 'session-2');
});

test('controller registry accepts an explicit monotonic target generation without rollback', () => {
  const registry = createControllerRegistry({ now: () => 1_000 });
  const restored = registry.register({ ...IDENTITY, hermesSessionId: 'session-1', generation: 4 });
  assert.equal(restored.generation, 4);

  const noRollback = registry.bindSession({
    controllerId: 'controller-fixture',
    hermesSessionId: 'session-1',
    generation: 2,
  });
  assert.equal(noRollback.generation, 4);

  const advanced = registry.bindSession({
    controllerId: 'controller-fixture',
    hermesSessionId: 'session-2',
    generation: 7,
  });
  assert.equal(advanced.generation, 7);
});

test('controller registry heartbeats keep entries live and expiry evicts them', () => {
  let now = 0;
  const registry = createControllerRegistry({ now: () => now, expiryMs: 5_000 });
  registry.register({ ...IDENTITY, hermesSessionId: 'session-1' });
  assert.ok(registry.get('controller-fixture'));

  now = 4_000;
  registry.touch('controller-fixture');
  assert.ok(registry.get('controller-fixture'));

  now = 10_000; // 6s after the last heartbeat, beyond the 5s expiry
  assert.equal(registry.get('controller-fixture'), null);
  assert.equal(registry.expire({ at: now }), 1);
  assert.equal(registry.count(), 0);
  // Heartbeat on an expired/unknown controller is a no-op, not a resurrection.
  assert.equal(registry.touch('controller-fixture'), null);
});

test('controller registry storage is bounded, versioned, minimal, and fails closed on hydrate', () => {
  const registry = createControllerRegistry({ now: () => 1_000 });
  registry.register({ ...IDENTITY, hermesSessionId: 'session-1' });
  registry.bindSession({ controllerId: 'controller-fixture', hermesSessionId: 'session-1' });

  const snapshot = registry.snapshot();
  assert.equal(snapshot.version, CONTROLLER_REGISTRY_VERSION);
  assert.equal(snapshot.entries.length, 1);
  assert.deepEqual(Object.keys(snapshot.entries[0]).sort(), [
    'boundAt', 'browserProfileId', 'controllerId', 'generation', 'heartbeatAt',
    'hermesSessionId', 'product', 'updatedAt',
  ]);
  // Never tickets, tokens, or credentials.
  const json = JSON.stringify(snapshot);
  for (const forbidden of ['ticket', 'token', 'secret', 'credential']) {
    assert.equal(json.toLowerCase().includes(forbidden), false, `registry snapshot must not contain ${forbidden}`);
  }

  // Corrupt / wrong-version / shape-mismatched hydrate fails closed to empty.
  assert.deepEqual(registry.hydrate(null), []);
  assert.deepEqual(registry.hydrate({ version: 99, entries: [] }), []);
  assert.deepEqual(registry.hydrate({ version: CONTROLLER_REGISTRY_VERSION, entries: 'nope' }), []);
  assert.deepEqual(registry.hydrate({ version: CONTROLLER_REGISTRY_VERSION, entries: [{ controllerId: 'x' }] }), []);

  // A valid snapshot round-trips with generation preserved (restart safety).
  const restored = createControllerRegistry({ now: () => 1_000 });
  restored.hydrate(snapshot);
  assert.equal(restored.generation('controller-fixture'), 2);
  assert.equal(restored.get('controller-fixture').hermesSessionId, 'session-1');
});

test('controller registry stays bounded when many controllers register', () => {
  const registry = createControllerRegistry({ now: () => 1_000 });
  for (let index = 0; index < 20; index += 1) {
    registry.register({
      controllerId: `controller-${index}`,
      browserProfileId: `profile-${index}`,
      product: { id: 'chromium', engine: 'chromium', label: 'Chromium browser' },
      hermesSessionId: `session-${index}`,
    });
  }
  assert.ok(registry.count() <= MAX_CONTROLLER_REGISTRY_ENTRIES);
  assert.equal(registry.snapshot().entries.length, MAX_CONTROLLER_REGISTRY_ENTRIES);
});

test('controller registry defaults are stable heartbeat/expiry bounds and a dedicated storage key', () => {
  assert.equal(CONTROLLER_DEFAULT_HEARTBEAT_MS, 60_000);
  assert.equal(CONTROLLER_DEFAULT_EXPIRY_MS, 5 * 60_000);
  assert.equal(CONTROLLER_REGISTRY_STORAGE_KEY, 'hermesBrowserControllerRegistry');
  assert.equal(CONTROLLER_REGISTRY_VERSION, 1);
});
