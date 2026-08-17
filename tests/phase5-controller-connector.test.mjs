import assert from 'node:assert/strict';
import test from 'node:test';

import { createControllerConnector } from '../extension/lib/controller-connector.mjs';

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

  send(raw) {
    this.sent.push(raw);
  }

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

  message(frame) {
    this.emit('message', { data: JSON.stringify(frame) });
  }
}

function dashboardBridge(ticket = 'cloud-ticket-fixture') {
  const calls = [];
  return {
    calls,
    async mintWsTicket(input) {
      calls.push(input);
      return { ok: true, ticket, ttlSeconds: 30, principal: { user_id: 'u1', provider: 'fixture' } };
    },
  };
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

test('local and VPS connector registers with Bearer auth then uses a credential-free subprotocol socket', async () => {
  const accessValue = ['fixture', 'access', 'value'].join('-');
  FakeSocket.instances = [];
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return jsonResponse(201, {
      ticket: 'api-ticket-fixture',
      ticket_expires_in_seconds: 30,
      ws_path: '/v1/browser-control/ws',
    });
  };
  const connector = createControllerConnector({ fetchImpl, WebSocketImpl: FakeSocket });
  const frames = [];
  const closes = [];
  const connecting = connector.connect({
    settings: {
      connectionTransport: 'local-api',
      gatewayUrl: 'http://127.0.0.1:8642',
      apiKey: accessValue,
      activeProfile: 'work',
    },
    identity: IDENTITY,
    onFrame: (frame) => frames.push(frame),
    onClose: (error) => closes.push(error?.message || ''),
  });
  await settle();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:8642/v1/browser-control/register');
  assert.equal(requests[0].options.headers.Authorization, ['Bearer', accessValue].join(' '));
  assert.equal(requests[0].options.headers['X-Hermes-Profile'], 'work');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(JSON.parse(requests[0].options.body).session_id, 'stored-session-fixture');

  const socket = FakeSocket.instances[0];
  assert.equal(socket.url, 'ws://127.0.0.1:8642/v1/browser-control/ws');
  assert.equal(socket.url.includes('ticket='), false);
  assert.deepEqual(socket.protocols, [
    'hermes-browser-control-v1',
    'hermes-browser-control-ticket.api-ticket-fixture',
  ]);
  socket.open();
  const connection = await connecting;

  const heartbeat = connection.heartbeat();
  await settle();
  const heartbeatFrame = lastJson(socket);
  assert.equal(heartbeatFrame.method, 'browser.controller.heartbeat');
  assert.match(heartbeatFrame.params.nonce, /^heartbeat-/);
  socket.message({
    method: 'browser.controller.heartbeat',
    params: { nonce: heartbeatFrame.params.nonce, ok: true },
  });
  assert.deepEqual(await heartbeat, { ok: true });

  socket.message({ method: 'browser.controller.command', params: { command_id: 'local-command' } });
  assert.deepEqual(frames, [{ method: 'browser.controller.command', params: { command_id: 'local-command' } }]);
  await connection.send({ method: 'browser.controller.result', params: { command_id: 'local-command', ok: true } });
  assert.deepEqual(lastJson(socket), { method: 'browser.controller.result', params: { command_id: 'local-command', ok: true } });
  socket.close();
  assert.equal(closes.length, 1);
});

