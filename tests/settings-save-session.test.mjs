// Saving Settings must not replace the session on screen unless the connection it belongs to changed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { applyStoredSettingsAfterSave, connectionIdentityChanged } from '../extension/lib/settings-save-effects.mjs';
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
  const stored = { sessionId: 'parent', sessionTitle: 'Parent title', remoteDashboardSession: { storedSessionId: 'parent' } };
  const live = {
    sessionId: 'child',
    sessionTitle: 'Child title',
    remoteDashboardSession: { transport: 'rest', storedSessionId: 'child' },
  };
  const merged = applyStoredSettingsAfterSave(stored, live, {});
  assert.equal(merged.sessionId, 'child');
  assert.equal(merged.sessionTitle, 'Child title');
  assert.equal(merged.remoteDashboardSession.storedSessionId, 'child');
});

test('applyStoredSettingsAfterSave keeps the stored session when Save changed Session ID', () => {
  const stored = { sessionId: 'typed-id', sessionTitle: 'Typed title' };
  const live = { sessionId: 'child', sessionTitle: 'Child title' };
  const owned = { sessionId: { had: true, from: 'parent', to: 'typed-id' } };
  const merged = applyStoredSettingsAfterSave(stored, live, owned);
  assert.equal(merged.sessionId, 'typed-id');
  assert.equal(merged.sessionTitle, 'Typed title');
});

test('applyStoredSettingsAfterSave keeps the stored title when Save edited Session title', () => {
  const stored = { sessionId: 'parent', sessionTitle: 'Typed rename' };
  const live = { sessionId: 'child', sessionTitle: 'Child title' };
  const owned = { sessionTitle: { had: true, from: 'Parent title', to: 'Typed rename' } };
  const merged = applyStoredSettingsAfterSave(stored, live, owned);
  assert.equal(merged.sessionId, 'child');
  assert.equal(merged.sessionTitle, 'Typed rename');
});

test('a successful Save keeps the child session adopted while the write waited', async () => {
  const settings = rememberSavedConnection({
    ...base,
    activeSavedConnectionId: 'default',
    savedConnections: [{ id: 'default', name: 'Default', connection: { ...base } }],
    sessionId: 'parent',
    sessionTitle: 'Parent title',
    remoteDashboardSession: { transport: 'rest', storedSessionId: 'parent' },
  });
  const h = await createSettingsSaveHarness({ settings });
  try {
    const renames = [];
    Object.assign(h.scope, {
      availableSessions: [
        { id: 'parent', title: 'Parent title' },
        { id: 'child', title: 'Child title' },
      ],
      renameHermesSessionTitle: async (id, title) => { renames.push({ id, title }); return true; },
      refreshAfterSettingsSave: async () => {},
    });
    h.els.sessionIdInput.value = 'parent';
    h.els.sessionIdInput.dataset.syncedValue = 'parent';
    h.els.sessionTitleInput.value = 'Parent title';
    const persist = h.fn('persistHermesBrowserSettings');
    h.scope.persistHermesBrowserSettings = async (next, options) => {
      assert.equal(next.sessionId, 'parent', 'next was built before the successor landed');
      assert.equal(next.sessionTitle, 'Parent title', 'next keeps the title the form snapshot had');
      // The chat advanced after next was frozen while its write is still queued behind Save.
      h.scope.settings = {
        ...h.scope.settings,
        sessionId: 'child',
        sessionTitle: 'Child title',
        remoteDashboardSession: { transport: 'rest', storedSessionId: 'child' },
      };
      return persist(next, options);
    };
    h.els.includeTabsInput.checked = !h.scope.settings.includeTabs;
    await h.save();
    assert.equal(h.scope.settings.sessionId, 'child', 'the live successor stays on screen after Save');
    assert.equal(h.scope.settings.sessionTitle, 'Child title', 'the live chat keeps its own title');
    assert.deepEqual(renames, [], 'Save does not rename the newly opened chat to the previous title');
    const storedSession = (await h.scope.browserApi.storage.local.get('hermesBrowserSettings')).hermesBrowserSettings;
    assert.equal(storedSession.sessionId, 'parent', 'storage still carries the write that landed first');
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
