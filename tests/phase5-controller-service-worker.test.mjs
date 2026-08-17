import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROLLER_MAX_TERMINAL_OUTBOX,
  CONTROLLER_TERMINAL_OUTBOX_TTL_MS,
  CONTROLLER_WORKER_MESSAGES,
  CONTROLLER_WORKER_STORAGE_KEY,
  createControllerServiceWorker,
} from '../extension/lib/controller-service-worker.mjs';
import {
  CONTROLLER_LIFECYCLE_STORAGE_KEY,
} from '../extension/lib/controller-lifecycle.mjs';
import {
  CONTROLLER_REGISTRY_STORAGE_KEY,
} from '../extension/lib/controller-registry.mjs';
import {
  TAB_LEASE_KINDS,
  TAB_LEASE_OWNERSHIPS,
  TAB_LEASE_STORAGE_KEY,
} from '../extension/lib/tab-leases.mjs';

const PRODUCT = Object.freeze({ id: 'chromium', engine: 'chromium', label: 'Chromium browser' });

function memoryStorage(initial = {}) {
  const state = structuredClone(initial);
  return {
    state,
    area: {
      async get(keys = null) {
        if (keys === null) return structuredClone(state);
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => Object.hasOwn(state, key)).map((key) => [key, structuredClone(state[key])]));
      },
      async set(values) {
        Object.assign(state, structuredClone(values));
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
      },
    },
  };
}

function controllerSettings(overrides = {}) {
  const accessValue = ['fixture', 'access', 'local'].join('-');
  return {
    connectionSchemaVersion: 1,
    connectionMode: 'local',
    connectionTransport: 'local-api',
    gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642',
    apiKey: accessValue,
    activeProfile: 'default',
    sessionId: 'stored-session-1',
    ...overrides,
  };
}

function fakeConnector() {
  const connections = [];
  return {
    connections,
    async connect(options) {
      const sent = [];
      const connection = {
        options,
        sent,
        closed: false,
        async send(frame) { sent.push(structuredClone(frame)); },
        async heartbeat() { return { ok: true }; },
        close() { connection.closed = true; },
        emit(frame) { return options.onFrame(structuredClone(frame)); },
        disconnect(reason = 'fixture disconnect') { connection.closed = true; return options.onClose(new Error(reason)); },
      };
      connections.push(connection);
      return connection;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledConnector() {
  const connections = [];
  const pending = [];
  return {
    connections,
    pending,
    async connect(options) {
      const gate = deferred();
      const connection = {
        options,
        sent: [],
        closed: false,
        async send(frame) { connection.sent.push(structuredClone(frame)); },
        async heartbeat() { return { ok: true }; },
        close() { connection.closed = true; },
        emit(frame) { return options.onFrame(structuredClone(frame)); },
        disconnect(reason = 'fixture disconnect') { connection.closed = true; return options.onClose(new Error(reason)); },
      };
      connections.push(connection);
      pending.push({ gate, connection });
      await gate.promise;
      return connection;
    },
  };
}

function extensionSender({ tabId = null, frameId = 0, extension = true } = {}) {
  return {
    url: extension ? 'chrome-extension://fixture/sidepanel.html' : 'https://example.test/page',
    frameId,
    tab: Number.isInteger(tabId) ? { id: tabId, windowId: 2 } : undefined,
  };
}

function uuids() {
  const values = ['controller-stable', 'profile-stable', 'unexpected-third-id'];
  return () => values.shift() || 'unexpected-id';
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('fresh service worker owns controller identity, registration, leases, and document generations without a side panel', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = fakeConnector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });

  const boot = await worker.boot();
  assert.equal(boot.connected, true);
  assert.equal(connector.connections.length, 1, 'boot connects from service-worker storage without an open panel');
  assert.equal(boot.controllerId, 'controller-stable');
  assert.equal(boot.browserProfileId, 'profile-stable');

  const lease = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownership: TAB_LEASE_OWNERSHIPS.BORROWED,
    ownerId: 'sidepanel-surface-1',
    tabIds: [17],
  }, extensionSender());
  assert.equal(lease.ok, true);
  assert.equal(lease.leases[0].tabId, 17);

  const doc = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 17 }));
  assert.deepEqual(doc, { ok: true, tabId: 17, frameId: 0, documentGeneration: 1 });

  const persisted = storage.state;
  assert.equal(persisted[CONTROLLER_WORKER_STORAGE_KEY].controllerId, 'controller-stable');
  assert.equal(persisted[CONTROLLER_REGISTRY_STORAGE_KEY].entries.length, 1);
  assert.equal(persisted[TAB_LEASE_STORAGE_KEY].entries[0].tabId, 17);
  assert.equal(persisted[CONTROLLER_LIFECYCLE_STORAGE_KEY].version, 1);
  const serialized = JSON.stringify({
    owner: persisted[CONTROLLER_WORKER_STORAGE_KEY],
    registry: persisted[CONTROLLER_REGISTRY_STORAGE_KEY],
    leases: persisted[TAB_LEASE_STORAGE_KEY],
    lifecycle: persisted[CONTROLLER_LIFECYCLE_STORAGE_KEY],
  });
  for (const forbidden of ['fixture-api-credential', 'ticket', 'page text', 'https://example.test/page']) {
    assert.equal(serialized.includes(forbidden), false, `persisted controller state must not include ${forbidden}`);
  }
});

