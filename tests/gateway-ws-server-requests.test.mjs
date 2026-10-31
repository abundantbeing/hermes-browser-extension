import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  classifyGatewayFrame,
  createGatewayClient,
  establishGatewaySession,
  NOT_SHOWN_CODE,
  WS_EVENTS,
  WS_METHODS,
} from '../extension/lib/gateway-ws.mjs';

class FakeWebSocket {
  constructor(url, protocols = []) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    this._listeners = {};
    FakeWebSocket.last = this;
  }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }

  send(data) { this.sent.push(data); }

  close() {
    this.readyState = 3;
    this._emit('close', { code: 1000 });
  }

  _emit(type, event) { for (const fn of this._listeners[type] || []) fn(event); }

  _open() {
    this.readyState = 1;
    this._emit('open', {});
  }

  _message(obj) { this._emit('message', { data: JSON.stringify(obj) }); }
}

const frames = (socket) => socket.sent.map((raw) => JSON.parse(raw));

async function connected(options = {}) {
  const client = createGatewayClient({ WebSocketImpl: FakeWebSocket, requestTimeoutMs: 100, ...options });
  const connecting = client.connect('wss://host/api/ws?ticket=t');
  const socket = FakeWebSocket.last;
  socket._open();
  socket._message({ method: 'event', params: { type: 'gateway.ready', payload: {} } });
  await connecting;
  return { client, socket };
}

function handlerSpy({ owns = ['approval', 'clarify'], throwOnHandle = false } = {}) {
  const seen = [];
  const cancels = [];
  return {
    seen,
    cancels,
    handler: {
      handle(request, controls) {
        seen.push({ request, controls });
        if (throwOnHandle) throw new Error('boom');
        return owns.includes(request.method);
      },
      cancel(payload) { cancels.push(payload); },
    },
  };
}

test('a frame with an id and a method that is not "event" is a server request', () => {
  assert.deepEqual(
    classifyGatewayFrame({ jsonrpc: '2.0', id: 'srq-abc', method: 'approval', params: { session_id: 's1', request_id: 'r1', command: 'ls' } }),
    { kind: 'server-request', id: 'srq-abc', method: 'approval', sessionId: 's1', params: { session_id: 's1', request_id: 'r1', command: 'ls' } },
  );
  assert.equal(classifyGatewayFrame({ id: 'srq-1', method: 'clarify' }).kind, 'server-request');
  assert.equal(classifyGatewayFrame({ method: 'event', params: { type: 'x' } }).kind, 'event');
  assert.equal(classifyGatewayFrame({ id: 4, result: {} }).kind, 'response');
  assert.equal(classifyGatewayFrame({ id: 4, error: { code: 1 } }).kind, 'error');
  assert.equal(classifyGatewayFrame({ method: 'approval' }).kind, 'ignore', 'a notification without an id is not a request');
});

test('a client with no handler never advertises server requests', async () => {
  const { socket } = await connected();
  assert.equal(frames(socket).some((frame) => frame.method === WS_METHODS.clientCapabilities), false);
});

test('a client with a handler advertises server_requests before the caller can send anything else', async () => {
  const spy = handlerSpy();
  const client = createGatewayClient({ WebSocketImpl: FakeWebSocket, requestTimeoutMs: 100, serverRequests: spy.handler });
  const connecting = client.connect('wss://host/api/ws?ticket=t');
  const socket = FakeWebSocket.last;
  socket._open();
  assert.equal(socket.sent.length, 0, 'nothing is sent before gateway.ready');
  socket._message({ method: 'event', params: { type: 'gateway.ready', payload: {} } });
  // The caller's first request is issued in the continuation of connect().
  await connecting.then(() => { client.request(WS_METHODS.promptSubmit, { session_id: 's', text: 'hi' }).catch(() => {}); });
  const sent = frames(socket);
  assert.equal(sent[0].method, 'client.capabilities');
  assert.deepEqual(sent[0].params, { server_requests: true });
  assert.equal(sent[1].method, 'prompt.submit');
});

