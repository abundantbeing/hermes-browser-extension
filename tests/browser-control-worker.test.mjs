import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROLLER_WORKER_MESSAGES,
  createControllerServiceWorker,
} from '../extension/lib/controller-service-worker.mjs';
import {
  TAB_LEASE_DEFAULT_TTL_MS,
  TAB_LEASE_KINDS,
  TAB_LEASE_OWNERSHIPS,
} from '../extension/lib/tab-leases.mjs';
import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';

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
      async set(values) { Object.assign(state, structuredClone(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; },
    },
  };
}

function settings(overrides = {}) {
  return {
    connectionSchemaVersion: 1,
    connectionMode: 'local',
    connectionTransport: 'local-api',
    gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642',
    apiKey: ['phase6', 'fixture', 'route'].join('-'),
    activeProfile: 'default',
    sessionId: 'phase6-session',
    browserControlEnabled: true,
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
        async send(frame) { connection.sent.push(structuredClone(frame)); },
        async heartbeat() { return { ok: true }; },
        close() {},
        emit(frame) { return options.onFrame(structuredClone(frame)); },
        disconnect(reason = 'fixture disconnect') { return options.onClose(new Error(reason)); },
      };
      connections.push(connection);
      return connection;
    },
  };
}

function extensionSender({ tabId = null, extension = true } = {}) {
  return {
    url: extension ? 'chrome-extension://fixture/sidepanel.html' : 'https://example.test/page',
    frameId: 0,
    tab: Number.isInteger(tabId) ? { id: tabId, windowId: 2 } : undefined,
  };
}

function uuids() {
  const values = ['controller-phase6', 'profile-phase6'];
  return () => values.shift() || 'unexpected';
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function ownedReady(worker, tabId, { windowId = null } = {}) {
  const boot = worker.status();
  assert.equal((await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: boot.controllerId,
    tabIds: [tabId],
    ...(Number(windowId) > 0 ? { windowId: Number(windowId) } : {}),
  }, extensionSender())).ok, true);
  const ready = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId }));
  return { boot, documentGeneration: ready.documentGeneration };
}

async function waitingApprovalWorker() {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const approvals = createBrowserControlApprovalStore();
  let sideEffects = 0;
  const executor = createBrowserControlExecutor({
    adapter: {
      contract: { enabled: true, actions: ['browser_press'] },
      async inspect() { return { currentUrl: 'https://example.test/form' }; },
      async execute() { sideEffects += 1; return { status: 'pressed' }; },
    },
    approvals,
    refs: createBrowserControlRefStore(),
  });
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    approvalStore: approvals,
    executeBrowserCommand: (frame, context) => executor.execute(frame, context),
  });
  await worker.boot();
  const ready = await ownedReady(worker, 81);
  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'approval-race',
      approval_nonce: 'approval-race-nonce',
      action: 'browser_press',
      arguments: { key: 'Enter' },
      tab_id: 81,
      document_generation: ready.documentGeneration,
    },
  });
  await settle();
  const pending = worker.status().pendingApproval;
  return {
    worker,
    transport,
    pending,
    grant: () => worker.handleMessage({
      type: CONTROLLER_WORKER_MESSAGES.approvalGrant,
      ...pending,
    }, extensionSender()),
    sideEffects: () => sideEffects,
  };
}

