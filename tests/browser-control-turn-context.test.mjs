import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_CONTEXT_TURN_BUDGETS,
  buildBrowserTurnEnvelope,
  serializeBrowserTurnEnvelope,
} from '../extension/lib/browser-context-protocol.mjs';
import { CHROMIUM_ACTIONS } from '../extension/lib/browser-controller-adapter.mjs';
import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';
import { SNAPSHOT_VIEW_BUDGETS } from '../extension/lib/browser-control-snapshot-view.mjs';
import { CONTROLLER_BROWSER_CAPABILITIES } from '../extension/lib/controller-protocol.mjs';
import {
  CONTROLLER_WORKER_MESSAGES,
  createControllerServiceWorker,
} from '../extension/lib/controller-service-worker.mjs';
import { TAB_LEASE_KINDS, TAB_LEASE_OWNERSHIPS } from '../extension/lib/tab-leases.mjs';

const CHROMIUM = Object.freeze({ id: 'chromium', engine: 'chromium', label: 'Chromium browser' });
const FIREFOX = Object.freeze({ id: 'firefox', engine: 'gecko', label: 'Firefox' });

const PAGE_NODES = [
  { role: 'button', name: 'Add to cart', backendDOMNodeId: 41 },
  { role: 'link', name: 'Home', backendDOMNodeId: 40 },
  { role: 'textbox', name: 'Password', inputType: 'password', backendDOMNodeId: 42 },
];

const ADAPTER_ACTIONS = [
  'browser_back', 'browser_click', 'browser_navigate', 'browser_press', 'browser_scroll',
  'browser_snapshot', 'browser_type',
];

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

function settings(overrides = {}) {
  return {
    connectionSchemaVersion: 1,
    connectionMode: 'local',
    connectionTransport: 'local-api',
    gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642',
    apiKey: ['turn', 'context', 'fixture'].join('-'),
    activeProfile: 'default',
    sessionId: 'turn-context-session',
    browserControlEnabled: true,
    ...overrides,
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

function extensionSender({ tabId = null } = {}) {
  return {
    url: 'chrome-extension://fixture/sidepanel.html',
    frameId: 0,
    tab: Number.isInteger(tabId) ? { id: tabId, windowId: 2 } : undefined,
  };
}

function uuids() {
  const values = ['controller-turn', 'profile-turn'];
  return () => values.shift() || 'unexpected';
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Reads until a value appears: a held command only reports once the person answers.
async function untilReady(read, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = read();
    if (value) return value;
    await settle();
  }
  return null;
}

// A page adapter that records every call, with the real executor and ref store
// in front of it, so a ref minted for the turn is exercised end to end.
function pageAdapter({ nodes = PAGE_NODES, snapshot = null, actions = ADAPTER_ACTIONS } = {}) {
  const calls = [];
  return {
    calls,
    contract: { enabled: true, actions },
    async inspect() { return { currentUrl: 'https://shop.example.test/cart', hasUnsavedContent: false }; },
    async execute(action, args, context) {
      calls.push({ action, args: { ...args }, tabId: context.scope.tabId, target: context.target || null });
      if (action === 'browser_snapshot') {
        if (typeof snapshot === 'function') return snapshot(args, context);
        return {
          title: 'Cart', url: 'https://shop.example.test/cart', text: 'Your cart is empty.', nodes, headings: [{ level: 1, name: 'Cart' }],
        };
      }
      return { status: 'ok' };
    },
  };
}

async function controlledWorker({
  product = CHROMIUM,
  adapter = pageAdapter(),
  tabs = { 41: 'https://shop.example.test/cart' },
  storage = memoryStorage({ hermesBrowserSettings: settings() }),
  tabIds = Object.keys(tabs).map(Number),
  kind = tabIds.length > 1 ? TAB_LEASE_KINDS.SELECTED_TABS : TAB_LEASE_KINDS.THIS_TAB,
  acquire = true,
} = {}) {
  const transport = connector();
  const refs = createBrowserControlRefStore();
  const approvals = createBrowserControlApprovalStore();
  const executor = createBrowserControlExecutor({ adapter, approvals, refs });
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    approvalStore: approvals,
    executeBrowserCommand: (frame, context) => executor.execute(frame, context),
    getTab: async (tabId) => {
      const url = tabs[Number(tabId)];
      if (!url) throw new Error('missing tab');
      return { id: Number(tabId), url, windowId: 2 };
    },
  });
  const boot = await worker.boot();
  if (acquire) {
    const acquired = await worker.handleMessage({
      type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
      kind,
      ownership: TAB_LEASE_OWNERSHIPS.OWNED,
      ownerId: boot.controllerId,
      tabIds,
    }, extensionSender());
    assert.equal(acquired.ok, true, JSON.stringify(acquired));
    for (const tabId of tabIds) {
      await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId }));
    }
  }
  const prepare = (tabId, url = tabs[tabId]) => worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.prepareTurn,
    tabId,
    frameId: 0,
    expectedUrl: url,
  }, extensionSender());
  const command = async (params) => {
    await transport.connections[0].emit({ method: 'browser.controller.command', params });
    await settle();
    return transport.connections[0].sent.at(-1).params;
  };
  return { worker, transport, adapter, refs, storage, boot, prepare, command, approvals };
}

