import assert from 'node:assert/strict';
import test from 'node:test';

import { createControllerConnector } from '../extension/lib/controller-connector.mjs';
import {
  CONTROLLER_BROWSER_CAPABILITIES,
  CONTROLLER_ROUTES,
  CONTROLLER_SESSION_PENDING,
  CONTROLLER_TRANSPORT_FAMILIES,
  controllerProfilePath,
  controllerRegistrationFor,
  controllerSocketPath,
  controllerWebSocketUrl,
} from '../extension/lib/controller-protocol.mjs';

// When Hermes core has no extension control (a stock Hermes), the companion
// plugin carries the same protocol on its own register and socket routes. The
// connector asks core first and falls back to the plugin on 404 or 405.

const CORE_REGISTER = 'http://127.0.0.1:8642/v1/browser-control/register';
const PLUGIN_REGISTER = 'http://127.0.0.1:8642/api/plugins/hermes-browser-companion/control/register';
const CORE_SOCKET = 'ws://127.0.0.1:8642/v1/browser-control/ws';
const PLUGIN_SOCKET = 'ws://127.0.0.1:8642/api/plugins/hermes-browser-companion/control/ws';
const PLUGIN_WS_PATH = '/api/plugins/hermes-browser-companion/control/ws';

const IDENTITY = Object.freeze({
  controllerId: 'controller-fixture',
  browserProfileId: 'browser-profile-fixture',
  hermesSessionId: 'stored-session-fixture',
  capabilities: ['browser_click', 'browser_snapshot'],
  product: { id: 'chromium', engine: 'chromium', label: 'Chromium browser' },
});
const LOCAL_SETTINGS = Object.freeze({
  connectionTransport: 'local-api',
  gatewayUrl: 'http://127.0.0.1:8642',
  apiKey: 'fixture-key',
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
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open', {});
    });
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
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return structuredClone(body); },
  };
}

// A fake gateway: register URL -> response (or a function of the call count).
function gateway(routes) {
  const requests = [];
  const counts = new Map();
  return {
    requests,
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, init });
      const count = (counts.get(url) || 0) + 1;
      counts.set(url, count);
      if (String(url).endsWith('/api/sessions')) return jsonResponse(201, { session: { id: 'stored-session-fixture' } });
      const entry = routes[url];
      if (entry === undefined) return jsonResponse(404, { error: { message: 'Not found' } });
      return typeof entry === 'function' ? entry(count) : entry;
    },
  };
}

function connect(fake, settings = LOCAL_SETTINGS) {
  FakeSocket.instances = [];
  const connector = createControllerConnector({ fetchImpl: fake.fetchImpl, WebSocketImpl: FakeSocket });
  return connector.connect({ settings: { ...settings }, identity: IDENTITY, onFrame: () => undefined, onClose: () => undefined });
}

test('Hermes core answering 404 or 405 falls back to the plugin register route and opens its socket path', async () => {
  for (const status of [404, 405]) {
    const fake = gateway({
      [CORE_REGISTER]: jsonResponse(status, { error: { message: 'Not found' } }),
      [PLUGIN_REGISTER]: jsonResponse(201, { ticket: 'plugin-ticket-fixture', ws_path: PLUGIN_WS_PATH, protocol_version: 1 }),
    });
    const connection = await connect(fake);
    assert.deepEqual(fake.requests.map((request) => request.url), [CORE_REGISTER, PLUGIN_REGISTER], String(status));
    assert.equal(FakeSocket.instances.length, 1);
    const [socket] = FakeSocket.instances;
    assert.equal(socket.url, PLUGIN_SOCKET);
    assert.deepEqual(socket.protocols, ['hermes-browser-control-v1', 'hermes-browser-control-ticket.plugin-ticket-fixture']);
    assert.ok(!socket.url.includes('plugin-ticket-fixture'), 'the ticket is never in the URL');
    // The same registration, credentials and profile header go to both routes.
    const [core, plugin] = fake.requests;
    assert.equal(core.init.body, plugin.init.body);
    assert.deepEqual(core.init.headers, plugin.init.headers);
    assert.equal(plugin.init.method, 'POST');
    assert.equal(plugin.init.headers.Authorization, 'Bearer fixture-key');
    assert.equal(plugin.init.redirect, 'error');
    const body = JSON.parse(plugin.init.body);
    assert.equal(body.protocol_version, 1);
    assert.deepEqual(body.capabilities, ['controller.noop', 'browser_click', 'browser_snapshot']);
    connection.close();
  }
});