test('controller session identity follows the active transport instead of a stale dashboard binding', async () => {
  const localTransport = connector();
  const localWorker = createControllerServiceWorker({
    storageArea: memoryStorage({
      hermesBrowserSettings: settings({
        connectionTransport: 'local-api',
        sessionId: 'current-local-session',
        remoteDashboardSession: {
          storedSessionId: 'stale-dashboard-session',
          gatewayUrl: 'https://dashboard.example.test',
        },
      }),
    }).area,
    connector: localTransport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
  });
  await localWorker.boot();
  assert.equal(
    localTransport.connections[0].options.identity.hermesSessionId,
    'current-local-session',
  );

  const cloudTransport = connector();
  const cloudWorker = createControllerServiceWorker({
    storageArea: memoryStorage({
      hermesBrowserSettings: settings({
        connectionMode: 'cloud',
        connectionTransport: 'cloud-ticket-ws',
        gatewayMode: 'remote-dashboard',
        gatewayUrl: 'https://dashboard.example.test',
        sessionId: 'durable-fallback-session',
        remoteDashboardSession: {
          storedSessionId: 'current-dashboard-session',
          gatewayUrl: 'https://dashboard.example.test',
        },
      }),
    }).area,
    connector: cloudTransport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
  });
  await cloudWorker.boot();
  assert.equal(
    cloudTransport.connections[0].options.identity.hermesSessionId,
    'current-dashboard-session',
  );
});

test('Phase 6 worker executes enabled real actions with exact worker-owned scope and minimal live status', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const calls = [];
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
    getControllerCapabilities: async (currentSettings) => currentSettings.browserControlEnabled
      ? ['controller.noop', 'browser_navigate']
      : ['controller.noop'],
    executeBrowserCommand: async (frame, context) => {
      calls.push({
        frame: structuredClone(frame),
        scope: structuredClone(context.scope),
        settings: structuredClone(context.settings),
      });
      return { ok: true, result: { status: 'navigated', url: frame.arguments.url } };
    },
  });
  const boot = await worker.boot();
  const ready = await ownedReady(worker, 77);
  const connection = transport.connections[0];
  await connection.emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'phase6-nav-1',
      action: 'browser_navigate',
      arguments: { url: 'https://example.test/next' },
      tab_id: 77,
      frame_id: 0,
      document_generation: ready.documentGeneration,
    },
  });
  await settle();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].scope, {
    controllerId: boot.controllerId,
    leaseOwnerId: boot.controllerId,
    leaseId: `${boot.controllerId}:77:1000`,
    leaseGeneration: boot.generation,
    tabId: 77,
    frameId: 0,
    documentGeneration: ready.documentGeneration,
  });
  assert.equal(calls[0].settings.browserControlEnabled, true);
  assert.deepEqual(transport.connections[0].options.identity.capabilities, ['controller.noop', 'browser_navigate']);
  assert.deepEqual(connection.sent.at(-1), {
    method: 'browser.controller.result',
    params: {
      command_id: 'phase6-nav-1',
      tab_id: 77,
      ok: true,
      result: { status: 'navigated', url: 'https://example.test/next' },
    },
  });
  const status = worker.status();
  assert.equal(status.controlEnabled, true);
  assert.equal(status.activeAction, null);
  assert.equal('arguments' in status, false);
  assert.doesNotMatch(JSON.stringify(status), /example\.test\/next/);
});

test('successful exact-target commands renew the owned lease idle TTL and persist it', async () => {
  let now = 0;
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => now,
    executeBrowserCommand: async () => ({ ok: true, result: { status: 'scrolled' } }),
  });
  await worker.boot();
  const ready = await ownedReady(worker, 76);
  const initialLease = structuredClone(storage.state.hermesBrowserTabLeases.entries[0]);

  now = TAB_LEASE_DEFAULT_TTL_MS - 1_000;
  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'renew-owned-lease',
      action: 'browser_scroll',
      arguments: { direction: 'down' },
      tab_id: 76,
      frame_id: 0,
      document_generation: ready.documentGeneration,
    },
  });
  await settle();

  const renewedLease = storage.state.hermesBrowserTabLeases.entries[0];
  assert.equal(renewedLease.leaseId, initialLease.leaseId);
  assert.equal(renewedLease.acquiredAt, initialLease.acquiredAt);
  assert.equal(renewedLease.expiresAt, now + TAB_LEASE_DEFAULT_TTL_MS);
  now = TAB_LEASE_DEFAULT_TTL_MS + 1;
  await worker.reconcile({ reason: 'post-original-idle-deadline' });
  assert.deepEqual(worker.status().leasedTabIds, [76]);
});

