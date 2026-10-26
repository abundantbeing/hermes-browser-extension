// D8: replay epoch and sequence state must survive a reconnect. The panel builds a NEW gateway client for
// every reconnect, so watermarks kept inside one client were lost every time and nothing was replayed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createGatewayClient, WS_METHODS } from '../extension/lib/gateway-ws.mjs';
import { createReplayWatermarks } from '../extension/lib/replay-watermarks.mjs';

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this._listeners = {};
    FakeWebSocket.last = this;
  }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }

  send(data) { this.sent.push(data); }

  close() { this.readyState = 3; this._emit('close', { code: 1000 }); }

  _emit(type, event) { for (const fn of this._listeners[type] || []) fn(event); }

  _open() { this.readyState = 1; this._emit('open', {}); }

  _message(obj) { this._emit('message', { data: JSON.stringify(obj) }); }
}
const frames = (socket) => socket.sent.map((raw) => JSON.parse(raw));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function connect(options, readyPayload) {
  const client = createGatewayClient({ WebSocketImpl: FakeWebSocket, requestTimeoutMs: 100, heartbeatIntervalMs: 0, ...options });
  const connecting = client.connect('wss://host/api/ws?ticket=t');
  const socket = FakeWebSocket.last;
  socket._open();
  socket._message({ method: 'event', params: { type: 'gateway.ready', payload: readyPayload } });
  await connecting;
  await tick();
  return { client, socket };
}

const sinceFrames = (socket) => frames(socket).filter((frame) => frame.method === WS_METHODS.sessionEventsSince);

// ---------- the client ----------

test('a NEW client seeded with what the old one saw asks for what it missed', async () => {
  const store = createReplayWatermarks().forEndpoint('wss://host');
  // client 1 sees events, then the socket drops and the panel builds client 2
  const first = await connect({ replayStore: store }, { replay_epoch: 'e1' });
  first.socket._message({ method: 'event', params: { type: 'message.delta', session_id: 'live-A', seq: 7, payload: { text: 'x' } } });
  first.client.close();

  const second = await connect({ replayStore: store }, { replay_epoch: 'e1' });
  const [since] = sinceFrames(second.socket);
  assert.ok(since, 'the second client asks');
  assert.deepEqual(since.params, { session_id: 'live-A', last_seen: 7 });
});

test('without a store a new client asks for nothing (the old behaviour, unchanged for other callers)', async () => {
  const first = await connect({}, { replay_epoch: 'e1' });
  first.socket._message({ method: 'event', params: { type: 'message.delta', session_id: 'live-A', seq: 7, payload: {} } });
  first.client.close();
  const second = await connect({}, { replay_epoch: 'e1' });
  assert.equal(sinceFrames(second.socket).length, 0);
});

test('a gateway restart (a different epoch) voids the saved marks and nothing is replayed', async () => {
  const store = createReplayWatermarks().forEndpoint('wss://host');
  const first = await connect({ replayStore: store }, { replay_epoch: 'e1' });
  first.socket._message({ method: 'event', params: { type: 'message.delta', session_id: 'live-A', seq: 97, payload: {} } });
  first.client.close();
  const second = await connect({ replayStore: store }, { replay_epoch: 'e2' });
  assert.equal(sinceFrames(second.socket).length, 0, 'seq 97 of e1 means nothing to e2');
  assert.deepEqual(second.client.getSeqWatermarks(), {});
  assert.equal(store.load(), null, 'the store forgot the old epoch');
});

test('a gateway that names no epoch cannot vouch for saved marks: they are dropped', async () => {
  const store = createReplayWatermarks().forEndpoint('wss://host');
  const first = await connect({ replayStore: store }, { replay_epoch: 'e1' });
  first.socket._message({ method: 'event', params: { type: 'message.delta', session_id: 'live-A', seq: 5, payload: {} } });
  first.client.close();
  const second = await connect({ replayStore: store }, {});
  assert.equal(sinceFrames(second.socket).length, 0);
  assert.deepEqual(second.client.getSeqWatermarks(), {});
});