test('prepare-turn returns a bounded snapshot whose refs the first broker browser_click can use', async () => {
  const { prepare, command, adapter } = await controlledWorker();
  const prepared = await prepare(41);

  assert.equal(prepared.ok, true);
  assert.equal(prepared.availability, 'available');
  assert.equal(prepared.state, 'ready');
  assert.equal(prepared.controlSnapshotOmitted, undefined);
  assert.equal(prepared.controlSnapshot.title, 'Cart');
  assert.match(prepared.controlSnapshot.text, /^\[@e1\] button "Add to cart"\n\[@e2\] link "Home"\n\[@e3\] textbox "Sensitive field"/);
  assert.doesNotMatch(prepared.controlSnapshot.text, /Password/);
  assert.equal(prepared.controlSnapshot.elementCount, 3);
  assert.ok(prepared.controlSnapshot.text.length <= SNAPSHOT_VIEW_BUDGETS.turn);

  // The model's first action: a broker command with only the ref from the turn.
  const result = await command({
    command_id: 'first-click',
    action: 'browser_click',
    arguments: { ref: '@e1' },
    tab_id: prepared.tabId,
    document_generation: prepared.documentGeneration,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.status, 'clicked');
  const click = adapter.calls.find((call) => call.action === 'browser_click');
  assert.equal(click.target.backendDOMNodeId, 41);
  // Preparing the turn used the same snapshot path, once.
  assert.equal(adapter.calls.filter((call) => call.action === 'browser_snapshot').length >= 1, true);
});

test('without preparing the turn the same ref is unknown, so the prepared refs are what make the first click work', async () => {
  const { command, adapter } = await controlledWorker();
  const result = await command({ command_id: 'cold-click', action: 'browser_click', arguments: { ref: '@e1' } });
  assert.equal(result.ok, false);
  assert.match(result.error.code, /unknown_ref|stale_ref/);
  assert.equal(adapter.calls.filter((call) => call.action === 'browser_click').length, 0);
});

test('prepare-turn refs also work when the broker command names no tab and no generation', async () => {
  const { prepare, command, adapter } = await controlledWorker();
  await prepare(41);
  const result = await command({ command_id: 'bare-click', action: 'browser_click', arguments: { ref: '@e2' } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(adapter.calls.find((call) => call.action === 'browser_click').target.backendDOMNodeId, 40);
});

test('prepare-turn keeps the page view within the turn budget on a large page', async () => {
  const nodes = Array.from({ length: 400 }, (_, index) => ({
    role: 'button', name: `Action number ${index} with a fairly long accessible name`, backendDOMNodeId: 1_000 + index,
  }));
  const { prepare } = await controlledWorker({ adapter: pageAdapter({ nodes }) });
  const prepared = await prepare(41);
  assert.ok(prepared.controlSnapshot.text.length <= SNAPSHOT_VIEW_BUDGETS.turn);
  assert.equal(prepared.controlSnapshot.truncated, true);
  assert.equal(prepared.controlSnapshot.elementCount, 400);
  assert.match(prepared.controlSnapshot.text, /more elements/);
});

test('prepare-turn never reads the page for Firefox', async () => {
  const adapter = pageAdapter();
  const { prepare } = await controlledWorker({ product: FIREFOX, adapter });
  const prepared = await prepare(41);
  assert.equal(prepared.availability, 'available');
  assert.equal(prepared.state, 'ready');
  assert.equal(prepared.controlSnapshot, undefined);
  assert.equal(prepared.controlSnapshotOmitted, 'unsupported_browser');
  assert.equal(adapter.calls.length, 0);
});

test('prepare-turn never reads a restricted page', async () => {
  const adapter = pageAdapter();
  const url = 'https://bank.example.test/accounts';
  const { prepare } = await controlledWorker({ adapter, tabs: { 41: url } });
  const prepared = await prepare(41);
  assert.equal(prepared.availability, 'available');
  assert.equal(prepared.controlSnapshot, undefined);
  assert.equal(prepared.controlSnapshotOmitted, 'restricted_page');
  assert.equal(adapter.calls.length, 0);
});

test('prepare-turn omits the snapshot but keeps the turn when the page read fails', async () => {
  const adapter = pageAdapter({ snapshot: () => { throw new Error('debugger exploded'); } });
  const { prepare } = await controlledWorker({ adapter });
  const prepared = await prepare(41);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.state, 'ready');
  assert.equal(prepared.controlSnapshot, undefined);
  assert.equal(prepared.controlSnapshotOmitted, 'command_error');
});

test('prepare-turn is time-boxed: a hung page read is omitted within about a second and a half', async () => {
  const adapter = pageAdapter({ snapshot: () => new Promise(() => {}) });
  const { prepare } = await controlledWorker({ adapter });
  const startedAt = Date.now();
  const prepared = await prepare(41);
  const elapsed = Date.now() - startedAt;
  assert.equal(prepared.state, 'ready');
  assert.equal(prepared.controlSnapshot, undefined);
  assert.match(prepared.controlSnapshotOmitted, /^(deadline_exceeded|snapshot_timeout)$/);
  assert.ok(elapsed < 2_500, `prepare took ${elapsed} ms`);
});

test('prepare-turn is unavailable, with attach guidance, when the tab is not attached', async () => {
  const { prepare } = await controlledWorker({ acquire: false });
  const prepared = await prepare(41);
  assert.equal(prepared.ok, false);
  assert.equal(prepared.availability, 'unavailable');
  assert.equal(prepared.reason, 'lease_required');
  assert.equal(prepared.isolatedFallback, 'forbidden');
  assert.match(prepared.message, /press Attach this tab/);
  assert.doesNotMatch(prepared.message, /Tab not found/);
});

test('prepare-turn is unavailable while control is paused and prepares nothing', async () => {
  const adapter = pageAdapter();
  const { worker, prepare } = await controlledWorker({ adapter });
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.pause }, extensionSender());
  const prepared = await prepare(41);
  assert.equal(prepared.availability, 'unavailable');
  assert.equal(prepared.reason, 'controller_paused');
  assert.equal(adapter.calls.length, 0);
});

