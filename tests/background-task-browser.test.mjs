import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_TASK_TABS, BACKGROUND_BROWSER_CONSENT, backgroundBrowserConsentIdentity, createBackgroundTaskBrowser,
} from '../extension/lib/background-task-browser.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';
import { packSavedConnectionStorage, SAVED_CONNECTION_SECRETS_STORAGE_KEY } from '../extension/lib/saved-connections.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('revocation rejects an in-flight controller registration and ignores its commands', async () => {
  const settings = {
    connectionTransport: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', apiKey: 'test-key',
  };
  const consent = await backgroundBrowserConsentIdentity(settings);
  const saved = { hermesBrowserSettings: settings, [BACKGROUND_BROWSER_CONSENT]: consent };
  const started = deferred();
  const handshake = deferred();
  let closed = false;
  const controller = createBackgroundTaskBrowser({
    browserApi: {
      storage: { local: { get: async () => ({ ...saved }) } },
      alarms: { create() {}, clear() {} },
      tabs: {},
    },
    connector: {
      connect({ onFrame }) {
        started.resolve(onFrame);
        return handshake.promise;
      },
    },
  });

  const connecting = controller.sync();
  const onFrame = await started.promise;
  delete saved[BACKGROUND_BROWSER_CONSENT];
  const revoking = controller.settingsChanged({ [BACKGROUND_BROWSER_CONSENT]: { oldValue: consent } });
  let replies = 0;
  handshake.resolve({ close() { closed = true; }, send() { replies += 1; } });
  await Promise.all([connecting, revoking]);
  await onFrame({ method: 'browser.controller.command', params: {
    command_id: 'stale-command', background_session: 'session', action: 'browser_tabs',
  } });
  assert.equal(closed, true);
  assert.equal(replies, 0);
});

