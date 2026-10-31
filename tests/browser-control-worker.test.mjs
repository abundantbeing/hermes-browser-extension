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
      async inspect() { return { currentUrl: 'https://example.test/form', focused: { role: 'textbox', name: 'Message', inputType: 'text', identity: '0123456789abcdef0123456789abcdef' } }; },
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
      // Every page action names the tab it ran in.
      result: { status: 'navigated', url: 'https://example.test/next', tab_id: 77 },
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

test('Phase 6 worker never registers while control is off and connects the moment it is turned on', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: settings({ browserControlEnabled: false }) });
  const transport = connector();
  let calls = 0;
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => { calls += 1; return { ok: true, result: { status: 'scrolled' } }; },
  });
  const booted = await worker.boot();
  // No registration at the gateway while control is off: it would bind a noop lane.
  assert.equal(transport.connections.length, 0);
  assert.equal(booted.connected, false);
  assert.equal(booted.dormant, true);
  assert.equal(worker.status().controlEnabled, false);
  assert.equal((await worker.reconcile({ reason: 'alarm' })).connected, false);
  assert.equal(transport.connections.length, 0);

  // Turning control on (settings refresh) connects immediately.
  storage.state.hermesBrowserSettings = settings({ browserControlEnabled: true });
  const refreshed = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.settingsRefresh }, extensionSender());
  assert.equal(refreshed.connected, true);
  assert.equal(transport.connections.length, 1);
  const ready = await ownedReady(worker, 78);
  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: { command_id: 'enabled-real', action: 'browser_scroll', arguments: { direction: 'down' }, tab_id: 78, document_generation: ready.documentGeneration },
  });
  await settle();
  assert.equal(calls, 1);
  assert.equal(transport.connections[0].sent.at(-1).params.ok, true);

  // Turning it off again closes the socket and does not re-register a noop lane.
  const detached = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.detach }, extensionSender());
  assert.equal(detached.ok, true);
  assert.equal(worker.status().connected, false);
  assert.equal(transport.connections.length, 1);
  assert.equal((await worker.reconcile({ reason: 'alarm' })).connected, false);
  assert.equal(transport.connections.length, 1);
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
  // Releasing the tab ends what is queued on it (cancelled); a tail that was not cancelled would fail the lease check.
  assert.match(leaseTail.params.error.code, /^(lease_required|cancelled)$/);
  assert.equal(executed.includes('lease-tail'), false, 'the queued side effect never ran');
});

test('Phase 6 approval grants require a trusted extension sender and bind exact command action and document', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const approvals = createBrowserControlApprovalStore();
  let sideEffects = 0;
  const executor = createBrowserControlExecutor({
    adapter: {
      contract: { enabled: true, actions: ['browser_press'] },
      async inspect() { return { currentUrl: 'https://example.test/form', focused: { role: 'textbox', name: 'Message', inputType: 'text', identity: '0123456789abcdef0123456789abcdef' } }; },
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
    result: { status: 'pressed', tab_id: 80 },
  });
});

test('a tab switch waits for approval and is granted through the worker even though it names another tab', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const approvals = createBrowserControlApprovalStore();
  const switched = [];
  const executor = createBrowserControlExecutor({
    adapter: {
      contract: { enabled: true, actions: ['browser_tab_activate'] },
      async execute(action, args) {
        switched.push(Number(args.tab_id));
        return { status: 'tab-activated' };
      },
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
  const leased = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: worker.status().controllerId,
    tabIds: [82],
  }, extensionSender());
  assert.equal(leased.ok, true, JSON.stringify(leased));
  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'switch-82',
      action: 'browser_tab_activate',
      arguments: { tab_id: 82 },
      tab_id: 81,
      document_generation: ready.documentGeneration,
    },
  });
  await settle();
  const pending = worker.status().pendingApproval;
  assert.equal(pending?.action, 'browser_tab_activate', JSON.stringify(worker.status()));
  assert.equal(pending.reason, 'Switch your view to this tab?');
  // The request is bound to the tab the command ran on, which is the tab the worker's lease check covers,
  // and to the tab it switches to, so the grant cannot be spent on another one.
  assert.equal(pending.tabId, 81);
  assert.equal(pending.binding, 'tab:82');
  assert.deepEqual(switched, []);
  assert.equal((await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.approvalGrant,
    ...pending,
  }, extensionSender())).ok, true);
  await settle();
  assert.deepEqual(switched, [82]);
  assert.deepEqual(transport.connections[0].sent.at(-1).params, {
    command_id: 'switch-82',
    tab_id: 81,
    ok: true,
    result: { status: 'tab-activated' },
  });
});

async function waitForPendingApproval(worker, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pending = worker.status().pendingApproval;
    if (pending) return pending;
    await settle();
  }
  assert.fail(`no approval was requested: ${JSON.stringify(worker.status())}`);
  return null;
}