test('prepare-turn is refused from an untrusted sender', async () => {
  const { worker } = await controlledWorker();
  const refused = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.prepareTurn,
    tabId: 41,
    expectedUrl: 'https://shop.example.test/cart',
  }, { url: 'https://example.test/page' });
  assert.deepEqual(refused, { ok: false, error: 'untrusted_sender' });
});

async function twoTabWorker(options = {}) {
  return controlledWorker({
    tabs: { 41: 'https://shop.example.test/cart', 42: 'https://shop.example.test/orders' },
    ...options,
  });
}

test('with several attached tabs a command without tab_id targets the most recent turn tab', async () => {
  const { prepare, command, adapter } = await twoTabWorker();

  const before = await command({ command_id: 'ambiguous', action: 'browser_scroll', arguments: { direction: 'down' } });
  assert.equal(before.ok, false);
  assert.equal(before.error.code, 'ambiguous_target');

  await prepare(42);
  const second = await command({ command_id: 'on-42', action: 'browser_scroll', arguments: { direction: 'down' } });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(adapter.calls.at(-1).tabId, 42);

  await prepare(41);
  const first = await command({ command_id: 'on-41', action: 'browser_scroll', arguments: { direction: 'down' } });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(adapter.calls.at(-1).tabId, 41);
});