test('fresh MV3 worker suspension preserves durable identity generation leases and parked metadata', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const firstConnector = fakeConnector();
  const first = createControllerServiceWorker({
    storageArea: storage.area,
    connector: firstConnector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });
  const firstBoot = await first.boot();
  await first.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: firstBoot.controllerId,
    tabIds: [23],
  }, extensionSender());
  await first.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 23 }));
  const firstLease = { ...storage.state[TAB_LEASE_STORAGE_KEY].entries[0] };

  storage.state[CONTROLLER_LIFECYCLE_STORAGE_KEY].pending = [
    { commandId: 'interrupted-command', tabId: 23, generation: firstBoot.generation },
  ];

  const secondConnector = fakeConnector();
  const second = createControllerServiceWorker({
    storageArea: storage.area,
    connector: secondConnector,
    product: PRODUCT,
    randomUUID: () => { throw new Error('suspension recovery must preserve durable identity'); },
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 2_000,
  });
  const secondBoot = await second.boot();
  assert.equal(secondBoot.controllerId, firstBoot.controllerId);
  assert.equal(secondBoot.browserProfileId, firstBoot.browserProfileId);
  assert.equal(secondBoot.generation, firstBoot.generation);
  assert.equal(storage.state[TAB_LEASE_STORAGE_KEY].entries[0].leaseId, firstLease.leaseId);
  assert.equal(storage.state[TAB_LEASE_STORAGE_KEY].entries[0].generation, firstLease.generation);
  assert.equal(storage.state[CONTROLLER_WORKER_STORAGE_KEY].documentGenerations['23:0'], 1);
  assert.equal(storage.state[CONTROLLER_LIFECYCLE_STORAGE_KEY].tombstones.includes('interrupted-command'), true);
  assert.equal(storage.state[CONTROLLER_LIFECYCLE_STORAGE_KEY].pending.length, 0);
  assert.equal(secondConnector.connections.length, 1);
  await settle();
  const recoveredTerminal = secondConnector.connections[0].sent.find(
    (frame) => frame?.params?.command_id === 'interrupted-command',
  );
  assert.equal(recoveredTerminal?.method, 'browser.controller.result');
  assert.equal(recoveredTerminal?.params?.error?.code, 'restarted');
});

test('fresh MV3 worker advances generation once when the durable controller route changed', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const first = createControllerServiceWorker({
    storageArea: storage.area,
    connector: fakeConnector(),
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });
  const firstBoot = await first.boot();
  await first.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: firstBoot.controllerId,
    tabIds: [24],
  }, extensionSender());

  storage.state.hermesBrowserSettings = controllerSettings({ gatewayUrl: 'http://127.0.0.1:9864' });
  const second = createControllerServiceWorker({
    storageArea: storage.area,
    connector: fakeConnector(),
    product: PRODUCT,
    randomUUID: () => { throw new Error('route replacement must preserve the durable ids'); },
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 2_000,
  });
  const secondBoot = await second.boot();
  assert.equal(secondBoot.generation, firstBoot.generation + 1);
  assert.equal(storage.state[TAB_LEASE_STORAGE_KEY].entries[0].generation, secondBoot.generation);
});

