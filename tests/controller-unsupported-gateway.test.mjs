import assert from 'node:assert/strict';
import test from 'node:test';

import { createControllerConnector } from '../extension/lib/controller-connector.mjs';
import { CONTROLLER_UNSUPPORTED_GATEWAY } from '../extension/lib/controller-protocol.mjs';
import {
  CONTROLLER_WORKER_MESSAGES,
  CONTROLLER_WORKER_STORAGE_KEY,
  createControllerServiceWorker,
} from '../extension/lib/controller-service-worker.mjs';

const IDENTITY = Object.freeze({
  controllerId: 'controller-fixture',
  browserProfileId: 'browser-profile-fixture',
  hermesSessionId: 'stored-session-fixture',
  product: { id: 'chromium', engine: 'chromium', label: 'Chromium browser' },
});

class FakeSocket {
  static instances = [];

  constructor(url, protocols = []) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  send(raw) { this.sent.push(raw); }

  close() {
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: '' });
  }

  emit(type, event) {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }

  open() {
    this.readyState = 1;
    this.emit('open', {});
  }

  message(frame) { this.emit('message', { data: JSON.stringify(frame) }); }
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return structuredClone(body); },
  };
}

function lastJson(socket) {
  return JSON.parse(socket.sent.at(-1));
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const LOCAL_SETTINGS = Object.freeze({
  connectionTransport: 'local-api',
  gatewayUrl: 'http://127.0.0.1:8642',
  apiKey: 'fixture-key',
});

function cloudConnector() {
  return createControllerConnector({
    WebSocketImpl: FakeSocket,
    tabsApi: { query: async () => [], get: async () => ({}) },
    scriptingApi: { executeScript: async () => [] },
    mintDashboardTicket: async () => ({ ok: true, ticket: 'cloud-ticket-fixture', ttlSeconds: 30 }),
  });
}

const CLOUD_SETTINGS = Object.freeze({
  connectionTransport: 'cloud-ticket-ws',
  connectionMode: 'cloud',
  gatewayUrl: 'https://dashboard.example/hermes',
  trustedDashboardOrigin: 'https://dashboard.example',
  trustedDashboardTabId: 77,
});

// Drive a Cloud connection up to the register RPC and answer it with `reply`.
async function answerCloudRegister(connecting, reply) {
  await settle();
  const socket = FakeSocket.instances.at(-1);
  socket.open();
  socket.message({ method: 'event', params: { type: 'gateway.ready', payload: {} } });
  await settle();
  socket.message({ id: lastJson(socket).id, result: { session_id: 'live-session-2', resumed: 'stored-session-fixture' } });
  await settle();
  assert.equal(lastJson(socket).method, 'browser.controller.register');
  socket.message({ id: lastJson(socket).id, ...reply });
  return socket;
}

test('REST registration answered 404 or 405 by Hermes core and by the companion plugin is the terminal unsupported_gateway result', async () => {
  for (const status of [404, 405]) {
    FakeSocket.instances = [];
    const requests = [];
    const connector = createControllerConnector({
      fetchImpl: async (url) => {
        requests.push(url);
        return jsonResponse(status, { error: { message: 'Not found' } });
      },
      WebSocketImpl: FakeSocket,
    });
    await assert.rejects(
      connector.connect({ settings: { ...LOCAL_SETTINGS }, identity: IDENTITY }),
      (error) => error.code === CONTROLLER_UNSUPPORTED_GATEWAY
        && /does not support Hermes Control \(HTTP \d+\)/.test(error.message)
        && /companion plugin's control route is not available/.test(error.message),
    );
    assert.deepEqual(requests, [
      'http://127.0.0.1:8642/v1/browser-control/register',
      'http://127.0.0.1:8642/api/plugins/hermes-browser-companion/control/register',
    ], 'both routes are asked once; an unsupported gateway is neither materialized, retried nor dialled');
    assert.equal(FakeSocket.instances.length, 0);
  }
});

test('other registration refusals stay ordinary retryable failures', async () => {
  for (const status of [401, 403, 500]) {
    const connector = createControllerConnector({
      fetchImpl: async () => jsonResponse(status, { error: { message: `refused ${status}` } }),
      WebSocketImpl: FakeSocket,
    });
    await assert.rejects(
      connector.connect({ settings: { ...LOCAL_SETTINGS }, identity: IDENTITY }),
      (error) => error.code === undefined && error.message === `refused ${status}`,
    );
  }
});

test('a 404 on the retry after ghost-session materialization is still terminal', async () => {
  let registerCalls = 0;
  const connector = createControllerConnector({
    fetchImpl: async (url) => {
      if (url.endsWith('/v1/browser-control/register')) {
        registerCalls += 1;
        return registerCalls === 1
          ? jsonResponse(403, { error: { code: 'browser_control_session_forbidden', message: 'unknown session' } })
          : jsonResponse(404, {});
      }
      if (url.endsWith('/control/register')) return jsonResponse(404, {});
      return jsonResponse(201, { session: { id: 'stored-session-fixture' } });
    },
    WebSocketImpl: FakeSocket,
  });
  await assert.rejects(
    connector.connect({ settings: { ...LOCAL_SETTINGS }, identity: IDENTITY }),
    (error) => error.code === CONTROLLER_UNSUPPORTED_GATEWAY,
  );
});

test('Cloud register answered method-not-found is the terminal unsupported_gateway result', async () => {
  FakeSocket.instances = [];
  const connecting = cloudConnector().connect({ settings: { ...CLOUD_SETTINGS }, identity: IDENTITY });
  const rejection = assert.rejects(connecting, (error) => error.code === CONTROLLER_UNSUPPORTED_GATEWAY);
  const socket = await answerCloudRegister(connecting, {
    error: { code: -32601, message: 'method not found: browser.controller.register' },
  });
  await rejection;
  assert.equal(socket.readyState, 3, 'the socket is closed after the terminal answer');
});

test('Cloud register failures other than method-not-found stay ordinary', async () => {
  FakeSocket.instances = [];
  const connecting = cloudConnector().connect({ settings: { ...CLOUD_SETTINGS }, identity: IDENTITY });
  const rejection = assert.rejects(connecting, (error) => error.code === 4001 && /busy/.test(error.message));
  await answerCloudRegister(connecting, { error: { code: 4001, message: 'busy' } });
  await rejection;
});

// ---- service worker -------------------------------------------------------

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

function workerSettings(overrides = {}) {
  return {
    connectionSchemaVersion: 1,
    connectionMode: 'local',
    connectionTransport: 'local-api',
    gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642',
    apiKey: 'fixture-access-local',
    activeProfile: 'default',
    sessionId: 'stored-session-1',
    browserControlEnabled: true,
    ...overrides,
  };
}

// A connector whose next outcomes are scripted: 'unsupported', 'fail', or 'ok'.
function scriptedConnector(outcomes) {
  const queue = [...outcomes];
  const connector = {
    attempts: 0,
    async connect(options) {
      connector.attempts += 1;
      const outcome = queue.shift() ?? 'ok';
      if (outcome === 'unsupported') {
        throw Object.assign(new Error('This Hermes does not support Hermes Control (HTTP 404).'), { code: CONTROLLER_UNSUPPORTED_GATEWAY });
      }
      if (outcome === 'fail') throw new Error('socket refused');
      return {
        options,
        async send() {},
        async heartbeat() { return { ok: true }; },
        close() {},
      };
    },
  };
  return connector;
}

function makeWorker({ storage, connector, clock }) {
  const ids = ['controller-stable', 'profile-stable', 'unexpected-third-id'];
  return createControllerServiceWorker({
    storageArea: storage.area,
    connector,
    product: PRODUCT,
    randomUUID: () => ids.shift() || 'unexpected-id',
    extensionOrigin: 'chrome-extension://fixture',
    now: () => clock.t,
  });
}

const trustedSender = { url: 'chrome-extension://fixture/sidepanel.html', frameId: 0 };

test('worker stops after a terminal unsupported_gateway result and reports it', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: workerSettings() });
  const connector = scriptedConnector(['unsupported']);
  const clock = { t: 1_000 };
  const worker = makeWorker({ storage, connector, clock });

  const booted = await worker.boot();
  assert.equal(booted.connected, false);
  assert.equal(booted.terminal, true);
  assert.equal(booted.reason, CONTROLLER_UNSUPPORTED_GATEWAY);
  assert.equal(booted.lastConnectFailure.reason, CONTROLLER_UNSUPPORTED_GATEWAY);
  assert.equal(booted.lastConnectFailure.retryAfterMs, undefined, 'a terminal result carries no retry hint');
  assert.equal(connector.attempts, 1);

  // Alarms, wake messages and status polls over the next hours never dial again.
  for (const reason of ['heartbeat-alarm', 'reconcile-alarm', 'message-wake']) {
    clock.t += 10 * 60_000;
    const again = await worker.reconcile({ reason });
    assert.equal(again.terminal, true);
    assert.equal(again.reason, CONTROLLER_UNSUPPORTED_GATEWAY);
  }
  for (let poll = 0; poll < 5; poll += 1) {
    clock.t += 6_000;
    const status = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.status }, trustedSender);
    assert.equal(status.lastConnectFailure.reason, CONTROLLER_UNSUPPORTED_GATEWAY);
  }
  await settle();
  assert.equal(connector.attempts, 1);
});