test('Phase 6 worker keeps real actions disabled without explicit user control setting', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: settings({ browserControlEnabled: false }) });
  const transport = connector();
  let calls = 0;
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => { calls += 1; return { ok: true }; },
  });
  await worker.boot();
  const ready = await ownedReady(worker, 78);
  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: { command_id: 'disabled-real', action: 'browser_scroll', arguments: { direction: 'down' }, tab_id: 78, document_generation: ready.documentGeneration },
  });
  await settle();
  assert.equal(calls, 0);
  assert.equal(transport.connections[0].sent.at(-1).params.error.code, 'action_disabled');
});

test('Phase 6 worker revalidates lease and document immediately before queued side effects', async () => {
  let releaseHead;
  const headGate = new Promise((resolve) => { releaseHead = resolve; });
  let releaseSecondHead;
  const secondGate = new Promise((resolve) => { releaseSecondHead = resolve; });
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const executed = [];
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async (frame) => {
      executed.push(frame.command_id);
      if (frame.command_id === 'head') await headGate;
      if (frame.command_id === 'lease-head') await secondGate;
      return { ok: true, result: { status: 'scrolled' } };
    },
  });
  const boot = await worker.boot();
  const ready = await ownedReady(worker, 79);
  const connection = transport.connections[0];
  await connection.emit({ method: 'browser.controller.command', params: { command_id: 'head', action: 'browser_scroll', arguments: { direction: 'down' }, tab_id: 79, document_generation: ready.documentGeneration } });
  await connection.emit({ method: 'browser.controller.command', params: { command_id: 'stale-tail', action: 'browser_scroll', arguments: { direction: 'down' }, tab_id: 79, document_generation: ready.documentGeneration } });
  await worker.handleTabUpdated(79, { status: 'loading', url: 'https://example.test/changed' });
  releaseHead();
  await settle();
  await settle();

  assert.deepEqual(executed, ['head']);
  const tail = connection.sent.find((frame) => frame.params.command_id === 'stale-tail');
  assert.equal(tail.params.error.code, 'stale_document');

  const nextReady = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 79 }));
  await connection.emit({ method: 'browser.controller.command', params: { command_id: 'lease-head', action: 'browser_scroll', arguments: { direction: 'down' }, tab_id: 79, document_generation: nextReady.documentGeneration } });
  await connection.emit({ method: 'browser.controller.command', params: { command_id: 'lease-tail', action: 'browser_scroll', arguments: { direction: 'down' }, tab_id: 79, document_generation: nextReady.documentGeneration } });
  await settle();
  assert.equal(executed.includes('lease-head'), true);
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.leaseRelease, ownerId: boot.controllerId, tabIds: [79] }, extensionSender());
  releaseSecondHead();
  await settle();
  await settle();
  const leaseTail = connection.sent.find((frame) => frame.params.command_id === 'lease-tail');
  assert.equal(leaseTail.params.error.code, 'lease_required');
});

