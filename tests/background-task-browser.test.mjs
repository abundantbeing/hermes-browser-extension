import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKGROUND_BROWSER_CONSENT, backgroundBrowserConsentIdentity, createBackgroundTaskBrowser,
} from '../extension/lib/background-task-browser.mjs';
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
