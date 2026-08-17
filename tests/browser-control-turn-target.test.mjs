import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBrowserTurnEnvelope } from '../extension/lib/browser-context-protocol.mjs';
import {
  CONTROLLER_WORKER_MESSAGES,
  createControllerServiceWorker,
} from '../extension/lib/controller-service-worker.mjs';
import {
  TAB_LEASE_KINDS,
  TAB_LEASE_OWNERSHIPS,
} from '../extension/lib/tab-leases.mjs';

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    area: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, structuredClone(data[key])]));
      },
      async set(values) { Object.assign(data, structuredClone(values)); },
    },
  };
}

function connector() {
  return {
    async connect() {
      return { send: async () => true, close: async () => true };
    },
  };
}

function extensionSender() {
  return { url: 'chrome-extension://fixture/sidepanel.html' };
}

function settings() {
  return {
    browserControlEnabled: true,
    browserControlPaused: false,
    connectionTransport: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642',
    apiKey: ['phase6', 'fixture', 'route'].join('-'),
    sessionId: 'session-fixture',
  };
}

async function controlledWorker({ tabUrl = 'https://example.test/watch?v=1' } = {}) {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: connector(),
    product: { id: 'chrome', engine: 'chromium', label: 'Chrome' },
    randomUUID: (() => {
      const ids = ['controller-fixture', 'profile-fixture'];
      return () => ids.shift() || 'uuid-fixture';
    })(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => ({ ok: true, result: {} }),
    getControllerCapabilities: async () => ['browser_snapshot'],
    getTab: async (tabId) => {
      if (Number(tabId) !== 41) throw new Error('missing tab');
      return { id: 41, url: tabUrl };
    },
  });
  const boot = await worker.boot();
  await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: boot.controllerId,
    tabIds: [41],
  }, extensionSender());
  const ready = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.documentReady,
    tabId: 41,
    frameId: 0,
  }, extensionSender());
  return { worker, boot, ready };
}

test('worker resolves one exact extension-controller target from tab, URL, lease, and document generation', async () => {
  const { worker, boot, ready } = await controlledWorker();
  const resolved = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.targetResolve,
    tabId: 41,
    frameId: 0,
    expectedUrl: 'https://example.test/watch?v=1#comments',
  }, extensionSender());

  assert.deepEqual(resolved, {
    ok: true,
    route: 'extension-controller',
    availability: 'available',
    isolatedFallback: 'forbidden',
    controllerId: boot.controllerId,
    browserProfileId: boot.browserProfileId,
    tabId: 41,
    frameId: 0,
    documentGeneration: ready.documentGeneration,
    url: 'https://example.test/watch?v=1',
    leaseOwned: true,
  });
});

test('worker fails closed when context tab, URL, or lease does not resolve exactly', async () => {
  const { worker, boot } = await controlledWorker();

  const missing = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.targetResolve,
    tabId: 99,
    frameId: 0,
    expectedUrl: 'https://example.test/watch?v=1',
  }, extensionSender());
  assert.equal(missing.availability, 'unavailable');
  assert.equal(missing.reason, 'tab_not_found');
  assert.match(missing.message, /Tab not found in your browser/i);
  assert.equal(missing.isolatedFallback, 'forbidden');

  const wrongUrl = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.targetResolve,
    tabId: 41,
    frameId: 0,
    expectedUrl: 'https://example.test/other',
  }, extensionSender());
  assert.equal(wrongUrl.reason, 'tab_url_mismatch');
  assert.equal(wrongUrl.isolatedFallback, 'forbidden');

  await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseRelease,
    ownerId: boot.controllerId,
    tabIds: [41],
  }, extensionSender());
  const released = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.targetResolve,
    tabId: 41,
    frameId: 0,
    expectedUrl: 'https://example.test/watch?v=1',
  }, extensionSender());
  assert.equal(released.reason, 'lease_required');
  assert.equal(released.isolatedFallback, 'forbidden');
});

test('BCP v2 carries authoritative control target outside page context for full and reference delivery', () => {
  const target = {
    route: 'extension-controller',
    availability: 'available',
    isolatedFallback: 'forbidden',
    controllerId: 'controller-fixture',
    browserProfileId: 'profile-fixture',
    tabId: 41,
    frameId: 0,
    documentGeneration: 3,
    url: 'https://example.test/watch?v=1',
    leaseOwned: true,
  };
  const full = buildBrowserTurnEnvelope({
    humanInput: 'control this tab',
    activeTab: { id: 41, url: target.url, title: 'Fixture' },
    contextScope: { mode: 'pinned-tab', pinnedTabId: 41, pinnedUrl: target.url },
    browserControl: target,
  });
  assert.deepEqual(full.browser_control, {
    route: 'extension-controller',
    availability: 'available',
    isolated_fallback: 'forbidden',
    controller_id: 'controller-fixture',
    browser_profile_id: 'profile-fixture',
    tab_id: 41,
    frame_id: 0,
    document_generation: 3,
    url: target.url,
    lease_owned: true,
  });

  const reference = buildBrowserTurnEnvelope({
    humanInput: 'continue',
    contextScope: { mode: 'pinned-tab', pinnedTabId: 41, pinnedUrl: target.url },
    contextHash: 'a1b2c3d4e5f60789',
    contextDelivery: 'reference',
    browserControl: target,
  });
  assert.equal(reference.browser_context.delivery, 'reference');
  assert.deepEqual(reference.browser_control, full.browser_control);
});