test('Phase 6 approval grants require a trusted extension sender and bind exact command action and document', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const approvals = createBrowserControlApprovalStore();
  let sideEffects = 0;
  const executor = createBrowserControlExecutor({
    adapter: {
      contract: { enabled: true, actions: ['browser_press'] },
      async inspect() { return { currentUrl: 'https://example.test/form' }; },
      async execute() { sideEffects += 1; return { status: 'pressed' }; },
    },
    approvals,
    refs: createBrowserControlRefStore(),
  });
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    approvalStore: approvals,
    executeBrowserCommand: (frame, context) => executor.execute(frame, context),
  });
  await worker.boot();
  const ready = await ownedReady(worker, 80);
  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'press-1',
      action: 'browser_press',
      arguments: { key: 'Enter' },
      tab_id: 80,
      document_generation: ready.documentGeneration,
    },
  });
  await settle();
  assert.equal(worker.status().pendingApprovals, 1);
  assert.equal(sideEffects, 0);
  const pendingApproval = worker.status().pendingApproval;
  const request = {
    type: CONTROLLER_WORKER_MESSAGES.approvalGrant,
    ...pendingApproval,
    documentGeneration: ready.documentGeneration,
  };
  assert.equal((await worker.handleMessage(request, extensionSender({ extension: false }))).error, 'untrusted_sender');
  assert.equal((await worker.handleMessage(request, extensionSender())).ok, true);
  await settle();
  assert.equal(worker.status().pendingApprovals, 0);
  assert.equal(sideEffects, 1);
  assert.deepEqual(transport.connections[0].sent.at(-1).params, {
    command_id: 'press-1',
    tab_id: 80,
    ok: true,
    result: { status: 'pressed' },
  });
});

test('recoverable reconnect preserves a paused approval without auto-approving it', async () => {
  const fixture = await waitingApprovalWorker();
  fixture.transport.connections[0].disconnect('recoverable approval reconnect');
  const rebound = await fixture.worker.reconcile({ reason: 'transport-lost' });
  assert.equal(rebound.pendingApprovals, 1);
  assert.deepEqual(fixture.worker.status().pendingApproval, fixture.pending);
  assert.equal(fixture.sideEffects(), 0);
  assert.equal((await fixture.grant()).ok, true);
  await settle();
  assert.equal(fixture.sideEffects(), 1);
});

test('stop detach and settings replacement reject late approval decisions without side effects', async () => {
  for (const transition of ['stop', 'detach', 'settings']) {
    const fixture = await waitingApprovalWorker();
    if (transition === 'settings') {
      await fixture.worker.syncSettings(settings({ gatewayUrl: 'http://127.0.0.1:8643' }));
    } else {
      await fixture.worker.handleMessage({
        type: transition === 'stop' ? CONTROLLER_WORKER_MESSAGES.stop : CONTROLLER_WORKER_MESSAGES.detach,
      }, extensionSender());
    }
    await settle();
    const late = await fixture.grant();
    assert.equal(late.ok, false, transition);
    assert.match(String(late.error), /^(approval_(missing|terminal)|lease_required)$/, transition);
    assert.equal(fixture.sideEffects(), 0, transition);
  }
});

test('debugger detach pauses only the affected lease and target close removes it without automatic reattach', async () => {
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
    executeBrowserCommand: async (_frame, context) => {
      await Promise.race([
        gate,
        new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true })),
      ]);
      return { ok: true, result: { late: true } };
    },
  });
  const boot = await worker.boot();
  assert.equal((await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.SELECTED_TABS,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: boot.controllerId,
    tabIds: [811, 812],
  }, extensionSender())).ok, true);
  const ready = await worker.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.documentReady },
    extensionSender({ tabId: 811 }),
  );
  await worker.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.documentReady },
    extensionSender({ tabId: 812 }),
  );
  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'debugger-detach-active',
      action: 'browser_scroll',
      arguments: { direction: 'down' },
      tab_id: 811,
      document_generation: ready.documentGeneration,
    },
  });
  await settle();

  const paused = await worker.handleDebuggerDetach({
    tabId: 811,
    reason: 'replaced_with_devtools',
    recoverable: false,
  });
  assert.deepEqual(paused, {
    ok: true,
    tabId: 811,
    reason: 'replaced_with_devtools',
    paused: true,
    leaseRemoved: false,
    cancelled: 1,
  });
  assert.equal(worker.status().pausedLeases['811'], 'replaced_with_devtools');
  assert.equal(worker.status().pausedLeases['812'], undefined);
  await settle();
  assert.equal(transport.connections[0].sent.at(-1).params.error.code, 'cancelled');

  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'debugger-detach-rejected',
      action: 'browser_scroll',
      arguments: { direction: 'down' },
      tab_id: 811,
      document_generation: ready.documentGeneration,
    },
  });
  assert.equal(transport.connections[0].sent.at(-1).params.error.code, 'debugger_detached');

  const closed = await worker.handleDebuggerDetach({
    tabId: 811,
    reason: 'target_closed',
    recoverable: false,
  });
  assert.equal(closed.leaseRemoved, true);
  assert.equal(worker.status().leasedTabIds.length, 1);
  assert.equal(worker.status().pausedLeases['811'], undefined);

  release();
  await worker.syncSettings(settings({ gatewayUrl: 'http://127.0.0.1:8649' }));
  assert.deepEqual(worker.status().pausedLeases, {});
});

