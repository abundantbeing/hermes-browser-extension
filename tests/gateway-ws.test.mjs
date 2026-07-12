import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertGatewayProfileAck,
  assertProfileSessionCapability,
  buildDashboardWsUrl,
  classifyGatewayFrame,
  createGatewayClient,
  forgetRemoteSessionBinding,
  mergeRemoteSessionsForProfile,
  normalizeRemoteSessionBindings,
  rememberRemoteSessionBinding,
  remoteSessionIdentity,
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

test('remoteSessionIdentity keeps live and stored session ids distinct across create, disconnect, and resume', () => {
  // session.create returns the live transport id plus the durable state.db key.
  const created = remoteSessionIdentity({ session_id: 'live-1', stored_session_id: 'stored-a' });
  assert.deepEqual(created, { liveId: 'live-1', storedId: 'stored-a' });
  assert.notEqual(created.liveId, created.storedId);

  // The socket is replaced; resume is requested with the STORED id and returns
  // a fresh live id. Live RPCs (history/prompt/interrupt) must use liveId,
  // while menus/bindings keep storedId.
  const resumed = remoteSessionIdentity(
    { session_id: 'live-2', session_key: 'stored-a', resumed: 'stored-a' },
    created.storedId,
  );
  assert.deepEqual(resumed, { liveId: 'live-2', storedId: 'stored-a' });
  assert.notEqual(resumed.liveId, created.liveId);

  // Compression-chain resolution: resume may re-anchor to a descendant key.
  assert.deepEqual(
    remoteSessionIdentity({ session_id: 'live-3', resumed: 'stored-b', session_key: 'stored-b' }, 'stored-a'),
    { liveId: 'live-3', storedId: 'stored-b' },
  );

  // Older gateways without stored ids fall back to the requested, then live id.
  assert.deepEqual(remoteSessionIdentity({ session_id: 'live-4' }, 'requested-x'), { liveId: 'live-4', storedId: 'requested-x' });
  assert.deepEqual(remoteSessionIdentity({ session_id: 'live-5' }), { liveId: 'live-5', storedId: 'live-5' });
  assert.deepEqual(remoteSessionIdentity({}), { liveId: '', storedId: '' });
});

test('assertGatewayProfileAck fails closed on missing or mismatched effective profile', () => {
  // Detect mode needs no ack.
  assert.equal(assertGatewayProfileAck({}, ''), '');
  assert.equal(assertGatewayProfileAck({ profile: '' }, ''), '');
  // Explicit selection with a matching ack passes.
  assert.equal(assertGatewayProfileAck({ profile: 'research' }, ' research '), 'research');
  // Missing ack (older dashboard) fails closed.
  assert.throws(() => assertGatewayProfileAck({}, 'research'), /does not confirm profile scope/);
  assert.throws(() => assertGatewayProfileAck({ profile: null }, 'research'), /does not confirm profile scope/);
  // The discovery-to-create race: the profile disappeared and the gateway
  // silently resolved the session to the launch profile.
  assert.throws(() => assertGatewayProfileAck({ profile: '' }, 'research'), /launch profile/);
  assert.throws(() => assertGatewayProfileAck({ profile: 'default' }, 'research'), /"default" instead of "research"/);
});

test('assertProfileSessionCapability refuses explicit profiles without the gateway capability', () => {
  // Detect mode is never gated.
  assert.equal(assertProfileSessionCapability(null, ''), '');
  assert.equal(assertProfileSessionCapability({}, ''), '');
  // Supported gateway passes the trimmed selection through.
  assert.equal(assertProfileSessionCapability({ session_profiles: true }, ' research '), 'research');
  // Legacy gateway (no capabilities, or capabilities without the flag).
  assert.throws(() => assertProfileSessionCapability(null, 'research'), /does not support profile-scoped sessions/);
  assert.throws(() => assertProfileSessionCapability({}, 'research'), /does not support profile-scoped sessions/);
  assert.throws(() => assertProfileSessionCapability({ session_profiles: false }, 'research'), /does not support profile-scoped sessions/);
});

test('legacy gateway without the capability gets NO profile-scoped session RPC at all', async () => {
  // The reviewer's regression: an explicit selection against a dashboard that
  // does not advertise session_profiles must not create a server-side session,
  // not merely skip the local binding. Simulate the wire: connect, receive a
  // legacy gateway.ready (skin only, no capabilities), gate, and assert no
  // session.create frame was ever written to the socket.
  const client = createGatewayClient({ WebSocketImpl: FakeWebSocket });
  const connecting = client.connect('wss://host/api/ws?ticket=t');
  FakeWebSocket.last._open();
  FakeWebSocket.last._message({ method: 'event', params: { type: 'gateway.ready', payload: { skin: 'default' } } });
  const readyPayload = await connecting;
  const capabilities = (readyPayload && typeof readyPayload.capabilities === 'object' && readyPayload.capabilities) || {};

  assert.deepEqual(capabilities, {});
  assert.throws(() => {
    assertProfileSessionCapability(capabilities, 'research');
    client.request(WS_METHODS.sessionCreate, withGatewayProfile({ title: 't' }, 'research'));
  }, /does not support profile-scoped sessions/);
  const sessionFrames = FakeWebSocket.last.sent
    .map((raw) => JSON.parse(raw))
    .filter((frame) => String(frame.method || '').startsWith('session.'));
  assert.deepEqual(sessionFrames, []);

  // A gateway that advertises the capability lets the same flow proceed.
  const modern = createGatewayClient({ WebSocketImpl: FakeWebSocket });
  const modernConnecting = modern.connect('wss://host/api/ws?ticket=t2');
  FakeWebSocket.last._open();
  FakeWebSocket.last._message({ method: 'event', params: { type: 'gateway.ready', payload: { skin: 'default', capabilities: { session_profiles: true } } } });
  const modernCapabilities = (await modernConnecting)?.capabilities || {};
  assert.equal(assertProfileSessionCapability(modernCapabilities, 'research'), 'research');
  const pendingCreate = modern.request(WS_METHODS.sessionCreate, withGatewayProfile({ title: 't' }, 'research'));
  const modernFrame = JSON.parse(FakeWebSocket.last.sent.at(-1));
  assert.equal(modernFrame.method, 'session.create');
  assert.equal(modernFrame.params.profile, 'research');

  // A capability-advertising gateway that still answers with a mismatched
  // effective profile (its documented behavior is to reject unresolved
  // profiles with 4041 BEFORE creating a session, so this shape means launch
  // fallback) must fail the ack check, and no binding may be persisted.
  FakeWebSocket.last._message({ id: modernFrame.id, result: { session_id: 'live-9', stored_session_id: 'stored-9', profile: '' } });
  const mismatched = await pendingCreate;
  assert.throws(() => assertGatewayProfileAck(mismatched, 'research'), /launch profile/);
});

test('forgetRemoteSessionBinding drops a re-anchored session id', () => {
  const bindings = rememberRemoteSessionBinding({}, { id: 'old-key', title: 'Chat' }, {
    profile: 'research',
    gatewayUrl: 'https://host.example/hermes',
    now: 10,
  });
  assert.deepEqual(Object.keys(forgetRemoteSessionBinding(bindings, 'old-key')), []);
  assert.deepEqual(Object.keys(forgetRemoteSessionBinding(bindings, 'other')), ['old-key']);
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
