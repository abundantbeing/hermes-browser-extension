import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROLLER_WORKER_MESSAGES,
  createControllerServiceWorker,
} from '../extension/lib/controller-service-worker.mjs';
import { CONTROLLER_REGISTRY_STORAGE_KEY } from '../extension/lib/controller-registry.mjs';

async function connectedWorker() {
  const settings = {
    connectionMode: 'local',
    connectionTransport: 'local-api',
    gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642',
    activeProfile: 'default',
    sessionId: 'stored-session-1',
    browserControlEnabled: true,
  };
  const state = { hermesBrowserSettings: structuredClone(settings) };
  const connections = [];
  const ids = ['controller-revision-fixture', 'profile-revision-fixture'];
  const worker = createControllerServiceWorker({
    storageArea: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.filter((key) => Object.hasOwn(state, key))
          .map((key) => [key, structuredClone(Reflect.get(state, key))]));
      },
      async set(values) { Object.assign(state, structuredClone(values)); },
    },
    connector: {
      async connect(options) {
        const connection = {
          options,
          closed: false,
          async send() {},
          async heartbeat() { return { ok: true }; },
          close() { connection.closed = true; },
        };
        connections.push(connection);
        return connection;
      },
    },
    product: { id: 'chromium', engine: 'chromium', label: 'Chromium browser' },
    randomUUID: () => ids.shift(),
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });
  await worker.boot();
  return { worker, state, settings, connections };
}

for (const { label, options } of [
  { label: 'omitted', options: undefined },
  { label: 'null', options: { revision: null } },
  { label: 'undefined', options: { revision: undefined } },
  { label: 'empty string', options: { revision: '' } },
]) {
  test(`revisionless session updates rebind after an explicit refresh (${label})`, async () => {
    const { worker, state, settings, connections } = await connectedWorker();
    await worker.handleMessage(
      { type: CONTROLLER_WORKER_MESSAGES.settingsRefresh },
      { url: 'chrome-extension://fixture/sidepanel.html' },
    );
    const previousRevision = worker.status().settingsRevision;
    const nextSettings = { ...settings, sessionId: 'stored-session-2' };
    state.hermesBrowserSettings = structuredClone(nextSettings);

    const rebound = await worker.syncSettings(nextSettings, options);

    assert.equal(rebound.staleSettingsRevision, undefined);
    assert.equal(rebound.settingsRevision, previousRevision + 1);
    assert.equal(rebound.connected, true);
    assert.equal(connections.length, 2);
    assert.equal(connections[0].closed, true);
    assert.equal(connections[1].options.identity.hermesSessionId, nextSettings.sessionId);
    assert.equal(Reflect.get(state, CONTROLLER_REGISTRY_STORAGE_KEY).entries[0].hermesSessionId, nextSettings.sessionId);
  });
}

test('successive implicit settings updates increase revisions and bind the latest session', async () => {
  const { worker, state, settings, connections } = await connectedWorker();
  await worker.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.settingsRefresh },
    { url: 'chrome-extension://fixture/sidepanel.html' },
  );
  const firstRevision = worker.status().settingsRevision;

  const changed = { ...settings, sessionId: 'stored-session-2' };
  const second = await worker.syncSettings(changed);
  const sameRoute = await worker.syncSettings({ ...changed, panelResidencyMode: 'global' });
  const latest = await worker.syncSettings({ ...settings, sessionId: 'stored-session-3' });

  assert.equal(second.settingsRevision, firstRevision + 1);
  assert.equal(sameRoute.settingsRevision, firstRevision + 2);
  assert.equal(latest.settingsRevision, firstRevision + 3);
  assert.equal(sameRoute.generation, second.generation);
  assert.equal(connections.length, 3, 'unrelated settings must not reconnect the socket');
  assert.equal(connections.at(-1).options.identity.hermesSessionId, 'stored-session-3');
  assert.equal(Reflect.get(state, CONTROLLER_REGISTRY_STORAGE_KEY).entries[0].hermesSessionId, 'stored-session-3');
});

test('explicit revision zero stays stale after a newer session binding', async () => {
  const { worker, state, settings, connections } = await connectedWorker();
  const newest = await worker.syncSettings({ ...settings, sessionId: 'newest-session' }, { revision: 2 });

  const stale = await worker.syncSettings({ ...settings, sessionId: 'stale-session' }, { revision: 0 });

  assert.equal(stale.staleSettingsRevision, true);
  assert.equal(stale.settingsRevision, 2);
  assert.equal(stale.generation, newest.generation);
  assert.equal(connections.length, 2, 'an explicit stale revision must not open another socket');
  assert.equal(connections.at(-1).closed, false);
  assert.equal(connections.at(-1).options.identity.hermesSessionId, 'newest-session');
  assert.equal(Reflect.get(state, CONTROLLER_REGISTRY_STORAGE_KEY).entries[0].hermesSessionId, 'newest-session');
});