test('worker routes noop commands through per-tab lifecycle and rejects real actions while control is disabled', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = fakeConnector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });
  const boot = await worker.boot();
  await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: boot.controllerId,
    tabIds: [31],
  }, extensionSender());
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 31 }));

  const connection = connector.connections[0];
  await connection.emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'noop-1',
      action: 'controller.noop',
      arguments: { echo: 'worker-owned' },
      tab_id: 31,
      document_generation: 1,
    },
  });
  await settle();
  assert.deepEqual(connection.sent.at(-1), {
    method: 'browser.controller.result',
    params: {
      command_id: 'noop-1',
      tab_id: 31,
      ok: true,
      result: { echo: 'worker-owned' },
    },
  });

  await connection.emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'disabled-1',
      action: 'browser_navigate',
      arguments: { url: 'https://example.test' },
      tab_id: 31,
      document_generation: 1,
    },
  });
  await settle();
  assert.equal(connection.sent.at(-1).params.error.code, 'action_disabled');
});

test('transport commands reject borrowed and foreign-owned leases before execution', async () => {
  const borrowedStorage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const borrowedConnector = fakeConnector();
  const borrowedWorker = createControllerServiceWorker({
    storageArea: borrowedStorage.area,
    connector: borrowedConnector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });
  await borrowedWorker.boot();
  await borrowedWorker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownership: TAB_LEASE_OWNERSHIPS.BORROWED,
    ownerId: 'sidepanel-surface-1',
    tabIds: [33],
  }, extensionSender());
  await borrowedWorker.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.documentReady },
    extensionSender({ tabId: 33 }),
  );

  const borrowedConnection = borrowedConnector.connections[0];
  await borrowedConnection.emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'borrowed-lease-command',
      action: 'controller.noop',
      arguments: { probe: 'must-not-execute' },
      tab_id: 33,
      document_generation: 1,
    },
  });
  await settle();
  assert.equal(borrowedConnection.sent.at(-1).params.error.code, 'lease_not_owned');
  assert.equal(
    borrowedStorage.state[CONTROLLER_LIFECYCLE_STORAGE_KEY].tombstones.includes('borrowed-lease-command'),
    true,
  );

  const foreignStorage = memoryStorage({
    hermesBrowserSettings: controllerSettings(),
    [TAB_LEASE_STORAGE_KEY]: {
      version: 1,
      entries: [{
        tabId: 34,
        windowId: 2,
        kind: TAB_LEASE_KINDS.THIS_TAB,
        ownership: TAB_LEASE_OWNERSHIPS.OWNED,
        ownerId: 'foreign-controller',
        generation: 1,
        acquiredAt: 1_000,
        expiresAt: 60_000,
        taskSetId: null,
        groupSource: 'native',
      }],
    },
  });
  const foreignConnector = fakeConnector();
  const foreignWorker = createControllerServiceWorker({
    storageArea: foreignStorage.area,
    connector: foreignConnector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 2_000,
  });
  await foreignWorker.boot();
  await foreignWorker.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.documentReady },
    extensionSender({ tabId: 34 }),
  );

  const foreignConnection = foreignConnector.connections[0];
  await foreignConnection.emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'foreign-owned-lease-command',
      action: 'controller.noop',
      arguments: { probe: 'must-not-execute' },
      tab_id: 34,
      document_generation: 1,
    },
  });
  await settle();
  assert.equal(foreignConnection.sent.at(-1).params.error.code, 'lease_not_owned');
  assert.equal(
    foreignStorage.state[CONTROLLER_LIFECYCLE_STORAGE_KEY].tombstones.includes('foreign-owned-lease-command'),
    true,
  );
});

