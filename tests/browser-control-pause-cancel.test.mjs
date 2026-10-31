// Pause is Stop plus a hold: a command that is running (or waiting for an approval) when the person presses
// Pause ends, the approval cannot be granted afterwards, and a command that lost its debugger never attaches again.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROLLER_WORKER_MESSAGES, createControllerServiceWorker } from '../extension/lib/controller-service-worker.mjs';
import { TAB_LEASE_KINDS, TAB_LEASE_OWNERSHIPS } from '../extension/lib/tab-leases.mjs';
import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';
import { createChromiumCdpAdapter } from '../extension/lib/browser-control-browser-adapters.mjs';

const PRODUCT = Object.freeze({ id: 'chromium', engine: 'chromium', label: 'Chromium browser' });

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

const settings = () => ({
  connectionSchemaVersion: 1,
  connectionMode: 'local',
  connectionTransport: 'local-api',
  gatewayMode: 'local-api',
  gatewayUrl: 'http://127.0.0.1:8642',
  apiKey: ['pause', 'fixture', 'route'].join('-'),
  activeProfile: 'default',
  sessionId: 'pause-session',
  browserControlEnabled: true,
});

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
        disconnect(reason = 'fixture disconnect') { return options.onClose(new Error(reason)); },
      };
      connections.push(connection);
      return connection;
    },
  };
}

const extensionSender = ({ tabId = null } = {}) => ({
  url: 'chrome-extension://fixture/sidepanel.html',
  frameId: 0,
  tab: Number.isInteger(tabId) ? { id: tabId, windowId: 2 } : undefined,
});
const uuids = () => {
  const values = ['controller-pause', 'profile-pause'];
  return () => values.shift() || 'unexpected';
};
async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
async function waitFor(check, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition never held');
  return null;
}
const terminalOf = (connection, commandId) => connection.sent
  .find((frame) => frame.method === 'browser.controller.result' && frame.params.command_id === commandId)?.params;

async function ownedReady(worker, tabId) {
  const boot = worker.status();
  assert.equal((await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseAcquire,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    ownership: TAB_LEASE_OWNERSHIPS.OWNED,
    ownerId: boot.controllerId,
    tabIds: [tabId],
    windowId: 2,
  }, extensionSender())).ok, true);
  const ready = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, extensionSender({ tabId }));
  return { boot, documentGeneration: ready.documentGeneration };
}

// A worker whose command blocks until the worker aborts it (or the test lets it go).
async function runningCommandWorker() {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const released = [];
  const signals = [];
  let gate;
  const open = new Promise((resolve) => { gate = resolve; });
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    releaseTabDebugger: async (tabId) => { released.push(tabId); },
    executeBrowserCommand: async (_frame, context) => {
      signals.push(context.signal);
      await Promise.race([open, new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }))]);
      return { ok: true, result: { status: 'scrolled' } };
    },
  });
  await worker.boot();
  const ready = await ownedReady(worker, 71);
  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'running-1', action: 'browser_scroll', arguments: { direction: 'down' }, tab_id: 71, document_generation: ready.documentGeneration,
    },
  });
  await waitFor(() => signals.length === 1);
  return { worker, transport, released, signals, ready, gate, connection: transport.connections[0] };
}

test('Pause ends the command that is running, like Stop does, and releases the tab', async () => {
  const fixture = await runningCommandWorker();
  await fixture.worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.pause }, extensionSender());
  const terminal = await waitFor(() => terminalOf(fixture.connection, 'running-1'));
  assert.equal(fixture.signals[0].aborted, true, 'the executor was told to stop');
  assert.equal(terminal.ok, false);
  assert.equal(terminal.error.code, 'cancelled');
  await settle();
  assert.deepEqual(fixture.released, [71]);
  assert.equal(fixture.worker.status().pendingCommands, 0);
  assert.equal(fixture.worker.status().paused, true);
});

test('releasing a tab ends the command that is running on it', async () => {
  const fixture = await runningCommandWorker();
  const result = await fixture.worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.leaseRelease, ownerId: fixture.ready.boot.controllerId, tabIds: [71],
  }, extensionSender());
  assert.equal(result.ok, true);
  await waitFor(() => terminalOf(fixture.connection, 'running-1'));
  assert.equal(fixture.signals[0].aborted, true);
  assert.equal(terminalOf(fixture.connection, 'running-1').error.code, 'cancelled');
});