test('the client keeps the store current as events arrive, and the marks are bounded', async () => {
  const backing = createReplayWatermarks({ maxSessions: 4 });
  const store = backing.forEndpoint('wss://host');
  const { client, socket } = await connect({ replayStore: store }, { replay_epoch: 'e1' });
  for (let index = 1; index <= 6; index += 1) {
    socket._message({ method: 'event', params: { type: 'message.delta', session_id: `live-${index}`, seq: index, payload: {} } });
  }
  const saved = store.load();
  assert.equal(saved.epoch, 'e1');
  assert.deepEqual(Object.keys(saved.watermarks), ['live-3', 'live-4', 'live-5', 'live-6'], 'oldest marks dropped past the bound');
  assert.ok(Object.keys(client.getSeqWatermarks()).length <= 64);
});

test('a truncated replay is reported and its hole is not reported again on the next reconnect', async () => {
  const store = createReplayWatermarks().forEndpoint('wss://host');
  const first = await connect({ replayStore: store }, { replay_epoch: 'e1' });
  first.socket._message({ method: 'event', params: { type: 'message.delta', session_id: 'live-A', seq: 3, payload: {} } });
  first.client.close();

  const seen = [];
  const client = createGatewayClient({ WebSocketImpl: FakeWebSocket, requestTimeoutMs: 100, heartbeatIntervalMs: 0, replayStore: store });
  client.on('session.replay.truncated', (event) => seen.push(event));
  const connecting = client.connect('wss://host/api/ws?ticket=t');
  const socket = FakeWebSocket.last;
  socket._open();
  socket._message({ method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 'e1' } } });
  await connecting;
  await tick();
  const [since] = sinceFrames(socket);
  socket._message({ id: since.id, result: { events: [], epoch: 'e1', truncated: true, latest_seq: 40, count: 0 } });
  await tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionId, 'live-A');
  assert.equal(store.load().watermarks['live-A'], 40, 'the mark moves past the hole');
});

// ---------- the store ----------

test('the store is bounded in endpoints and in sessions', () => {
  const backing = createReplayWatermarks({ maxEndpoints: 2, maxSessions: 2 });
  for (const name of ['a', 'b', 'c']) backing.forEndpoint(name).save({ epoch: 'e', watermarks: { s1: 1, s2: 2, s3: 3 } });
  assert.equal(backing.size, 2);
  assert.equal(backing.forEndpoint('a').load(), null, 'the least recently used endpoint went');
  assert.deepEqual(Object.keys(backing.forEndpoint('c').load().watermarks), ['s2', 's3']);
});

test('the store ignores junk and an empty save forgets the endpoint', () => {
  const backing = createReplayWatermarks();
  const store = backing.forEndpoint('x');
  store.save({ epoch: 'e1', watermarks: { ok: 4, zero: 0, neg: -1, text: 'x', '': 5 } });
  assert.deepEqual(store.load().watermarks, { ok: 4 });
  store.save({ epoch: 'e1', watermarks: {} });
  assert.equal(store.load(), null);
  assert.equal(backing.forEndpoint(''), null);
});

test('the store survives a panel reload through storage.session, and a bad blob is ignored', async () => {
  const area = {};
  const storage = {
    get: async (key) => ({ [key]: area[key] }),
    set: async (values) => { Object.assign(area, JSON.parse(JSON.stringify(values))); },
  };
  const first = createReplayWatermarks({ storage });
  first.forEndpoint('wss://host').save({ epoch: 'e1', watermarks: { 'live-A': 9 } });
  await first.flush();

  const second = createReplayWatermarks({ storage });
  await second.hydrate();
  assert.deepEqual(second.forEndpoint('wss://host').load(), { epoch: 'e1', watermarks: { 'live-A': 9 } });

  const broken = createReplayWatermarks({ storage: { get: async () => ({ hermesReplayWatermarks: 'junk' }) } });
  assert.equal(await broken.hydrate(), false);
  const throwing = createReplayWatermarks({ storage: { get: async () => { throw new Error('storage unavailable'); } } });
  assert.equal(await throwing.hydrate(), false);
});

