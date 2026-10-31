// Controls inside child frames, through the real executor, ref store and controller worker.
//
// A live stream's chat, an embedded player, a comment box: each is its own iframe. The page adapter returns
// what the browser reports (nodes that name the frame they came from), and everything after it is the real
// code: refs are minted per frame, the turn's page view is rendered within its budget, and a command with a
// framed ref reaches the adapter with the right target.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';
import { SNAPSHOT_VIEW_BUDGETS } from '../extension/lib/browser-control-snapshot-view.mjs';
import {
  CONTROLLER_WORKER_MESSAGES,
  createControllerServiceWorker,
} from '../extension/lib/controller-service-worker.mjs';
import { TAB_LEASE_KINDS, TAB_LEASE_OWNERSHIPS } from '../extension/lib/tab-leases.mjs';

const CHROMIUM = Object.freeze({ id: 'chromium', engine: 'chromium', label: 'Chromium browser' });
const ACTIONS = ['browser_back', 'browser_click', 'browser_navigate', 'browser_press', 'browser_scroll', 'browser_snapshot', 'browser_type'];
const PAGE_URL = 'https://stream.example.test/watch?v=abc';

function memoryStorage(initial = {}) {
  const state = structuredClone(initial);
  return {
    async get(keys = null) {
      if (keys === null) return structuredClone(state);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => Object.hasOwn(state, key)).map((key) => [key, structuredClone(state[key])]));
    },
    async set(values) { Object.assign(state, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; },
  };
}

function connector() {
  const connections = [];
  return {
    connections,
    async connect(options) {
      const connection = {
        options,
        sent: [],
        async send(frame) { connection.sent.push(structuredClone(frame)); },
        async heartbeat() { return { ok: true }; },
        close() {},
        emit(frame) { return options.onFrame(structuredClone(frame)); },
      };
      connections.push(connection);
      return connection;
    },
  };
}

const sender = (tabId) => ({
  url: 'chrome-extension://fixture/sidepanel.html',
  frameId: 0,
  tab: Number.isInteger(tabId) ? { id: tabId, windowId: 2 } : undefined,
});
const settle = async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); };

// A page of `own` long-list links around frames named by CDP id: { CHAT: { nodes, text } }.
function page({ own = 0, frames = {}, elementCount, truncated } = {}) {
  const ownNodes = Array.from({ length: own }, (_, index) => ({ role: 'link', name: `Recommended video ${index} with a sample title`, backendDOMNodeId: 100 + index }));
  const framed = Object.entries(frames).flatMap(([frameId, frame]) => frame.nodes.map((node) => ({ ...node, frameId })));
  const frameText = Object.values(frames).map((frame) => frame.text || '').filter(Boolean).join('\n');
  return {
    title: 'Live stream',
    url: PAGE_URL,
    text: 'Live: Hermes stream',
    ...(frameText ? { frameText } : {}),
    nodes: [{ role: 'button', name: 'Subscribe', backendDOMNodeId: 40 }, ...ownNodes, ...framed],
    headings: [{ level: 1, name: 'Live: Hermes stream' }],
    ...(elementCount === undefined ? {} : { element_count: elementCount }),
    ...(truncated ? { truncated } : {}),
  };
}

const CHAT = {
  nodes: [
    { role: 'textbox', name: 'Chat', backendDOMNodeId: 5001, editable: true },
    { role: 'button', name: 'Send', backendDOMNodeId: 5002 },
    { role: 'button', name: 'Open emoji picker', backendDOMNodeId: 5003 },
  ],
  text: 'viewer1 first chat message\nviewer2 second chat message',
};