test('late old-socket frames and stale document commands are terminally rejected without execution', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = fakeConnector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });
  const boot = await worker.boot();
  await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: boot.controllerId,
    tabIds: [41],
  }, extensionSender());
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 41 }));
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 41 }));

  const oldConnection = connector.connections[0];
  await oldConnection.disconnect();
  await worker.reconcile({ reason: 'test-reconnect' });
  const newConnection = connector.connections[1];

  await oldConnection.emit({
    method: 'browser.controller.command',
    params: { command_id: 'old-socket', action: 'controller.noop', arguments: {}, tab_id: 41, document_generation: 2 },
  });
  assert.equal(oldConnection.sent.at(-1).params.error.code, 'stale_generation');

  await newConnection.emit({
    method: 'browser.controller.command',
    params: { command_id: 'old-document', action: 'controller.noop', arguments: {}, tab_id: 41, document_generation: 1 },
  });
  assert.equal(newConnection.sent.at(-1).params.error.code, 'stale_document');
  assert.equal(storage.state[CONTROLLER_LIFECYCLE_STORAGE_KEY].tombstones.includes('old-document'), true);
});

test('settings changes rebind immediately, advance registry/worker generations together, and preserve leases safely', async () => {
  const replacementAccessValue = ['replacement', 'access', 'local'].join('-');
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = fakeConnector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });
  const first = await worker.boot();
  await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: first.controllerId,
    tabIds: [47],
  }, extensionSender());
  const firstConnection = connector.connections[0];

  const changed = controllerSettings({
    gatewayUrl: 'http://127.0.0.1:8643',
    apiKey: replacementAccessValue,
    activeProfile: 'alternate',
    sessionId: 'stored-session-2',
  });
  const rebound = await worker.syncSettings(changed);
  assert.equal(firstConnection.closed, true);
  assert.equal(connector.connections.length, 2);
  assert.equal(connector.connections[1].options.identity.hermesSessionId, 'stored-session-2');
  assert.ok(rebound.generation > first.generation);
  assert.equal(storage.state[TAB_LEASE_STORAGE_KEY].entries[0].generation, rebound.generation);
  assert.equal(storage.state[CONTROLLER_REGISTRY_STORAGE_KEY].entries[0].generation, rebound.generation);
  assert.equal(storage.state[CONTROLLER_REGISTRY_STORAGE_KEY].entries[0].hermesSessionId, 'stored-session-2');
  assert.equal(JSON.stringify(storage.state[CONTROLLER_WORKER_STORAGE_KEY]).includes(replacementAccessValue), false);

  const sameRoute = await worker.syncSettings({ ...changed, panelResidencyMode: 'global' });
  assert.equal(sameRoute.generation, rebound.generation);
  assert.equal(connector.connections.length, 2, 'unrelated settings must not churn the controller socket');
});

test('an in-flight old-generation command never sends its terminal result on a rebound socket', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = fakeConnector();
  const execution = deferred();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
    executeCommand: () => execution.promise,
  });
  const boot = await worker.boot();
  await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: boot.controllerId,
    tabIds: [37],
  }, extensionSender());
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 37 }));

  const oldConnection = connector.connections[0];
  const queued = await oldConnection.emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'in-flight-rebind',
      action: 'controller.noop',
      arguments: { probe: 'origin-only' },
      tab_id: 37,
      document_generation: 1,
    },
  });
  assert.equal(queued.ok, true);
  assert.equal(worker.status().pendingCommands, 1, 'fixture command must still be executing before rebind');

  const rebound = await worker.syncSettings(controllerSettings({
    gatewayUrl: 'http://127.0.0.1:8643',
    sessionId: 'stored-session-2',
  }));
  assert.equal(rebound.connected, true);
  const newConnection = connector.connections[1];

  execution.resolve({ ok: true, result: { probe: 'origin-only' } });
  await settle();
  assert.equal(newConnection.sent.length, 0, 'old command result must never cross onto the rebound socket');
  assert.equal(oldConnection.sent.length, 0, 'closed origin socket cannot receive a terminal frame');
  assert.equal(
    storage.state[CONTROLLER_LIFECYCLE_STORAGE_KEY].tombstones.includes('in-flight-rebind'),
    true,
    'restart must persist the replay tombstone before the new route is active',
  );
});