test('arguments.tab_id picks an attached tab and is rejected for tabs the controller does not own', async () => {
  const { prepare, command, adapter } = await twoTabWorker();
  await prepare(41);

  const named = await command({ command_id: 'named', action: 'browser_scroll', arguments: { direction: 'down', tab_id: 42 } });
  assert.equal(named.ok, true, JSON.stringify(named));
  assert.equal(adapter.calls.at(-1).tabId, 42);

  const foreign = await command({ command_id: 'foreign', action: 'browser_scroll', arguments: { direction: 'down', tab_id: 999 } });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error.code, 'lease_not_owned');
  assert.equal(adapter.calls.filter((call) => call.tabId === 999).length, 0);

  const junk = await command({ command_id: 'junk', action: 'browser_scroll', arguments: { direction: 'down', tab_id: 'abc' } });
  assert.equal(junk.ok, false);
  assert.equal(junk.error.code, 'lease_not_owned');
});

test('the most recent turn tab survives a worker restart and is forgotten when its tab goes away', async () => {
  const first = await twoTabWorker();
  await first.prepare(42);
  assert.equal(first.storage.state.hermesBrowserControllerWorker.lastTurnTabId, 42);

  const restarted = await twoTabWorker({ storage: first.storage, acquire: false });
  const result = await restarted.command({ command_id: 'after-restart', action: 'browser_scroll', arguments: { direction: 'down' } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(restarted.adapter.calls.at(-1).tabId, 42);

  await restarted.worker.handleTabRemoved(42);
  assert.equal(restarted.storage.state.hermesBrowserControllerWorker.lastTurnTabId, 0);
  const only41 = await restarted.command({ command_id: 'only-41', action: 'browser_scroll', arguments: { direction: 'down' } });
  assert.equal(only41.ok, true, JSON.stringify(only41));
  assert.equal(restarted.adapter.calls.at(-1).tabId, 41);
});

test('the tab of the latest action is reported as lastActionTabId, survives a restart, and is forgotten when its tab goes away', async () => {
  const first = await twoTabWorker();
  await first.prepare(41);
  const acted = await first.command({ command_id: 'act-42', action: 'browser_scroll', arguments: { direction: 'down', tab_id: 42 } });
  assert.equal(acted.ok, true, JSON.stringify(acted));
  assert.equal(first.worker.status().lastActionTabId, 42);
  assert.equal(first.storage.state.hermesBrowserControllerWorker.lastActionTabId, 42);

  const restarted = await twoTabWorker({ storage: first.storage, acquire: false });
  assert.equal(restarted.worker.status().lastActionTabId, 42);

  await restarted.worker.handleTabRemoved(42);
  assert.equal(restarted.worker.status().lastActionTabId, null);
  assert.equal(restarted.storage.state.hermesBrowserControllerWorker.lastActionTabId, 0);
});

test('tab-owned arguments.tab_id still means the tab to act on, not the command target', async () => {
  const { prepare, adapter, approvals, transport } = await twoTabWorker({
    adapter: pageAdapter({ actions: [...ADAPTER_ACTIONS, 'browser_tab_activate'] }),
  });
  await prepare(41);
  // Switching tabs asks the person first, so the command is held until they grant it.
  transport.connections[0].emit({
    method: 'browser.controller.command',
    params: { command_id: 'activate', action: 'browser_tab_activate', arguments: { tab_id: 42 } },
  });
  await settle();
  const request = await untilReady(() => approvals.pending()[0] || null);
  assert.equal(request?.action, 'browser_tab_activate', JSON.stringify(approvals.pending()));
  assert.equal(adapter.calls.some((call) => call.action === 'browser_tab_activate'), false);
  approvals.grant(request);
  const result = await untilReady(() => transport.connections[0].sent.find((frame) => frame.params?.command_id === 'activate') || null);
  assert.equal(result?.params.ok, true, JSON.stringify(result));
  assert.equal(adapter.calls.at(-1).args.tab_id, 42);
});

test('the controller capability list never outgrows what the Chromium adapter implements', () => {
  const adapterActions = new Set(CHROMIUM_ACTIONS);
  for (const capability of CONTROLLER_BROWSER_CAPABILITIES) {
    assert.ok(adapterActions.has(capability), `${capability} is registered but no adapter implements it`);
  }
  for (const capability of ['browser_fill', 'browser_select', 'browser_hover', 'browser_scroll_to', 'browser_drag']) {
    assert.ok(CONTROLLER_BROWSER_CAPABILITIES.includes(capability), `${capability} must be registered`);
  }
});

function readyControl(overrides = {}) {
  return {
    route: 'extension-controller',
    availability: 'available',
    isolatedFallback: 'forbidden',
    controllerId: 'controller-turn',
    browserProfileId: 'profile-turn',
    tabId: 41,
    frameId: 0,
    documentGeneration: 3,
    url: 'https://shop.example.test/cart',
    leaseOwned: true,
    state: 'ready',
    ...overrides,
  };
}

test('the turn envelope carries state ready and the bounded control snapshot', () => {
  const text = '[@e1] button "Add to cart"\n[@e2] link "Home"\n\n## Cart';
  const envelope = buildBrowserTurnEnvelope({
    humanInput: 'add it',
    activeTab: { id: 41, url: 'https://shop.example.test/cart', title: 'Cart' },
    contextScope: { mode: 'pinned-tab', pinnedTabId: 41, pinnedUrl: 'https://shop.example.test/cart' },
    browserControl: readyControl({ controlSnapshot: { title: 'Cart', text, truncated: false, elementCount: 2 } }),
  });
  assert.equal(envelope.browser_control.state, 'ready');
  assert.deepEqual(envelope.browser_control.control_snapshot, {
    title: 'Cart', text, truncated: false, element_count: 2,
  });
  assert.equal(envelope.browser_control.control_snapshot_omitted, undefined);
});

test('a turn from another chat moves Hermes Control to that chat before the tab is reported ready', async () => {
  const { worker, transport } = await controlledWorker();
  assert.equal(transport.connections[0].options.identity.hermesSessionId, 'turn-context-session');

  const prepared = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.prepareTurn,
    tabId: 41,
    frameId: 0,
    expectedUrl: 'https://shop.example.test/cart',
    sessionId: 'second-window-chat',
  }, extensionSender());

  // The gateway serves the tab tools to the session the controller registered for, so a turn
  // from another chat is only ready once the controller registered for that chat.
  assert.equal(transport.connections.length, 2);
  assert.equal(transport.connections[1].options.identity.hermesSessionId, 'second-window-chat');
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.state, 'ready');
  assert.equal(prepared.leaseOwned, true, 'the attached tab stays attached across the move');
});

