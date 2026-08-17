import assert from 'node:assert/strict';
import test from 'node:test';

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
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => Object.hasOwn(data, key)).map((key) => [key, structuredClone(data[key])]));
      },
      async set(values) { Object.assign(data, structuredClone(values)); },
    },
  };
}

function uuids() {
  const values = ['controller-approval-worker', 'profile-approval-worker'];
  return () => values.shift();
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

const TRUSTED = Object.freeze({ url: 'chrome-extension://fixture/sidepanel.html' });
const SETTINGS = Object.freeze({
  hermesBrowserSettings: {
    connectionTransport: 'local-api',
    gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642',
    apiKey: ['fixture', 'approval', 'worker'].join('-'),
    sessionId: 'approval-worker-session',
    browserControlEnabled: true,
  },
});

test('Phase 6 worker refuses pre-granted approvals when no exact command is waiting', async () => {
  const worker = createControllerServiceWorker({
    storageArea: memoryStorage(SETTINGS).area,
    connector: connector(),
    product: { id: 'edge', engine: 'chromium', label: 'Microsoft Edge' },
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => ({ ok: true }),
  });
  const boot = await worker.boot();
  const lease = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: 'this-tab',
    ownership: 'owned',
    ownerId: boot.controllerId,
    tabIds: [61],
  }, TRUSTED);
  assert.equal(lease.ok, true);
  const ready = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady, tabId: 61 }, { tab: { id: 61 }, frameId: 0 });
  const result = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.approvalGrant,
    approvalId: 'not-pending',
    commandId: 'not-pending',
    action: 'browser_press',
    tabId: 61,
    frameId: 0,
    documentGeneration: ready.documentGeneration,
  }, TRUSTED);
  assert.deepEqual(result, { ok: false, error: 'approval_missing' });
  assert.equal(worker.status().pendingApprovals, 0);
});
