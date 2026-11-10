import assert from 'node:assert/strict';
import test from 'node:test';

import { createWakeBackgroundController, wakeNeedsReconfigure } from '../extension/lib/wake-background.mjs';
import { WS_EVENTS, WS_METHODS } from '../extension/lib/gateway-ws.mjs';
import { WAKE_MESSAGES } from '../extension/lib/wake-word.mjs';

const local = {
  connectionMode: 'local', connectionTransport: 'local-api', gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642',
  wakeWordEnabled: true, wakeWordPreferNative: true, wakeWordBrowserFallback: false, wakeWordPhrase: 'hey hermes',
};
const settle = async (times = 12) => { for (let step = 0; step < times; step += 1) await new Promise((resolve) => globalThis.setImmediate(resolve)); };

function mockChrome(settings) {
  const values = { hermesBrowserSettings: { ...settings } };
  return {
    values,
    api: {
      runtime: {
        getManifest: () => ({ version: '0.2.0' }),
        getURL: (path) => `chrome-extension://test/${path}`,
        getContexts: async () => [],
        sendMessage: async () => ({ ok: true }),
      },
      storage: {
        local: {
          get: async (key) => (typeof key === 'string' ? { [key]: values[key] } : { ...values }),
          set: async (patch) => Object.assign(values, patch),
          remove: async (key) => { delete values[key]; },
        },
      },
      offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
      tabs: { query: async () => [{ id: 1, active: true, currentWindow: true }] },
      scripting: { executeScript: async () => [] },
    },
  };
}

function fakeClient(name, { holdConnect = false } = {}) {
  const listeners = new Map();
  const client = {
    name,
    calls: [],
    closed: false,
    releaseConnect: null,
    connect: () => {
      client.calls.push('connect');
      return holdConnect ? new Promise((resolve) => { client.releaseConnect = resolve; }) : Promise.resolve();
    },
    request: async (method) => {
      client.calls.push(method);
      if (method === WS_METHODS.wakeStatus) return { available: true, provider: 'openwakeword' };
      if (method === WS_METHODS.wakeStart) return { started: true, provider: 'openwakeword' };
      return { ok: true };
    },
    on: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
      return () => listeners.get(type)?.delete(handler);
    },
    close: () => { client.closed = true; client.calls.push('close'); },
    emit: async (type, event = {}) => Promise.all([...(listeners.get(type) || [])].map((handler) => handler(event))),
  };
  return client;
}

const tokenPage = async () => ({ ok: true, text: async () => '<script>window.__HERMES_SESSION_TOKEN__ = "loopback-token";</script>' });

function wakeController(chrome, clients, { hold = [] } = {}) {
  return createWakeBackgroundController({
    chromeApi: chrome.api,
    gatewayClientFactory: () => {
      const client = fakeClient(clients.length, { holdConnect: hold.includes(clients.length) });
      clients.push(client);
      return client;
    },
    fetchFn: tokenPage,
    openPanel: async () => {},
  });
}

test('a start overtaken while it connects closes its own client, and the newer start owns the listener', async () => {
  const chrome = mockChrome(local);
  const clients = [];
  const controller = wakeController(chrome, clients, { hold: [0] });
  await controller.configure(local);
  await settle();
  assert.equal(clients.length, 1);
  await controller.configure({ ...local, wakeWordPhrase: 'computer' });
  clients[0].releaseConnect();
  await settle(30);
  assert.equal(clients[0].closed, true, 'the overtaken start cleans up its own client');
  assert.equal(clients.length, 2, 'one more start, run after the first ended');
  assert.equal(clients[1].closed, false);
  assert.equal(controller.state().state, 'listening');
  await clients[1].emit(WS_EVENTS.wakeDetected, { payload: {} });
  assert.ok(clients[1].calls.includes(WS_METHODS.voiceToggle), 'the surviving client records the command');
  assert.ok(!clients[0].calls.includes(WS_METHODS.voiceToggle));
});

