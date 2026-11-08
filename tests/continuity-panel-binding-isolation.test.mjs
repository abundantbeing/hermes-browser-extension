// D13: per-tab panels share one `hermesBrowserSettings` record. One panel must not adopt another panel's
// session binding (remoteDashboardSession / sessionId) from storage, or its next reconnect resumes - and
// then writes into - the other panel's session.
//
// What this proves is the unit level: the code paths that copy the shared record into a running panel's
// own settings. The two-panel behaviour itself needs a manual check (listed in the hand-over notes).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  hydrateHermesBrowserSettingsFromStorage,
  packedHermesBrowserSettingsWrite,
  SAVED_CONNECTION_SECRETS_STORAGE_KEY,
} from '../extension/lib/saved-connections.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const lines = source.split('\n');

function functionSource(name) {
  const start = lines.findIndex((line) => new RegExp(`^(async )?function ${name}[(]`).test(line));
  assert.ok(start >= 0, `${name} exists`);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end += 1;
  return lines.slice(start, end + 1).join('\n');
}

async function flushMicrotasks() {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// The storage.onChanged listener, as the panel registers it.
function storageListener(initialSettings) {
  const start = lines.findIndex((line) => line.includes('browserApi.storage.onChanged.addListener((changes, areaName) => {'));
  assert.ok(start >= 0, 'the storage listener exists');
  let end = start + 1;
  while (end < lines.length && lines[end] !== '  });') end += 1;
  const text = lines.slice(start, end + 1).join('\n');
  let listener = null;
  const lastStorageSnapshot = {
    hermesBrowserSettings: structuredClone(initialSettings),
    [SAVED_CONNECTION_SECRETS_STORAGE_KEY]: {},
  };
  const context = vm.createContext({
    settings: initialSettings,
    loadedSavedConnectionId: initialSettings.activeSavedConnectionId || '',
    reloads: [],
    reloadForSavedConnection(next) { this.reloads.push(next); },
    SAVED_CONNECTION_SECRETS_STORAGE_KEY,
    hydrateHermesBrowserSettingsFromStorage,
    async readBrowserSettingsFromStorage() {
      return hydrateHermesBrowserSettingsFromStorage(lastStorageSnapshot, null);
    },
    CUSTOM_THEME_STORAGE_KEY: 'customThemes',
    CONTEXT_CONSENT_STORAGE_KEY: 'consent',
    ONBOARDING_COMPLETED_STORAGE_KEY: 'onboardingDone',
    INLINE_ASSIST_AUTO_REPLACE_STORAGE_KEY: 'hermesInlineAssistAutoReplace',
    adoptInlineAssistAutoReplaceChange() {},
    adoptInlineAssistIconChange() {},
    adoptInlineAssistOpenModeChange() {},
    adoptInlineAssistModelChange() {},
    adoptInlineAssistSessionRetentionChange() {},
    INLINE_SITE_CONTEXT_STORAGE_KEY: 'hermesInlineSiteContextPreferences',
    adoptInlineAssistSitesChange() {},
    INLINE_ASSIST_HIDDEN_SITES_STORAGE_KEY: 'hermesInlineAssistHiddenSites',
    adoptOnboardingCompletedChange() {},
    adoptStoredResponsePresentation() {},
    updateConnectionPrompt() {},
    renderBrowserControl() {},
    renderSavedConnections() {},
    resetLocalDashboardState() {},
    handleCustomThemeStoreChange() {},
    normalizeContextConsentLedger: (value) => value,
    renderBrowserContextConsentControl() {},
    refreshContext() {},
    browserApi: {
      storage: {
        onChanged: { addListener: (fn) => { listener = fn; } },
        local: {
          get: async (keys) => {
            if (keys === null || keys === undefined) return structuredClone(lastStorageSnapshot);
            const list = Array.isArray(keys) ? keys : [keys];
            const out = {};
            for (const key of list) {
              if (Object.hasOwn(lastStorageSnapshot, key)) {
                out[key] = structuredClone(lastStorageSnapshot[key]);
              }
            }
            return out;
          },
        },
      },
    },
  });
  vm.runInContext(text, context);
  return {
    listener,
    context,
    applyStorage(changes) {
      const next = changes.hermesBrowserSettings?.newValue;
      if (next && typeof next === 'object') lastStorageSnapshot.hermesBrowserSettings = structuredClone(next);
      if (Object.hasOwn(changes, SAVED_CONNECTION_SECRETS_STORAGE_KEY)) {
        lastStorageSnapshot[SAVED_CONNECTION_SECRETS_STORAGE_KEY] = structuredClone(
          changes[SAVED_CONNECTION_SECRETS_STORAGE_KEY]?.newValue || {},
        );
      }
    },
  };
}

const mine = { sessionId: 'A', gatewayMode: 'remote-dashboard', gatewayUrl: 'https://hermes.example', apiKey: '', remoteDashboardSession: { storedSessionId: 'A', gatewayUrl: 'https://hermes.example' } };

test('a settings write by another panel does not move this panel to that panel\'s session', async () => {
  const { listener, context, applyStorage } = storageListener({ ...mine });
  const changes = {
    hermesBrowserSettings: {
      newValue: { ...mine, sessionId: 'B', remoteDashboardSession: { storedSessionId: 'B', gatewayUrl: 'https://hermes.example' } },
    },
  };
  applyStorage(changes);
  listener(changes, 'local');
  await flushMicrotasks();
  assert.equal(vm.runInContext('settings.remoteDashboardSession.storedSessionId', context), 'A');
  assert.equal(vm.runInContext('settings.sessionId', context), 'A');
});

test('credential and connection changes written by the controller or the pairing flow are still adopted', async () => {
  const { listener, context, applyStorage } = storageListener({ ...mine, apiKey: 'old', gatewayMode: 'local-api' });
  const changes = { hermesBrowserSettings: { newValue: { ...mine, apiKey: 'fresh', gatewayMode: 'remote-dashboard', trustedDashboardOrigin: 'https://hermes.example', trustedDashboardTabId: 7 } } };
  applyStorage(changes);
  listener(changes, 'local');
  await flushMicrotasks();
  assert.equal(vm.runInContext('settings.apiKey', context), 'fresh');
  assert.equal(vm.runInContext('settings.gatewayMode', context), 'remote-dashboard');
  assert.equal(vm.runInContext('settings.trustedDashboardTabId', context), 7);
});

test('a saved-connection switch in another panel reloads before adopting its session', async () => {
  const { listener, context, applyStorage } = storageListener({ ...mine, activeSavedConnectionId: 'default' });
  const next = { ...mine, activeSavedConnectionId: 'work', sessionId: '' };
  // The callback is called as a plain function by the browser.
  context.reloadForSavedConnection = (value) => context.reloads.push(value);
  const changes = { hermesBrowserSettings: { newValue: next } };
  applyStorage(changes);
  listener(changes, 'local');
  await flushMicrotasks();
  assert.equal(context.reloads.length, 1);
  assert.equal(context.reloads[0].activeSavedConnectionId, 'work');
  assert.equal(vm.runInContext('settings.sessionId', context), 'A');
});

test('the toggle that persists Gmail capture adopts only its own key, not the whole shared record', async () => {
  const storedState = {
    hermesBrowserSettings: { ...mine, sessionId: 'B', remoteDashboardSession: { storedSessionId: 'B', gatewayUrl: 'https://hermes.example' }, gmailCaptureEnabled: false },
    [SAVED_CONNECTION_SECRETS_STORAGE_KEY]: {},
  };
  const writes = [];
  const context = vm.createContext({
    settings: { ...mine, gmailCaptureEnabled: false },
    els: { gmailCaptureEnabledInput: { checked: false }, explicitSiteCaptureWrap: { hidden: false }, explicitSiteCaptureButton: { hidden: true } },
    SAVED_CONNECTION_SECRETS_STORAGE_KEY,
    async readBrowserSettingsFromStorage() {
      return hydrateHermesBrowserSettingsFromStorage(structuredClone(storedState), null);
    },
    async setPackedBrowserSettings(next) {
      const packed = await packedHermesBrowserSettingsWrite(structuredClone(next), null);
      writes.push(packed);
    },
    browserApi: { storage: { local: { get: async () => structuredClone(storedState), set: async () => {} } } },
  });
  vm.runInContext(functionSource('persistGmailCaptureEnabled'), context);
  await vm.runInContext('persistGmailCaptureEnabled', context)(true);
  assert.equal(vm.runInContext('settings.gmailCaptureEnabled', context), true);
  assert.equal(vm.runInContext('settings.sessionId', context), 'A', 'this panel keeps its own session');
  assert.equal(vm.runInContext('settings.remoteDashboardSession.storedSessionId', context), 'A');
  assert.equal(writes.at(-1).hermesBrowserSettings.gmailCaptureEnabled, true, 'the shared record still gets the toggle');
  assert.equal(writes.at(-1).hermesBrowserSettings.sessionId, 'B', 'and the other panel\'s binding is not rewritten by it');
});

test('a panel reconnecting resumes its own binding: ensureRemoteWsSession reads settings, never storage', () => {
  const body = functionSource('ensureRemoteWsSession');
  assert.match(body, /remoteStoredSessionIdForGateway\(settings\.remoteDashboardSession/);
  assert.doesNotMatch(body, /storage\.local\.get/);
});
