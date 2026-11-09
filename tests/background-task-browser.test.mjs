import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKGROUND_BROWSER_CONSENT, backgroundBrowserGateway, createBackgroundTaskBrowser,
} from '../extension/lib/background-task-browser.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('revocation rejects an in-flight controller registration and ignores its commands', async () => {
  const settings = {
    connectionTransport: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', apiKey: 'test-key',
  };
  const consent = backgroundBrowserGateway(settings);
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

test('an external debugger detach aborts the active command and revokes the tab', async () => {
  const settings = { connectionTransport: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', apiKey: 'test-key' };
  const started = deferred();
  const opened = { id: 21, windowId: 1, status: 'complete', url: 'https://example.test/' };
  const replies = new Map();
  let receive;
  let executions = 0;
  const controller = createBackgroundTaskBrowser({
    browserApi: {
      storage: { local: { get: async () => ({
        hermesBrowserSettings: settings, [BACKGROUND_BROWSER_CONSENT]: backgroundBrowserGateway(settings),
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
  assert.equal((await command('create', 'browser_tab_create', { url: opened.url })).ok, true);
  const active = command('snapshot', 'browser_snapshot', { tab_id: opened.id });
  await started.promise;
  controller.releaseTab(opened.id);
  assert.equal((await active).error.code, 'cancelled');
  assert.equal((await command('retry', 'browser_snapshot', { tab_id: opened.id })).error.code, 'lease_not_owned');
  assert.equal(executions, 1);
});
