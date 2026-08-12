import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildDashboardWsEndpoint,
  buildDashboardWsUrl,
  buildDashboardWsUrlWithCredential,
  buildSessionModelSwitchRequest,
  classifyGatewayFrame,
  createGatewayClient,
  establishGatewaySession,
  gatewayWebSocketProtocols,
  normalizeGatewayHistoryMessages,
  remoteSessionIdentity,
  remoteStoredSessionIdForGateway,
  runtimeModelFromSessionStatus,
  WS_METHODS,
} from '../extension/lib/gateway-ws.mjs';

test('Cloud history normalization keeps canonical gateway text rows and legacy content rows', () => {
  const messages = normalizeGatewayHistoryMessages({
    count: 6,
    messages: [
      { role: 'user', text: 'old user turn', row_id: 41 },
      { role: 'assistant', text: 'old assistant turn', row_id: 42 },
      { role: 'system', content: [{ type: 'text', text: 'legacy block content' }] },
      { role: 'assistant', content: { text: 'legacy object content' } },
      { role: 'tool', name: 'web_search', context: 'searched the web' },
      null,
    ],
  });

  assert.deepEqual(
    messages.map(({ role, content }) => ({ role, content })),
    [
      { role: 'user', content: 'old user turn' },
      { role: 'assistant', content: 'old assistant turn' },
      { role: 'system', content: 'legacy block content' },
      { role: 'assistant', content: 'legacy object content' },
      { role: 'tool', content: 'searched the web' },
    ],
  );
  assert.equal(messages[0].row_id, 41);
});