test('an owned server request is answered through controls.reply with the same id', async () => {
  const spy = handlerSpy();
  const { socket } = await connected({ serverRequests: spy.handler });
  socket._message({ jsonrpc: '2.0', id: 'srq-1', method: 'approval', params: { session_id: 'live', request_id: 'r', command: 'ls', choices: ['once', 'deny'] } });
  assert.equal(spy.seen.length, 1);
  assert.deepEqual(spy.seen[0].request, {
    id: 'srq-1', method: 'approval', params: { session_id: 'live', request_id: 'r', command: 'ls', choices: ['once', 'deny'] },
  });
  assert.equal(frames(socket).some((frame) => frame.id === 'srq-1'), false, 'the handler answers later, on the user\'s decision');
  spy.seen[0].controls.reply({ choice: 'deny' });
  assert.deepEqual(frames(socket).at(-1), { jsonrpc: '2.0', id: 'srq-1', result: { choice: 'deny' } });
});

test('controls.replyError sends a JSON-RPC error and controls.reply throws on a closed socket', async () => {
  const spy = handlerSpy();
  const { socket } = await connected({ serverRequests: spy.handler });
  socket._message({ id: 'srq-2', method: 'clarify', params: { session_id: 'live', questions: [] } });
  spy.seen[0].controls.replyError(-32602, 'bad');
  assert.deepEqual(frames(socket).at(-1), { jsonrpc: '2.0', id: 'srq-2', error: { code: -32602, message: 'bad' } });
  socket.readyState = 3;
  assert.throws(() => spy.seen[0].controls.reply({}), /not open/);
});

test('a request the handler does not own is declined, never left waiting', async () => {
  const spy = handlerSpy();
  const { socket } = await connected({ serverRequests: spy.handler });
  socket._message({ id: 'srq-3', method: 'sudo', params: { session_id: 'live' } });
  const reply = frames(socket).at(-1);
  assert.equal(reply.id, 'srq-3');
  assert.equal(reply.error.code, -32601);
});

