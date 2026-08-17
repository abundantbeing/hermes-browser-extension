import assert from 'node:assert/strict';
import test from 'node:test';

import { createControllerLifecycle } from '../extension/lib/controller-lifecycle.mjs';
import {
  CONTROLLER_WORKER_MESSAGES,
  createControllerServiceWorker,
} from '../extension/lib/controller-service-worker.mjs';

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    area: {
      async get(keys) {
        if (!keys) return structuredClone(data);
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => Object.hasOwn(data, key)).map((key) => [key, structuredClone(data[key])]));
      },
      async set(values) { Object.assign(data, structuredClone(values)); },
    },
  };
}

function uuids() {
  const values = ['controller-ui', 'profile-ui'];
  return () => values.shift() || `uuid-${values.length}`;
}

const PRODUCT = Object.freeze({ id: 'edge', engine: 'chromium', label: 'Microsoft Edge' });
const TRUSTED = Object.freeze({ url: 'chrome-extension://fixture/sidepanel.html' });

function settings(overrides = {}) {
  return {
    connectionTransport: 'local-api',
    gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642',
    apiKey: ['phase6', 'fixture', 'value'].join('-'),
    sessionId: 'phase6-ui-session',
    browserControlEnabled: true,
    browserControlPaused: false,
    ...overrides,
  };
}

function connector() {
  const connections = [];
  return {
    connections,
    async connect(options) {
      const connection = {
        options,
        sent: [],
        async send(frame) { this.sent.push(structuredClone(frame)); },
        async heartbeat() {},
        close() {},
        async emit(frame) { return options.onFrame(frame); },
      };
      connections.push(connection);
      return connection;
    },
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('Phase 6 lifecycle stop-all terminalizes active and queued commands exactly once', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const terminals = [];
  const lifecycle = createControllerLifecycle({
    execute: async (_frame, { signal }) => {
      await Promise.race([
        gate,
        new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
      ]);
      return { ok: true };
    },
  });
  lifecycle.onTerminal((terminal) => terminals.push(terminal));
  lifecycle.enqueueCommand({ frame: { command_id: 'active', action: 'controller.noop' }, tabId: 41 });
  lifecycle.enqueueCommand({ frame: { command_id: 'queued', action: 'controller.noop' }, tabId: 41 });
  await settle();

  const stopped = lifecycle.cancelAll();
  assert.deepEqual(stopped, { ok: true, cancelled: 2 });
  release();
  await settle();
  assert.deepEqual(
    terminals
      .map((terminal) => [terminal.params.command_id, terminal.params.error.code])
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      ['active', 'cancelled'],
      ['queued', 'cancelled'],
    ],
  );
  assert.equal(lifecycle.pendingCount(), 0);
});

test('Phase 6 trusted worker controls pause new actions, resume, stop, and detach owned leases', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async (_frame, { signal }) => {
      await Promise.race([
        gate,
        new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
      ]);
      return { ok: true };
    },
  });
  const boot = await worker.boot();
  const lease = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: 'this-tab',
    ownership: 'owned',
    ownerId: boot.controllerId,
    tabIds: [44],
  }, TRUSTED);
  assert.equal(lease.ok, true);
  const ready = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady, tabId: 44 }, { tab: { id: 44 }, frameId: 0 });

  const paused = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.pause }, TRUSTED);
  assert.equal(paused.ok, true);
  assert.equal(paused.paused, true);
  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: { command_id: 'paused-command', action: 'browser_scroll', arguments: { direction: 'down' }, tab_id: 44, document_generation: ready.documentGeneration },
  });
  await settle();
  assert.equal(transport.connections[0].sent.at(-1).params.error.code, 'controller_paused');

  const resumed = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.resume }, TRUSTED);
  assert.equal(resumed.paused, false);
  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: { command_id: 'running-command', action: 'browser_scroll', arguments: { direction: 'down' }, tab_id: 44, document_generation: ready.documentGeneration },
  });
  await settle();
  assert.equal(worker.status().activeAction.commandId, 'running-command');

  const stopped = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.stop }, TRUSTED);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.cancelled, 1);
  release();
  await settle();
  assert.equal(worker.status().pendingCommands, 0);

  const detached = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.detach }, TRUSTED);
  assert.equal(detached.ok, true);
  assert.deepEqual(detached.releasedTabIds, [44]);
  assert.deepEqual(worker.status().leasedTabIds, []);
  assert.equal(worker.status().pendingApprovals, 0);
});

test('Phase 6 control mutations reject webpage senders', async () => {
  const worker = createControllerServiceWorker({
    storageArea: memoryStorage({ hermesBrowserSettings: settings() }).area,
    connector: connector(),
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => ({ ok: true }),
  });
  await worker.boot();
  for (const type of [
    CONTROLLER_WORKER_MESSAGES.pause,
    CONTROLLER_WORKER_MESSAGES.resume,
    CONTROLLER_WORKER_MESSAGES.stop,
    CONTROLLER_WORKER_MESSAGES.detach,
    CONTROLLER_WORKER_MESSAGES.approvalReject,
  ]) {
    assert.deepEqual(await worker.handleMessage({ type }, { url: 'https://attacker.example/page' }), { ok: false, error: 'untrusted_sender' });
  }
});

test('Phase 6 Detach runs on the serialized settings transition chain', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const originalConnect = transport.connect;
  const events = [];
  let releaseConnect;
  const connectGate = new Promise((resolve) => { releaseConnect = resolve; });
  let connectCount = 0;
  transport.connect = async (options) => {
    connectCount += 1;
    if (connectCount === 2) {
      events.push('refresh-start');
      await connectGate;
      events.push('refresh-end');
    }
    return originalConnect.call(transport, options);
  };
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => ({ ok: true }),
  });
  await worker.boot();

  const refreshedSettings = settings({ activeProfile: 'phase6-next-profile' });
  const refresh = worker.syncSettings(refreshedSettings).then(() => events.push('refresh-done'));
  await settle();
  assert.deepEqual(events, ['refresh-start']);
  const detach = worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.detach }, TRUSTED)
    .then(() => events.push('detach-done'));
  await settle();
  assert.deepEqual(events, ['refresh-start']);
  releaseConnect();
  await Promise.all([refresh, detach]);
  assert.deepEqual(events, ['refresh-start', 'refresh-end', 'refresh-done', 'detach-done']);
  assert.equal(storage.data.hermesBrowserSettings.browserControlEnabled, false);
  assert.deepEqual(worker.status().leasedTabIds, []);
});
