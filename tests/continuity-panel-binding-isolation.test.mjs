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
  hydrateSavedConnectionSecrets,
  packSavedConnectionStorage,
  rememberSavedConnection,
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

function adoptContext(initialSettings, secrets = undefined, storedSettings = undefined) {
  const context = vm.createContext({
    settings: initialSettings,
    loadedSavedConnectionId: initialSettings.activeSavedConnectionId || '',
    loadedSavedConnectionRevision: Number(initialSettings.savedConnectionSwitchRevision) || 0,
    reloads: [],
    reloadForSavedConnection(next) { this.reloads.push(next); },
    migrateConnectionSettings: (value) => value,
    hydrateSavedConnectionSecrets,
    SAVED_CONNECTION_SECRETS_STORAGE_KEY,
    readAloudPlayer: { stop() {} },
    readAloudDashboard: null,
    readAloudDashboardIdentity: '',
    readAloudDashboardProbe: null,
    notifyReadAloudDashboardProbeChanged() {},
    settingsAdoptionSequence: 0,
    adoptInlineAssistAutoReplaceChange() {},
    adoptInlineAssistIconChange() {},
    adoptInlineAssistOpenModeChange() {},
    adoptInlineAssistModelChange() {},
    adoptInlineAssistEffortChange() {},
    adoptInlineAssistSessionRetentionChange() {},
    adoptStoredResponsePresentation() {},
    updateConnectionPrompt() {},
    renderBrowserControl() {},
    renderSavedConnections() {},
    resetLocalDashboardState() {},
    browserApi: {
      storage: {
        local: {
          get: async (key) => {
            const keys = Array.isArray(key) ? key : [key];
            return {
              ...(keys.includes(SAVED_CONNECTION_SECRETS_STORAGE_KEY) ? { [SAVED_CONNECTION_SECRETS_STORAGE_KEY]: secrets } : {}),
              ...(keys.includes('hermesBrowserSettings') && storedSettings ? { hermesBrowserSettings: storedSettings } : {}),
            };
          },
        },
      },
    },
  });
  vm.runInContext(functionSource('hermesBrowserSettingsFromStorageChanges'), context);
  vm.runInContext(functionSource('panelBehindSavedConnectionSwitch'), context);
  vm.runInContext(functionSource('adoptHermesBrowserSettingsStorageChange'), context);
  return context;
}

const mine = { sessionId: 'A', gatewayMode: 'remote-dashboard', gatewayUrl: 'https://hermes.example', apiKey: '', remoteDashboardSession: { storedSessionId: 'A', gatewayUrl: 'https://hermes.example' } };

test('a settings write by another panel does not move this panel to that panel\'s session', async () => {
  const context = adoptContext({ ...mine });
  await vm.runInContext('adoptHermesBrowserSettingsStorageChange', context)({
    hermesBrowserSettings: {
      newValue: { ...mine, sessionId: 'B', remoteDashboardSession: { storedSessionId: 'B', gatewayUrl: 'https://hermes.example' } },
    },
  });
  assert.equal(vm.runInContext('settings.remoteDashboardSession.storedSessionId', context), 'A');
  assert.equal(vm.runInContext('settings.sessionId', context), 'A');
});

test('credential and connection changes written by the controller or the pairing flow are still adopted', async () => {
  const context = adoptContext({ ...mine, apiKey: 'old', gatewayMode: 'local-api' });
  await vm.runInContext('adoptHermesBrowserSettingsStorageChange', context)({
    hermesBrowserSettings: {
      newValue: { ...mine, apiKey: 'fresh', gatewayMode: 'remote-dashboard', trustedDashboardOrigin: 'https://hermes.example', trustedDashboardTabId: 7 },
    },
  });
  assert.equal(vm.runInContext('settings.apiKey', context), 'fresh');
  assert.equal(vm.runInContext('settings.gatewayMode', context), 'remote-dashboard');
  assert.equal(vm.runInContext('settings.trustedDashboardTabId', context), 7);
});

test('headers changed by another panel are adopted, and an unchanged list leaves read aloud playing', async () => {
  const headers = [{ name: 'X-Proxy-Token', value: 'proxy-value' }];
  const context = adoptContext({ ...mine, connectionHeaders: [] });
  let stops = 0;
  context.readAloudPlayer = { stop() { stops += 1; } };
  const adopt = vm.runInContext('adoptHermesBrowserSettingsStorageChange', context);
  await adopt({ hermesBrowserSettings: { newValue: { ...mine, connectionHeaders: headers } } });
  assert.deepEqual(vm.runInContext('settings.connectionHeaders', context), headers);
  assert.equal(stops, 1, 'new headers change how requests are made');
  await adopt({ hermesBrowserSettings: { newValue: { ...mine, connectionHeaders: [...headers] } } });
  assert.equal(stops, 1, 'the same headers are not a change');
});

