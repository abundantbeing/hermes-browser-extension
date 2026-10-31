// Saving Settings must not replace the session on screen unless the connection it belongs to changed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { connectionIdentityChanged } from '../extension/lib/settings-save-effects.mjs';
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

test('the Save handler passes what saveSettingsFromForm reports, and saveSettingsFromForm reports the identity change', () => {
  assert.match(source, /const saved = await saveSettingsFromForm\(\);\s*persisted = true;/);
  assert.match(source, /await refreshAfterSettingsSave\(saved\);/);
  const save = source.match(/async function saveSettingsFromForm\(\)[\s\S]*?\n\}\n/)[0];
  assert.match(save, /return \{ connectionIdentityChanged: identityChanged \};/);
  assert.match(save, /connectionIdentityChanged\(previousSettings, settings, normalizeGatewayUrl\)/);
});
