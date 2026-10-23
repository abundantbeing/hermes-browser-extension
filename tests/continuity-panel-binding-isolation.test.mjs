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

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const lines = source.split('\n');

function functionSource(name) {
  const start = lines.findIndex((line) => new RegExp(`^(async )?function ${name}[(]`).test(line));
  assert.ok(start >= 0, `${name} exists`);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end += 1;
  return lines.slice(start, end + 1).join('\n');
}

// The storage.onChanged listener, as the panel registers it.
function storageListener(initialSettings) {
  const start = lines.findIndex((line) => line.includes('browserApi.storage.onChanged.addListener((changes, areaName) => {'));
  assert.ok(start >= 0, 'the storage listener exists');
  let end = start + 1;
  while (end < lines.length && lines[end] !== '  });') end += 1;
  const text = lines.slice(start, end + 1).join('\n');
  let listener = null;
  const context = vm.createContext({
    settings: initialSettings,
    CUSTOM_THEME_STORAGE_KEY: 'customThemes',
    CONTEXT_CONSENT_STORAGE_KEY: 'consent',
    adoptStoredResponsePresentation() {},
    updateConnectionPrompt() {},
    renderBrowserControl() {},
    resetLocalDashboardState() {},
    handleCustomThemeStoreChange() {},
    normalizeContextConsentLedger: (value) => value,
    renderBrowserContextConsentControl() {},
    refreshContext() {},
    browserApi: { storage: { onChanged: { addListener: (fn) => { listener = fn; } } } },
  });
  vm.runInContext(text, context);
  return { listener, context };
}

const mine = { sessionId: 'A', gatewayMode: 'remote-dashboard', gatewayUrl: 'https://hermes.example', apiKey: '', remoteDashboardSession: { storedSessionId: 'A', gatewayUrl: 'https://hermes.example' } };

test('a settings write by another panel does not move this panel to that panel\'s session', () => {
  const { listener, context } = storageListener({ ...mine });
  listener({
    hermesBrowserSettings: {
      newValue: { ...mine, sessionId: 'B', remoteDashboardSession: { storedSessionId: 'B', gatewayUrl: 'https://hermes.example' } },
    },
  }, 'local');
  assert.equal(vm.runInContext('settings.remoteDashboardSession.storedSessionId', context), 'A');
  assert.equal(vm.runInContext('settings.sessionId', context), 'A');
});

test('credential and connection changes written by the controller or the pairing flow are still adopted', () => {
  const { listener, context } = storageListener({ ...mine, apiKey: 'old', gatewayMode: 'local-api' });
  listener({ hermesBrowserSettings: { newValue: { ...mine, apiKey: 'fresh', gatewayMode: 'remote-dashboard', trustedDashboardOrigin: 'https://hermes.example', trustedDashboardTabId: 7 } } }, 'local');
  assert.equal(vm.runInContext('settings.apiKey', context), 'fresh');
  assert.equal(vm.runInContext('settings.gatewayMode', context), 'remote-dashboard');
  assert.equal(vm.runInContext('settings.trustedDashboardTabId', context), 7);
});

test('the toggle that persists Gmail capture adopts only its own key, not the whole shared record', async () => {
  const stored = { hermesBrowserSettings: { ...mine, sessionId: 'B', remoteDashboardSession: { storedSessionId: 'B', gatewayUrl: 'https://hermes.example' }, gmailCaptureEnabled: false } };
  const writes = [];
  const context = vm.createContext({
    settings: { ...mine, gmailCaptureEnabled: false },
    els: { gmailCaptureEnabledInput: { checked: false }, explicitSiteCaptureWrap: { hidden: false }, explicitSiteCaptureButton: { hidden: true } },
    browserApi: { storage: { local: { get: async () => structuredClone(stored), set: async (value) => { writes.push(value); } } } },
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