test('background tabs hide restricted metadata and lose control on debugger detach', async () => {
  const settings = { connectionTransport: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', apiKey: 'test-key' };
  const started = deferred();
  const opened = { id: 21, windowId: 1, status: 'complete', url: 'https://example.test/' };
  const replies = new Map();
  let receive;
  let executions = 0;
  const controller = createBackgroundTaskBrowser({
    browserApi: {
      storage: { local: { get: async () => ({
        hermesBrowserSettings: settings, [BACKGROUND_BROWSER_CONSENT]: await backgroundBrowserConsentIdentity(settings),
      }) } },
      alarms: { create() {}, clear() {} },
      windows: { getLastFocused: async () => ({ id: 1, type: 'normal' }) },
      tabs: {
        create: async () => opened, group: async () => 2, update: async () => opened, get: async () => opened,
      },
      tabGroups: { update: async () => {} },
    },
    connector: {
      async connect({ onFrame }) {
        receive = onFrame;
        return { send({ params }) { replies.get(params.command_id).resolve(params); } };
      },
    },
    runtime: {
      async execute(_frame, { signal }) {
        executions += 1;
        started.resolve();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        throw signal.reason;
      },
    },
  });
  await controller.sync();
  function command(id, action, args) {
    const reply = deferred();
    replies.set(id, reply);
    receive({ method: 'browser.controller.command', params: {
      command_id: id, background_session: 'session', action, arguments: args,
    } });
    return reply.promise;
  }
  const publicUrl = opened.url;
  opened.url = 'https://example.test/?access_token=private';
  opened.title = 'Private sign-in';
  const created = await command('create', 'browser_tab_create', { url: publicUrl });
  assert.equal(created.ok, true);
  assert.equal(created.result.tab.title, 'Restricted page');
  assert.equal(Object.hasOwn(created.result.tab, 'url'), false);

  opened.url = publicUrl;
  opened.pendingUrl = 'chrome://settings/';
  const listed = await command('list', 'browser_tabs');
  assert.equal(listed.result.tabs[0].title, 'Restricted page');
  assert.equal(Object.hasOwn(listed.result.tabs[0], 'url'), false);
  delete opened.pendingUrl;
  opened.title = 'Public page';
  const ordinary = await command('list-public', 'browser_tabs');
  assert.equal(ordinary.result.tabs[0].title, 'Public page');
  assert.equal(ordinary.result.tabs[0].url, publicUrl);
  const active = command('snapshot', 'browser_snapshot', { tab_id: opened.id });
  await started.promise;
  controller.releaseTab(opened.id);
  assert.equal((await active).error.code, 'cancelled');
  assert.equal((await command('retry', 'browser_snapshot', { tab_id: opened.id })).error.code, 'lease_not_owned');
  assert.equal(executions, 1);
});

test('changing the API key disconnects background control until the new key is authorized', async () => {
  const settings = {
    connectionTransport: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', activeProfile: 'default', apiKey: 'key-a',
  };
  const saved = await packSavedConnectionStorage(settings);
  assert.equal(saved.hermesBrowserSettings.apiKey, '');
  const registrations = [];
  let closed = 0;
  const controller = createBackgroundTaskBrowser({
    browserApi: {
      storage: { local: { get: async () => ({ ...saved }) } },
      alarms: { create() {}, clear() {} },
      tabs: {},
    },
    connector: {
      async connect({ settings }) {
        registrations.push(settings.apiKey);
        return { close() { closed += 1; } };
      },
    },
  });

  saved[BACKGROUND_BROWSER_CONSENT] = JSON.stringify([new URL(settings.gatewayUrl).href, settings.activeProfile]);
  await controller.sync();
  assert.deepEqual(registrations, [], 'legacy consent cannot authorize an unspecified key');
  saved[BACKGROUND_BROWSER_CONSENT] = await backgroundBrowserConsentIdentity(settings);
  assert.equal(saved[BACKGROUND_BROWSER_CONSENT].includes(settings.apiKey), false);
  await controller.sync();

  const updated = { ...settings, apiKey: 'key-b' };
  const previousSecrets = saved[SAVED_CONNECTION_SECRETS_STORAGE_KEY];
  Object.assign(saved, await packSavedConnectionStorage(updated, previousSecrets));
  assert.equal(saved.hermesBrowserSettings.apiKey, '');
  await controller.settingsChanged({
    [SAVED_CONNECTION_SECRETS_STORAGE_KEY]: {
      oldValue: previousSecrets, newValue: saved[SAVED_CONNECTION_SECRETS_STORAGE_KEY],
    },
  });
  assert.equal(closed, 1);
  assert.deepEqual(registrations, ['key-a']);

  saved[BACKGROUND_BROWSER_CONSENT] = await backgroundBrowserConsentIdentity(updated);
  await controller.settingsChanged({ [BACKGROUND_BROWSER_CONSENT]: {} });
  assert.deepEqual(registrations, ['key-a', 'key-b']);
});

test('unrelated settings save keeps background task tab leases when consent identity is unchanged', async () => {
  const settings = {
    connectionTransport: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', activeProfile: 'default',
    apiKey: 'stable-key', botModeDisplayDensity: 'comfortable',
  };
  const saved = {
    hermesBrowserSettings: settings,
    [BACKGROUND_BROWSER_CONSENT]: await backgroundBrowserConsentIdentity(settings),
    [SAVED_CONNECTION_SECRETS_STORAGE_KEY]: { default: { apiKey: 'encrypted-stable-key' } },
  };
  const opened = { id: 42, windowId: 1, status: 'complete', url: 'https://example.test/task', title: 'Task' };
  const replies = new Map();
  let receive;
  let released = 0;
  const controller = createBackgroundTaskBrowser({
    browserApi: {
      storage: { local: { get: async () => structuredClone(saved) } },
      alarms: { create() {}, clear() {} },
      windows: { getLastFocused: async () => ({ id: 1, type: 'normal' }) },
      tabs: {
        create: async () => opened, group: async () => 7, update: async () => opened, get: async () => opened,
      },
      tabGroups: { update: async () => {} },
    },
    connector: {
      async connect({ onFrame }) {
        receive = onFrame;
        return { close() {}, heartbeat: async () => {}, send({ params }) { replies.get(params.command_id).resolve(params); } };
      },
    },
    runtime: {
      async execute() {
        return { ok: true, result: { snapshot: true } };
      },
      releaseTab() {
        released += 1;
      },
    },
  });
  await controller.sync();
  function command(id, action, args) {
    const reply = deferred();
    replies.set(id, reply);
    receive({ method: 'browser.controller.command', params: {
      command_id: id, background_session: 'bg-session', action, arguments: args,
    } });
    return reply.promise;
  }
  const created = await command('open', 'browser_tab_create', { url: opened.url });
  assert.equal(created.ok, true);

  const updatedSettings = { ...settings, botModeDisplayDensity: 'compact' };
  saved.hermesBrowserSettings = updatedSettings;
  saved[SAVED_CONNECTION_SECRETS_STORAGE_KEY] = {
    default: { apiKey: 're-encrypted-stable-key' },
  };
  await controller.settingsChanged({
    hermesBrowserSettings: { oldValue: settings, newValue: updatedSettings },
    [SAVED_CONNECTION_SECRETS_STORAGE_KEY]: {
      oldValue: { default: { apiKey: 'encrypted-stable-key' } },
      newValue: saved[SAVED_CONNECTION_SECRETS_STORAGE_KEY],
    },
  });
  await controller.sync();
  const snapshot = await command('snapshot', 'browser_snapshot', { tab_id: opened.id });
  assert.equal(snapshot.ok, true);
  assert.equal(released, 0);
});

test('background consent identity change releases task tab leases', async () => {
  const settings = {
    connectionTransport: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', activeProfile: 'default', apiKey: 'key-one',
  };
  const saved = {
    hermesBrowserSettings: settings,
    [BACKGROUND_BROWSER_CONSENT]: await backgroundBrowserConsentIdentity(settings),
  };
  const opened = { id: 11, windowId: 1, status: 'complete', url: 'https://example.test/', title: 'Task' };
  const replies = new Map();
  let receive;
  let released = 0;
  const controller = createBackgroundTaskBrowser({
    browserApi: {
      storage: { local: { get: async () => structuredClone(saved) } },
      alarms: { create() {}, clear() {} },
      windows: { getLastFocused: async () => ({ id: 1, type: 'normal' }) },
      tabs: {
        create: async () => opened, group: async () => 4, update: async () => opened, get: async () => opened,
      },
      tabGroups: { update: async () => {} },
    },
    connector: {
      async connect({ onFrame }) {
        receive = onFrame;
        return { close() {}, send({ params }) { replies.get(params.command_id).resolve(params); } };
      },
    },
    runtime: {
      async execute() {
        return { ok: true, result: {} };
      },
      releaseTab() {
        released += 1;
      },
    },
  });
  await controller.sync();
  function command(id, action, args) {
    const reply = deferred();
    replies.set(id, reply);
    receive({ method: 'browser.controller.command', params: {
      command_id: id, background_session: 'bg-session', action, arguments: args,
    } });
    return reply.promise;
  }
  const created = await command('open', 'browser_tab_create', { url: opened.url });
  assert.equal(created.ok, true);

  const updated = { ...settings, apiKey: 'key-two' };
  saved.hermesBrowserSettings = updated;
  saved[BACKGROUND_BROWSER_CONSENT] = await backgroundBrowserConsentIdentity(updated);
  await controller.settingsChanged({ hermesBrowserSettings: { oldValue: settings, newValue: updated } });
  await controller.sync();
  const snapshot = await command('snapshot', 'browser_snapshot', { tab_id: opened.id });
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.error.code, 'lease_not_owned');
  assert.equal(released, 1);
});

