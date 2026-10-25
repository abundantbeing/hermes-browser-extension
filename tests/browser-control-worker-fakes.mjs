// Fakes for tests that drive the controller service worker: storage, a connector, a leased tab. Not a test file.
import assert from 'node:assert/strict';

import { CONTROLLER_WORKER_MESSAGES } from '../extension/lib/controller-service-worker.mjs';
import { TAB_LEASE_KINDS, TAB_LEASE_OWNERSHIPS } from '../extension/lib/tab-leases.mjs';

export const PRODUCT = Object.freeze({ id: 'chromium', engine: 'chromium', label: 'Chromium browser' });

export function memoryStorage(initial = {}) {
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

export const settings = () => ({
  connectionSchemaVersion: 1,
  connectionMode: 'local',
  connectionTransport: 'local-api',
  gatewayMode: 'local-api',
  gatewayUrl: 'http://127.0.0.1:8642',
  apiKey: ['pause', 'fixture', 'route'].join('-'),
  activeProfile: 'default',
  sessionId: 'pause-session',
  browserControlEnabled: true,
});

export function connector() {
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

export const extensionSender = ({ tabId = null } = {}) => ({
  url: 'chrome-extension://fixture/sidepanel.html',
  frameId: 0,
  tab: Number.isInteger(tabId) ? { id: tabId, windowId: 2 } : undefined,
});
export const uuids = () => {
  const values = ['controller-pause', 'profile-pause'];
  return () => values.shift() || 'unexpected';
};
export async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
export async function waitFor(check, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition never held');
  return null;
}
export const terminalOf = (connection, commandId) => connection.sent
  .find((frame) => frame.method === 'browser.controller.result' && frame.params.command_id === commandId)?.params;

export async function ownedReady(worker, tabId) {
  const boot = worker.status();
  assert.equal((await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: boot.controllerId,
    tabIds: [tabId],
    windowId: 2,
  }, extensionSender())).ok, true);
  const ready = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId }));
  return { boot, documentGeneration: ready.documentGeneration };
}