async function controlledWorker({ snapshot, act }) {
  const calls = [];
  const adapter = {
    calls,
    contract: { enabled: true, actions: ACTIONS },
    async inspect() { return { currentUrl: PAGE_URL, hasUnsavedContent: false }; },
    async execute(action, args, context) {
      calls.push({ action, args: { ...args }, target: context.target || null, signal: context.signal });
      if (action === 'browser_snapshot') return snapshot(args, context);
      if (act) return act(action, args, context);
      return { status: 'ok' };
    },
  };
  const storage = memoryStorage({
    hermesBrowserSettings: {
      connectionSchemaVersion: 1, connectionMode: 'local', connectionTransport: 'local-api', gatewayMode: 'local-api',
      gatewayUrl: 'http://127.0.0.1:8642', apiKey: ['child', 'frames', 'fixture'].join('-'), activeProfile: 'default',
      sessionId: 'child-frames-session', browserControlEnabled: true,
    },
  });
  const transport = connector();
  const refs = createBrowserControlRefStore();
  const approvals = createBrowserControlApprovalStore();
  const executor = createBrowserControlExecutor({ adapter, approvals, refs });
  const uuids = ['controller-frames', 'profile-frames'];
  const worker = createControllerServiceWorker({
    storageArea: storage,
    connector: transport,
    product: CHROMIUM,
    randomUUID: () => uuids.shift() || 'unexpected',
    extensionOrigin: 'chrome-extension://fixture',
    approvalStore: approvals,
    executeBrowserCommand: (frame, context) => executor.execute(frame, context),
    getTab: async (tabId) => ({ id: Number(tabId), url: PAGE_URL, windowId: 2 }),
  });
  const boot = await worker.boot();
  const acquired = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: boot.controllerId,
    tabIds: [41],
  }, sender());
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, sender(41));
  const prepare = () => worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.prepareTurn, tabId: 41, frameId: 0, expectedUrl: PAGE_URL,
  }, sender());
  const command = async (params) => {
    await transport.connections[0].emit({ method: 'browser.controller.command', params });
    await settle();
    return transport.connections[0].sent.at(-1).params;
  };
  return { worker, adapter, calls, prepare, command, refs };
}

const refOf = (text, role, name) => text.match(new RegExp(`\\[(@[a-z0-9]+)\\] ${role} "${name}"`))?.[1];

test('the turn\'s page view lists a child frame\'s controls and text on a page far longer than the view', async () => {
  const { prepare } = await controlledWorker({ snapshot: () => page({ own: 700, frames: { CHAT } }) });

  const prepared = await prepare();

  assert.equal(prepared.state, 'ready');
  const text = prepared.controlSnapshot.text;
  assert.ok(text.length <= SNAPSHOT_VIEW_BUDGETS.turn);
  assert.match(refOf(text, 'textbox', 'Chat') || '', /^@f\d+e\d+$/, `the chat composer is listed with a framed ref:\n${text.slice(0, 600)}`);
  assert.ok(refOf(text, 'button', 'Send'), 'the Send button is listed');
  assert.ok(refOf(text, 'button', 'Subscribe'), 'the page\'s own first control is still listed');
  assert.match(text, /\[text inside embedded frames\]\nviewer1 first chat message\nviewer2 second chat message/);
  assert.equal(prepared.controlSnapshot.truncated, true, 'the page was cut, and the view says so');
  assert.equal(prepared.controlSnapshot.elementCount, 704);
});