class FakeWebSocket {
  constructor(url, protocols = []) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    this._listeners = {};
    FakeWebSocket.last = this;
  }

  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this._emit('close', { code: 1000 });
  }

  _emit(type, event) {
    for (const fn of this._listeners[type] || []) fn(event);
  }

  _open() {
    this.readyState = 1;
    this._emit('open', {});
  }

  _message(obj) {
    this._emit('message', { data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  }
}

test('buildDashboardWsUrl upgrades scheme, keeps path prefix, encodes ticket', () => {
  assert.equal(
    buildDashboardWsUrl('https://kurokami.example.ts.net', 'abc/123'),
    'wss://kurokami.example.ts.net/api/ws?ticket=abc%2F123',
  );
  assert.equal(
    buildDashboardWsUrl('http://127.0.0.1:8642/hermes/', 't1'),
    'ws://127.0.0.1:8642/hermes/api/ws?ticket=t1',
  );
});

test('gateway controller admission uses a credential-free endpoint and ticket subprotocol', async () => {
  const endpoint = buildDashboardWsEndpoint('https://dashboard.example/hermes?copied=1#section');
  assert.equal(endpoint, 'wss://dashboard.example/hermes/api/ws');
  assert.equal(endpoint.includes('ticket='), false);
  assert.deepEqual(gatewayWebSocketProtocols('ticket-fixture'), [
    'hermes-gateway-v1',
    'hermes-gateway-ticket.ticket-fixture',
  ]);
  assert.throws(() => gatewayWebSocketProtocols('bad ticket'), /unsupported/i);

  const client = createGatewayClient({ WebSocketImpl: FakeWebSocket });
  const connecting = client.connect(endpoint, gatewayWebSocketProtocols('ticket-fixture'));
  assert.equal(FakeWebSocket.last.url, endpoint);
  assert.deepEqual(FakeWebSocket.last.protocols, [
    'hermes-gateway-v1',
    'hermes-gateway-ticket.ticket-fixture',
  ]);
  FakeWebSocket.last._open();
  FakeWebSocket.last._message({ method: 'event', params: { type: 'gateway.ready', payload: {} } });
  await connecting;
});

test('loopback dashboard WebSockets use the injected session token instead of an OAuth ticket', () => {
  assert.equal(
    buildDashboardWsUrlWithCredential('http://127.0.0.1:9119', 'token', 'local/session'),
    'ws://127.0.0.1:9119/api/ws?token=local%2Fsession',
  );
  assert.throws(() => buildDashboardWsUrlWithCredential('http://127.0.0.1:9119', 'internal', 'secret'), /credential/i);
});

test('Cloud session model switches use the persistent session-scoped config contract', () => {
  assert.deepEqual(
    buildSessionModelSwitchRequest({ sessionId: 'runtime-1', model: 'gpt-5.6-luna', provider: 'nous' }),
    {
      method: 'config.set',
      params: {
        session_id: 'runtime-1',
        key: 'model',
        value: 'gpt-5.6-luna --provider nous --session',
      },
    },
  );
  assert.throws(() => buildSessionModelSwitchRequest({ sessionId: '', model: 'x', provider: 'nous' }), /session/i);
  assert.throws(() => buildSessionModelSwitchRequest({ sessionId: 'runtime-1', model: '', provider: 'nous' }), /model/i);
  // Provider is optional for the gateway-default alias: 'hermes-agent' is
  // resolved by the gateway, never sent as an explicit provider override.
  assert.deepEqual(
    buildSessionModelSwitchRequest({ sessionId: 'runtime-1', model: 'hermes-agent', provider: '' }),
    {
      method: 'config.set',
      params: {
        session_id: 'runtime-1',
        key: 'model',
        value: 'hermes-agent --session',
      },
    },
  );
  assert.throws(() => buildSessionModelSwitchRequest({ sessionId: 'runtime-1', model: 'x --global', provider: 'nous' }), /flags|whitespace/i);
  assert.throws(() => buildSessionModelSwitchRequest({ sessionId: 'runtime-1', model: 'x', provider: '--global' }), /flags|whitespace/i);
});

test('session.status model lines provide runtime acknowledgement for Cloud switches', () => {
  assert.deepEqual(
    runtimeModelFromSessionStatus('Hermes TUI Status\n\nModel: openai/gpt-5.6-luna (nous)\nAgent Running: No'),
    { model: 'openai/gpt-5.6-luna', provider: 'nous' },
  );
  assert.deepEqual(runtimeModelFromSessionStatus('Model: (unknown) (unknown)'), { model: '', provider: '' });
  assert.deepEqual(runtimeModelFromSessionStatus('no model metadata'), { model: '', provider: '' });
});

test('session.status runtime acknowledgement accepts structured fields and strips terminal formatting', () => {
  assert.deepEqual(
    runtimeModelFromSessionStatus({ model: 'openai/gpt-5.6-luna', provider: 'nous' }),
    { model: 'openai/gpt-5.6-luna', provider: 'nous' },
  );
  assert.deepEqual(
    runtimeModelFromSessionStatus({ output: '\u001b[36mModel: vendor/model (preview) (provider-id)\u001b[0m' }),
    { model: 'vendor/model (preview)', provider: 'provider-id' },
  );
  assert.deepEqual(
    runtimeModelFromSessionStatus({ output: 'Model: vendor/model', model: 'vendor/model', provider: '' }),
    { model: 'vendor/model', provider: '' },
  );
});

test('WS_METHODS exposes Desktop/TUI session steering instead of slash-command injection', () => {
  assert.equal(WS_METHODS.sessionSteer, 'session.steer');
  assert.equal(WS_METHODS.promptSubmit, 'prompt.submit');
});

test('remoteSessionIdentity keeps live and durable ids distinct', () => {
  assert.deepEqual(
    remoteSessionIdentity({ session_id: 'live-A', stored_session_id: 'stored-A' }),
    { liveId: 'live-A', storedId: 'stored-A', profile: '' },
  );
  assert.deepEqual(
    remoteSessionIdentity({ session_id: 'live-B', resumed: 'stored-B', session_key: 'stored-B' }, 'stored-A'),
    { liveId: 'live-B', storedId: 'stored-B', profile: '' },
  );
  assert.deepEqual(
    remoteSessionIdentity({ session_id: 'live-C' }, 'stored-C'),
    { liveId: 'live-C', storedId: 'stored-C', profile: '' },
  );
});

test('remoteSessionIdentity surfaces the server-reported profile', () => {
  assert.deepEqual(
    remoteSessionIdentity({ session_id: 'live-A', stored_session_id: 'stored-A', profile: 'sebastian' }),
    { liveId: 'live-A', storedId: 'stored-A', profile: 'sebastian' },
  );
  assert.deepEqual(
    remoteSessionIdentity({ session_id: 'live-B', stored_session_id: 'stored-B', profile_name: 'work' }),
    { liveId: 'live-B', storedId: 'stored-B', profile: 'work' },
  );
  assert.deepEqual(
    remoteSessionIdentity({ session_id: 'live-C', stored_session_id: 'stored-C', effective_profile: 'default' }),
    { liveId: 'live-C', storedId: 'stored-C', profile: 'default' },
  );
});

test('remote stored session bindings never cross dashboard origins', () => {
  const binding = {
    storedSessionId: 'stored-A',
    gatewayUrl: 'https://one.example/hermes/',
  };
  assert.equal(remoteStoredSessionIdForGateway(binding, 'https://one.example/hermes'), 'stored-A');
  assert.equal(remoteStoredSessionIdForGateway(binding, 'https://two.example/hermes'), '');
  assert.equal(remoteStoredSessionIdForGateway({ ...binding, storedSessionId: '' }, 'https://one.example/hermes'), '');
  assert.equal(remoteStoredSessionIdForGateway(null, 'https://one.example/hermes'), '');
});

test('gateway session reconnect resumes the durable id and routes follow-up RPCs through the fresh live id', async () => {
  const first = createGatewayClient({ WebSocketImpl: FakeWebSocket });
  const firstConnect = first.connect('wss://host/api/ws?ticket=first');
  FakeWebSocket.last._open();
  FakeWebSocket.last._message({ method: 'event', params: { type: 'gateway.ready', payload: {} } });
  await firstConnect;

  const creating = establishGatewaySession({ client: first, createParams: { title: 'Durable chat' } });
  const createFrame = JSON.parse(FakeWebSocket.last.sent.at(-1));
  assert.equal(createFrame.method, WS_METHODS.sessionCreate);
  FakeWebSocket.last._message({
    id: createFrame.id,
    result: { session_id: 'live-A', stored_session_id: 'stored-A' },
  });
  assert.deepEqual(await creating, { action: 'created', liveId: 'live-A', storedId: 'stored-A', profile: '' });

  first.close();

  const second = createGatewayClient({ WebSocketImpl: FakeWebSocket });
  const secondConnect = second.connect('wss://host/api/ws?ticket=second');
  FakeWebSocket.last._open();
  FakeWebSocket.last._message({ method: 'event', params: { type: 'gateway.ready', payload: {} } });
  await secondConnect;

  const resuming = establishGatewaySession({
    client: second,
    storedSessionId: 'stored-A',
    createParams: { title: 'must not create' },
  });
  const resumeFrame = JSON.parse(FakeWebSocket.last.sent.at(-1));
  assert.equal(resumeFrame.method, WS_METHODS.sessionResume);
  assert.deepEqual(resumeFrame.params, { session_id: 'stored-A' });
  assert.equal(
    FakeWebSocket.last.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.method === WS_METHODS.sessionCreate).length,
    0,
  );
  FakeWebSocket.last._message({
    id: resumeFrame.id,
    result: { session_id: 'live-B', resumed: 'stored-A', session_key: 'stored-A' },
  });
  assert.deepEqual(await resuming, { action: 'resumed', liveId: 'live-B', storedId: 'stored-A', profile: '' });

  const followUp = second.request(WS_METHODS.sessionHistory, { session_id: 'live-B' });
  const historyFrame = JSON.parse(FakeWebSocket.last.sent.at(-1));
  assert.equal(historyFrame.params.session_id, 'live-B');
  FakeWebSocket.last._message({ id: historyFrame.id, result: { messages: [] } });
  await followUp;
});