test('heartbeat alarm requires acknowledgement and reconnects the same controller generation', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = fakeConnector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });
  const first = await worker.boot();
  connector.connections[0].heartbeat = async () => { throw new Error('heartbeat timeout'); };

  const reconciled = await worker.reconcile({ reason: 'heartbeat-alarm' });
  assert.equal(connector.connections[0].closed, true);
  assert.equal(connector.connections.length, 2);
  assert.equal(reconciled.generation, first.generation);
  assert.equal(reconciled.connected, true);
});

test('recoverable socket loss preserves controller generation and completes pending work once on the rebound socket', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = fakeConnector();
  const execution = deferred();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
    executeCommand: () => execution.promise,
  });
  const first = await worker.boot();
  const firstConnection = connector.connections[0];

  await firstConnection.emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'survive-reconnect',
      action: 'controller.noop',
      arguments: {},
    },
  });
  await settle();
  assert.equal(worker.status().pendingCommands, 1);

  firstConnection.disconnect('recoverable socket loss');
  const rebound = await worker.reconcile({ reason: 'transport-lost' });

  assert.equal(rebound.controllerId, first.controllerId);
  assert.equal(rebound.browserProfileId, first.browserProfileId);
  assert.equal(rebound.generation, first.generation);
  assert.equal(rebound.pendingCommands, 1);
  assert.equal(connector.connections.length, 2);

  execution.resolve({ ok: true, result: { status: 'survived-reconnect' } });
  await settle();
  await settle();

  assert.equal(firstConnection.sent.length, 0);
  assert.deepEqual(connector.connections[1].sent, [{
    method: 'browser.controller.result',
    params: {
      command_id: 'survive-reconnect',
      tab_id: 2_147_483_647,
      ok: true,
      result: { status: 'survived-reconnect' },
    },
  }]);
  assert.equal(worker.status().pendingCommands, 0);
});

test('stop wins over reconnect and late success while duplicate stop stays idempotent', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = fakeConnector();
  const execution = deferred();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
    executeCommand: () => execution.promise,
  });
  await worker.boot();
  const firstConnection = connector.connections[0];
  await firstConnection.emit({
    method: 'browser.controller.command',
    params: { command_id: 'stop-is-terminal', action: 'controller.noop', arguments: {} },
  });
  await settle();

  const firstStop = await worker.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.stop },
    extensionSender(),
  );
  const duplicateStop = await worker.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.stop },
    extensionSender(),
  );
  assert.equal(firstStop.cancelled, 1);
  assert.equal(duplicateStop.cancelled, 0);
  await settle();

  firstConnection.disconnect('socket lost after stop');
  await worker.reconcile({ reason: 'transport-lost-after-stop' });
  execution.resolve({ ok: true, result: { status: 'late-success-must-not-win' } });
  await settle();
  await settle();

  const terminals = [...firstConnection.sent, ...connector.connections[1].sent]
    .filter((frame) => frame?.params?.command_id === 'stop-is-terminal');
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].params.ok, false);
  assert.equal(terminals[0].params.error.code, 'cancelled');
  assert.doesNotMatch(JSON.stringify(terminals), /late-success-must-not-win/);
  assert.equal(worker.status().pendingCommands, 0);
});

test('acknowledged heartbeat recreates an expired registry record after browser sleep', async () => {
  let now = 1_000;
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = fakeConnector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => now,
  });
  const first = await worker.boot();
  now += (6 * 60 * 1_000);

  const wake = await worker.reconcile({ reason: 'post-sleep-heartbeat' });
  assert.equal(wake.connected, true);
  const registry = storage.state[CONTROLLER_REGISTRY_STORAGE_KEY];
  assert.equal(registry.entries.length, 1);
  assert.equal(registry.entries[0].controllerId, first.controllerId);
  assert.equal(registry.entries[0].hermesSessionId, 'stored-session-1');
  assert.equal(registry.entries[0].generation, wake.generation);
});

test('post-sleep registry recreation preserves the recoverable transport generation', async () => {
  let now = 1_000;
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = fakeConnector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => now,
  });
  const first = await worker.boot();
  connector.connections[0].disconnect();
  const second = await worker.reconcile({ reason: 'transport-lost' });
  assert.equal(second.generation, first.generation);

  now += (6 * 60 * 1_000);
  const wake = await worker.reconcile({ reason: 'post-sleep-recovery' });
  const registry = storage.state[CONTROLLER_REGISTRY_STORAGE_KEY];
  assert.equal(registry.entries.length, 1);
  assert.equal(registry.entries[0].generation, wake.generation);
  assert.equal(registry.entries[0].generation, second.generation);
});

