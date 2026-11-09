// Pause is Stop plus a hold: a command that is running (or waiting for an approval) when the person presses
// Pause ends, the approval cannot be granted afterwards, and a command that lost its debugger never attaches again.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROLLER_WORKER_MESSAGES, createControllerServiceWorker } from '../extension/lib/controller-service-worker.mjs';
import {
  addSavedConnection,
  hydrateSavedConnectionSecrets,
  rememberSavedConnection,
  withSavedConnectionsLock,
} from '../extension/lib/saved-connections.mjs';
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

test('Pause blocks new gateway commands while the saved-connections lock is held', async () => {
  const queue = [];
  let running = false;
  const locks = {
    request(_name, task) {
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        const tryRun = () => {
          if (running || !queue.length) return;
          running = true;
          const { task: next, resolve: res, reject: rej } = queue.shift();
          Promise.resolve(next())
            .then(res, rej)
            .finally(() => {
              running = false;
              tryRun();
            });
        };
        tryRun();
      });
    },
  };
  const prevNav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true });
  let releaseHolder;
  const holderDone = new Promise((r) => { releaseHolder = r; });
  const otherPanelWork = withSavedConnectionsLock(async () => {
    await holderDone;
  });
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const executed = [];
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async (frame) => {
      executed.push(frame);
      return { ok: true, result: { status: 'done' } };
    },
  });
  try {
    await worker.boot();
    const ready = await ownedReady(worker, 91);
    await settle();
    const pausePromise = worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.pause }, extensionSender());
    await settle();
    assert.equal(worker.status().paused, true, 'pause guard is on before lock callback runs');
    await transport.connections[0].emit({
      method: 'browser.controller.command',
      params: {
        command_id: 'during-lock',
        action: 'browser_scroll',
        arguments: { direction: 'down' },
        tab_id: 91,
        document_generation: ready.documentGeneration,
      },
    });
    await settle();
    assert.equal(executed.length, 0, 'executor must not run while pause guard is active during lock wait');
    const rejected = terminalOf(transport.connections[0], 'during-lock');
    assert.equal(rejected?.ok, false);
    assert.equal(rejected?.error?.code, 'controller_paused');
    releaseHolder();
    await pausePromise;
    await otherPanelWork;
    assert.equal(worker.status().paused, true);
  } finally {
    if (prevNav === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', { value: prevNav, configurable: true });
  }
});

test('Resume after Pause runs syncSettings so a newer stored chat closes the old transport', async () => {
  const base = settings();
  const storage = memoryStorage({ hermesBrowserSettings: base });
  const transport = connector();
  const closes = [];
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => ({ ok: true, result: { status: 'noop' } }),
  });
  await worker.boot();
  const firstConnection = transport.connections[0];
  const originalClose = firstConnection.close.bind(firstConnection);
  firstConnection.close = () => { closes.push('close'); originalClose(); };
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.pause }, extensionSender());
  storage.state.hermesBrowserSettings = { ...base, sessionId: 'session-b', sessionTitle: 'B' };
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.resume }, extensionSender());
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.settingsRefresh }, extensionSender());
  await settle();
  assert.ok(closes.length >= 1, 'stale socket must close when storage advances the chat');
  assert.equal(transport.connections.length, 2, 'a new connection opens for the advanced session');
});

test('Pause persists the newest chat from storage instead of copying the worker memory session', async () => {
  const base = settings();
  const storage = memoryStorage({ hermesBrowserSettings: base });
  const transport = connector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => ({ ok: true, result: { status: 'noop' } }),
  });
  await worker.boot();
  // Another panel advanced the shared session in storage; this worker has not run settingsRefresh yet.
  storage.state.hermesBrowserSettings = { ...base, sessionId: 'session-b', sessionTitle: 'B' };
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.pause }, extensionSender());
  assert.equal(storage.state.hermesBrowserSettings.sessionId, 'session-b');
  assert.equal(storage.state.hermesBrowserSettings.browserControlPaused, true);
});