test('hydrate never replaces what this page already learned', async () => {
  const storage = { get: async () => ({ hermesReplayWatermarks: { 'wss://host': { epoch: 'old', watermarks: { s: 1 } } } }) };
  const backing = createReplayWatermarks({ storage });
  backing.forEndpoint('wss://host').save({ epoch: 'new', watermarks: { s: 5 } });
  await backing.hydrate();
  assert.equal(backing.forEndpoint('wss://host').load().epoch, 'new');
});

test('persisting is debounced: a burst of events is one write', async () => {
  const writes = [];
  const timers = [];
  const backing = createReplayWatermarks({
    storage: { set: async (values) => { writes.push(values); } },
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  const store = backing.forEndpoint('e');
  for (let seq = 1; seq <= 50; seq += 1) store.save({ epoch: 'e1', watermarks: { s: seq } });
  assert.equal(timers.length, 1);
  assert.equal(writes.length, 0);
  timers[0]();
  await tick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].hermesReplayWatermarks.e.watermarks.s, 50);
});

// ---------- the panel ----------

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const lines = source.split('\n');
function functionSource(name) {
  const start = lines.findIndex((line) => new RegExp(`^(async )?function ${name}[(]`).test(line));
  assert.ok(start >= 0, `${name} exists`);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end += 1;
  return lines.slice(start, end + 1).join('\n');
}

test('every chat connection the panel opens is seeded from, and saves into, the shared replay store', () => {
  const factory = functionSource('createChatGatewayClient');
  assert.match(factory, /replayStore: replayWatermarks\.forEndpoint\(replayEndpoint\)/);
  assert.match(factory, /'session\.replay\.truncated'/);
  // the six chat connections name their endpoint (the fourth is Hermes Web's ticketed socket, the fifth the one the paired gateway signs in, the sixth the one a Hermes account sign-in opens)
  const calls = [...source.matchAll(/(?<!function )createChatGatewayClient\(([^)]*)\)/g)].map((match) => match[1]);
  assert.equal(calls.length, 6);
  for (const args of calls) assert.match(args, /replayEndpoint:/);
  assert.match(source, /void replayWatermarks\.hydrate\(\)/);
});

function truncated({ sending = false, viewed = 'A', attach = null, live = 'live-A' } = {}) {
  const toasts = [];
  const reloads = [];
  const context = vm.createContext({
    settings: { sessionId: viewed },
    sending,
    liveAttach: attach,
    durableContextSessionId: (id) => ({ 'live-A': 'A', 'live-B': 'B' }[id] || id),
    t: (key) => `t:${key}`,
    showOperationToast: (toast) => toasts.push(toast),
    refreshActiveSessionHistoryQuietly: async () => { reloads.push('history'); return true; },
    reconcileAttachedLiveSession: async () => { reloads.push('attach'); },
  });
  vm.runInContext(functionSource('onReplayTruncated'), context);
  const handled = vm.runInContext('onReplayTruncated', context)({ sessionId: live, payload: { latestSeq: 40 } });
  return { handled, toasts, reloads, context };
}

test('a truncated replay for the viewed session says so and reloads its stored history', () => {
  const { handled, toasts, reloads } = truncated();
  assert.equal(handled, true);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, 't:session.replay.truncated');
  assert.deepEqual(reloads, ['history']);
});

test('a truncated replay for another session, or while this view runs a turn, changes nothing visible', () => {
  assert.equal(truncated({ live: 'live-B' }).handled, false);
  const busy = truncated({ sending: true });
  assert.equal(busy.handled, false);
  assert.deepEqual(busy.toasts, []);
  assert.deepEqual(busy.reloads, []);
});