test('a batch click that needs approval after its own navigation is granted through the worker under the new document generation', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const approvals = createBrowserControlApprovalStore();
  const clicked = [];
  let workerRef = null;
  const adapter = {
    contract: { enabled: true, actions: ['browser_batch', 'browser_navigate', 'browser_click', 'browser_snapshot'] },
    inspect: async () => ({ currentUrl: 'https://example.test/start', hasUnsavedContent: false }),
    settle: async () => ({ navigated: true, url: 'https://example.test/next', title: 'Next', timedOut: false }),
    async execute(action, args) {
      if (action === 'browser_navigate') {
        // Chrome reports the navigation, then the new document's content script announces itself.
        await workerRef.handleTabUpdated(81, { status: 'loading' });
        await workerRef.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 81 }));
        return { navigated: true, url: 'https://example.test/next', title: 'Next' };
      }
      if (action === 'browser_click') {
        clicked.push({ x: args.x, y: args.y });
        return { status: 'clicked' };
      }
      return { title: 'Next', url: 'https://example.test/next', text: '', nodes: [] };
    },
  };
  const executor = createBrowserControlExecutor({ adapter, approvals, refs: createBrowserControlRefStore() });
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    approvalStore: approvals,
    executeBrowserCommand: (frame, context) => executor.execute(frame, context),
  });
  workerRef = worker;
  await worker.boot();
  const ready = await ownedReady(worker, 81);
  const connection = transport.connections[0];
  await connection.emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'batch-nav-click',
      action: 'browser_batch',
      arguments: { actions: [{ action: 'navigate', url: 'https://example.test/next' }, { action: 'click', x: 10, y: 20 }] },
    },
  });
  const pending = await waitForPendingApproval(worker);
  assert.equal(pending.commandId, 'batch-nav-click');
  assert.equal(pending.action, 'browser_click');
  // The click runs on the document the navigation produced, so the request names that one.
  assert.ok(pending.documentGeneration > ready.documentGeneration, JSON.stringify(pending));
  const granted = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.approvalGrant, ...pending }, extensionSender());
  assert.equal(granted.ok, true, JSON.stringify(granted));
  const terminal = await waitForTerminal(connection, 'batch-nav-click');
  assert.equal(terminal.ok, true, JSON.stringify(terminal));
  assert.equal(terminal.result.status, 'completed');
  assert.equal(terminal.result.completed, 2);
  assert.deepEqual(clicked, [{ x: 10, y: 20 }]);
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

test('a tab Hermes opens becomes the Show tab target, is persisted, and survives a restart', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const createWorker = (transport) => createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async (frame) => ({
      ok: true,
      result: frame.action === 'browser_tab_create'
        ? { tab: { id: 912, windowId: 2, active: false, url: 'https://example.test/new' } }
        : { status: 'ok' },
    }),
  });
  const transport = connector();
  const worker = createWorker(transport);
  await worker.boot();
  const ready = await ownedReady(worker, 911, { windowId: 2 });
  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'create-background',
      action: 'browser_tab_create',
      arguments: { url: 'https://example.test/new', active: true, lease_kind: TAB_LEASE_KINDS.TASK_SET, task_set_id: 'task-912' },
      tab_id: 911,
      document_generation: ready.documentGeneration,
    },
  });
  await settle();
  assert.equal(transport.connections[0].sent.at(-1).params.ok, true, JSON.stringify(transport.connections[0].sent.at(-1)));
  assert.deepEqual(worker.status().leasedTabIds, [911, 912]);
  assert.equal(worker.status().lastActionTabId, 912);
  assert.equal(storage.state.hermesBrowserControllerWorker.lastActionTabId, 912);

  const restarted = createWorker(connector());
  await restarted.boot();
  assert.equal(restarted.status().lastActionTabId, 912);
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

test('worker drops a rejected pairing token so reconnect can mint a fresh ticket', async () => {
  const store = memoryStorage({
    hermesBrowserSettings: settings({ tokenSource: 'pairing' }),
  });
  const worker = createControllerServiceWorker({
    storageArea: store.area,
    connector: {
      async connect() {
        throw new Error('Controller registration failed (HTTP 401).');
      },
    },
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => ({ ok: true, result: {} }),
    now: () => 0,
  });
  const failed = await worker.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.status },
    extensionSender(),
  );
  assert.equal(failed.connected, false);
  assert.equal(failed.lastConnectFailure.reason, 'connect_failed');
  assert.equal(String(store.state.hermesBrowserSettings.tokenSource || ''), '');
  assert.equal(String(store.state.hermesBrowserSettings.apiKey || ''), '');
});