test('a page with no child frames is rendered exactly as before', async () => {
  const { prepare } = await controlledWorker({ snapshot: () => page({ own: 3 }) });

  const prepared = await prepare();

  assert.doesNotMatch(prepared.controlSnapshot.text, /@f\d|embedded frames/);
  assert.match(prepared.controlSnapshot.text, /^\[@e1\] button "Subscribe"\n\[@e2\] link "Recommended video 0/);
});

test('commands act on a framed ref: type into the chat composer and open its emoji picker', async () => {
  const { prepare, command, calls } = await controlledWorker({ snapshot: () => page({ own: 700, frames: { CHAT } }) });
  const prepared = await prepare();
  const composer = refOf(prepared.controlSnapshot.text, 'textbox', 'Chat');
  const emoji = refOf(prepared.controlSnapshot.text, 'button', 'Open emoji picker');

  const typed = await command({
    command_id: 'type-chat', action: 'browser_type', arguments: { ref: composer, text: 'hello chat' },
    tab_id: prepared.tabId, document_generation: prepared.documentGeneration,
  });
  assert.equal(typed.ok, true, JSON.stringify(typed));
  const click = await command({
    command_id: 'click-emoji', action: 'browser_click', arguments: { ref: emoji },
    tab_id: prepared.tabId, document_generation: prepared.documentGeneration,
  });
  assert.equal(click.ok, true, JSON.stringify(click));

  assert.equal(calls.find((call) => call.action === 'browser_type').target.backendDOMNodeId, 5001);
  assert.equal(calls.find((call) => call.action === 'browser_click').target.backendDOMNodeId, 5003);
  assert.equal(calls.find((call) => call.action === 'browser_type').target.frameId, '1', 'the target names its frame by short key, not by CDP id');
});

test('an action on a framed ref whose frame has since moved to a restricted page is refused with its own error code', async () => {
  const { prepare, command } = await controlledWorker({
    snapshot: () => page({ own: 3, frames: { CHAT } }),
    act: () => { throw Object.assign(new Error('The frame this control is in is on a page Hermes will not act on.'), { code: 'restricted_frame' }); },
  });
  const prepared = await prepare();
  const composer = refOf(prepared.controlSnapshot.text, 'textbox', 'Chat');
  const typed = await command({
    command_id: 'type-moved', action: 'browser_type', arguments: { ref: composer, text: 'hello chat' },
    tab_id: prepared.tabId, document_generation: prepared.documentGeneration,
  });
  assert.equal(typed.ok, false);
  assert.equal(typed.error?.code ?? typed.error, 'restricted_frame', JSON.stringify(typed));
});

test('a snapshot command keeps the frame refs of a control, and never exposes the CDP frame id', async () => {
  const { prepare, command } = await controlledWorker({ snapshot: () => page({ own: 5, frames: { 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6': CHAT } }) });
  const prepared = await prepare();

  const result = await command({
    command_id: 'snap', action: 'browser_snapshot', arguments: { full: true },
    tab_id: prepared.tabId, document_generation: prepared.documentGeneration,
  });

  assert.equal(result.ok, true);
  const framed = result.result.refs.filter((item) => item.frameId);
  assert.deepEqual(framed.map((item) => [item.ref, item.role, item.name, item.frameId]), [
    ['@f1e7', 'textbox', 'Chat', '1'],
    ['@f1e8', 'button', 'Send', '1'],
    ['@f1e9', 'button', 'Open emoji picker', '1'],
  ]);
  assert.doesNotMatch(JSON.stringify(prepared) + JSON.stringify(result), /A1B2C3D4E5F6/);
});

test('a control keeps its ref when another frame leaves the page or a new one arrives before it', async () => {
  let frames = { AD: { nodes: [{ role: 'link', name: 'Sponsored offer', backendDOMNodeId: 7001 }], text: 'Sponsored' }, CHAT };
  const { prepare, command } = await controlledWorker({ snapshot: () => page({ own: 3, frames }) });
  const snapshotRefs = async () => {
    const prepared = await prepare();
    return { prepared, text: prepared.controlSnapshot.text };
  };

  const first = await snapshotRefs();
  const composer = refOf(first.text, 'textbox', 'Chat');
  const sponsored = refOf(first.text, 'link', 'Sponsored offer');
  assert.notEqual(composer.split('e')[0], sponsored.split('e')[0], 'each frame has its own key');

  // the ad frame goes away: the chat is still the same control
  frames = { CHAT };
  const afterRemoval = await snapshotRefs();
  assert.equal(refOf(afterRemoval.text, 'textbox', 'Chat'), composer);
  assert.equal(refOf(afterRemoval.text, 'button', 'Send'), refOf(first.text, 'button', 'Send'));
  assert.equal(refOf(afterRemoval.text, 'link', 'Sponsored offer'), undefined);

  // a new frame arrives ahead of it: it gets a key nobody has used, and the chat keeps its own
  frames = { NEWS: { nodes: [{ role: 'link', name: 'Breaking news', backendDOMNodeId: 8001 }] }, CHAT };
  const afterArrival = await snapshotRefs();
  assert.equal(refOf(afterArrival.text, 'textbox', 'Chat'), composer);
  const news = refOf(afterArrival.text, 'link', 'Breaking news');
  assert.notEqual(news.split('e')[0], composer.split('e')[0]);
  assert.notEqual(news.split('e')[0], sponsored.split('e')[0], 'a key a departed frame had is not handed to another');

  // and a ref minted before the ad left still reaches the chat
  const typed = await command({
    command_id: 'type-after', action: 'browser_type', arguments: { ref: composer, text: 'still works' },
    tab_id: afterArrival.prepared.tabId, document_generation: afterArrival.prepared.documentGeneration,
  });
  assert.equal(typed.ok, true, JSON.stringify(typed));
});

test('a frame cut at its cap is reported as cut, with the true count, through the executor', async () => {
  const many = { nodes: Array.from({ length: 400 }, (_, index) => ({ role: 'button', name: `Emoji ${index}`, backendDOMNodeId: 2_000 + index })) };
  const { prepare, command } = await controlledWorker({
    snapshot: () => page({ own: 2, frames: { PICKER: many }, elementCount: 1 + 2 + 461, truncated: true }),
  });

  const prepared = await prepare();
  assert.equal(prepared.controlSnapshot.truncated, true);
  assert.equal(prepared.controlSnapshot.elementCount, 464);

  const full = await command({
    command_id: 'snap-full', action: 'browser_snapshot', arguments: { full: true },
    tab_id: prepared.tabId, document_generation: prepared.documentGeneration,
  });
  assert.equal(full.result.truncated, true, 'a full view that lost controls to a frame cap must not look complete');
  assert.equal(full.result.element_count, 464);
});

test('a full snapshot of a page whose browser reports no count counts what it returned', async () => {
  const { prepare } = await controlledWorker({ snapshot: () => page({ own: 3 }) });

  const prepared = await prepare();

  assert.equal(prepared.controlSnapshot.elementCount, 4);
  assert.equal(prepared.controlSnapshot.truncated, false);
});

// --- the turn's page read ends when the person takes control away ------------------------------------------------------

// A turn read that never finishes by itself, so what stops it can be seen.
async function pendingTurnRead() {
  let started;
  const begun = new Promise((resolve) => { started = resolve; });
  let readSignal = null;
  const world = await controlledWorker({
    snapshot: (_args, context) => {
      readSignal = context.signal;
      started();
      return new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
    },
  });
  const prepared = world.prepare();
  await begun;
  return { ...world, prepared, signal: () => readSignal };
}

test('a debugger detach stops the turn\'s page read at once, before it can ask for another frame', async () => {
  const { worker, prepared, signal } = await pendingTurnRead();
  assert.equal(signal().aborted, false);

  const detaching = worker.handleDebuggerDetach({ tabId: 41, reason: 'canceled_by_user' });
  assert.equal(signal().aborted, true, 'aborted synchronously, not after the worker has booted');
  await detaching;

  const result = await prepared;
  assert.equal(result.controlSnapshot, undefined);
  assert.equal(result.controlSnapshotOmitted, 'cancelled');
});

test('Pause, Stop, Turn off and releasing the tab each stop the turn\'s page read', async () => {
  const ways = [
    ['Pause', (worker) => worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.pause }, sender())],
    ['Stop', (worker) => worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.stop }, sender())],
    ['Turn off', (worker) => worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.detach }, sender())],
    ['release', (worker, boot) => worker.handleMessage({
      type: CONTROLLER_WORKER_MESSAGES.leaseRelease, ownerId: boot.ownerId, tabIds: [41],
    }, sender())],
  ];
  for (const [name, stop] of ways) {
    const { worker, prepared, signal, boot } = await pendingTurnRead();
    await stop(worker, { ownerId: (await worker.boot()).controllerId, ...boot });
    assert.equal(signal().aborted, true, `${name} stops the read`);
    assert.equal((await prepared).controlSnapshot, undefined, name);
  }
});

test('closing the tab stops the turn\'s page read', async () => {
  const { worker, prepared, signal } = await pendingTurnRead();

  const removing = worker.handleTabRemoved(41);
  assert.equal(signal().aborted, true);
  await removing;

  assert.equal((await prepared).controlSnapshot, undefined);
});

test('a page read that is not interrupted finishes, and its bookkeeping is gone afterwards', async () => {
  const { worker, prepare } = await controlledWorker({ snapshot: () => page({ own: 2, frames: { CHAT } }) });

  const first = await prepare();
  const second = await prepare();
  assert.equal(first.state, 'ready');
  assert.equal(second.state, 'ready');
  // nothing is left to abort: a detach now is a plain detach
  assert.equal((await worker.handleDebuggerDetach({ tabId: 41, reason: 'canceled_by_user' })).ok, true);
});