test('an attached view re-reads the run it follows instead', () => {
  const attach = { sessionId: 'A', historySeeded: true };
  const { reloads } = truncated({ attach });
  assert.deepEqual(reloads, ['attach']);
  assert.equal(attach.historySeeded, false, 'the transcript is read again');
});

// ---------- review finding 10: panels share one storage.session record ----------

function sharedArea() {
  const area = {};
  return {
    area,
    storage: {
      get: async (key) => ({ [key]: area[key] === undefined ? undefined : JSON.parse(JSON.stringify(area[key])) }),
      set: async (values) => { Object.assign(area, JSON.parse(JSON.stringify(values))); },
    },
  };
}

test('two panels writing the shared record do not drop each other\'s endpoints', async () => {
  const { area, storage } = sharedArea();
  const one = createReplayWatermarks({ storage });
  const two = createReplayWatermarks({ storage });
  one.forEndpoint('wss://one').save({ epoch: 'e1', watermarks: { a: 3 } });
  two.forEndpoint('wss://two').save({ epoch: 'e2', watermarks: { b: 7 } });
  await one.flush();
  await two.flush();
  assert.deepEqual(Object.keys(area.hermesReplayWatermarks).sort(), ['wss://one', 'wss://two']);
});

test('on the same endpoint and epoch the higher mark per session wins, whichever panel writes last', async () => {
  const { area, storage } = sharedArea();
  const one = createReplayWatermarks({ storage });
  const two = createReplayWatermarks({ storage });
  one.forEndpoint('wss://host').save({ epoch: 'e1', watermarks: { shared: 9, onlyOne: 2 } });
  two.forEndpoint('wss://host').save({ epoch: 'e1', watermarks: { shared: 4, onlyTwo: 6 } });
  await one.flush();
  await two.flush();
  assert.deepEqual(area.hermesReplayWatermarks['wss://host'], { epoch: 'e1', watermarks: { shared: 9, onlyOne: 2, onlyTwo: 6 } });
});

test('a newer epoch replaces the old marks, and a forgotten endpoint is removed from the shared record', async () => {
  const { area, storage } = sharedArea();
  const one = createReplayWatermarks({ storage });
  one.forEndpoint('wss://host').save({ epoch: 'e1', watermarks: { s: 9 } });
  one.forEndpoint('wss://gone').save({ epoch: 'e1', watermarks: { s: 1 } });
  await one.flush();
  const two = createReplayWatermarks({ storage });
  two.forEndpoint('wss://host').save({ epoch: 'e2', watermarks: { s: 1 } });
  two.forget('wss://gone');
  await two.flush();
  assert.deepEqual(area.hermesReplayWatermarks, { 'wss://host': { epoch: 'e2', watermarks: { s: 1 } } });
});

test('the merged record stays bounded', async () => {
  const { area, storage } = sharedArea();
  const one = createReplayWatermarks({ storage, maxEndpoints: 2, maxSessions: 3 });
  for (const host of ['a', 'b']) one.forEndpoint(`wss://${host}`).save({ epoch: 'e', watermarks: { s1: 1, s2: 1, s3: 1 } });
  await one.flush();
  const two = createReplayWatermarks({ storage, maxEndpoints: 2, maxSessions: 3 });
  two.forEndpoint('wss://c').save({ epoch: 'e', watermarks: { t1: 1, t2: 1, t3: 1 } });
  two.forEndpoint('wss://a').save({ epoch: 'e', watermarks: { s4: 5 } });
  await two.flush();
  assert.ok(Object.keys(area.hermesReplayWatermarks).length <= 2);
  for (const entry of Object.values(area.hermesReplayWatermarks)) assert.ok(Object.keys(entry.watermarks).length <= 3);
});