test('window-owned requests are declined with the not-shown code once the gateway says it counts it', async () => {
  const spy = handlerSpy();
  const client = createGatewayClient({ WebSocketImpl: FakeWebSocket, requestTimeoutMs: 100, serverRequests: spy.handler });
  const connecting = client.connect('wss://host/api/ws?ticket=t');
  const socket = FakeWebSocket.last;
  socket._open();
  socket._message({ method: 'event', params: { type: 'gateway.ready', payload: {} } });
  await connecting;

  socket._message({ id: 'srq-4', method: 'preview.read', params: { session_id: 'live' } });
  assert.equal(frames(socket).at(-1).error.code, -32601, 'an older gateway settles on the first error, so no decline code');

  const capabilities = frames(socket).find((frame) => frame.method === 'client.capabilities');
  socket._message({ id: capabilities.id, result: { server_requests: ['approval', 'clarify'], declines_not_shown: true } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const method of ['preview.read', 'terminal.read', 'window.read', 'preview.act', 'tour']) {
    socket._message({ id: `srq-${method}`, method, params: { session_id: 'live' } });
    const reply = frames(socket).at(-1);
    assert.equal(reply.id, `srq-${method}`);
    assert.equal(reply.error.code, NOT_SHOWN_CODE, method);
  }
  socket._message({ id: 'srq-secret', method: 'secret', params: { session_id: 'live' } });
  assert.equal(frames(socket).at(-1).error.code, -32601, 'a prompt for a secret is never answered, only declined');
});

test('a handler that throws gets an internal error reply instead of silence', async () => {
  const spy = handlerSpy({ throwOnHandle: true });
  const { socket } = await connected({ serverRequests: spy.handler });
  socket._message({ id: 'srq-5', method: 'approval', params: { session_id: 'live' } });
  assert.equal(frames(socket).at(-1).error.code, -32603);
});

test('request.cancel reaches the handler as well as ordinary listeners', async () => {
  const spy = handlerSpy();
  const { client, socket } = await connected({ serverRequests: spy.handler });
  const seen = [];
  client.on(WS_EVENTS.requestCancel, (event) => seen.push(event.payload));
  socket._message({ method: 'event', params: { type: 'request.cancel', session_id: 'live', payload: { id: 'srq-1', method: 'approval', reason: 'timeout' } } });
  assert.deepEqual(spy.cancels, [{ id: 'srq-1', method: 'approval', reason: 'timeout' }]);
  assert.equal(seen.length, 1);
});

test('requests still open when a session is resumed are redelivered to the handler', async () => {
  const spy = handlerSpy();
  const { client, socket } = await connected({ serverRequests: spy.handler });
  const resuming = establishGatewaySession({ client, storedSessionId: 'stored-A', createParams: {} });
  const resume = frames(socket).find((frame) => frame.method === WS_METHODS.sessionResume);
  socket._message({
    id: resume.id,
    result: {
      session_id: 'live-B',
      resumed: 'stored-A',
      open_requests: [
        { id: 'srq-9', method: 'approval', params: { session_id: 'live-B', request_id: 'r9', command: 'ls' } },
        { id: 'srq-10', method: 'clarify', params: { session_id: 'live-B', questions: [{ qid: 'q', question: 'Q?' }] } },
        { method: 'approval' },
        null,
      ],
    },
  });
  await resuming;
  assert.deepEqual(spy.seen.map((item) => item.request.id), ['srq-9', 'srq-10']);
  spy.seen[0].controls.reply({ choice: 'deny' });
  assert.deepEqual(frames(socket).at(-1), { jsonrpc: '2.0', id: 'srq-9', result: { choice: 'deny' } });
});

test('requests listed by session.events.since after a reconnect are redelivered too', async () => {
  const spy = handlerSpy();
  const { client, socket: first } = await connected({ serverRequests: spy.handler });
  first._message({ method: 'event', params: { type: 'message.delta', session_id: 'live-A', seq: 4, payload: { text: 'x' } } });

  client.close();
  const reconnecting = client.connect('wss://host/api/ws?ticket=second');
  const socket = FakeWebSocket.last;
  socket._open();
  socket._message({ method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 'e1' } } });
  await reconnecting;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const since = frames(socket).find((frame) => frame.method === WS_METHODS.sessionEventsSince);
  assert.ok(since, 'the client asks what it missed');
  socket._message({
    id: since.id,
    result: {
      events: [], latest_seq: 4, truncated: false, count: 0, epoch: 'e1',
      open_requests: [{ id: 'srq-20', method: 'approval', params: { session_id: 'live-A', request_id: 'r', command: 'ls' } }],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(spy.seen.map((item) => item.request.id), ['srq-20']);
});

test('without a handler open requests are ignored', async () => {
  const { client, socket } = await connected();
  const resuming = establishGatewaySession({ client, storedSessionId: 'stored-A', createParams: {} });
  const resume = frames(socket).find((frame) => frame.method === WS_METHODS.sessionResume);
  socket._message({ id: resume.id, result: { session_id: 'live-B', resumed: 'stored-A', open_requests: [{ id: 'srq-1', method: 'approval', params: {} }] } });
  await resuming;
  assert.equal(frames(socket).some((frame) => frame.id === 'srq-1'), false);
});

test('only chat surfaces advertise: the Browser wires handlers on its chat connections and nowhere else', () => {
  const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.equal((sidepanel.match(/createGatewayClient\(/g) || []).length, 1, 'sidepanel creates raw clients only through createChatGatewayClient');
  assert.equal((sidepanel.match(/createChatGatewayClient\(/g) || []).length, 7, 'definition plus the six chat connections (the sixth is the Hermes account sign-in socket)');
  assert.match(sidepanel, /serverRequests: gatewayServerRequests/);
  for (const file of ['controller-connector.mjs', 'wake-background.mjs']) {
    assert.doesNotMatch(readFileSync(new URL(`../extension/lib/${file}`, import.meta.url), 'utf8'), /serverRequests/, file);
  }
});