test('a turn from the chat Hermes Control already serves, or with no chat named, does not reconnect', async () => {
  const { worker, transport } = await controlledWorker();
  for (const sessionId of ['turn-context-session', '', undefined]) {
    const prepared = await worker.handleMessage({
      type: CONTROLLER_WORKER_MESSAGES.prepareTurn,
      tabId: 41,
      frameId: 0,
      expectedUrl: 'https://shop.example.test/cart',
      ...(sessionId === undefined ? {} : { sessionId }),
    }, extensionSender());
    assert.equal(prepared.state, 'ready', String(sessionId));
  }
  assert.equal(transport.connections.length, 1);
});

test('a turn from another chat never takes Hermes Control away from a command still running', async () => {
  const held = deferredGate();
  const adapter = pageAdapter();
  const execute = adapter.execute.bind(adapter);
  adapter.execute = async (action, args, context) => {
    if (action === 'browser_scroll') await held.promise;
    return execute(action, args, context);
  };
  const { worker, transport } = await controlledWorker({ adapter });
  const scope = transport.connections[0].options.identity;
  void transport.connections[0].emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'running-scroll', action: 'browser_scroll', tab_id: 41, frame_id: 0,
      session_id: scope.hermesSessionId, arguments: { direction: 'down' },
    },
  });
  await settle();

  const prepared = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.prepareTurn,
    tabId: 41,
    frameId: 0,
    expectedUrl: 'https://shop.example.test/cart',
    sessionId: 'second-window-chat',
  }, extensionSender());
  held.resolve();

  assert.equal(transport.connections.length, 1, 'the running chat keeps its controller');
  assert.equal(prepared.ok, false);
  assert.equal(prepared.availability, 'unavailable');
  assert.equal(prepared.reason, 'controller_busy');
});

