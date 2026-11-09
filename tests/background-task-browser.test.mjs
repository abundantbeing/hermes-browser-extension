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