test('Phase 6 worker adopts created tabs and releases closed tabs under controller ownership', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const calls = [];
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async (frame, context) => {
      calls.push({
        frame: structuredClone(frame),
        context: {
          scope: structuredClone(context.scope),
          ownedTabIds: [...context.ownedTabIds],
          currentWindowId: context.currentWindowId,
        },
      });
      if (frame.action === 'browser_tab_create') {
        return { ok: true, result: { tab: { id: 912, windowId: 2, active: false, url: 'https://example.test/new' } } };
      }
      return { ok: true, result: { status: 'tab-closed' } };
    },
  });
  await worker.boot();
  const ready = await ownedReady(worker, 911, { windowId: 2 });
  const emit = (params) => transport.connections[0].emit({ method: 'browser.controller.command', params: {
    ...params,
    tab_id: 911,
    document_generation: ready.documentGeneration,
  } });

  await emit({ command_id: 'create-912', action: 'browser_tab_create', arguments: {
    url: 'https://example.test/new', active: false, lease_kind: TAB_LEASE_KINDS.TASK_SET, task_set_id: 'task-912',
  } });
  await settle();
  assert.equal(calls.length, 1, JSON.stringify(transport.connections[0].sent.at(-1)));
  assert.equal(calls[0].frame.action, 'browser_tab_create');
  assert.equal(transport.connections[0].sent.at(-1).params.ok, true);
  assert.deepEqual(worker.status().leasedTabIds, [911, 912]);
  assert.equal(calls[0].context.currentWindowId, 2);
  assert.deepEqual(calls[0].context.ownedTabIds, [911]);

  await emit({ command_id: 'close-912', action: 'browser_tab_close', arguments: { tab_id: 912 } });
  await settle();
  assert.deepEqual(worker.status().leasedTabIds, [911]);
  assert.deepEqual(calls[1].context.ownedTabIds, [911, 912]);
});

test('broker-v1 commands without target metadata resolve only one exact owned tab', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const calls = [];
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async (frame, context) => {
      calls.push({ frame: structuredClone(frame), scope: structuredClone(context.scope) });
      return { ok: true, result: { status: 'navigated', url: frame.arguments.url } };
    },
  });
  await worker.boot();
  const ready = await ownedReady(worker, 901);
  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'broker-v1-single',
      action: 'browser_navigate',
      arguments: { url: 'https://example.test/broker-v1' },
    },
  });
  await settle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].frame.tab_id, 901);
  assert.equal(calls[0].frame.document_generation, ready.documentGeneration);
  assert.equal(calls[0].scope.tabId, 901);
  assert.equal(transport.connections[0].sent.at(-1).params.ok, true);
});

test('broker-v1 commands without target metadata fail closed when more than one owned tab is live', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  let calls = 0;
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => { calls += 1; return { ok: true }; },
  });
  const boot = await worker.boot();
  assert.equal((await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.SELECTED_TABS,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: boot.controllerId,
    tabIds: [902, 903],
  }, extensionSender())).ok, true);
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 902 }));
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 903 }));
  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'broker-v1-ambiguous',
      action: 'browser_scroll',
      arguments: { direction: 'down' },
    },
  });
  await settle();

  assert.equal(calls, 0);
  assert.equal(transport.connections[0].sent.at(-1).params.error.code, 'ambiguous_target');
});