test('a chat move queued behind a heartbeat looks for running work again before it changes the connection', async () => {
  const held = deferredGate();
  const heartbeat = deferredGate();
  const adapter = pageAdapter();
  const execute = adapter.execute.bind(adapter);
  adapter.execute = async (action, args, context) => {
    if (action === 'browser_scroll') await held.promise;
    return execute(action, args, context);
  };
  const { worker, transport } = await controlledWorker({ adapter });
  const first = transport.connections[0];
  first.heartbeat = () => heartbeat.promise;
  const beating = worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.wake }, extensionSender());
  await settle();

  // Nothing is running when the turn arrives, so the first look passes; the move waits behind the heartbeat.
  const preparing = worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.prepareTurn,
    tabId: 41,
    frameId: 0,
    expectedUrl: 'https://shop.example.test/cart',
    sessionId: 'second-window-chat',
  }, extensionSender());
  await settle();
  void first.emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'running-scroll', action: 'browser_scroll', tab_id: 41, frame_id: 0,
      session_id: first.options.identity.hermesSessionId, arguments: { direction: 'down' },
    },
  });
  await settle();
  heartbeat.resolve({ ok: true });
  const prepared = await preparing;
  await beating;
  held.resolve();
  await settle();

  assert.equal(transport.connections.length, 1, 'the running chat keeps its controller');
  assert.equal(prepared.ok, false);
  assert.equal(prepared.reason, 'controller_busy');
  const finished = first.sent.map((frame) => frame.params).find((params) => params?.command_id === 'running-scroll');
  assert.equal(finished?.ok, true, JSON.stringify(finished));
});

test('a turn is never ready for a chat Hermes Control has not moved to, even when the move is still waiting', async (t) => {
  const heartbeat = deferredGate();
  const { worker, transport } = await controlledWorker();
  const first = transport.connections[0];
  first.heartbeat = () => heartbeat.promise;
  const beating = worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.wake }, extensionSender());
  await settle();

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const preparing = worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.prepareTurn,
    tabId: 41,
    frameId: 0,
    expectedUrl: 'https://shop.example.test/cart',
    sessionId: 'second-window-chat',
  }, extensionSender());
  for (let turn = 0; turn < 200; turn += 1) await Promise.resolve();
  t.mock.timers.tick(3_000);
  const prepared = await preparing;
  t.mock.timers.reset();

  assert.notEqual(prepared.state, 'ready', 'the old chat is still the one connected');
  assert.equal(prepared.ok, false);
  assert.equal(prepared.availability, 'unavailable');
  heartbeat.resolve({ ok: true });
  await beating;
  await settle();
});

test('a turn from another chat does not undo the stop the person pressed on a tab', async () => {
  const { worker, adapter } = await controlledWorker();
  await worker.handleDebuggerDetach({ tabId: 41, reason: 'canceled_by_user' });
  const snapshotsBefore = adapter.calls.filter((call) => call.action === 'browser_snapshot').length;

  const prepared = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.prepareTurn,
    tabId: 41,
    frameId: 0,
    expectedUrl: 'https://shop.example.test/cart',
    sessionId: 'second-window-chat',
  }, extensionSender());

  assert.equal(prepared.ok, false, JSON.stringify(prepared));
  assert.equal(prepared.reason, 'debugger_detached');
  assert.deepEqual(Object.keys(worker.status().pausedLeases), ['41']);
  assert.equal(adapter.calls.filter((call) => call.action === 'browser_snapshot').length, snapshotsBefore,
    'the page is not read, so the debugger is not attached again');
});

