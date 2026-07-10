import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDashboardWsUrl,
  classifyGatewayFrame,
  createGatewayClient,
  mergeRemoteSessionsForProfile,
  normalizeRemoteSessionBindings,
  rememberRemoteSessionBinding,
  resolveVerifiedGatewayProfile,
  sessionProfileForGateway,
  withGatewayProfile,
  WS_METHODS,
} from '../extension/lib/gateway-ws.mjs';

class FakeWebSocket {
  constructor(url) {
    this.url = url;
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

test('WS_METHODS exposes Desktop/TUI session steering instead of slash-command injection', () => {
  assert.equal(WS_METHODS.sessionSteer, 'session.steer');
  assert.equal(WS_METHODS.promptSubmit, 'prompt.submit');
});

test('withGatewayProfile adds a trimmed profile without mutating the input', () => {
  const params = { session_id: 's1' };
  assert.deepEqual(withGatewayProfile(params, '  research  '), { session_id: 's1', profile: 'research' });
  assert.deepEqual(withGatewayProfile(params, ''), { session_id: 's1' });
  assert.deepEqual(params, { session_id: 's1' });
});

test('resolveVerifiedGatewayProfile fails closed for stale or missing profile discovery', () => {
  const input = {
    selectedProfile: ' research ',
    profiles: [{ name: 'research' }],
    verifiedBaseUrl: 'https://host.example/hermes/',
    gatewayUrl: 'https://host.example/hermes',
  };
  assert.equal(resolveVerifiedGatewayProfile(input), 'research');
  assert.equal(resolveVerifiedGatewayProfile({ ...input, selectedProfile: '' }), '');
  assert.throws(() => resolveVerifiedGatewayProfile({ ...input, profiles: [] }), /not verified/);
  assert.throws(() => resolveVerifiedGatewayProfile({ ...input, verifiedBaseUrl: 'https://other.example' }), /not verified/);
});

test('remote session bindings preserve profile ownership and isolate session menus', () => {
  const bindings = rememberRemoteSessionBinding({}, {
    id: 'profile-session',
    title: 'Research session',
    source: 'hermes_browser',
  }, {
    profile: 'research',
    gatewayUrl: 'https://host.example/hermes/',
    now: 20,
  });
  assert.deepEqual(normalizeRemoteSessionBindings(bindings), {
    'profile-session': {
      profile: 'research',
      gatewayUrl: 'https://host.example/hermes',
      title: 'Research session',
      source: 'hermes_browser',
      updatedAt: 20,
    },
  });
  assert.equal(sessionProfileForGateway({ id: 'profile-session' }, bindings, 'https://host.example/hermes'), 'research');
  assert.equal(sessionProfileForGateway({ id: 'profile-session' }, bindings, 'https://other.example'), '');
  assert.equal(sessionProfileForGateway({ id: 'direct', profile: 'research', gatewayUrl: 'https://host.example/hermes' }, bindings, 'https://other.example'), '');
  const switchedBindings = rememberRemoteSessionBinding(bindings, {
    id: 'thanos-session',
    title: 'Thanos session',
  }, {
    profile: 'thanos',
    gatewayUrl: 'https://host.example/hermes',
    now: 50,
  });

  const listed = [
    { id: 'launch-session', title: 'Launch', profile: '', lastActive: 30 },
    { id: 'future-scoped', title: 'Scoped', profile: 'research', lastActive: 40 },
  ];
  assert.deepEqual(
    mergeRemoteSessionsForProfile({ listedSessions: listed, bindings, gatewayUrl: 'https://host.example/hermes', selectedProfile: '' })
      .map((session) => session.id),
    ['launch-session'],
  );
  assert.deepEqual(
    mergeRemoteSessionsForProfile({ listedSessions: listed, bindings: switchedBindings, gatewayUrl: 'https://host.example/hermes', selectedProfile: 'research' })
      .map((session) => session.id),
    ['future-scoped', 'profile-session'],
  );
  assert.deepEqual(
    mergeRemoteSessionsForProfile({ listedSessions: listed, bindings: switchedBindings, gatewayUrl: 'https://host.example/hermes', selectedProfile: 'thanos' })
      .map((session) => session.id),
    ['thanos-session'],
  );
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
  FakeWebSocket.last._open();
  await connecting;

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

test('gateway client rejects pending requests when the socket closes', async () => {
  const client = createGatewayClient({ WebSocketImpl: FakeWebSocket });
  const connecting = client.connect('wss://host/api/ws?ticket=t');
  FakeWebSocket.last._open();
  await connecting;

  const pending = client.request('session.list', {});
  FakeWebSocket.last.close();
  await assert.rejects(pending, /closed/i);
});
