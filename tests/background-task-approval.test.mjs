import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import {
  BACKGROUND_BROWSER_CONSENT,
  backgroundBrowserConsentIdentity,
  createBackgroundTaskBrowser,
} from '../extension/lib/background-task-browser.mjs';
import {
  classifyBrowserControlAction,
  createBrowserControlApprovalStore,
} from '../extension/lib/browser-control-safety.mjs';
import { createBackgroundApprovalSurface } from '../extension/lib/background-approval-surface.mjs';
import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import {
  CONTROLLER_WORKER_MESSAGES,
  createControllerServiceWorker,
} from '../extension/lib/controller-service-worker.mjs';

const TRUSTED = Object.freeze({ url: 'chrome-extension://fixture/sidepanel.html' });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    area: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => Object.hasOwn(data, key)).map((key) => [key, structuredClone(data[key])]));
      },
      async set(values) { Object.assign(data, structuredClone(values)); },
    },
  };
}

function waitFor(fn, turns = 30) {
  return (async () => {
    for (let i = 0; i < turns; i += 1) {
      const value = fn();
      if (value) return value;
      await nextTurn();
    }
    return fn();
  })();
}

test('Drive Download and any other site use the same page-changing classifier, with no site branch', () => {
  const driveDownload = classifyBrowserControlAction({
    action: 'browser_click',
    currentUrl: 'https://drive.google.com/drive/u/0/home',
    target: { role: 'button', name: 'Download' },
  });
  assert.equal(driveDownload.risk, 'approval-required');
  assert.equal(driveDownload.reason, 'consequential-action');

  const exampleDownload = classifyBrowserControlAction({
    action: 'browser_click',
    currentUrl: 'https://example.test/files',
    target: { role: 'button', name: 'Download' },
  });
  assert.equal(exampleDownload.reason, 'consequential-action');

  const continuar = classifyBrowserControlAction({
    action: 'browser_click',
    currentUrl: 'https://example.test/files',
    target: { role: 'button', name: 'Continuar' },
  });
  assert.equal(continuar.reason, 'page-changing-action');
});

test('the approval store keeps translation keys so the existing card can use all 21 locales', async () => {
  const approvals = createBrowserControlApprovalStore();
  const pending = approvals.request({
    approvalId: 'a1',
    approvalNonce: 'n1',
    commandId: 'c1',
    controllerId: 'background-test',
    leaseId: 'lease',
    leaseGeneration: 1,
    action: 'browser_click',
    tabId: 7,
    frameId: 0,
    documentGeneration: 1,
    state: 'paused',
    reason: 'Click "Continue"? It may change the page.',
    reasonKey: 'browser_control.approval.click',
    reasonParams: { name: 'Continue' },
    stepNumber: 2,
    stepTotal: 3,
  });
  const [request] = approvals.pending();
  assert.equal(request.reasonKey, 'browser_control.approval.click');
  assert.deepEqual(request.reasonParams, { name: 'Continue' });
  assert.equal(request.stepNumber, 2);
  assert.equal(request.stepTotal, 3);
  approvals.cancelRequest('a1', 'approval_denied');
  assert.equal((await pending).error, 'approval_denied');
});

