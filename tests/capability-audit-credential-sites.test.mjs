import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { createWakeBackgroundController } from '../extension/lib/wake-background.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const CREDENTIAL = 'C'.repeat(43);

function chromeWith(settings) {
  const values = { hermesBrowserSettings: settings };
  return {
    runtime: {
      getManifest: () => ({ version: '0.4.0' }),
      getURL: (path) => `chrome-extension://test/${path}`,
      getContexts: async () => [],
      sendMessage: async () => ({ ok: true }),
    },
    storage: {
      local: {
        get: async (key) => (typeof key === 'string' ? { [key]: values[key] } : { ...values }),
        set: async (patch) => Object.assign(values, patch),
        remove: async () => {},
      },
    },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
    tabs: { query: async () => [] },
    scripting: { executeScript: async () => [] },
  };
}

async function settle(controller, state) {
  for (let attempt = 0; attempt < 60 && controller.state().state !== state; attempt += 1) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 2));
  }
  return controller.state();
}

test('native wake dials the Webapp with a one-use ticket when only the held sign-in works, never the sign-in itself', async () => {
  const dialed = [];
  const minted = [];
  const controller = createWakeBackgroundController({
    chromeApi: chromeWith({ connectionMode: 'local', connectionTransport: 'local-api', gatewayMode: 'local-api' }),
    // 9119 is gone (the Webapp took the dashboard's place) and nothing can mint a ticket there.
    fetchFn: async () => { throw new Error('connection refused'); },
    webappCredentials: {
      held: async () => ({ origin: 'http://127.0.0.1:9120', basePath: '', token: CREDENTIAL }),
      mintSocketTicket: async (target, options) => {
        minted.push({ target, options });
        return { ok: true, ticket: 'ticket-abc', ttlSeconds: 30 };
      },
    },
    gatewayClientFactory: () => ({
      on: () => () => {},
      connect: async (url) => { dialed.push(url); throw new Error('offline for this test'); },
      request: async () => ({}),
      close: () => {},
    }),
    openPanel: async () => {},
  });
  await controller.configure({ wakeWordEnabled: true, wakeWordPreferNative: true, wakeWordBrowserFallback: false, wakeWordPhrase: 'hey hermes' });
  await settle(controller, 'unavailable');
  assert.equal(minted.length, 1);
  assert.equal(minted[0].target.origin, 'http://127.0.0.1:9120');
  assert.equal(dialed.length, 1);
  assert.equal(dialed[0], 'ws://127.0.0.1:9120/api/ws?ticket=ticket-abc');
  assert.ok(!dialed[0].includes(CREDENTIAL), 'the sign-in is never put in a URL');
});

test('without a held sign-in the wake path reports the dashboard as unavailable and dials nothing', async () => {
  const dialed = [];
  const controller = createWakeBackgroundController({
    chromeApi: chromeWith({ connectionMode: 'local', connectionTransport: 'local-api', gatewayMode: 'local-api' }),
    fetchFn: async () => { throw new Error('connection refused'); },
    webappCredentials: { held: async () => null, mintSocketTicket: async () => { throw new Error('must not mint'); } },
    gatewayClientFactory: () => ({ on: () => () => {}, connect: async (url) => { dialed.push(url); }, request: async () => ({}), close: () => {} }),
    openPanel: async () => {},
  });
  await controller.configure({ wakeWordEnabled: true, wakeWordPreferNative: true, wakeWordBrowserFallback: false, wakeWordPhrase: 'hey hermes' });
  await settle(controller, 'unavailable');
  assert.deepEqual(dialed, []);
});

test('the dictation page passes the held credential to the dashboard speech calls and the probe', () => {
  const source = read('extension/voice-dictation.js');
  assert.match(source, /createWebappCredentialStore/);
  assert.match(source, /storageSession: browserApi\?\.storage\?\.session/);
  assert.match(source, /transcribeAudioViaDashboard\(\{[^}]*dashboardToken: await dashboardTokenFor\(baseUrl\)/s);
  assert.match(source, /fetchDashboardSessionToken\(\{ baseUrl, timeoutMs: 1_500, dashboardToken: await dashboardTokenFor\(baseUrl\) \}\)/);
});

test('GPT-Live session creation accepts the dashboard token and the panel supplies it', () => {
  const live = read('extension/lib/voice-live.mjs');
  assert.match(live, /history = \[\], dashboardToken = ''/);
  assert.match(live, /timeoutMs: 45_000,\s*dashboardToken,/);
  const panel = read('extension/sidepanel.js');
  assert.match(panel, /requestVoiceLiveSession\(\{ baseUrl, profile, sdp, history, dashboardToken: await dashboardTokenFor\(baseUrl, ''\) \}\)/);
});

test('the background hands its credential store to the wake controller', () => {
  assert.match(read('extension/background.js'), /createWakeBackgroundController\(\{[^}]*webappCredentials,/s);
});