async function waitingApprovalWorker() {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const approvals = createBrowserControlApprovalStore();
  let sideEffects = 0;
  const executor = createBrowserControlExecutor({
    adapter: {
      contract: { enabled: true, actions: ['browser_press'] },
      async inspect() { return { currentUrl: 'https://example.test/form' }; },
      async execute() { sideEffects += 1; return { status: 'pressed' }; },
    },
    approvals,
    refs: createBrowserControlRefStore(),
  });
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    approvalStore: approvals,
    executeBrowserCommand: (frame, context) => executor.execute(frame, context),
  });
  await worker.boot();
  const ready = await ownedReady(worker, 81);
  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'approval-pause', approval_nonce: 'approval-pause-nonce', action: 'browser_press', arguments: { key: 'Enter' }, tab_id: 81, document_generation: ready.documentGeneration,
    },
  });
  const pending = await waitFor(() => worker.status().pendingApproval);
  return {
    worker,
    connection: transport.connections[0],
    pending,
    grant: () => worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.approvalGrant, ...pending }, extensionSender()),
    sideEffects: () => sideEffects,
  };
}

test('Pause while an approval card is open ends the command, and Approve afterwards does nothing', async () => {
  const fixture = await waitingApprovalWorker();
  await fixture.worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.pause }, extensionSender());
  await settle();
  const late = await fixture.grant();
  assert.equal(late.ok, false);
  assert.equal(late.error, 'controller_paused', 'it says why, rather than that the approval is missing');
  await settle();
  assert.equal(fixture.sideEffects(), 0);
  assert.equal(terminalOf(fixture.connection, 'approval-pause')?.ok, false);
  // Resuming does not bring the cancelled command back.
  await fixture.worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.resume }, extensionSender());
  await settle();
  assert.equal(fixture.sideEffects(), 0);
});

// --- the adapter never re-attaches a debugger the person released --------------------------------------------------

function debuggerFake({ onSend } = {}) {
  const calls = [];
  const counts = { attach: 0, detach: 0 };
  const api = {
    tabs: { get: async () => ({ url: 'https://example.com/', status: 'complete', active: true, windowId: 1 }) },
    scripting: { executeScript: async () => [{ result: {} }] },
    debugger: {
      attach: async () => { counts.attach += 1; },
      detach: async () => { counts.detach += 1; },
      sendCommand: async (_target, method, params) => {
        calls.push([method, params]);
        onSend?.(method);
        if (method === 'DOM.getBoxModel') return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 44, frameId: 'MAIN' };
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'MAIN', url: 'https://example.com/' } } };
        if (method === 'DOM.describeNode') return { node: { nodeName: 'A' } };
        if (method === 'Runtime.evaluate') return { result: { value: false } };
        return {};
      },
      onDetach: { addListener() {}, removeListener() {} },
      onEvent: { addListener() {}, removeListener() {} },
    },
  };
  return { api, calls, counts };
}
const mouseEvents = (calls) => calls.filter((call) => call[0] === 'Input.dispatchMouseEvent').map((call) => call[1].type);

test('a click whose tab is released mid-way stops, and does not attach the debugger again to finish', async () => {
  let adapter;
  let released = false;
  const fake = debuggerFake({
    onSend: (method) => {
      if (method === 'DOM.getBoxModel' && !released) {
        released = true;
        adapter.releaseTab(1);
      }
    },
  });
  adapter = createChromiumCdpAdapter({ browserApi: fake.api });
  await assert.rejects(
    adapter.execute('browser_click', {}, { scope: { tabId: 1 }, signal: new AbortController().signal, target: { backendDOMNodeId: 44 } }),
    (error) => error?.code === 'debugger_detached' && /detached/i.test(error.message),
  );
  assert.equal(fake.counts.attach, 1, 'attached once, never again');
  assert.deepEqual(mouseEvents(fake.calls), [], 'nothing was pressed');

  // The next command is a new one and attaches as usual.
  await adapter.execute('browser_click', {}, { scope: { tabId: 1 }, signal: new AbortController().signal, target: { backendDOMNodeId: 44 } });
  assert.equal(fake.counts.attach, 2);
  assert.deepEqual(mouseEvents(fake.calls), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  await adapter.dispose();
});