test('a change of gateway still clears the stops on tabs, since the tabs belong to a new route', async () => {
  const { worker } = await controlledWorker();
  await worker.handleDebuggerDetach({ tabId: 41, reason: 'canceled_by_user' });
  await worker.syncSettings(settings({ gatewayUrl: 'http://127.0.0.1:9999' }));
  assert.deepEqual(worker.status().pausedLeases, {});
});

async function movedToSecondChat(options = {}) {
  const made = await controlledWorker(options);
  const prepared = await made.worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.prepareTurn,
    tabId: 41,
    frameId: 0,
    expectedUrl: 'https://shop.example.test/cart',
    sessionId: 'second-window-chat',
  }, extensionSender());
  assert.equal(prepared.state, 'ready', JSON.stringify(prepared));
  assert.equal(made.transport.connections.length, 2);
  return made;
}

test('a settings write that does not name another chat leaves Hermes Control on the chat that moved it', async () => {
  const { worker, transport } = await movedToSecondChat();
  // Another open panel saves an unrelated setting and writes the chat it still shows.
  await worker.syncSettings(settings({ responseStyle: 'brief' }));
  assert.equal(transport.connections.length, 2, 'no reconnect back to the panel chat');

  // A chat the person opens in a panel is still followed.
  await worker.syncSettings(settings({ sessionId: 'opened-in-panel' }));
  assert.equal(transport.connections.length, 3);
  assert.equal(transport.connections[2].options.identity.hermesSessionId, 'opened-in-panel');
});

test('Hermes Control never saves the chat that moved it over the chat the panel shows', async () => {
  const { worker, storage } = await movedToSecondChat();
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.pause }, extensionSender());
  assert.equal(storage.state.hermesBrowserSettings.browserControlPaused, true);
  assert.equal(storage.state.hermesBrowserSettings.sessionId, 'turn-context-session');
});

test('a restarted worker connects for the chat that moved Hermes Control, not the one the panel saved', async () => {
  const { storage } = await movedToSecondChat();
  const restarted = await controlledWorker({ storage, acquire: false });
  assert.equal(restarted.transport.connections[0].options.identity.hermesSessionId, 'second-window-chat');
});

function deferredGate() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('the control snapshot is redacted and bounded like every other envelope field', () => {
  const secret = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('-');
  const envelope = buildBrowserTurnEnvelope({
    humanInput: 'go',
    browserControl: readyControl({
      controlSnapshot: { text: `[@e1] button "Use ${secret}"\n${'x'.repeat(9_000)}`, truncated: false, elementCount: 1 },
    }),
  });
  const snapshot = envelope.browser_control.control_snapshot;
  assert.doesNotMatch(snapshot.text, /sk-proj-abcdefghijklmnopqrstuvwxyz/);
  assert.ok(snapshot.text.length <= BROWSER_CONTEXT_TURN_BUDGETS.controlSnapshotChars);
  assert.equal(snapshot.truncated, true);
  assert.equal(envelope.source_receipt.truncation.sources['browser_control.control_snapshot'] > 0, true);
  assert.equal(BROWSER_CONTEXT_TURN_BUDGETS.controlSnapshotChars, SNAPSHOT_VIEW_BUDGETS.turn);
});

