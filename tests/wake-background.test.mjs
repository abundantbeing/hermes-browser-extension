import assert from 'node:assert/strict';
import test from 'node:test';

import { createWakeBackgroundController } from '../extension/lib/wake-background.mjs';
import { WS_EVENTS, WS_METHODS } from '../extension/lib/gateway-ws.mjs';
import { WAKE_MESSAGES, WAKE_STORAGE_KEYS } from '../extension/lib/wake-word.mjs';
import { readFileSync } from 'node:fs';

function mockChrome() {
  const values = { hermesBrowserSettings: {} };
  const messages = [];
  const created = [];
  const closed = [];
  return {
    values,
    messages,
    created,
    closed,
    api: {
      runtime: {
        getManifest: () => ({ version: '0.2.0' }),
        getURL: (path) => `chrome-extension://test/${path}`,
        getContexts: async () => [],
        sendMessage: async (message) => {
          messages.push(message);
          return { ok: true };
        },
      },
      storage: {
        local: {
          get: async (key) => typeof key === 'string' ? { [key]: values[key] } : { ...values },
          set: async (patch) => Object.assign(values, patch),
          remove: async (key) => { delete values[key]; },
        },
      },
      offscreen: {
        createDocument: async (options) => created.push(options),
        closeDocument: async () => closed.push(true),
      },
      tabs: {
        query: async () => [{ id: 1, active: true, currentWindow: true }],
      },
      scripting: {
        executeScript: async () => [],
      },
    },
  };
}

test('browser fallback creates a local-only offscreen listener after explicit enable', async () => {
  const chrome = mockChrome();
  const controller = createWakeBackgroundController({ chromeApi: chrome.api, openPanel: async () => {} });
  const state = await controller.configure({
    wakeWordEnabled: true,
    wakeWordPreferNative: false,
    wakeWordBrowserFallback: true,
    wakeWordPhrase: 'hey hermes',
  });
  assert.equal(state.mode, 'browser-local');
  assert.equal(chrome.created.length, 1);
  assert.deepEqual(chrome.created[0].reasons, ['USER_MEDIA', 'AUDIO_PLAYBACK']);
  assert.ok(chrome.messages.some((message) => message.type === WAKE_MESSAGES.configure && message.enabled));
});

test('disabling browser wake releases the offscreen listener document', async () => {
  const chrome = mockChrome();
  let contexts = [];
  chrome.api.runtime.getContexts = async () => contexts;
  chrome.api.offscreen.createDocument = async (options) => {
    chrome.created.push(options);
    contexts = [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: 'chrome-extension://test/wake-listener.html' }];
  };
  chrome.api.offscreen.closeDocument = async () => {
    chrome.closed.push(true);
    contexts = [];
  };
  const controller = createWakeBackgroundController({ chromeApi: chrome.api, openPanel: async () => {} });
  await controller.configure({ wakeWordEnabled: true, wakeWordPreferNative: false });
  await controller.configure({ wakeWordEnabled: false });
  assert.equal(chrome.closed.length, 1);
});

test('native Hermes wake owns the full wake, VAD transcript, TTS, and resume lifecycle', async () => {
  const chrome = mockChrome();
  chrome.api.tabs.query = async (query = {}) => query.active
    ? [{ id: 7, active: true, currentWindow: true }]
    : [{ id: 9, status: 'complete', discarded: false, url: 'http://127.0.0.1:9119/' }];
  chrome.api.scripting.executeScript = async () => [{ result: { ok: true, ticket: 'single-use-ticket', ttlSeconds: 30 } }];
  const calls = [];
  const listeners = new Map();
  const client = {
    connect: async (url) => calls.push(['connect', url]),
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === WS_METHODS.wakeStatus) return {
        available: true,
        enabled: false,
        listening: false,
        provider: 'openwakeword',
      };
      if (method === WS_METHODS.wakeStart) return { started: true, provider: 'openwakeword' };
      return { ok: true };
    },
    on: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
      return () => listeners.get(type)?.delete(handler);
    },
    close: () => calls.push(['close']),
    emit: async (type, event = {}) => Promise.all([...(listeners.get(type) || [])].map((handler) => handler(event))),
  };
  let opened = 0;
  const controller = createWakeBackgroundController({
    chromeApi: chrome.api,
    gatewayClientFactory: () => client,
    fetchFn: async () => ({
      ok: true,
      text: async () => '<script>window.__HERMES_SESSION_TOKEN__ = "loopback-token";</script>',
    }),
    openPanel: async () => { opened += 1; },
  });
  const arming = await controller.configure({
    wakeWordEnabled: true,
    wakeWordPreferNative: true,
    wakeWordBrowserFallback: false,
    wakeWordPhrase: 'computer',
  });
  assert.equal(arming.mode, 'native');
  assert.equal(arming.state, 'arming');
  for (let attempt = 0; attempt < 10 && controller.state().state !== 'listening'; attempt += 1) {
    await new Promise((resolve) => globalThis.setImmediate(resolve));
  }
  assert.equal(controller.state().state, 'listening');
  assert.equal(controller.state().phrase, 'hey hermes');
  assert.match(controller.state().detail, /hey hermes/);
  assert.doesNotMatch(controller.state().detail, /computer/);
  assert.ok(calls.some(([method, url]) => method === 'connect' && url.includes('?token=loopback-token')));
  await client.emit(WS_EVENTS.wakeDetected, { payload: { phrase: 'hey hermes' } });
  assert.ok(calls.some(([method]) => method === WS_METHODS.voiceToggle));
  assert.ok(calls.some(([method]) => method === WS_METHODS.voiceRecord));
  await client.emit(WS_EVENTS.voiceTranscript, { payload: { text: 'summarize this page' } });
  assert.equal(opened, 1);
  assert.equal(chrome.values[WAKE_STORAGE_KEYS.turn].mode, 'native');
  await controller.handleMessage({ type: WAKE_MESSAGES.turnReply, text: 'Summary complete.' });
  assert.ok(calls.some(([method, params]) => method === WS_METHODS.voiceTts && params.text === 'Summary complete.'));
  assert.ok(calls.some(([method]) => method === WS_METHODS.wakeResume));
});