test('a background password field stays blocked without an approval card', async () => {
  const approvals = createBrowserControlApprovalStore();
  const refs = createBrowserControlRefStore();
  const scope = {
    controllerId: 'background-test', leaseOwnerId: 'background-test', leaseId: 'lease',
    leaseGeneration: 1, tabId: 7, frameId: 0, documentGeneration: 1,
  };
  refs.replace({ ...scope, nodes: [{ role: 'textbox', name: 'Password', inputType: 'password', backendDOMNodeId: 13 }] });
  let typed = 0;
  const executor = createBrowserControlExecutor({
    adapter: {
      contract: { enabled: true, actions: ['browser_type'] },
      inspect: async () => ({ currentUrl: 'https://example.test/login' }),
      execute: async () => { typed += 1; return { ok: true }; },
    },
    refs,
    approvals,
  });
  const result = await executor.execute({
    command_id: 'cmd-password', action: 'browser_type',
    arguments: { ref: '@e1', text: 'secret' },
    tab_id: 7, frame_id: 0, document_generation: 1,
  }, { scope, backgroundTask: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'sensitive_action_blocked');
  assert.equal(typed, 0);
  assert.equal(approvals.pending().length, 0);
});

async function backgroundHarness() {
  const settings = { connectionTransport: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', apiKey: 'test-key' };
  const tabsById = new Map();
  let nextTabId = 21;
  const tabAt = (id, url = 'https://example.test/files') => {
    const tab = { id, windowId: 1, status: 'complete', url, title: 'Files', incognito: false };
    tabsById.set(id, tab);
    return tab;
  };
  const replies = new Map();
  let receive;
  let clicks = 0;
  const notifications = [];
  const windowsOpened = [];
  const windowsClosed = [];
  const badge = [];
  const approvals = createBrowserControlApprovalStore();
  const refs = createBrowserControlRefStore();
  const adapter = {
    contract: { enabled: true, actions: ['browser_click', 'browser_snapshot'] },
    inspect: async () => ({ currentUrl: 'https://example.test/files' }),
    execute: async (action) => (action === 'browser_snapshot' ? { nodes: [], url: 'https://example.test/files' } : { clicks: ++clicks }),
  };
  const executor = createBrowserControlExecutor({ adapter, refs, approvals });
  const runtime = {
    approvals,
    execute(frame, context, runSettings) {
      if (context?.scope && frame?.action === 'browser_click') {
        refs.replace({
          ...context.scope,
          nodes: [{ role: 'button', name: 'Continue', backendDOMNodeId: 12 }],
        });
      }
      return executor.execute(frame, context, runSettings);
    },
    releaseTab: async () => {},
  };
  const browser = createBackgroundTaskBrowser({
    browserApi: {
      runtime: {
        getURL: (path) => `chrome-extension://fixture/${path}`,
        // No side panel is open: nothing receives the runtime broadcast.
        sendMessage: (message) => { notifications.push(message); return Promise.reject(new Error('Receiving end does not exist.')); },
      },
      storage: { local: { get: async () => ({
        hermesBrowserSettings: settings, [BACKGROUND_BROWSER_CONSENT]: await backgroundBrowserConsentIdentity(settings),
      }) } },
      alarms: { create() {}, clear() {} },
      windows: { getLastFocused: async () => ({ id: 1, type: 'normal' }), get: async () => ({ id: 1, type: 'normal' }) },
      tabs: {
        create: async () => { const id = nextTabId; nextTabId += 1; return { ...tabAt(id, 'about:blank') }; },
        group: async () => 2,
        update: async (id, patch = {}) => {
          const current = tabsById.get(id) || tabAt(id);
          const next = { ...current, ...patch, id, windowId: 1, status: 'complete', incognito: false };
          if (!next.url || next.url === 'about:blank') next.url = 'https://example.test/files';
          tabsById.set(id, next);
          return next;
        },
        get: async (id) => tabsById.get(id) || tabAt(id),
        query: async () => [...tabsById.values()],
        remove: async (id) => { tabsById.delete(id); },
      },
      tabGroups: { update: async () => {} },
    },
    connector: {
      async connect({ onFrame }) {
        receive = onFrame;
        return { send({ params }) { replies.get(params.command_id)?.resolve(params); } };
      },
    },
    runtime,
    product: { engine: 'chromium', id: 'chrome', label: 'Chrome' },
    approvalSurface: createBackgroundApprovalSurface({
      browserApi: {
        runtime: { getURL: (path) => `chrome-extension://fixture/${path}` },
        windows: {
          create: async (options) => { const id = 700 + windowsOpened.length; windowsOpened.push({ id, ...options }); return { id }; },
          remove: async (id) => { windowsClosed.push(id); },
        },
        action: { setBadgeText: async ({ text }) => { badge.push(text); } },
      },
      translate: (key) => key,
      visibleGraceMs: 0,
    }),
  });
  const worker = createControllerServiceWorker({
    storageArea: memoryStorage({
      hermesBrowserSettings: {
        connectionTransport: 'local-api',
        gatewayMode: 'local-api',
        gatewayUrl: 'http://127.0.0.1:8642',
        apiKey: 'fixture-key',
        sessionId: 'approval-session',
        browserControlEnabled: true,
        browserControlPaused: true,
      },
    }).area,
    connector: { async connect() { return { sent: [], async send() {}, async heartbeat() {}, close() {} }; } },
    product: { id: 'chrome', engine: 'chromium', label: 'Chrome' },
    randomUUID: (() => { const values = ['controller-manual', 'profile-manual']; return () => values.shift(); })(),
    extensionOrigin: 'chrome-extension://fixture',
    approvalStore: approvals,
    decideBackgroundApproval: (message, approved) => browser.decideBackgroundApproval(message, approved),
    executeBrowserCommand: async () => ({ ok: true }),
  });
  await worker.boot();
  assert.equal(worker.status().paused, true, 'manual Control is paused');
  await browser.sync();

  function sessionCommand(sessionId, id, action, args) {
    const reply = deferred();
    replies.set(id, reply);
    receive({ method: 'browser.controller.command', params: {
      command_id: id, background_session: sessionId, action, arguments: args,
    } });
    return reply.promise;
  }
  function cancel(id) {
    receive({ method: 'browser.controller.cancel', params: { command_id: id } });
  }
  return {
    approvals, worker, browser, notifications, windowsOpened, windowsClosed, badge, sessionCommand, cancel,
    clicks: () => clicks,
  };
}

test('a background click waits on the card, runs only after handleMessage grant, and stays blocked when rejected', async () => {
  const { approvals, worker, notifications, windowsOpened, windowsClosed, badge, sessionCommand, clicks: clickCount } = await backgroundHarness();
  const createdA = await sessionCommand('session-a', 'create-a', 'browser_tab_create', { url: 'https://example.test/files' });
  const createdB = await sessionCommand('session-b', 'create-b', 'browser_tab_create', { url: 'https://example.test/other' });
  assert.equal(createdA.ok, true, 'tab_create on the background path still does not wait for approval');
  assert.equal(createdB.ok, true);
  const tabA = createdA.result.tab.id;
  const tabB = createdB.result.tab.id;

  const firstClick = sessionCommand('session-a', 'click-continue', 'browser_click', { ref: '@e1', tab_id: tabA });
  const secondClick = sessionCommand('session-b', 'click-later', 'browser_click', { ref: '@e1', tab_id: tabB });
  await waitFor(() => approvals.pending().length >= 2);
  const queued = approvals.pending();
  assert.equal(queued.length, 2, 'concurrent background approvals from different sessions stay queued');
  assert.match(queued[0].controllerId, /^background-/);
  assert.equal(queued[0].action, 'browser_click');
  assert.equal(queued[0].reasonKey, 'browser_control.approval.click');
  assert.equal(clickCount(), 0);
  assert.equal(notifications.some((message) => message?.type === 'HERMES_BACKGROUND_APPROVAL_CHANGED'), true);

  const grant = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.approvalGrant,
    ...queued[0],
  }, TRUSTED);
  assert.equal(grant.ok, true, 'grant must work while manual Control is paused');
  const granted = queued[0].tabId === tabA ? firstClick : secondClick;
  const remainingClick = queued[0].tabId === tabA ? secondClick : firstClick;
  assert.equal((await granted).ok, true);
  assert.equal(clickCount(), 1);
  const remaining = approvals.pending();
  assert.equal(remaining.length, 1, 'approving the first request must not strand the next');
  const stale = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.approvalGrant,
    ...remaining[0],
    approvalNonce: 'wrong-nonce',
  }, TRUSTED);
  assert.equal(stale.ok, false);
  const reject = await worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.approvalReject,
    ...remaining[0],
  }, TRUSTED);
  assert.equal(reject.ok, true);
  const denied = await remainingClick;
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'approval_denied');
  assert.equal(clickCount(), 1);
  // With no side panel open, each request got its own focused approval window, closed once decided.
  assert.deepEqual(windowsOpened.map((item) => new URL(item.url).searchParams.get('approval')).sort(),
    queued.map((item) => item.approvalId).sort());
  assert.ok(windowsOpened.every((item) => item.focused === true && item.type === 'popup'));
  await waitFor(() => windowsClosed.length === 2);
  assert.deepEqual([...windowsClosed].sort(), windowsOpened.map((item) => item.id).sort());
  assert.equal(badge.at(-1), '', 'the toolbar signal clears when nothing is waiting');
});