test('the control snapshot counts against the 48k envelope budget', () => {
  const snapshotText = Array.from({ length: 400 }, (_, index) => `[@e${index + 1}] button "Action ${index} \\"quoted\\""`).join('\n');
  const envelope = buildBrowserTurnEnvelope({
    humanInput: 'x'.repeat(5_000),
    activeTab: { id: 41, url: 'https://shop.example.test/cart', title: 'Cart' },
    contextScope: { mode: 'pinned-tab', pinnedTabId: 41, pinnedUrl: 'https://shop.example.test/cart' },
    pageContext: { title: 'Cart', url: 'https://shop.example.test/cart', text: 'p'.repeat(40_000) },
    browserControl: readyControl({ controlSnapshot: { text: snapshotText, truncated: false, elementCount: 400 } }),
  });
  const serialized = serializeBrowserTurnEnvelope({
    humanInput: 'x'.repeat(5_000),
    activeTab: { id: 41, url: 'https://shop.example.test/cart', title: 'Cart' },
    contextScope: { mode: 'pinned-tab', pinnedTabId: 41, pinnedUrl: 'https://shop.example.test/cart' },
    pageContext: { title: 'Cart', url: 'https://shop.example.test/cart', text: 'p'.repeat(40_000) },
    browserControl: readyControl({ controlSnapshot: { text: snapshotText, truncated: false, elementCount: 400 } }),
  });
  assert.ok(serialized.length <= BROWSER_CONTEXT_TURN_BUDGETS.totalSerializedChars);
  assert.equal(envelope.source_receipt.budgets.total_limit, 48_000);
  // The page view survives; the long page text gives way first.
  assert.ok(envelope.browser_control.control_snapshot.text.length > 1_000);
  assert.ok(envelope.source_receipt.budgets.serialized_chars <= 48_000);
});

test('the control snapshot shrinks, never the human request, when nothing else can give', () => {
  // Control characters serialize as six characters each, so these two fields
  // alone overflow the envelope once the page text and attachments are gone.
  const envelope = buildBrowserTurnEnvelope({
    humanInput: '\u0001'.repeat(BROWSER_CONTEXT_TURN_BUDGETS.humanInputChars),
    browserControl: readyControl({ controlSnapshot: { text: '\u0001'.repeat(6_000), truncated: false, elementCount: 1 } }),
  });
  assert.ok(envelope.source_receipt.budgets.serialized_chars <= BROWSER_CONTEXT_TURN_BUDGETS.totalSerializedChars);
  assert.equal(envelope.human_input.text.length, BROWSER_CONTEXT_TURN_BUDGETS.humanInputChars);
  assert.ok(envelope.browser_control.control_snapshot.text.length < 6_000);
  assert.ok(envelope.browser_control.control_snapshot.text.length > 500);
  assert.equal(envelope.browser_control.control_snapshot.truncated, true);
  assert.ok(envelope.source_receipt.truncation.sources['browser_control.control_snapshot_total'] > 0);
});

test('not_requested and unavailable control never claim a tab and never say Tab not found by default', () => {
  const off = buildBrowserTurnEnvelope({
    humanInput: 'hi',
    browserControl: {
      route: 'extension-controller',
      availability: 'not_requested',
      isolatedFallback: 'forbidden',
      reason: 'control_off',
      message: 'Hermes Control is off for this turn.',
    },
  });
  assert.deepEqual(off.browser_control, {
    route: 'extension-controller',
    availability: 'not_requested',
    isolated_fallback: 'forbidden',
    reason: 'control_off',
    message: 'Hermes Control is off for this turn.',
  });

  const defaulted = buildBrowserTurnEnvelope({
    humanInput: 'hi',
    browserControl: { availability: 'not_requested' },
  });
  assert.equal(defaulted.browser_control.reason, 'control_off');
  assert.doesNotMatch(defaulted.browser_control.message, /Tab not found/);

  const unavailable = buildBrowserTurnEnvelope({ humanInput: 'hi', browserControl: { availability: 'nonsense' } });
  assert.equal(unavailable.browser_control.availability, 'unavailable');
  assert.equal(unavailable.browser_control.isolated_fallback, 'forbidden');
});

test('a ready turn without a snapshot says why it was omitted', () => {
  const envelope = buildBrowserTurnEnvelope({
    humanInput: 'go',
    browserControl: readyControl({ controlSnapshotOmitted: 'restricted_page' }),
  });
  assert.equal(envelope.browser_control.state, 'ready');
  assert.equal(envelope.browser_control.control_snapshot, undefined);
  assert.equal(envelope.browser_control.control_snapshot_omitted, 'restricted_page');
});