test('Phase 6 worker drops the tab debugger session when a lease is released, paused, or detached', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const released = [];
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: connector(),
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => ({ ok: true, result: { status: 'scrolled' } }),
    releaseTabDebugger: async (tabId) => {
      released.push(tabId);
      if (tabId === 913) throw new Error('detach failed');
    },
  });
  await worker.boot();
  const { boot } = await ownedReady(worker, 911, { windowId: 2 });
  const sender = extensionSender();

  const release = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseRelease, ownerId: boot.controllerId, tabIds: [911],
  }, sender);
  assert.equal(release.ok, true);
  await settle();
  assert.deepEqual(released, [911]);

  await ownedReady(worker, 912, { windowId: 2 });
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.pause }, sender);
  await settle();
  assert.deepEqual(released, [911, 912], 'pausing releases the leased tabs');
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.resume }, sender);
  await settle();
  assert.deepEqual(released, [911, 912], 'resuming does not touch sessions; the next command re-attaches');

  await ownedReady(worker, 913, { windowId: 2 });
  const detached = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.detach }, sender);
  assert.equal(detached.ok, true, 'a failing release hook never fails the transition');
  await settle();
  assert.ok(released.includes(913));
});

test('Phase 6 worker works without a debugger release hook', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: connector(),
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => ({ ok: true, result: { status: 'scrolled' } }),
  });
  await worker.boot();
  const { boot } = await ownedReady(worker, 911, { windowId: 2 });
  const release = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseRelease, ownerId: boot.controllerId, tabIds: [911],
  }, extensionSender());
  assert.equal(release.ok, true);
});

async function waitForTerminal(connection, commandId, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const terminal = connection.sent.find((frame) => frame.method === 'browser.controller.result' && frame.params.command_id === commandId);
    if (terminal) return terminal.params;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`No terminal frame for ${commandId}`);
  return null;
}

// A worker wired to the real executor with an adapter whose first click
// navigates the way Chrome does: tabs.onUpdated bumps the document generation
// and the new document's content script announces another one.
async function navigatingClickWorker({ announceDuring }) {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const clicks = [];
  let workerRef = null;
  let onDetailPage = false;
  const announce = async () => {
    await workerRef.handleTabUpdated(91, { status: 'loading' });
    await workerRef.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId: 91 }));
  };
  const adapter = {
    contract: { enabled: true, actions: ['browser_click', 'browser_snapshot'] },
    inspect: async () => ({ currentUrl: 'https://example.test/list', hasUnsavedContent: false }),
    settle: async () => ({ navigated: clicks.length === 1, url: 'https://example.test/detail', title: 'Detail', timedOut: false }),
    async execute(action, args, context) {
      if (action === 'browser_snapshot') {
        if (onDetailPage && announceDuring === 'snapshot' && clicks.length === 1) await announce();
        return onDetailPage
          ? { title: 'Detail', url: 'https://example.test/detail', text: 'Detail page body', nodes: [{ role: 'button', name: 'Add to cart', backendDOMNodeId: 501 }] }
          : { title: 'List', url: 'https://example.test/list', text: 'List', nodes: [{ role: 'link', name: 'Open detail', backendDOMNodeId: 101 }] };
      }
      clicks.push({ ref: args.ref, backendDOMNodeId: context.target?.backendDOMNodeId });
      if (clicks.length === 1) {
        onDetailPage = true;
        if (announceDuring === 'click') await announce();
        else await workerRef.handleTabUpdated(91, { status: 'loading' });
      }
      return { status: 'clicked' };
    },
  };
  const executor = createBrowserControlExecutor({
    adapter,
    approvals: createBrowserControlApprovalStore(),
    refs: createBrowserControlRefStore(),
  });
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: (frame, context) => executor.execute(frame, context),
  });
  workerRef = worker;
  await worker.boot();
  await ownedReady(worker, 91);
  return { transport, clicks };
}

for (const announceDuring of ['click', 'snapshot']) {
  test(`Phase 2 refs minted after a navigating click work for the next command (document ready during ${announceDuring})`, async () => {
    const { transport, clicks } = await navigatingClickWorker({ announceDuring });
    const connection = transport.connections[0];
    // Broker-v1 style: no tab or generation, the worker binds the authoritative ones.
    const send = (commandId, action, args) => connection.emit({
      method: 'browser.controller.command',
      params: { command_id: commandId, action, arguments: args },
    });

    await send('nav-snapshot', 'browser_snapshot', {});
    const first = await waitForTerminal(connection, 'nav-snapshot');
    assert.equal(first.ok, true);
    assert.equal(first.result.refs[0].ref, '@e1');

    await send('nav-click-1', 'browser_click', { ref: '@e1' });
    const clicked = await waitForTerminal(connection, 'nav-click-1');
    assert.equal(clicked.ok, true, JSON.stringify(clicked));
    assert.equal(clicked.result.status, 'clicked');
    assert.equal(clicked.result.navigated, true);
    assert.equal(clicked.result.url, 'https://example.test/detail');
    assert.deepEqual(clicked.result.snapshot.refs.map((item) => item.name), ['Add to cart']);
    const nextRef = clicked.result.snapshot.refs[0].ref;

    // The refs in that result must be valid for the very next command.
    await send('nav-click-2', 'browser_click', { ref: nextRef });
    const followUp = await waitForTerminal(connection, 'nav-click-2');
    assert.equal(followUp.ok, true, JSON.stringify(followUp));
    assert.equal(followUp.result.status, 'clicked');
    assert.deepEqual(clicks.map((click) => click.backendDOMNodeId), [101, 501]);
  });
}