test('settings rebind waits for an in-flight reconnect and always opens the new route', async () => {
  const replacementAccessValue = ['replacement', 'access', 'value'].join('-');
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = controlledConnector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });

  const booting = worker.boot();
  await settle();
  connector.pending[0].gate.resolve();
  await booting;
  connector.connections[0].disconnect();

  const reconnecting = worker.reconcile({ reason: 'socket-close' });
  await settle();
  assert.equal(connector.connections.length, 2);
  const changed = controllerSettings({
    gatewayUrl: 'http://127.0.0.1:8643',
    apiKey: replacementAccessValue,
    sessionId: 'stored-session-2',
  });
  const rebinding = worker.syncSettings(changed);
  await settle();
  assert.equal(connector.connections.length, 2, 'settings mutation must wait for the active reconnect transition');

  connector.pending[1].gate.resolve();
  await reconnecting;
  await settle();
  assert.equal(connector.connections.length, 3, 'completed reconnect must be followed by a new-route connection');
  connector.pending[2].gate.resolve();
  const rebound = await rebinding;
  assert.equal(rebound.connected, true);
  assert.equal(connector.connections[2].options.identity.hermesSessionId, 'stored-session-2');
  assert.equal(connector.connections[2].options.settings.gatewayUrl, 'http://127.0.0.1:8643');
});

test('settings rebind cannot overtake an acknowledged heartbeat transition', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = fakeConnector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });
  await worker.boot();
  const heartbeat = deferred();
  connector.connections[0].heartbeat = () => heartbeat.promise;

  const reconciling = worker.reconcile({ reason: 'heartbeat-alarm' });
  await settle();
  const rebinding = worker.syncSettings(controllerSettings({
    gatewayUrl: 'http://127.0.0.1:8643',
    sessionId: 'stored-session-2',
  }));
  await settle();
  assert.equal(connector.connections.length, 1, 'settings mutation must not close a socket with an in-flight heartbeat');
  assert.equal(connector.connections[0].closed, false);

  heartbeat.resolve({ ok: true });
  await reconciling;
  const rebound = await rebinding;
  assert.equal(connector.connections.length, 2);
  assert.equal(connector.connections[0].closed, true);
  assert.equal(rebound.connected, true);
  assert.equal(connector.connections[1].options.identity.hermesSessionId, 'stored-session-2');
});

test('out-of-order settings refresh reads cannot overwrite the newest controller route', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = fakeConnector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });
  const first = await worker.boot();
  const originalGet = storage.area.get;
  const settingsReads = [];
  storage.area.get = async (keys = null) => {
    if (keys !== 'hermesBrowserSettings') return originalGet(keys);
    const gate = deferred();
    settingsReads.push(gate);
    return gate.promise;
  };

  const staleRefresh = worker.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.settingsRefresh },
    extensionSender(),
  );
  await settle();
  const newestRefresh = worker.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.settingsRefresh },
    extensionSender(),
  );
  await settle();
  assert.equal(settingsReads.length, 2);

  const newestSettings = controllerSettings({
    gatewayUrl: 'http://127.0.0.1:8644',
    sessionId: 'newest-session',
  });
  settingsReads[1].resolve({ hermesBrowserSettings: newestSettings });
  const newest = await newestRefresh;
  assert.ok(newest.generation > first.generation);
  assert.equal(connector.connections.at(-1).options.settings.gatewayUrl, newestSettings.gatewayUrl);
  assert.equal(connector.connections.at(-1).options.identity.hermesSessionId, newestSettings.sessionId);

  settingsReads[0].resolve({
    hermesBrowserSettings: controllerSettings({
      gatewayUrl: 'http://127.0.0.1:8643',
      sessionId: 'stale-session',
    }),
  });
  const stale = await staleRefresh;
  assert.equal(stale.generation, newest.generation);
  assert.equal(connector.connections.length, 2);
  assert.equal(connector.connections.at(-1).closed, false);
  assert.equal(connector.connections.at(-1).options.settings.gatewayUrl, newestSettings.gatewayUrl);
  assert.equal(connector.connections.at(-1).options.identity.hermesSessionId, newestSettings.sessionId);
});