test('a settings event that finishes late does not replace what a newer event already applied', async () => {
  const context = adoptContext({ ...mine, apiKey: 'start-key' });
  let releaseRead;
  context.browserApi = { storage: { local: { get: () => new Promise((resolve) => { releaseRead = () => resolve({}); }) } } };
  const adopt = vm.runInContext('adoptHermesBrowserSettingsStorageChange', context);
  const older = adopt({ hermesBrowserSettings: { newValue: { ...mine, apiKey: 'older-key' } } });
  await adopt({
    hermesBrowserSettings: { newValue: { ...mine, apiKey: 'newer-key' } },
    [SAVED_CONNECTION_SECRETS_STORAGE_KEY]: { newValue: {} },
  });
  releaseRead();
  await older;
  assert.equal(vm.runInContext('settings.apiKey', context), 'newer-key');
});

test('a secrets-only event does not discard a settings event that is still being read', async () => {
  const context = adoptContext({ ...mine, apiKey: 'start-key' });
  let releaseRead;
  let reads = 0;
  context.browserApi = { storage: { local: { get: () => (reads++ === 0 ? new Promise((resolve) => { releaseRead = () => resolve({}); }) : Promise.resolve({})) } } };
  const adopt = vm.runInContext('adoptHermesBrowserSettingsStorageChange', context);
  const pending = adopt({ hermesBrowserSettings: { newValue: { ...mine, apiKey: 'pending-key' } } });
  await adopt({ [SAVED_CONNECTION_SECRETS_STORAGE_KEY]: { newValue: {} } });
  releaseRead();
  await pending;
  assert.equal(vm.runInContext('settings.apiKey', context), 'pending-key');
});

test('a shared write that only changes appearance leaves read aloud playing', async () => {
  const context = adoptContext({ ...mine, appearanceTheme: 'nous' });
  let stops = 0;
  context.readAloudPlayer = { stop() { stops += 1; } };
  await vm.runInContext('adoptHermesBrowserSettingsStorageChange', context)({
    hermesBrowserSettings: { newValue: { ...mine, appearanceTheme: 'mono' } },
  });
  assert.equal(stops, 0);
});

test('a connection change written by another panel stops read aloud and drops the dashboard probe', async () => {
  const context = adoptContext({ ...mine, gatewayMode: 'local-api' });
  let stops = 0;
  let probeNotices = 0;
  context.readAloudPlayer = { stop() { stops += 1; } };
  context.readAloudDashboardProbe = { reachable: true };
  context.notifyReadAloudDashboardProbeChanged = () => { probeNotices += 1; };
  await vm.runInContext('adoptHermesBrowserSettingsStorageChange', context)({
    hermesBrowserSettings: { newValue: { ...mine, gatewayMode: 'remote-dashboard' } },
  });
  assert.equal(stops, 1);
  assert.equal(probeNotices, 1);
  assert.equal(context.readAloudDashboardProbe, null);
});

test('a packed settings save still restores the active gateway key for this panel', async () => {
  const live = rememberSavedConnection({
    gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642',
    apiKey: 'live-key', tokenSource: 'manual', activeSavedConnectionId: 'default',
  });
  const packed = await packSavedConnectionStorage(live);
  assert.equal(packed.hermesBrowserSettings.apiKey, '');
  const context = adoptContext({ ...live, apiKey: 'live-key' });
  await vm.runInContext('adoptHermesBrowserSettingsStorageChange', context)({
    hermesBrowserSettings: { newValue: packed.hermesBrowserSettings },
    [SAVED_CONNECTION_SECRETS_STORAGE_KEY]: { newValue: packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY] },
  });
  assert.equal(vm.runInContext('settings.apiKey', context), 'live-key');
});

test('a saved-connection switch in another panel reloads before adopting its session', async () => {
  const context = adoptContext({ ...mine, activeSavedConnectionId: 'default' });
  const next = { ...mine, activeSavedConnectionId: 'work', sessionId: '' };
  context.reloadForSavedConnection = (value) => context.reloads.push(value);
  await vm.runInContext('adoptHermesBrowserSettingsStorageChange', context)({ hermesBrowserSettings: { newValue: next } });
  assert.equal(context.reloads.length, 1);
  assert.equal(context.reloads[0].activeSavedConnectionId, 'work');
  assert.equal(vm.runInContext('settings.sessionId', context), 'A');
});

