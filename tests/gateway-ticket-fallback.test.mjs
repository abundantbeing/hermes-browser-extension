import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { connectGatewayWithTicket, createGatewayClient } from '../extension/lib/gateway-ws.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const sidepanel = read('extension/sidepanel.js');
const app = read('extension/app.js');

// A browser closes a socket from the outside asynchronously: close() returns
// first, the 'close' event follows. A fake that emits it inline hides every
// ordering bug that depends on that.
class BrowserLikeSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    BrowserLikeSocket.all.push(this);
  }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }

  send(data) { this.sent.push(JSON.parse(data)); }

  close() {
    this.readyState = 2;
    setTimeout(() => this.emit('close', { code: 1000 }), 0);
  }

  emit(type, event) { for (const fn of this.listeners[type] || []) fn(event); }

  open() {
    this.readyState = 1;
    this.emit('open', {});
  }

  message(frame) { this.emit('message', { data: JSON.stringify(frame) }); }

  ready(payload = {}) { this.message({ method: 'event', params: { type: 'gateway.ready', payload } }); }

  event(type, sessionId, payload, seq) {
    this.message({ method: 'event', params: { type, session_id: sessionId, payload, ...(seq ? { seq } : {}) } });
  }

  // Answers the next request the client sent for `method`.
  reply(method, result) {
    const frame = this.sent.find((item) => item.method === method && !item.answered);
    assert.ok(frame, `no ${method} request was sent`);
    frame.answered = true;
    this.message({ jsonrpc: '2.0', id: frame.id, result });
  }

  fail(method, error) {
    const frame = this.sent.find((item) => item.method === method && !item.answered);
    assert.ok(frame, `no ${method} request was sent`);
    frame.answered = true;
    this.message({ jsonrpc: '2.0', id: frame.id, error });
  }
}
BrowserLikeSocket.all = [];

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---- WebSocket ticket fallback -------------------------------------------------

test('the query-string fallback never offers the ticket the first handshake may have spent', async () => {
  BrowserLikeSocket.all = [];
  const client = createGatewayClient({ WebSocketImpl: BrowserLikeSocket });
  let minted = 0;
  const connecting = connectGatewayWithTicket(client, 'http://127.0.0.1:9119', 'spent-ticket', {
    refreshTicket: async () => {
      minted += 1;
      return 'fresh-ticket';
    },
  });
  BrowserLikeSocket.all[0].emit('close', { code: 1006 });
  await tick();
  assert.equal(minted, 1);
  assert.equal(BrowserLikeSocket.all.length, 2);
  assert.equal(BrowserLikeSocket.all[1].url, 'ws://127.0.0.1:9119/api/ws?ticket=fresh-ticket');
  assert.ok(!BrowserLikeSocket.all.some((socket) => socket.url.includes('spent-ticket')));
  BrowserLikeSocket.all[1].open();
  BrowserLikeSocket.all[1].ready();
  await connecting;
});

test('when no fresh ticket can be minted the handshake failure is reported, not retried with the old one', async () => {
  for (const refreshTicket of [async () => '', async () => { throw new Error('no dashboard tab'); }]) {
    BrowserLikeSocket.all = [];
    const client = createGatewayClient({ WebSocketImpl: BrowserLikeSocket });
    const connecting = connectGatewayWithTicket(client, 'http://127.0.0.1:9119', 'maybe-spent', { refreshTicket });
    BrowserLikeSocket.all[0].emit('close', { code: 1006 });
    await assert.rejects(connecting, /closed before gateway\.ready and open/);
    assert.equal(BrowserLikeSocket.all.length, 1, 'no second handshake');
  }
});

test('an older dashboard still gets the query ticket when the caller has no way to mint another', async () => {
  BrowserLikeSocket.all = [];
  const client = createGatewayClient({ WebSocketImpl: BrowserLikeSocket });
  const connecting = connectGatewayWithTicket(client, 'http://127.0.0.1:9119', 'old-ticket');
  BrowserLikeSocket.all[0].emit('close', { code: 1006 });
  await tick();
  assert.equal(BrowserLikeSocket.all[1].url, 'ws://127.0.0.1:9119/api/ws?ticket=old-ticket');
  BrowserLikeSocket.all[1].open();
  BrowserLikeSocket.all[1].ready();
  await connecting;
});

test('every chat connection mints its own replacement ticket for the fallback', () => {
  // The local dashboard tab's ticket, Hermes Web's socket ticket, and the remote dashboard's ticket.
  assert.equal((sidepanel.match(/connectGatewayWithTicket\([^;]*?refreshTicket: async \(\) => \{/g) || []).length, 3);
  assert.equal((app.match(/connectGatewayWithTicket\([^;]*?refreshTicket: async \(\) => \{/g) || []).length, 1);
  for (const source of [sidepanel, app]) assert.match(source, /return fresh\?\.ok \? fresh\.ticket : '';/);
});