test('transient boot failure can retry after storage recovers', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const originalGet = storage.area.get;
  let failOnce = true;
  storage.area.get = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('transient storage read');
    }
    return originalGet(...args);
  };
  const connector = fakeConnector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });

  await assert.rejects(worker.boot(), /transient storage read/);
  const recovered = await worker.boot();
  assert.equal(recovered.connected, true);
  assert.equal(connector.connections.length, 1);
});

test('disconnected dormant or misconfigured workers retry without generation churn', async () => {
  for (const settings of [controllerSettings({ sessionId: '' }), controllerSettings({ apiKey: '' })]) {
    const storage = memoryStorage({ hermesBrowserSettings: settings });
    const connector = fakeConnector();
    if (settings.apiKey === '') connector.connect = async () => { throw new Error('missing API credential'); };
    const worker = createControllerServiceWorker({
      storageArea: storage.area,
      connector,
      product: PRODUCT,
      randomUUID: uuids(),
      extensionOrigin: 'chrome-extension://fixture',
      now: () => 1_000,
    });
    const boot = await worker.boot();
    const before = boot.generation;
    const retried = await worker.reconcile({ reason: 'heartbeat-alarm' });
    assert.equal(retried.generation, before, 'retrying without an active controller connection must not mint a new epoch');
  }
});

test('terminal state persists before send failure and retries only on the same controller route', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = fakeConnector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });
  const boot = await worker.boot();
  await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: boot.controllerId,
    tabIds: [61],
  }, extensionSender());
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 61 }));
  const origin = connector.connections[0];
  origin.send = async () => { throw new Error('socket closed'); };

  await origin.emit({
    method: 'browser.controller.command',
    params: { command_id: 'terminal-send-failure', action: 'controller.noop', arguments: {}, tab_id: 61, document_generation: 1 },
  });
  await settle();
  assert.equal(storage.state[CONTROLLER_LIFECYCLE_STORAGE_KEY].tombstones.includes('terminal-send-failure'), true);
  assert.equal(storage.state[CONTROLLER_WORKER_STORAGE_KEY].terminalOutbox.length, 1);
  assert.deepEqual(Object.keys(storage.state[CONTROLLER_WORKER_STORAGE_KEY].terminalOutbox[0]).sort(), [
    'commandId', 'createdAt', 'errorCode', 'expiresAt', 'ok', 'routeKey', 'tabId',
  ]);

  origin.disconnect();
  const reconnected = await worker.reconcile({ reason: 'same-route-reconnect' });
  assert.equal(reconnected.connected, true);
  await settle();
  assert.equal(connector.connections[1].sent.some((frame) => frame?.params?.command_id === 'terminal-send-failure'), true);
  assert.equal(storage.state[CONTROLLER_WORKER_STORAGE_KEY].terminalOutbox.length, 0);
});

test('terminal outbox uses collision-free route scopes and recovers lost success payloads as interrupted delivery', async () => {
  const collisionSessions = ['collision-session-022789', 'collision-session-239192'];
  const routeKeys = [];
  for (const sessionId of collisionSessions) {
    const storage = memoryStorage({ hermesBrowserSettings: controllerSettings({ sessionId }) });
    const connector = fakeConnector();
    const worker = createControllerServiceWorker({
      storageArea: storage.area,
      connector,
      product: PRODUCT,
      randomUUID: uuids(),
      extensionOrigin: 'chrome-extension://fixture',
      now: () => 1_000,
    });
    const boot = await worker.boot();
    await worker.handleMessage({
      type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
      kind: TAB_LEASE_KINDS.THIS_TAB,
      ownership: TAB_LEASE_OWNERSHIPS.OWNED,
      ownerId: boot.controllerId,
      tabIds: [62],
    }, extensionSender());
    await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 62 }));
    const origin = connector.connections[0];
    origin.send = async () => { throw new Error('socket closed'); };
    await origin.emit({
      method: 'browser.controller.command',
      params: { command_id: `lost-result-${sessionId}`, action: 'controller.noop', arguments: { probe: sessionId }, tab_id: 62, document_generation: 1 },
    });
    await settle();
    routeKeys.push(storage.state[CONTROLLER_WORKER_STORAGE_KEY].terminalOutbox[0].routeKey);
    origin.disconnect();
    await worker.reconcile({ reason: 'same-route-reconnect' });
    await settle();
    const recovered = connector.connections[1].sent.find((frame) => frame?.params?.command_id === `lost-result-${sessionId}`);
    assert.equal(recovered?.params?.ok, false);
    assert.equal(recovered?.params?.error?.code, 'delivery_interrupted');
  }
  assert.notEqual(routeKeys[0], routeKeys[1], 'different durable routes must never alias to one recovery scope');
});