test('a restarted worker remembers the terminal result for the same route', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: workerSettings() });
  const clock = { t: 1_000 };
  const first = scriptedConnector(['unsupported']);
  await makeWorker({ storage, connector: first, clock }).boot();
  assert.equal(storage.state[CONTROLLER_WORKER_STORAGE_KEY].unsupportedRouteKey.startsWith('route-v2:'), true);

  const second = scriptedConnector(['ok']);
  const restarted = await makeWorker({ storage, connector: second, clock }).boot();
  assert.equal(second.attempts, 0, 'the suspended-and-woken worker does not re-ask a gateway that already said no');
  assert.equal(restarted.terminal, true);
  assert.equal(restarted.lastConnectFailure.reason, CONTROLLER_UNSUPPORTED_GATEWAY);
});

test('a changed connection or credential clears the terminal result and tries again', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: workerSettings() });
  const connector = scriptedConnector(['unsupported', 'ok']);
  const clock = { t: 1_000 };
  const worker = makeWorker({ storage, connector, clock });
  await worker.boot();
  assert.equal(connector.attempts, 1);

  const resettled = await worker.syncSettings(workerSettings({ gatewayUrl: 'http://127.0.0.1:9999' }));
  assert.equal(connector.attempts, 2);
  assert.equal(resettled.connected, true);
  assert.equal(resettled.lastConnectFailure, null);
  assert.equal(storage.state[CONTROLLER_WORKER_STORAGE_KEY].unsupportedRouteKey, '');
});