test('the approval window reads its own request, and a cancelled command can no longer be approved through handleMessage', async () => {
  const { approvals, worker, browser, windowsOpened, windowsClosed, sessionCommand, cancel, clicks } = await backgroundHarness();
  const created = await sessionCommand('session-c', 'create-c', 'browser_tab_create', { url: 'https://example.test/files' });
  const tabId = created.result.tab.id;
  const click = sessionCommand('session-c', 'click-cancelled', 'browser_click', { ref: '@e1', tab_id: tabId });
  await waitFor(() => approvals.pending().length === 1);
  const [request] = approvals.pending();
  await waitFor(() => windowsOpened.length === 1);
  const approvalId = new URL(windowsOpened[0].url).searchParams.get('approval');
  assert.equal(approvalId, request.approvalId);
  assert.deepEqual(browser.backgroundApproval(approvalId), request, 'the window loads the same request the panel would show');
  assert.equal(browser.backgroundApproval('someone-else'), null);

  cancel('click-cancelled');
  const outcome = await click;
  assert.equal(outcome.ok, false);
  const late = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.approvalGrant, ...request }, TRUSTED);
  assert.equal(late.ok, false, 'a cancelled command cannot be approved afterwards');
  assert.equal(clicks(), 0);
  assert.equal(approvals.pending().length, 0);
  await waitFor(() => windowsClosed.length === 1);
  assert.deepEqual(windowsClosed, [windowsOpened[0].id], 'the cancelled request closes its window');
});