test('terminal outbox is capped at eight metadata-only records and expires stale delivery state', async () => {
  let now = 1_000;
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = fakeConnector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => now,
  });
  await worker.boot();
  const origin = connector.connections[0];
  origin.send = async () => { throw new Error('socket closed'); };
  for (let index = 0; index < 10; index += 1) {
    await origin.emit({
      method: 'browser.controller.command',
      params: {
        command_id: `bounded-terminal-${index}`,
        action: 'controller.noop',
        arguments: { typed: `forbidden-${index}` },
      },
    });
    await settle();
  }
  const outbox = storage.state[CONTROLLER_WORKER_STORAGE_KEY].terminalOutbox;
  assert.equal(CONTROLLER_MAX_TERMINAL_OUTBOX, 8);
  assert.equal(outbox.length, CONTROLLER_MAX_TERMINAL_OUTBOX);
  assert.equal(outbox[0].commandId, 'bounded-terminal-2');
  assert.deepEqual(Object.keys(outbox[0]).sort(), [
    'commandId', 'createdAt', 'errorCode', 'expiresAt', 'ok', 'routeKey', 'tabId',
  ]);
  assert.doesNotMatch(JSON.stringify(outbox), /forbidden-|arguments|typed/);

  now += CONTROLLER_TERMINAL_OUTBOX_TTL_MS + 1;
  const recoveredConnector = fakeConnector();
  const recovered = createControllerServiceWorker({
    storageArea: storage.area,
    connector: recoveredConnector,
    product: PRODUCT,
    randomUUID: () => { throw new Error('recovery must preserve identity'); },
    extensionOrigin: 'chrome-extension://fixture',
    now: () => now,
  });
  await recovered.boot();
  assert.equal(storage.state[CONTROLLER_WORKER_STORAGE_KEY].terminalOutbox.length, 0);
  assert.equal(recoveredConnector.connections[0].sent.length, 0);
});

test('tab removal drops lease and document authority while navigation invalidates the old document generation', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = fakeConnector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });
  const boot = await worker.boot();
  await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: boot.controllerId,
    tabIds: [71, 72],
  }, extensionSender());
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 71 }));
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 72 }));

  await worker.handleTabUpdated(71, { status: 'loading', url: 'https://example.test/next' });
  assert.equal(storage.state[CONTROLLER_WORKER_STORAGE_KEY].documentGenerations['71:0'], 2);
  await worker.handleTabRemoved(72);
  assert.equal(storage.state[TAB_LEASE_STORAGE_KEY].entries.some((entry) => entry.tabId === 72), false);
  assert.equal(Object.keys(storage.state[CONTROLLER_WORKER_STORAGE_KEY].documentGenerations).some((key) => key.startsWith('72:')), false);
});

test('runtime messages fail closed by sender and wake/reconcile survives without a sidepanel', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: controllerSettings() });
  const connector = fakeConnector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });
  await worker.boot();

  const denied = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownerId: 'hostile-page',
    tabIds: [51],
  }, extensionSender({ extension: false }));
  assert.deepEqual(denied, { ok: false, error: 'untrusted_sender' });

  await connector.connections[0].disconnect();
  const wake = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.wake }, extensionSender({ tabId: 51, extension: false }));
  assert.equal(wake.ok, true, 'content-script wake is allowed but cannot mutate leases');
  assert.equal(connector.connections.length, 2);
  const status = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.status }, extensionSender({ extension: false }));
  assert.equal(status.connected, true);
});