test('a start overtaken before it has a client never opens one', async () => {
  const chrome = mockChrome(local);
  const clients = [];
  let releaseCredential;
  const controller = createWakeBackgroundController({
    chromeApi: chrome.api,
    gatewayClientFactory: () => { const client = fakeClient(clients.length); clients.push(client); return client; },
    fetchFn: () => (clients.length === 0 && !releaseCredential
      ? new Promise((resolve) => { releaseCredential = () => resolve(tokenPage()); })
      : tokenPage()),
    openPanel: async () => {},
  });
  await controller.configure(local);
  await settle();
  await controller.configure({ ...local, wakeWordPhrase: 'computer' });
  releaseCredential();
  await settle(30);
  assert.equal(clients.length, 1, 'only the newer start opened a client');
  assert.equal(controller.state().state, 'listening');
});

test('the same configuration arriving twice while the first is starting starts wake once', async () => {
  const chrome = mockChrome(local);
  const clients = [];
  const controller = wakeController(chrome, clients, { hold: [0] });
  await controller.configure(local);
  await settle();
  await controller.restore();
  await controller.handleMessage({ type: WAKE_MESSAGES.setEnabled, enabled: true, settings: {} });
  clients[0].releaseConnect();
  await settle(30);
  assert.equal(clients.length, 1, 'the save and the storage listener did not each open a listener');
  assert.equal(clients[0].closed, false);
  assert.equal(controller.state().state, 'listening');
  await clients[0].emit(WS_EVENTS.wakeDetected, { payload: {} });
  assert.ok(clients[0].calls.includes(WS_METHODS.voiceToggle));
});

test('turning wake off and back on while a start waits for its credential ends up listening', async () => {
  const chrome = mockChrome(local);
  const clients = [];
  let fetches = 0;
  let releaseFirst;
  const controller = createWakeBackgroundController({
    chromeApi: chrome.api,
    gatewayClientFactory: () => { const client = fakeClient(clients.length); clients.push(client); return client; },
    fetchFn: () => (fetches++ === 0 ? new Promise((resolve) => { releaseFirst = () => resolve(tokenPage()); }) : tokenPage()),
    openPanel: async () => {},
  });
  await controller.configure(local);
  await settle();
  await controller.configure({ ...local, wakeWordEnabled: false });
  assert.equal(controller.state().state, 'off');
  await controller.configure(local);
  releaseFirst();
  await settle(40);
  assert.equal(clients.length, 1, 'the overtaken start opened nothing and the new one opened one client');
  assert.equal(controller.state().state, 'listening', 'wake did not stay off');
  assert.equal(controller.state().enabled, true);
});

test('wake stored as off stops the listener even when the panel that saved it never sent a message', async () => {
  const chrome = mockChrome(local);
  const clients = [];
  const controller = wakeController(chrome, clients);
  await controller.configure(local);
  await settle(30);
  assert.equal(controller.state().state, 'listening');
  const before = { ...chrome.values.hermesBrowserSettings };
  chrome.values.hermesBrowserSettings = { ...before, wakeWordEnabled: false };
  assert.equal(wakeNeedsReconfigure(before, chrome.values.hermesBrowserSettings), true);
  await controller.restore();
  assert.equal(clients[0].closed, true, 'the native client is closed');
  assert.ok(clients[0].calls.includes(WS_METHODS.wakeStop), 'and the engine is told to stop');
  assert.equal(controller.state().state, 'off');
  assert.equal(controller.state().enabled, false);
});

test('only an off-transition, or a connection change while on, reconfigures wake', () => {
  const on = { ...local, activeSavedConnectionId: 'default' };
  assert.equal(wakeNeedsReconfigure(on, { ...on, wakeWordEnabled: false }), true, 'on to off');
  assert.equal(wakeNeedsReconfigure({ ...on, wakeWordEnabled: false }, { ...on, wakeWordEnabled: false }), false, 'off stays off');
  assert.equal(wakeNeedsReconfigure({ ...on, wakeWordEnabled: false }, on), false, 'turning on is the panel\'s own flow, with the microphone permission');
  assert.equal(wakeNeedsReconfigure(on, { ...on, activeSavedConnectionId: 'work' }), true);
  assert.equal(wakeNeedsReconfigure(on, { ...on, appearanceTheme: 'mono' }), false);
  assert.equal(wakeNeedsReconfigure(undefined, undefined), false);
});

test('the real background reconfigures wake from the stored setting, not only from the panel\'s message', async () => {
  const { readFile } = await import('node:fs/promises');
  const background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(background, /wakeNeedsReconfigure\(changes\.hermesBrowserSettings\.oldValue, changes\.hermesBrowserSettings\.newValue\)[\s\S]{0,200}wakeController\.restore\(\)/);
});