test('broker-v1 commands bind an explicit owned source tab to its authoritative document generation', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const calls = [];
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async (frame, context) => { calls.push({ frame, context }); return { ok: true }; },
  });
  const boot = await worker.boot();
  assert.equal((await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.SELECTED_TABS,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: boot.controllerId,
    tabIds: [904, 905],
  }, extensionSender())).ok, true);
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 904 }));
  const ready = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 905 }));
  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'broker-v1-exact-source',
      action: 'browser_scroll',
      arguments: { direction: 'down', source_tab_id: 905 },
      tab_id: 905,
    },
  });
  await settle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].frame.tab_id, 905);
  assert.equal(calls[0].frame.document_generation, ready.documentGeneration);
  assert.equal(calls[0].context.scope.tabId, 905);
  assert.equal(transport.connections[0].sent.at(-1).params.ok, true);
});

test('worker keeps retrying the controller connection on status polls after a failed first connect', async () => {
  const clock = { value: 0 };
  let attempts = 0;
  const flakyConnector = {
    async connect() {
      attempts += 1;
      if (attempts < 3) throw new Error('broker unavailable');
      return { send: async () => true, close: async () => true };
    },
  };
  const worker = createControllerServiceWorker({
    storageArea: memoryStorage({ hermesBrowserSettings: settings() }).area,
    connector: flakyConnector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => ({ ok: true, result: {} }),
    getControllerCapabilities: async () => ['browser_snapshot'],
    now: () => clock.value,
  });
  const status = () => worker.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.status },
    extensionSender(),
  );

  const first = await status();
  assert.equal(first.connected, false);
  assert.equal(attempts, 1);

  const sameTick = await status();
  assert.equal(sameTick.connected, false);
  assert.equal(attempts, 1);

  clock.value = 7_000;
  const retried = await status();
  await settle();
  assert.equal(retried.connected, false);
  assert.equal(attempts, 2);

  clock.value = 14_000;
  await status();
  await settle();
  assert.equal(attempts, 3);
  const reconnected = await status();
  assert.equal(reconnected.connected, true);
});

test('worker surfaces the bounded last connect failure and skips reconnect kicks without a session identity', async () => {
  const clock = { value: 0 };
  let attempts = 0;
  const failingConnector = {
    async connect() {
      attempts += 1;
      throw new Error('Controller registration failed (HTTP 401).');
    },
  };
  const missingSession = createControllerServiceWorker({
    storageArea: memoryStorage({
      hermesBrowserSettings: settings({ sessionId: '' }),
    }).area,
    connector: failingConnector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => ({ ok: true, result: {} }),
    now: () => clock.value,
  });
  const dormant = await missingSession.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.status },
    extensionSender(),
  );
  assert.equal(dormant.connected, false);
  assert.equal(dormant.lastConnectFailure.reason, 'missing_session');
  assert.equal(attempts, 0);

  clock.value = 7_000;
  const stillDormant = await missingSession.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.status },
    extensionSender(),
  );
  assert.equal(stillDormant.connected, false);
  assert.equal(attempts, 0);

  const authed = createControllerServiceWorker({
    storageArea: memoryStorage({ hermesBrowserSettings: settings() }).area,
    connector: failingConnector,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => ({ ok: true, result: {} }),
    now: () => clock.value,
  });
  const failed = await authed.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.status },
    extensionSender(),
  );
  assert.equal(failed.connected, false);
  assert.equal(failed.lastConnectFailure.reason, 'connect_failed');
  assert.equal(failed.lastConnectFailure.detail, 'Controller registration failed (HTTP 401).');
  assert.equal(attempts, 1);
});