test('Pause leaves the worker serving the in-memory chat while storage records a newer one', async () => {
  const base = settings();
  const storage = memoryStorage({ hermesBrowserSettings: base });
  const transport = connector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => ({ ok: true, result: { status: 'noop' } }),
  });
  await worker.boot();
  assert.equal(transport.connections[0]?.options?.settings?.sessionId, 'pause-session');
  storage.state.hermesBrowserSettings = { ...base, sessionId: 'session-b', sessionTitle: 'B' };
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.pause }, extensionSender());
  assert.equal(storage.state.hermesBrowserSettings.sessionId, 'session-b');
  assert.equal(transport.connections[0]?.options?.settings?.sessionId, 'pause-session');
});

test('an appearance save during a queued Resume still completes the resume and keeps the theme', async () => {
  const base = {
    ...settings(),
    browserControlPaused: true,
    appearanceTheme: 'nous',
    colorMode: 'dark',
  };
  const storage = memoryStorage({ hermesBrowserSettings: base });
  const transport = connector();
  const executed = [];
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async (frame) => {
      executed.push(frame);
      return { ok: true, result: { status: 'done' } };
    },
  });
  await worker.boot();
  const ready = await ownedReady(worker, 94);
  let releaseHeartbeat;
  const heartbeatHeld = new Promise((resolve) => { releaseHeartbeat = resolve; });
  transport.connections[0].heartbeat = () => heartbeatHeld;
  const reconciling = worker.reconcile({ reason: 'heartbeat-alarm' });
  await settle();
  storage.state.hermesBrowserSettings = {
    ...storage.state.hermesBrowserSettings,
    appearanceTheme: 'mono',
    colorMode: 'light',
    browserControlPaused: true,
  };
  const hydratedTheme = await hydrateSavedConnectionSecrets(
    storage.state.hermesBrowserSettings,
    storage.state.hermesBrowserSavedConnectionSecrets,
  );
  const syncPromise = worker.syncSettings(hydratedTheme);
  const resumePromise = worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.resume }, extensionSender());
  releaseHeartbeat({ ok: true });
  await reconciling;
  await resumePromise;
  await syncPromise;
  await settle();
  assert.equal(worker.status().paused, false);
  assert.equal(storage.state.hermesBrowserSettings.appearanceTheme, 'mono');
  assert.equal(storage.state.hermesBrowserSettings.colorMode, 'light');
  assert.equal(storage.state.hermesBrowserSettings.browserControlPaused, false);
  const generationAfterResume = (await worker.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.documentReady },
    extensionSender({ tabId: 94 }),
  )).documentGeneration;
  const activeConnection = transport.connections.at(-1);
  await activeConnection.emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'after-theme-resume',
      action: 'browser_scroll',
      arguments: { direction: 'down' },
      tab_id: 94,
      document_generation: generationAfterResume,
    },
  });
  await settle();
  assert.equal(executed.length, 1);
});

test('turning control off from a worker that is still on the old connection does not overwrite the saved list', async () => {
  const onDefault = rememberSavedConnection({ ...settings(), browserControlEnabled: true });
  const storage = memoryStorage({ hermesBrowserSettings: onDefault });
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: connector(),
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async () => ({ ok: true, result: { status: 'done' } }),
  });
  await worker.boot();
  storage.state.hermesBrowserSettings = addSavedConnection(onDefault, 'Added', 'added');
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.detach }, extensionSender());
  const stored = storage.state.hermesBrowserSettings;
  assert.equal(stored.savedConnections.length, 2, 'the added connection survives');
  assert.equal(stored.activeSavedConnectionId, 'added', 'and stays the active one');
});