test('sidepanel reconnect wiring persists the durable id and resumes only on the bound dashboard', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(source, /remoteStoredSessionIdForGateway\(settings\.remoteDashboardSession, connection\.baseUrl\)/);
  assert.match(source, /establishGatewaySession\(\{[\s\S]*?storedSessionId,[\s\S]*?createParams:/);
  assert.match(source, /remoteDashboardSession:\s*\{[\s\S]*?storedSessionId:\s*storedId,[\s\S]*?gatewayUrl:\s*connection\.baseUrl/);
  assert.match(source, /connection\.wsStoredSessionId\s*=\s*storedId/);
});

test('both Browser surfaces normalize Cloud history before rendering it', () => {
  const appSource = readFileSync(new URL('../extension/app.js', import.meta.url), 'utf8');
  const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

  assert.match(
    appSource,
    /function dashboardHistoryMessages\(payload = \{\}\) \{\s*return normalizeGatewayHistoryMessages\(payload\);\s*\}/,
  );
  assert.match(
    sidepanelSource,
    /const contextMessages = normalizeGatewayHistoryMessages\(result\)[\s\S]*?content: message\.content/,
  );
  assert.doesNotMatch(sidepanelSource, /coerceWsMessageContent/);
});

test('classifyGatewayFrame distinguishes responses, errors, events, and noise', () => {
  assert.deepEqual(classifyGatewayFrame('{"id":1,"result":{"ok":true}}'), {
    kind: 'response',
    id: 1,
    result: { ok: true },
  });
  assert.equal(classifyGatewayFrame('{"id":2,"error":{"message":"nope"}}').kind, 'error');
  assert.deepEqual(
    classifyGatewayFrame({ method: 'event', params: { type: 'message.delta', session_id: 's1', payload: { text: 'hi' } } }),
    { kind: 'event', type: 'message.delta', sessionId: 's1', payload: { text: 'hi' } },
  );
  assert.equal(classifyGatewayFrame('not json').kind, 'ignore');
  assert.equal(classifyGatewayFrame({ method: 'event', params: {} }).kind, 'ignore');
});

test('gateway client connects, resolves a matching RPC response, and dispatches events', async () => {
  const client = createGatewayClient({ WebSocketImpl: FakeWebSocket });
  const connecting = client.connect('wss://host/api/ws?ticket=t');
  let connected = false;
  connecting.then(() => { connected = true; });
  FakeWebSocket.last._open();
  await Promise.resolve();
  assert.equal(connected, false, 'socket open alone must not prove Hermes gateway identity');
  FakeWebSocket.last._message({ method: 'event', params: { type: 'gateway.ready', payload: { protocol: 1 } } });
  assert.deepEqual(await connecting, { protocol: 1 });
  assert.deepEqual(client.readyPayload, { protocol: 1 });

  const deltas = [];
  client.on('message.delta', (event) => deltas.push(event.payload.text));

  const pending = client.request('prompt.submit', { session_id: 's1', text: 'hello' });
  const sent = JSON.parse(FakeWebSocket.last.sent.at(-1));
  assert.equal(sent.jsonrpc, '2.0');
  assert.equal(sent.method, 'prompt.submit');
  assert.deepEqual(sent.params, { session_id: 's1', text: 'hello' });

  FakeWebSocket.last._message({ method: 'event', params: { type: 'message.delta', session_id: 's1', payload: { text: 'hel' } } });
  FakeWebSocket.last._message({ id: sent.id, result: { status: 'streaming' } });

  assert.deepEqual(await pending, { status: 'streaming' });
  assert.deepEqual(deltas, ['hel']);
});

test('gateway client rejects a socket that never sends gateway.ready', async () => {
  const client = createGatewayClient({ WebSocketImpl: FakeWebSocket, readyTimeoutMs: 10 });
  const connecting = client.connect('wss://host/api/ws?ticket=t');
  FakeWebSocket.last._open();
  await assert.rejects(connecting, /gateway\.ready.*timed out/i);
  assert.equal(client.readyState, -1);
});

test('gateway client ignores a late close from a timed-out socket during reconnect', async () => {
  const sockets = [];
  class DelayedCloseSocket extends FakeWebSocket {
    constructor(url) {
      super(url);
      sockets.push(this);
    }

    close() {
      this.readyState = 3;
    }

    flushClose() {
      this._emit('close', { code: 1006, reason: '' });
    }
  }

  const client = createGatewayClient({ WebSocketImpl: DelayedCloseSocket, readyTimeoutMs: 10 });
  await assert.rejects(client.connect('wss://host/api/ws?ticket=old'), /gateway\.ready.*timed out/i);

  const reconnecting = client.connect('wss://host/api/ws?ticket=new');
  sockets[0].flushClose();
  sockets[1]._open();
  sockets[1]._message({ method: 'event', params: { type: 'gateway.ready', payload: { skin: 'hermes' } } });
  await assert.doesNotReject(reconnecting);
  assert.equal(client.readyState, 1);
});

test('gateway client rejects pending requests when the socket closes', async () => {
  const client = createGatewayClient({ WebSocketImpl: FakeWebSocket });
  const connecting = client.connect('wss://host/api/ws?ticket=t');
  FakeWebSocket.last._open();
  FakeWebSocket.last._message({ method: 'event', params: { type: 'gateway.ready', payload: {} } });
  await connecting;

  const pending = client.request('session.list', {});
  FakeWebSocket.last.close();
  await assert.rejects(pending, /closed/i);
});