test('Hermes core that serves the route keeps the core route and its socket; the plugin is never asked', async () => {
  const fake = gateway({
    [CORE_REGISTER]: jsonResponse(201, { ticket: 'core-ticket-fixture', ws_path: '/v1/browser-control/ws' }),
    [PLUGIN_REGISTER]: jsonResponse(201, { ticket: 'should-not-be-used' }),
  });
  const connection = await connect(fake);
  assert.deepEqual(fake.requests.map((request) => request.url), [CORE_REGISTER]);
  assert.equal(FakeSocket.instances[0].url, CORE_SOCKET);
  assert.deepEqual(FakeSocket.instances[0].protocols.at(-1), 'hermes-browser-control-ticket.core-ticket-fixture');
  connection.close();
});

test('a refusal from core other than 404 or 405 never falls back to the plugin', async () => {
  for (const [status, body] of [[401, { error: { message: 'bad key' } }], [403, { error: { message: 'no' } }], [500, {}], [503, {}]]) {
    const fake = gateway({
      [CORE_REGISTER]: jsonResponse(status, body),
      [PLUGIN_REGISTER]: jsonResponse(201, { ticket: 'plugin-ticket-fixture' }),
    });
    await assert.rejects(connect(fake), (error) => error.code === undefined, String(status));
    assert.deepEqual(fake.requests.map((request) => request.url), [CORE_REGISTER], String(status));
    assert.equal(FakeSocket.instances.length, 0);
  }
});

test('the plugin route refusing for another reason than 404 or 405 is an ordinary retryable failure', async () => {
  for (const status of [401, 403, 500]) {
    const fake = gateway({
      [CORE_REGISTER]: jsonResponse(404, {}),
      [PLUGIN_REGISTER]: jsonResponse(status, { error: { message: `plugin refused ${status}` } }),
    });
    await assert.rejects(connect(fake), (error) => error.code === undefined && error.message === `plugin refused ${status}`, String(status));
    assert.equal(FakeSocket.instances.length, 0);
  }
});

test('a plugin registration for a session the server does not know is "not ready", never created', async () => {
  const fake = gateway({
    [CORE_REGISTER]: jsonResponse(404, {}),
    [PLUGIN_REGISTER]: jsonResponse(403, { error: { code: 'browser_control_session_forbidden', message: 'unknown session' } }),
  });
  await assert.rejects(connect(fake), (error) => error.code === CONTROLLER_SESSION_PENDING);
  assert.deepEqual(fake.requests.map((request) => request.url), [CORE_REGISTER, PLUGIN_REGISTER]);
  assert.equal(FakeSocket.instances.length, 0);
});

test('a named profile is addressed with /p/<profile> on both routes and on the socket; the profile header stays', async () => {
  const core = 'http://127.0.0.1:8642/p/luxord/v1/browser-control/register';
  const plugin = 'http://127.0.0.1:8642/p/luxord/api/plugins/hermes-browser-companion/control/register';
  const fake = gateway({
    [core]: jsonResponse(404, {}),
    [plugin]: jsonResponse(201, { ticket: 'plugin-ticket-fixture', ws_path: PLUGIN_WS_PATH }),
  });
  const connection = await connect(fake, { ...LOCAL_SETTINGS, activeProfile: 'luxord' });
  assert.deepEqual(fake.requests.map((request) => request.url), [core, plugin], 'nothing goes to the default profile');
  assert.equal(fake.requests[1].init.headers['X-Hermes-Profile'], 'luxord');
  assert.equal(FakeSocket.instances[0].url, `ws://127.0.0.1:8642/p/luxord${PLUGIN_WS_PATH}`);
  connection.close();
  // The default (no profile) keeps the plain addresses.
  const plain = gateway({
    [CORE_REGISTER]: jsonResponse(404, {}),
    [PLUGIN_REGISTER]: jsonResponse(201, { ticket: 'plugin-ticket-fixture', ws_path: PLUGIN_WS_PATH }),
  });
  (await connect(plain)).close();
  assert.deepEqual(plain.requests.map((request) => request.url), [CORE_REGISTER, PLUGIN_REGISTER]);
});