test('local API registration POST is bounded by the connector timeout', async () => {
  const accessValue = ['fixture', 'access', 'value'].join('-');
  let capturedSignal = null;
  const connector = createControllerConnector({
    fetchImpl: async (_url, options) => {
      capturedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
    WebSocketImpl: FakeSocket,
    connectTimeoutMs: 5,
  });

  await assert.rejects(connector.connect({
    settings: {
      connectionTransport: 'local-api',
      gatewayUrl: 'http://127.0.0.1:8642',
      apiKey: accessValue,
    },
    identity: IDENTITY,
  }), /timed out/i);
  assert.equal(capturedSignal?.aborted, true);
});

test('remote API connector rejects insecure or credential-in-URL endpoints before fetch', async () => {
  const accessValue = ['fixture', 'access', 'value'].join('-');
  const credentialedUrl = new URL('https://agent.example.test');
  credentialedUrl.username = ['fixture', 'user'].join('-');
  credentialedUrl.password = ['fixture', 'pass'].join('-');
  let fetched = false;
  const connector = createControllerConnector({
    fetchImpl: async () => { fetched = true; throw new Error('must not fetch'); },
    WebSocketImpl: FakeSocket,
  });
  await assert.rejects(connector.connect({
    settings: { connectionTransport: 'remote-api', gatewayUrl: 'http://agent.example.test', apiKey: accessValue },
    identity: IDENTITY,
  }), /https/i);
  await assert.rejects(connector.connect({
    settings: { connectionTransport: 'remote-api', gatewayUrl: credentialedUrl.href, apiKey: accessValue },
    identity: IDENTITY,
  }), /credentials/i);
  assert.equal(fetched, false);
});

test('Cloud connector uses trusted dashboard mint, credential-free gateway subprotocol, exact resume, and live-session registration', async () => {
  FakeSocket.instances = [];
  const bridge = dashboardBridge();
  const connector = createControllerConnector({
    WebSocketImpl: FakeSocket,
    tabsApi: { query: async () => [], get: async () => ({}) },
    scriptingApi: { executeScript: async () => [] },
    mintDashboardTicket: bridge.mintWsTicket,
  });
  const inbound = [];
  const connecting = connector.connect({
    settings: {
      connectionTransport: 'cloud-ticket-ws',
      connectionMode: 'cloud',
      gatewayUrl: 'https://dashboard.example/hermes?copied=1#section',
      trustedDashboardOrigin: 'https://dashboard.example',
      trustedDashboardTabId: 77,
      activeProfile: 'default',
    },
    identity: IDENTITY,
    onFrame: (frame) => inbound.push(frame),
  });
  await settle();

  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].baseUrl, 'https://dashboard.example/hermes?copied=1#section');
  assert.equal(bridge.calls[0].tabId, 77);
  const socket = FakeSocket.instances[0];
  assert.equal(socket.url, 'wss://dashboard.example/hermes/api/ws');
  assert.equal(socket.url.includes('ticket='), false);
  assert.deepEqual(socket.protocols, [
    'hermes-gateway-v1',
    'hermes-gateway-ticket.cloud-ticket-fixture',
  ]);
  socket.open();
  socket.message({ method: 'event', params: { type: 'gateway.ready', payload: {} } });
  await settle();

  const resume = lastJson(socket);
  assert.equal(resume.method, 'session.resume');
  assert.deepEqual(resume.params, { session_id: 'stored-session-fixture' });
  socket.message({ id: resume.id, result: { session_id: 'live-session-2', resumed: 'stored-session-fixture' } });
  await settle();

  const register = lastJson(socket);
  assert.equal(register.method, 'browser.controller.register');
  assert.equal(register.params.session_id, 'live-session-2');
  assert.equal(register.params.controller_id, 'controller-fixture');
  socket.message({ id: register.id, result: { scope: { session_id: 'live-session-2' } } });
  const connection = await connecting;

  const heartbeat = connection.heartbeat();
  await settle();
  const heartbeatFrame = lastJson(socket);
  assert.equal(heartbeatFrame.method, 'browser.controller.heartbeat');
  assert.equal(heartbeatFrame.params.session_id, 'live-session-2');
  socket.message({ id: heartbeatFrame.id, result: { ok: true } });
  assert.deepEqual(await heartbeat, { ok: true });

  socket.message({
    method: 'event',
    params: {
      type: 'browser.controller.command',
      session_id: 'live-session-2',
      payload: { command_id: 'cloud-command', action: 'controller.noop', arguments: {} },
    },
  });
  assert.equal(inbound.at(-1).method, 'event');
  assert.equal(inbound.at(-1).params.session_id, 'live-session-2');

  const sendingResult = connection.send({
    method: 'browser.controller.result',
    params: { command_id: 'cloud-command', ok: true, result: {} },
  });
  await settle();
  const result = lastJson(socket);
  assert.equal(result.method, 'browser.controller.result');
  assert.equal(result.params.session_id, 'live-session-2');
  socket.message({ id: result.id, result: { accepted: true } });
  assert.deepEqual(await sendingResult, { accepted: true });
});