test('a theme save that arrives while a Resume waits behind the heartbeat does not cancel that Resume', async () => {
  const base = { ...settings(), browserControlPaused: true, appearanceTheme: 'nous' };
  const storage = memoryStorage({ hermesBrowserSettings: base });
  const pausedWrites = [];
  const area = {
    ...storage.area,
    async set(values) {
      if (values.hermesBrowserSettings) pausedWrites.push(values.hermesBrowserSettings.browserControlPaused);
      return storage.area.set(values);
    },
  };
  const transport = connector();
  const executed = [];
  const worker = createControllerServiceWorker({
    storageArea: area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async (frame) => {
      executed.push(frame);
      return { ok: true, result: { status: 'done' } };
    },
  });
  await worker.boot();
  await ownedReady(worker, 95);
  let releaseHeartbeat;
  const heartbeatHeld = new Promise((resolve) => { releaseHeartbeat = resolve; });
  transport.connections[0].heartbeat = () => heartbeatHeld;
  const reconciling = worker.reconcile({ reason: 'heartbeat-alarm' });
  await settle();
  const resumePromise = worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.resume }, extensionSender());
  await settle();
  const pausedBeforeTheme = pausedWrites.length;
  storage.state.hermesBrowserSettings = { ...storage.state.hermesBrowserSettings, appearanceTheme: 'mono' };
  const themeSave = worker.syncSettings({ ...base, appearanceTheme: 'mono' });
  releaseHeartbeat({ ok: true });
  await reconciling;
  await resumePromise;
  await themeSave;
  assert.deepEqual(pausedWrites.slice(pausedBeforeTheme), [false]);
  // The storage event Resume's own write produces reaches the worker last, as it does in the browser.
  await worker.syncSettings(await hydrateSavedConnectionSecrets(
    storage.state.hermesBrowserSettings,
    storage.state.hermesBrowserSavedConnectionSecrets,
  ));
  await settle();
  assert.equal(worker.status().paused, false);
  assert.equal(storage.state.hermesBrowserSettings.appearanceTheme, 'mono');
  const generation = (await worker.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.documentReady },
    extensionSender({ tabId: 95 }),
  )).documentGeneration;
  await transport.connections.at(-1).emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'after-resume-with-theme-save',
      action: 'browser_scroll',
      arguments: { direction: 'down' },
      tab_id: 95,
      document_generation: generation,
    },
  });
  await settle();
  assert.equal(executed.length, 1);
});

test('a Resume queued behind settings sync does not un-pause after storage reports paused', async () => {
  const base = { ...settings(), browserControlPaused: true, sessionId: 'session-before-resume' };
  const storage = memoryStorage({ hermesBrowserSettings: base });
  const transport = connector();
  const executed = [];
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async (frame) => {
      executed.push(frame);
      return { ok: true, result: { status: 'done' } };
    },
  });
  await worker.boot();
  const ready = await ownedReady(worker, 93);
  storage.state.hermesBrowserSettings = {
    ...base,
    sessionId: 'session-after-chat-change',
    sessionTitle: 'Advanced chat',
    browserControlPaused: true,
  };
  let releaseHeartbeat;
  const heartbeatHeld = new Promise((resolve) => { releaseHeartbeat = resolve; });
  transport.connections[0].heartbeat = () => heartbeatHeld;
  const reconciling = worker.reconcile({ reason: 'heartbeat-alarm' });
  await settle();
  storage.state.hermesBrowserSettings = {
    ...storage.state.hermesBrowserSettings,
    browserControlPaused: true,
  };
  const hydratedPause = await hydrateSavedConnectionSecrets(
    storage.state.hermesBrowserSettings,
    storage.state.hermesBrowserSavedConnectionSecrets,
  );
  const resumePromise = worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.resume }, extensionSender());
  await settle();
  const syncPromise = worker.syncSettings(hydratedPause);
  releaseHeartbeat({ ok: true });
  await reconciling;
  await resumePromise;
  await syncPromise;
  await settle();
  assert.equal(worker.status().paused, true);
  assert.equal(storage.state.hermesBrowserSettings.browserControlPaused, true);
  const activeConnection = transport.connections.at(-1);
  const generationAfterSync = (await worker.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.documentReady },
    extensionSender({ tabId: 93 }),
  )).documentGeneration;
  await activeConnection.emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'after-sync-pause-during-resume',
      action: 'browser_scroll',
      arguments: { direction: 'down' },
      tab_id: 93,
      document_generation: generationAfterSync,
    },
  });
  await settle();
  assert.equal(executed.length, 0);
  assert.equal(terminalOf(activeConnection, 'after-sync-pause-during-resume')?.error?.code, 'controller_paused');
});