test('only the two known socket paths are followed; any other ws_path is ignored for the route\'s own', async () => {
  for (const wsPath of ['/evil/socket', 'wss://evil.example/x', '//evil.example/x', '/v1/browser-control/ws/../x', '', null, 7]) {
    const fake = gateway({
      [CORE_REGISTER]: jsonResponse(404, {}),
      [PLUGIN_REGISTER]: jsonResponse(201, { ticket: 'plugin-ticket-fixture', ws_path: wsPath }),
    });
    const connection = await connect(fake);
    assert.equal(FakeSocket.instances[0].url, PLUGIN_SOCKET, String(wsPath));
    connection.close();
  }
  const fake = gateway({
    [CORE_REGISTER]: jsonResponse(201, { ticket: 'core-ticket-fixture', ws_path: PLUGIN_WS_PATH }),
  });
  const connection = await connect(fake);
  assert.equal(FakeSocket.instances[0].url, PLUGIN_SOCKET, 'a known path is accepted');
  connection.close();
});

test('a remote HTTPS gateway with a path prefix reaches the plugin routes under that prefix', async () => {
  const prefixed = 'https://hermes.example/gateway';
  const fake = gateway({
    [`${prefixed}/v1/browser-control/register`]: jsonResponse(404, {}),
    [`${prefixed}/api/plugins/hermes-browser-companion/control/register`]: jsonResponse(201, { ticket: 'plugin-ticket-fixture', ws_path: PLUGIN_WS_PATH }),
  });
  const connection = await connect(fake, { ...LOCAL_SETTINGS, connectionTransport: 'remote-api', gatewayUrl: prefixed });
  assert.equal(FakeSocket.instances[0].url, `wss://hermes.example/gateway${PLUGIN_WS_PATH}`);
  connection.close();
});

test('the protocol exports stay stable and gain the plugin route', () => {
  assert.equal(CONTROLLER_BROWSER_CAPABILITIES.length, 20);
  assert.deepEqual({ ...CONTROLLER_ROUTES }, { core: 'core', plugin: 'plugin' });
  const family = CONTROLLER_TRANSPORT_FAMILIES.LOCAL_API;
  const baseUrl = 'http://127.0.0.1:8642';
  // The default is core's route, exactly as before.
  assert.equal(controllerRegistrationFor({ family, baseUrl, identity: IDENTITY }).registrationUrl, CORE_REGISTER);
  assert.equal(controllerRegistrationFor({ family, baseUrl, identity: IDENTITY, route: 'core' }).registrationUrl, CORE_REGISTER);
  const plugin = controllerRegistrationFor({ family, baseUrl, identity: IDENTITY, route: CONTROLLER_ROUTES.plugin });
  assert.equal(plugin.registrationUrl, PLUGIN_REGISTER);
  assert.equal(plugin.transport, 'api-ticket-ws');
  assert.equal(plugin.payload.protocol_version, 1);
  assert.throws(() => controllerRegistrationFor({ family, baseUrl, identity: IDENTITY, route: 'elsewhere' }), /Unsupported controller route/);
  // Cloud registration is an RPC, not a route.
  const cloud = controllerRegistrationFor({ family: CONTROLLER_TRANSPORT_FAMILIES.CLOUD_TICKET_WS, baseUrl: 'https://dash.example', identity: IDENTITY, route: 'plugin' });
  assert.equal(cloud.method, 'browser.controller.register');
  assert.equal(cloud.registrationUrl, undefined);
  assert.equal(controllerWebSocketUrl(baseUrl), CORE_SOCKET);
  assert.equal(controllerWebSocketUrl(baseUrl, PLUGIN_WS_PATH), PLUGIN_SOCKET);
  assert.equal(controllerWebSocketUrl(baseUrl, '/nope'), CORE_SOCKET);
  assert.equal(controllerWebSocketUrl(baseUrl, PLUGIN_WS_PATH, 'luxord'), `ws://127.0.0.1:8642/p/luxord${PLUGIN_WS_PATH}`);
  assert.equal(controllerProfilePath('/v1/x', 'luxord'), '/p/luxord/v1/x');
  assert.equal(controllerProfilePath('/p/other/v1/x', 'luxord'), '/p/other/v1/x');
  assert.equal(controllerProfilePath('/v1/x', ''), '/v1/x');
  assert.equal(controllerSocketPath('plugin', undefined), PLUGIN_WS_PATH);
  assert.equal(controllerSocketPath('core', undefined), '/v1/browser-control/ws');
  assert.equal(controllerSocketPath('core', ` ${PLUGIN_WS_PATH} `), PLUGIN_WS_PATH);
});
