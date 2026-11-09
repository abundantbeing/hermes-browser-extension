// Saving Settings must not replace the session on screen unless the connection it belongs to changed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { applyStoredSettingsAfterSave, connectionIdentityChanged } from '../extension/lib/settings-save-effects.mjs';
import { createSessionLineage } from '../extension/lib/session-lineage.mjs';
import { createSettingsSaveHarness } from './helpers/settings-save-harness.mjs';
import { rememberSavedConnection } from '../extension/lib/saved-connections.mjs';
import { normalizeGatewayUrl } from '../extension/lib/common.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const base = { connectionMode: 'local', connectionTransport: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', apiKey: 'k', activeProfile: 'default' };

test('connectionIdentityChanged: only the gateway, credential, profile, mode or transport count', () => {
  assert.equal(connectionIdentityChanged(base, { ...base, theme: 'dark', autoNameSessions: false, includeTabs: true }, normalizeGatewayUrl), false);
  assert.equal(connectionIdentityChanged(base, { ...base, gatewayUrl: 'http://127.0.0.1:8642/' }, normalizeGatewayUrl), false, 'a trailing slash is the same gateway');
  assert.equal(connectionIdentityChanged(base, { ...base, gatewayUrl: 'http://127.0.0.1:9000' }, normalizeGatewayUrl), true);
  assert.equal(connectionIdentityChanged(base, { ...base, apiKey: 'other' }, normalizeGatewayUrl), true);
  assert.equal(connectionIdentityChanged(base, { ...base, activeProfile: 'work' }, normalizeGatewayUrl), true);
  assert.equal(connectionIdentityChanged(base, { ...base, connectionMode: 'remote' }, normalizeGatewayUrl), true);
  assert.equal(connectionIdentityChanged(base, { ...base, connectionTransport: 'remote-dashboard' }, normalizeGatewayUrl), true);
});

// The step the Save handler runs once the settings are stored.
const refreshSource = source.slice(
  source.indexOf('async function refreshAfterSettingsSave('),
  source.indexOf('\n}\n', source.indexOf('async function refreshAfterSettingsSave(')) + 3,
);

function afterSave({ saved, ready = true } = {}) {
  const calls = [];
  const names = ['loadGatewayCapabilities', 'loadModels', 'loadSkills', 'loadProfiles', 'loadSessions', 'initializeSessionForPanelOpen', 'beginHermesBrowserDraft', 'detachLiveSession'];
  const context = vm.createContext({
    minimumConnectionReady: () => ready,
    ...Object.fromEntries(names.map((name) => [name, async () => { calls.push(name); }])),
  });
  assert.ok(refreshSource.length > 10, 'refreshAfterSettingsSave exists');
  vm.runInContext(refreshSource, context);
  return { calls, run: () => vm.runInContext('refreshAfterSettingsSave(saved)', Object.assign(context, { saved })) };
}

test('an unrelated Save refreshes the catalogs but leaves the viewed session alone', async () => {
  const h = afterSave({ saved: { connectionIdentityChanged: false } });
  await h.run();
  assert.deepEqual(h.calls, ['loadGatewayCapabilities', 'loadModels', 'loadSkills', 'loadProfiles', 'loadSessions']);
});

test('a Save that changed the connection re-establishes the session', async () => {
  const h = afterSave({ saved: { connectionIdentityChanged: true } });
  await h.run();
  assert.equal(h.calls.at(-1), 'initializeSessionForPanelOpen');
});

test('a Save with no connection ready does nothing to the session', async () => {
  const h = afterSave({ saved: { connectionIdentityChanged: true }, ready: false });
  await h.run();
  assert.deepEqual(h.calls, []);
});

test('applyStoredSettingsAfterSave keeps a successor session when Save did not edit Session ID', () => {
  const stored = { sessionId: 'parent', remoteDashboardSession: { storedSessionId: 'parent' } };
  const live = {
    sessionId: 'child',
    remoteDashboardSession: { transport: 'rest', storedSessionId: 'child' },
  };
  const merged = applyStoredSettingsAfterSave(stored, live, {});
  assert.equal(merged.sessionId, 'child');
  assert.equal(merged.remoteDashboardSession.storedSessionId, 'child');
});

test('applyStoredSettingsAfterSave keeps the stored session when Save changed Session ID', () => {
  const stored = { sessionId: 'typed-id' };
  const live = { sessionId: 'child' };
  const owned = { sessionId: { had: true, from: 'parent', to: 'typed-id' } };
  assert.equal(applyStoredSettingsAfterSave(stored, live, owned).sessionId, 'typed-id');
});

test('a successful Save keeps the child session adopted while the write waited', async () => {
  const settings = rememberSavedConnection({
    ...base,
    activeSavedConnectionId: 'default',
    savedConnections: [{ id: 'default', name: 'Default', connection: { ...base } }],
    sessionId: 'parent',
    remoteDashboardSession: { transport: 'rest', storedSessionId: 'parent' },
  });
  const h = await createSettingsSaveHarness({ settings });
  try {
    const lineage = createSessionLineage();
    lineage.adopt('parent', 'child');
    Object.assign(h.scope, {
      queuedTurn: null,
      activeSessionRuntime: null,
      sessionLineage: lineage,
      sessionContextStore: { entries: {} },
      renameSessionContextEntry: (store) => store,
      scheduleSessionContextPersist: () => {},
      updateSessionLabel: () => {},
      saveSessionBindingForActiveScope: async () => {},
      setPackedBrowserSettings: async (next) => {
        Object.assign(h.store, await import('../extension/lib/saved-connections.mjs').then((m) => m.packSavedConnectionStorage(next, h.store[m.SAVED_CONNECTION_SECRETS_STORAGE_KEY] || {})));
      },
      refreshAfterSettingsSave: async () => {},
    });
    h.els.sessionIdInput.value = 'parent';
    h.els.sessionIdInput.dataset.syncedValue = 'parent';
    const read = h.fn('readBrowserSettingsFromStorage');
    h.scope.readBrowserSettingsFromStorage = async () => {
      await h.fn('adoptSessionSuccessor')('parent', 'child', null);
      return read();
    };
    h.els.includeTabsInput.checked = !h.scope.settings.includeTabs;
    await h.save();
    assert.equal(h.scope.settings.sessionId, 'child', 'the live successor stays on screen after Save');
    assert.equal(h.store.hermesBrowserSettings.sessionId, 'child', 'storage keeps the child id too');
  } finally {
    h.close();
  }
});

test('the Save handler passes what saveSettingsFromForm reports, and saveSettingsFromForm reports the identity change', () => {
  assert.match(source, /const saved = await saveSettingsFromForm\(\);\s*persisted = true;/);
  assert.match(source, /await refreshAfterSettingsSave\(saved\);/);
  const save = source.match(/async function saveSettingsFromForm\([^)]*\)[\s\S]*?\n\}\n/)[0];
  assert.match(save, /return \{\s*connectionIdentityChanged: identityChanged,/);
  assert.match(save, /connectionIdentityChanged\(previousSettings, settings, normalizeGatewayUrl\)/);
  assert.match(save, /settings = applyStoredSettingsAfterSave\(next, settings, changedBySave\);/);
});