test('detected browser-local command opens Hermes only after no existing surface responds', async () => {
  const chrome = mockChrome();
  const sendMessage = chrome.api.runtime.sendMessage;
  chrome.api.runtime.sendMessage = async (message) => {
    const response = await sendMessage(message);
    if (message.type === WAKE_MESSAGES.turnReady) throw new Error('No receiving end');
    return response;
  };
  let opened = 0;
  const controller = createWakeBackgroundController({ chromeApi: chrome.api, openPanel: async () => { opened += 1; } });
  await controller.configure({ wakeWordEnabled: true, wakeWordPreferNative: false });
  await controller.handleMessage({ type: WAKE_MESSAGES.localDetected, text: 'summarize this page' });
  assert.equal(opened, 1);
  assert.equal(chrome.values[WAKE_STORAGE_KEYS.turn].text, 'summarize this page');
  assert.equal(chrome.values[WAKE_STORAGE_KEYS.turn].mode, 'browser-local');
  assert.equal(chrome.messages.filter((message) => message.type === WAKE_MESSAGES.turnReady).length, 2);
});

for (const connectionMode of ['local', 'remote', 'cloud']) {
  test(`existing Hermes surface handles a ${connectionMode} wake turn without opening another tab`, async () => {
    const chrome = mockChrome();
    chrome.values.hermesBrowserSettings = {
      connectionMode,
      sessionId: `existing-${connectionMode}-session`,
      webSessionId: `existing-${connectionMode}-web-session`,
    };
    const sendMessage = chrome.api.runtime.sendMessage;
    chrome.api.runtime.sendMessage = async (message) => {
      const response = await sendMessage(message);
      if (message.type === WAKE_MESSAGES.turnReady) {
        return { ok: true, accepted: true, surface: 'side_panel' };
      }
      return response;
    };
    let opened = 0;
    const controller = createWakeBackgroundController({
      chromeApi: chrome.api,
      openPanel: async () => { opened += 1; },
    });

    await controller.configure({ wakeWordEnabled: true, wakeWordPreferNative: false });
    await controller.handleMessage({ type: WAKE_MESSAGES.localDetected, text: 'summarize this page' });

    assert.equal(opened, 0);
    assert.equal(chrome.values.hermesBrowserSettings.connectionMode, connectionMode);
    assert.equal(chrome.values.hermesBrowserSettings.sessionId, `existing-${connectionMode}-session`);
    assert.equal(chrome.values.hermesBrowserSettings.webSessionId, `existing-${connectionMode}-web-session`);
    assert.equal(chrome.messages.filter((message) => message.type === WAKE_MESSAGES.turnReady).length, 1);
  });
}

test('wake turns have one atomic surface claimant across side panel and Hermes Web', async () => {
  const chrome = mockChrome();
  const controller = createWakeBackgroundController({ chromeApi: chrome.api, openPanel: async () => {} });
  await controller.configure({ wakeWordEnabled: true, wakeWordPreferNative: false });
  await controller.handleMessage({ type: WAKE_MESSAGES.localDetected, text: 'summarize this page' });
  const turnId = chrome.values[WAKE_STORAGE_KEYS.turn].id;

  const [sidepanel, web] = await Promise.all([
    controller.handleMessage({ type: WAKE_MESSAGES.claimTurn, turnId, surface: 'sidepanel' }),
    controller.handleMessage({ type: WAKE_MESSAGES.claimTurn, turnId, surface: 'web' }),
  ]);

  assert.equal([sidepanel, web].filter((result) => result?.claimed).length, 1);
  assert.equal(chrome.values[WAKE_STORAGE_KEYS.turn], undefined);
});

test('the real extension background routes atomic wake claims into the controller', () => {
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const routedTypes = background.match(/const WAKE_BACKGROUND_MESSAGE_TYPES = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
  assert.match(routedTypes, /WAKE_MESSAGES\.claimTurn/);
});

test('both Hermes surfaces immediately acknowledge a delivered wake turn', () => {
  const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../extension/app.js', import.meta.url), 'utf8');

  assert.match(sidepanel, /sendResponse\?\.\(\{ ok: true, accepted: true, surface: SURFACE_KINDS\.SIDE_PANEL \}\)/);
  assert.match(app, /sendResponse\?\.\(\{ ok: true, accepted: true, surface: SURFACE_KINDS\.FULL_TAB \}\)/);
});

test('wake reply resumes local listener when spoken replies are disabled', async () => {
  const chrome = mockChrome();
  const controller = createWakeBackgroundController({ chromeApi: chrome.api, openPanel: async () => {} });
  await controller.configure({
    wakeWordEnabled: true,
    wakeWordPreferNative: false,
    wakeWordSpeakReplies: false,
  });
  await controller.handleMessage({ type: WAKE_MESSAGES.turnReply, text: 'Done.' });
  assert.ok(chrome.messages.some((message) => message.type === WAKE_MESSAGES.resumeLocal));
  assert.equal(chrome.messages.some((message) => message.type === WAKE_MESSAGES.speak), false);
});