test('local API connector materializes a ghost session on browser_control_session_forbidden and retries', async () => {
  FakeSocket.instances = [];
  const requests = [];
  let registerCalls = 0;
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/v1/browser-control/register')) {
      registerCalls += 1;
      if (registerCalls === 1) {
        return jsonResponse(403, {
          error: {
            message: 'Browser control may register only for an existing server session.',
            code: 'browser_control_session_forbidden',
          },
        });
      }
      return jsonResponse(201, {
        ticket: 'api-ticket-after-materialize',
        ticket_expires_in_seconds: 30,
        ws_path: '/v1/browser-control/ws',
      });
    }
    if (url.endsWith('/api/sessions')) {
      const body = JSON.parse(options.body);
      assert.equal(body.id, 'stored-session-fixture');
      assert.equal(body.source, 'hermes_browser');
      return jsonResponse(201, { session: { id: body.id } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const connector = createControllerConnector({ fetchImpl, WebSocketImpl: FakeSocket });
  const connecting = connector.connect({
    settings: {
      connectionTransport: 'local-api',
      gatewayUrl: 'http://127.0.0.1:8642',
      apiKey: 'fixture-key',
      sessionTitle: 'Hermes Browser Extension · fixture',
      sessionSource: 'hermes_browser',
    },
    identity: IDENTITY,
  });
  await settle();

  assert.equal(registerCalls, 2, 'register must be retried after materializing the session');
  assert.equal(requests.length, 3);
  assert.equal(requests[1].url, 'http://127.0.0.1:8642/api/sessions');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[2].url, 'http://127.0.0.1:8642/v1/browser-control/register');
  assert.equal(JSON.parse(requests[2].options.body).session_id, 'stored-session-fixture');

  const socket = FakeSocket.instances[0];
  assert.equal(socket.url, 'ws://127.0.0.1:8642/v1/browser-control/ws');
  assert.deepEqual(socket.protocols, [
    'hermes-browser-control-v1',
    'hermes-browser-control-ticket.api-ticket-after-materialize',
  ]);
  socket.open();
  const connection = await connecting;
  assert.ok(connection.send, 'connection must resolve after the retried register');
});

test('local API connector fails when the ghost-session materialize POST is refused', async () => {
  FakeSocket.instances = [];
  let registerCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/v1/browser-control/register')) {
      registerCalls += 1;
      return jsonResponse(403, {
        error: { message: 'Browser control may register only for an existing server session.', code: 'browser_control_session_forbidden' },
      });
    }
    if (url.endsWith('/api/sessions')) return jsonResponse(401, { error: { message: 'Invalid key' } });
    throw new Error(`Unexpected request: ${url}`);
  };
  const connector = createControllerConnector({ fetchImpl, WebSocketImpl: FakeSocket });
  await assert.rejects(connector.connect({
    settings: {
      connectionTransport: 'local-api',
      gatewayUrl: 'http://127.0.0.1:8642',
      apiKey: 'fixture-key',
      sessionTitle: 'Hermes Browser Extension · fixture',
      sessionSource: 'hermes_browser',
    },
    identity: IDENTITY,
  }), /Browser control may register only for an existing server session/);
  assert.equal(registerCalls, 1, 'no register retry when materialization fails');
});

test('Cloud connector fails closed when dashboard trust does not match the configured origin', async () => {
  let minted = false;
  const connector = createControllerConnector({
    WebSocketImpl: FakeSocket,
    mintDashboardTicket: async () => { minted = true; return { ok: true, ticket: 'x' }; },
  });
  await assert.rejects(connector.connect({
    settings: {
      connectionTransport: 'remote-dashboard',
      gatewayUrl: 'https://dashboard.example',
      trustedDashboardOrigin: 'https://other.example',
      trustedDashboardTabId: 10,
    },
    identity: IDENTITY,
  }), /trusted dashboard/i);
  assert.equal(minted, false);
});