test('a panel that is on the same connection but missed a switch reloads, and an ordinary write does not', async () => {
  const onDefault = { ...mine, activeSavedConnectionId: 'default', savedConnectionSwitchRevision: 0 };
  const context = adoptContext({ ...onDefault });
  context.reloadForSavedConnection = (value) => context.reloads.push(value);
  const adopt = vm.runInContext('adoptHermesBrowserSettingsStorageChange', context);
  await adopt({ hermesBrowserSettings: { newValue: { ...onDefault, appearanceTheme: 'mono' } } });
  assert.equal(context.reloads.length, 0, 'the same revision is the same chat');
  await adopt({ hermesBrowserSettings: { newValue: { ...onDefault, savedConnectionSwitchRevision: 2 } } });
  assert.equal(context.reloads.length, 1, 'A to B to A is two switches: this panel starts fresh');
  assert.equal(context.reloads[0].savedConnectionSwitchRevision, 2);
  assert.equal(vm.runInContext('settings.sessionId', context), 'A', 'its own session stays until the reload');
});

test('the newest event wins when A to B to A arrives while B is still being read', async () => {
  const onDefault = { ...mine, activeSavedConnectionId: 'default', savedConnectionSwitchRevision: 0 };
  const context = adoptContext({ ...onDefault });
  context.reloadForSavedConnection = (value) => context.reloads.push(value);
  let releaseRead;
  let reads = 0;
  context.browserApi = { storage: { local: { get: () => (reads++ === 0 ? new Promise((resolve) => { releaseRead = () => resolve({}); }) : Promise.resolve({})) } } };
  const adopt = vm.runInContext('adoptHermesBrowserSettingsStorageChange', context);
  const toB = adopt({ hermesBrowserSettings: { newValue: { ...onDefault, activeSavedConnectionId: 'work', savedConnectionSwitchRevision: 1 } } });
  await adopt({ hermesBrowserSettings: { newValue: { ...onDefault, savedConnectionSwitchRevision: 2 } } });
  releaseRead();
  await toB;
  assert.equal(context.reloads.length, 1, 'the answer to A is acted on although B was dropped');
  assert.equal(context.reloads[0].activeSavedConnectionId, 'default');
});

test('a change to the protected record alone, such as removing a header, is adopted by this panel', async () => {
  const withHeader = rememberSavedConnection({
    gatewayMode: 'remote-api', gatewayUrl: 'https://hermes.example', apiKey: 'live-key', tokenSource: 'manual',
    activeSavedConnectionId: 'default', connectionHeaders: [{ name: 'X-Proxy-Token', value: 'proxy-value' }],
  });
  const first = await packSavedConnectionStorage(withHeader);
  const removed = await packSavedConnectionStorage({ ...withHeader, connectionHeaders: [] });
  assert.equal(JSON.stringify(first.hermesBrowserSettings), JSON.stringify(removed.hermesBrowserSettings), 'only the protected record differs');
  const context = adoptContext({ ...withHeader }, first[SAVED_CONNECTION_SECRETS_STORAGE_KEY], removed.hermesBrowserSettings);
  let stops = 0;
  context.readAloudPlayer = { stop() { stops += 1; } };
  await vm.runInContext('adoptHermesBrowserSettingsStorageChange', context)({
    [SAVED_CONNECTION_SECRETS_STORAGE_KEY]: { newValue: removed[SAVED_CONNECTION_SECRETS_STORAGE_KEY] },
  });
  assert.deepEqual(vm.runInContext('settings.connectionHeaders', context), [], 'the removed header is no longer sent from this panel');
  assert.equal(stops, 1, 'new headers change how requests are made');
});

test('a protected-record event with no settings stored adopts nothing', async () => {
  const context = adoptContext({ ...mine, apiKey: 'keep' }, {}, undefined);
  await vm.runInContext('adoptHermesBrowserSettingsStorageChange', context)({ [SAVED_CONNECTION_SECRETS_STORAGE_KEY]: { newValue: {} } });
  assert.equal(vm.runInContext('settings.apiKey', context), 'keep');
});

test('the toggle that persists Gmail capture adopts only its own key, not the whole shared record', async () => {
  const stored = { hermesBrowserSettings: { ...mine, sessionId: 'B', remoteDashboardSession: { storedSessionId: 'B', gatewayUrl: 'https://hermes.example' }, gmailCaptureEnabled: false } };
  const writes = [];
  const context = vm.createContext({
    settings: { ...mine, gmailCaptureEnabled: false },
    els: { gmailCaptureEnabledInput: { checked: false }, explicitSiteCaptureWrap: { hidden: false }, explicitSiteCaptureButton: { hidden: true } },
    async mergePackedBrowserSettingsFromStorage(mergeFn) {
      const fresh = structuredClone(stored.hermesBrowserSettings);
      const next = typeof mergeFn === 'function' ? mergeFn(fresh) : { ...fresh, ...mergeFn };
      writes.push({ hermesBrowserSettings: next });
      return next;
    },
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