test('turning control off and on again is a fresh attempt', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: workerSettings() });
  const connector = scriptedConnector(['unsupported', 'ok']);
  const clock = { t: 1_000 };
  const worker = makeWorker({ storage, connector, clock });
  await worker.boot();

  const off = await worker.syncSettings(workerSettings({ browserControlEnabled: false }));
  assert.equal(off.reason, 'control_off');
  const on = await worker.syncSettings(workerSettings({ browserControlEnabled: true }));
  assert.equal(connector.attempts, 2);
  assert.equal(on.connected, true);
});

test('transient failures honour retryAfterMs as a backoff and never churn the generation', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: workerSettings() });
  const connector = scriptedConnector(['fail', 'fail', 'ok']);
  const clock = { t: 1_000 };
  const worker = makeWorker({ storage, connector, clock });

  const first = await worker.boot();
  assert.equal(first.connected, false);
  assert.equal(first.reason, 'connect_failed');
  assert.equal(first.retryAfterMs, 1_000);
  assert.equal(first.lastConnectFailure.retryAfterMs, 1_000, 'the status and the result agree on one delay');
  const generation = first.generation;

  // Inside the window nothing dials, however often the alarm or a poll asks.
  clock.t += 500;
  const early = await worker.reconcile({ reason: 'heartbeat-alarm' });
  assert.equal(early.reason, 'backoff');
  assert.equal(early.retryAfterMs, 500);
  assert.equal(connector.attempts, 1);

  // After the window it dials once; the next failure backs off for twice as long.
  clock.t += 500;
  const second = await worker.reconcile({ reason: 'heartbeat-alarm' });
  assert.equal(connector.attempts, 2);
  assert.equal(second.retryAfterMs, 2_000);
  clock.t += 1_999;
  assert.equal((await worker.reconcile({ reason: 'heartbeat-alarm' })).reason, 'backoff');
  assert.equal(connector.attempts, 2);

  clock.t += 1;
  const recovered = await worker.reconcile({ reason: 'heartbeat-alarm' });
  assert.equal(connector.attempts, 3);
  assert.equal(recovered.connected, true);
  assert.equal(recovered.generation, generation);
});