test('active task tabs are opt-in and do not change the background default', async () => {
  const settings = { connectionTransport: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', apiKey: 'test-key' };
  const consent = await backgroundBrowserConsentIdentity(settings);
  const opened = { id: 21, windowId: 4, status: 'complete', url: 'https://example.test/', title: 'Example', active: false };
  const created = [];
  const focused = [];
  const replies = new Map();
  let receive;
  let capabilities;
  const saved = {
    hermesBrowserSettings: settings,
    [BACKGROUND_BROWSER_CONSENT]: consent,
  };
  const controller = createBackgroundTaskBrowser({
    browserApi: {
      storage: { local: { get: async () => ({ ...saved }) } },
      alarms: { create() {}, clear() {} },
      windows: {
        getLastFocused: async () => ({ id: 4, type: 'normal' }),
        get: async () => ({ id: 4, type: 'normal' }),
        update: async (id, patch) => { focused.push([id, patch]); },
      },
      tabs: {
        create: async (options) => { created.push(options); return opened; },
        query: async () => [],
        group: async () => 2,
        update: async (id, patch) => {
          created.push(['update', id, patch]);
          if (patch.active === true) opened.active = true;
          return { ...opened, ...patch };
        },
        get: async () => ({ ...opened }),
      },
      tabGroups: { update: async () => {} },
    },
    connector: {
      async connect({ identity, onFrame }) {
        capabilities = identity.capabilities;
        receive = onFrame;
        return { close() {}, send({ params }) { replies.get(params.command_id).resolve(params); } };
      },
    },
    runtime: {
      calls: [],
      async execute(frame, context) {
        this.calls.push({ action: frame.action, backgroundTask: context.backgroundTask === true, tabId: frame.tab_id });
        return { ok: true, result: { status: 'tab-activated' } };
      },
      releaseTab() {},
    },
  });
  function command(id, action, args) {
    const reply = deferred();
    replies.set(id, reply);
    receive({ method: 'browser.controller.command', params: {
      command_id: id, background_session: 'session', action, arguments: args,
    } });
    return reply.promise;
  }

  await controller.sync();
  assert.equal(capabilities.includes('browser_tab_activate'), false);
  const backgroundOpen = await command('bg-open', 'browser_tab_create', { url: opened.url });
  assert.equal(backgroundOpen.ok, true);
  assert.equal(created[0].active, false);
  const refused = await command('bg-activate', 'browser_tab_activate', { tab_id: opened.id });
  assert.equal(refused.error.code, 'background_action_unavailable');

  saved.hermesActiveTaskTabs = true;
  await controller.settingsChanged({ hermesActiveTaskTabs: { oldValue: undefined, newValue: true } });
  assert.equal(capabilities.includes('browser_tab_activate'), true);
  created.length = 0;
  focused.length = 0;
  const activeOpen = await command('active-open', 'browser_tab_create', { url: opened.url });
  assert.equal(activeOpen.ok, true);
  assert.equal(created[0].active, false, 'a new tab stays in the background until the switch is approved');
  focused.length = 0;
  created.length = 0;
  opened.active = false;
  const activated = await command('active-switch', 'browser_tab_activate', { tab_id: opened.id });
  assert.equal(activated.ok, true);
  assert.equal(activated.result.status, 'tab-activated');
  assert.equal(activated.result.tab.active, true);
  assert.deepEqual(
    created.filter((entry) => Array.isArray(entry) && entry[2]?.active === true).at(-1),
    ['update', opened.id, { active: true }],
  );
  assert.deepEqual(focused.at(-1), [4, { focused: true }]);
});


function approvalRuntime() {
  const approvals = createBrowserControlApprovalStore();
  return {
    approvals,
    calls: [],
    async execute(frame, context, settings) {
      this.calls.push({
        action: frame.action,
        backgroundTask: context.backgroundTask === true,
        tabId: frame.tab_id,
        commandId: frame.command_id,
        enabled: settings?.browserControlEnabled === true,
      });
      if (settings?.browserControlEnabled !== true) {
        return { ok: false, error: { code: 'action_disabled', message: 'Browser control is not enabled with the required permission.' } };
      }
      if (frame.action === 'browser_tab_activate' && context.backgroundTask !== true) {
        const approval = {
          approvalId: frame.command_id,
          approvalNonce: frame.command_id,
          commandId: frame.command_id,
          controllerId: context.scope.controllerId,
          leaseId: context.scope.leaseId,
          leaseGeneration: context.scope.leaseGeneration,
          tabId: context.scope.tabId,
          frameId: 0,
          documentGeneration: context.currentDocumentGeneration?.() || context.scope.documentGeneration,
          action: frame.action,
          state: 'paused',
        };
        const requested = await approvals.request({ ...approval, reason: 'Switch to this tab?' });
        if (!requested?.ok) {
          return { ok: false, error: { code: requested?.error || 'approval_cancelled', message: 'The approval request was cancelled.' } };
        }
        const consumed = approvals.consume(approval);
        if (!consumed.ok) return { ok: false, error: { code: 'approval_required', message: 'This action requires approval.' } };
        return { ok: true, result: { status: 'tab-activated' } };
      }
      return { ok: true, result: { status: 'ok' } };
    },
    releaseTab() {},
  };
}

async function waitForPending(approvals, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [request] = approvals.pending();
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for a pending approval');
}

function grantMessage(request) {
  return {
    type: 'HERMES_CONTROLLER_APPROVAL_GRANT',
    approvalId: request.approvalId,
    approvalNonce: request.approvalNonce,
    commandId: request.commandId,
    controllerId: request.controllerId,
    leaseId: request.leaseId,
    leaseGeneration: request.leaseGeneration,
    action: request.action,
    tabId: request.tabId,
    frameId: request.frameId ?? 0,
    documentGeneration: request.documentGeneration,
    state: request.state,
  };
}

test('active task tab switches are approved through the task controller, not a stubbed execute', async () => {
  const settings = { connectionTransport: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', apiKey: 'test-key' };
  const consent = await backgroundBrowserConsentIdentity(settings);
  const opened = { id: 21, windowId: 4, status: 'complete', url: 'https://example.test/', title: 'Example', active: false };
  const created = [];
  const focused = [];
  const replies = new Map();
  let receive;
  const runtime = approvalRuntime();
  const saved = {
    hermesBrowserSettings: settings,
    [BACKGROUND_BROWSER_CONSENT]: consent,
    [ACTIVE_TASK_TABS]: true,
  };
  const controller = createBackgroundTaskBrowser({
    browserApi: {
      storage: { local: { get: async () => ({ ...saved }) } },
      alarms: { create() {}, clear() {} },
      windows: {
        getLastFocused: async () => ({ id: 4, type: 'normal' }),
        get: async () => ({ id: 4, type: 'normal' }),
        update: async (id, patch) => { focused.push([id, patch]); },
      },
      tabs: {
        create: async (options) => { created.push(options); return { ...opened }; },
        query: async () => [],
        group: async () => 2,
        update: async (id, patch) => {
          created.push(['update', id, patch]);
          if (patch.active === true) opened.active = true;
          return { ...opened, ...patch };
        },
        get: async () => ({ ...opened }),
      },
      tabGroups: { update: async () => {} },
    },
    connector: {
      async connect({ onFrame }) {
        receive = onFrame;
        return { close() {}, send({ params }) { replies.get(params.command_id).resolve(params); } };
      },
    },
    runtime,
  });
  function command(id, action, args) {
    const reply = deferred();
    replies.set(id, reply);
    receive({ method: 'browser.controller.command', params: {
      command_id: id, background_session: 'session', action, arguments: args,
    } });
    return reply.promise;
  }

  await controller.sync();
  const opening = command('active-open', 'browser_tab_create', { url: opened.url });
  const request = await waitForPending(runtime.approvals);
  assert.equal(request.action, 'browser_tab_activate');
  assert.equal(request.commandId, 'active-open:switch');
  assert.equal(
    controller.handleApproval({ ...grantMessage(request), approvalId: 'someone-else' }),
    null,
    'a grant for another controller is left alone',
  );
  const granted = controller.handleApproval(grantMessage(request));
  assert.equal(granted.ok, true);
  const createdTab = await opening;
  assert.equal(createdTab.ok, true);
  assert.equal(createdTab.result.tab.active, true);
  assert.equal(createdTab.result.focus_error, undefined);
  assert.deepEqual(focused.at(-1), [4, { focused: true }]);

  opened.active = false;
  focused.length = 0;
  const switching = command('active-switch', 'browser_tab_activate', { tab_id: opened.id });
  const switchRequest = await waitForPending(runtime.approvals);
  assert.equal(switchRequest.commandId, 'active-switch:switch');
  assert.equal(controller.handleApproval(grantMessage(switchRequest)).ok, true);
  const activated = await switching;
  assert.equal(activated.ok, true);
  assert.equal(activated.result.status, 'tab-activated');
  assert.equal(activated.result.tab.active, true);
  assert.deepEqual(focused.at(-1), [4, { focused: true }]);
});

test('a denied focus approval still returns the created task tab', async () => {
  const settings = { connectionTransport: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', apiKey: 'test-key' };
  const consent = await backgroundBrowserConsentIdentity(settings);
  const opened = { id: 21, windowId: 4, status: 'complete', url: 'https://example.test/', title: 'Example', active: false };
  const replies = new Map();
  let receive;
  const runtime = approvalRuntime();
  const saved = {
    hermesBrowserSettings: settings,
    [BACKGROUND_BROWSER_CONSENT]: consent,
    [ACTIVE_TASK_TABS]: true,
  };
  const controller = createBackgroundTaskBrowser({
    browserApi: {
      storage: { local: { get: async () => ({ ...saved }) } },
      alarms: { create() {}, clear() {} },
      windows: {
        getLastFocused: async () => ({ id: 4, type: 'normal' }),
        get: async () => ({ id: 4, type: 'normal' }),
        update: async () => {},
      },
      tabs: {
        create: async () => ({ ...opened }),
        query: async () => [],
        group: async () => 2,
        update: async (id, patch) => ({ ...opened, ...patch }),
        get: async () => ({ ...opened }),
        remove: async () => { throw new Error('the created tab must not be removed when focus is denied'); },
      },
      tabGroups: { update: async () => {} },
    },
    connector: {
      async connect({ onFrame }) {
        receive = onFrame;
        return { close() {}, send({ params }) { replies.get(params.command_id).resolve(params); } };
      },
    },
    runtime,
  });
  await controller.sync();
  const opening = (() => {
    const reply = deferred();
    replies.set('active-open', reply);
    receive({ method: 'browser.controller.command', params: {
      command_id: 'active-open', background_session: 'session', action: 'browser_tab_create', arguments: { url: opened.url },
    } });
    return reply.promise;
  })();
  const request = await waitForPending(runtime.approvals);
  const rejected = controller.handleApproval({
    ...grantMessage(request),
    type: 'HERMES_CONTROLLER_APPROVAL_REJECT',
  });
  assert.equal(rejected.ok, true);
  const createdTab = await opening;
  assert.equal(createdTab.ok, true);
  assert.equal(createdTab.result.tab.id, opened.id);
  assert.equal(createdTab.result.focus_error.code, 'approval_denied');
  const listed = await (() => {
    const reply = deferred();
    replies.set('list', reply);
    receive({ method: 'browser.controller.command', params: {
      command_id: 'list', background_session: 'session', action: 'browser_tabs', arguments: {},
    } });
    return reply.promise;
  })();
  assert.equal(listed.ok, true);
  assert.equal(listed.result.tabs[0].id, opened.id);
});

test('background-only page actions in the same window do not wait on the focus lock', async () => {
  const settings = { connectionTransport: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', apiKey: 'test-key' };
  const consent = await backgroundBrowserConsentIdentity(settings);
  const tabs = {
    a: { id: 21, windowId: 4, status: 'complete', url: 'https://a.test/', title: 'A', active: false },
    b: { id: 22, windowId: 4, status: 'complete', url: 'https://b.test/', title: 'B', active: false },
  };
  const replies = new Map();
  let receive;
  let running = 0;
  let maxRunning = 0;
  const gates = [];
  const saved = {
    hermesBrowserSettings: settings,
    [BACKGROUND_BROWSER_CONSENT]: consent,
  };
  let createdTabs = 0;
  const controller = createBackgroundTaskBrowser({
    browserApi: {
      storage: { local: { get: async () => ({ ...saved }) } },
      alarms: { create() {}, clear() {} },
      windows: {
        getLastFocused: async () => ({ id: 4, type: 'normal' }),
        get: async () => ({ id: 4, type: 'normal' }),
      },
      tabs: {
        create: async () => {
          createdTabs += 1;
          return createdTabs === 1 ? { ...tabs.a } : { ...tabs.b };
        },
        query: async () => [],
        group: async () => 2,
        update: async (id, patch) => (id === tabs.b.id ? { ...tabs.b, ...patch } : { ...tabs.a, ...patch }),
        get: async (id) => (id === tabs.b.id ? { ...tabs.b } : { ...tabs.a }),
      },
      tabGroups: { update: async () => {} },
    },
    connector: {
      async connect({ onFrame }) {
        receive = onFrame;
        return { close() {}, send({ params }) { replies.get(params.command_id).resolve(params); } };
      },
    },
    runtime: {
      async execute() {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => { gates.push(resolve); });
        running -= 1;
        return { ok: true, result: { status: 'ok' } };
      },
      releaseTab() {},
    },
  });
  function command(id, action, args, session) {
    const reply = deferred();
    replies.set(id, reply);
    receive({ method: 'browser.controller.command', params: {
      command_id: id, background_session: session, action, arguments: args,
    } });
    return reply.promise;
  }
  await controller.sync();
  assert.equal((await command('open-a', 'browser_tab_create', { url: tabs.a.url }, 'session-a')).ok, true);
  assert.equal((await command('open-b', 'browser_tab_create', { url: tabs.b.url }, 'session-b')).ok, true);
  const first = command('snap-a', 'browser_snapshot', { tab_id: tabs.a.id }, 'session-a');
  const second = command('snap-b', 'browser_snapshot', { tab_id: tabs.b.id }, 'session-b');
  const deadline = Date.now() + 1000;
  while (maxRunning < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(maxRunning, 2, 'two background snapshots in the same window run at the same time');
  gates.forEach((release) => release());
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
});