test('a Pause between Resume lock release and its transition is not overridden by that Resume', async () => {
  const storage = memoryStorage({ hermesBrowserSettings: { ...settings(), browserControlPaused: true } });
  const transport = connector();
  const executed = [];
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async (frame) => {
      executed.push(frame);
      return { ok: true, result: { status: 'done' } };
    },
  });
  await worker.boot();
  const ready = await ownedReady(worker, 88);
  const resumePromise = worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.resume }, extensionSender());
  const pausePromise = worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.pause }, extensionSender());
  await Promise.all([resumePromise, pausePromise]);
  await settle();
  assert.equal(storage.state.hermesBrowserSettings.browserControlPaused, true);
  assert.equal(worker.status().paused, true);
  await transport.connections[0].emit({
    method: 'browser.controller.command',
    params: {
      command_id: 'race-after-resume-transition',
      action: 'browser_scroll',
      arguments: { direction: 'down' },
      tab_id: 88,
      document_generation: ready.documentGeneration,
    },
  });
  await settle();
  assert.equal(executed.length, 0);
  assert.equal(terminalOf(transport.connections[0], 'race-after-resume-transition')?.error?.code, 'controller_paused');
});

test('a stale Resume after a newer Pause finishes does not apply browserControlPaused:false or admit commands', async () => {
  const queue = [];
  let running = false;
  const locks = {
    request(_name, task) {
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        const tryRun = () => {
          if (running || !queue.length) return;
          running = true;
          const { task: next, resolve: res, reject: rej } = queue.shift();
          Promise.resolve(next())
            .then(res, rej)
            .finally(() => {
              running = false;
              tryRun();
            });
        };
        tryRun();
      });
    },
  };
  const prevNav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true });
  let releaseHolder;
  const holderDone = new Promise((r) => { releaseHolder = r; });
  const otherPanelWork = withSavedConnectionsLock(async () => {
    await holderDone;
  });
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const executed = [];
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    executeBrowserCommand: async (frame) => {
      executed.push(frame);
      return { ok: true, result: { status: 'done' } };
    },
  });
  try {
    await worker.boot();
    const ready = await ownedReady(worker, 91);
    await settle();
    const firstResume = worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.resume }, extensionSender());
    await settle();
    const secondPause = worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.pause }, extensionSender());
    await settle();
    releaseHolder();
    await firstResume;
    await secondPause;
    await otherPanelWork;
    assert.equal(storage.state.hermesBrowserSettings.browserControlPaused, true, 'storage stays paused after the second Pause');
    await transport.connections[0].emit({
      method: 'browser.controller.command',
      params: {
        command_id: 'after-stale-resume',
        action: 'browser_scroll',
        arguments: { direction: 'down' },
        tab_id: 91,
        document_generation: ready.documentGeneration,
      },
    });
    await settle();
    assert.equal(executed.length, 0, 'stale Resume must not admit gateway commands while still paused');
    const rejected = terminalOf(transport.connections[0], 'after-stale-resume');
    assert.equal(rejected?.ok, false);
    assert.equal(rejected?.error?.code, 'controller_paused');
  } finally {
    if (prevNav === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', { value: prevNav, configurable: true });
  }
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
