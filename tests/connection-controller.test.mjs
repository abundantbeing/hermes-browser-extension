import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONNECTION_STATES,
  createConnectionController,
} from '../extension/lib/connection-controller.mjs';

test('connection controller ignores stale generations', () => {
  const snapshots = [];
  const controller = createConnectionController({
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  const local = controller.begin({ mode: 'local', transport: 'local-api' });
  const cloud = controller.begin({ mode: 'cloud', transport: 'cloud-ticket-ws' });

  assert.equal(controller.transition(local, 'ready'), false);
  assert.equal(controller.transition(cloud, 'ready', { gateway: 'hermes' }), true);
  assert.equal(controller.snapshot.status, 'ready');
  assert.equal(controller.snapshot.mode, 'cloud');
  assert.equal(controller.snapshot.detail.gateway, 'hermes');
  assert.equal(snapshots.length, 3);
});

test('connection controller cancel invalidates in-flight work', () => {
  const controller = createConnectionController();
  const generation = controller.begin({ mode: 'remote', transport: 'remote-api' });
  controller.cancel('settings changed');

  assert.equal(controller.isCurrent(generation), false);
  assert.equal(controller.snapshot.status, CONNECTION_STATES.IDLE);
  assert.equal(controller.snapshot.reason, 'settings changed');
  assert.deepEqual(controller.snapshot.detail, {});
});

test('connection controller rejects unknown states', () => {
  const controller = createConnectionController();
  const generation = controller.begin({ mode: 'local', transport: 'local-api' });
  assert.throws(
    () => controller.transition(generation, 'connected-ish'),
    /Unknown connection state/,
  );
});

test('connection controller freezes snapshots and merges safe detail', () => {
  const controller = createConnectionController();
  const generation = controller.begin({
    mode: 'remote',
    transport: 'remote-dashboard',
    detail: { attempt: 'test' },
  });
  controller.transition(generation, CONNECTION_STATES.DEGRADED, { errorKind: 'network-cors' });

  assert.deepEqual(controller.snapshot.detail, {
    attempt: 'test',
    errorKind: 'network-cors',
  });
  assert.equal(Object.isFrozen(controller.snapshot), true);
  assert.equal(Object.isFrozen(controller.snapshot.detail), true);
});
