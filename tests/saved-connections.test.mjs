import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addSavedConnection,
  deleteSavedConnection,
  rememberSavedConnection,
  renameSavedConnection,
  savedConnectionStorageKey,
  selectSavedConnection,
} from '../extension/lib/saved-connections.mjs';
import { createRevisionGate } from '../extension/lib/context-scope-transition.mjs';
import { createSettingsSaveHarness } from './helpers/settings-save-harness.mjs';

const local = {
  gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642',
  apiKey: 'local-test-token', tokenSource: 'pairing', appearanceTheme: 'nous',
};

function twoConnections() {
  const added = addSavedConnection(local, 'Work', 'work');
  return rememberSavedConnection({
    ...added, connectionMode: 'remote', connectionTransport: 'remote-api', gatewayMode: 'remote-api',
    gatewayUrl: 'https://work.example.test', apiKey: 'work-test-token', tokenSource: 'manual',
  });
}

test('existing settings become the first connection without losing credentials', () => {
  const state = rememberSavedConnection(local, 'This computer');
  assert.equal(state.activeSavedConnectionId, 'default');
  assert.equal(state.savedConnections.length, 1);
  assert.equal(state.savedConnections[0].name, 'This computer');
  assert.equal(state.savedConnections[0].connection.apiKey, local.apiKey);
  const legacy = rememberSavedConnection({ gatewayMode: 'remote-api', gatewayUrl: 'https://remote.example.test' });
  assert.equal(legacy.savedConnections[0].connection.connectionMode, 'remote');
});

test('switching round trips each address and key and clears session and control state', () => {
  const work = {
    ...twoConnections(), sessionId: 'work-session', activeProfile: 'work-bot',
    remoteDashboardSession: { storedId: 'work-session' }, agentToken: 'legacy-secret',
    browserControlEnabled: true, sessionModelBindings: { 'work-session': { modelId: 'work-model' } },
    extensionPreferredModel: { modelId: 'work-model' },
  };
  const home = selectSavedConnection(work, 'default');
  assert.equal(home.gatewayUrl, local.gatewayUrl);
  assert.equal(home.apiKey, local.apiKey);
  assert.equal(home.tokenSource, 'pairing');
  assert.equal(home.appearanceTheme, 'nous');
  assert.equal(home.activeProfile, '');
  assert.equal(home.sessionId, '');
  assert.equal(home.browserControlEnabled, false);
  assert.equal(home.remoteDashboardSession, null);
  assert.equal(home.agentToken, '');
  assert.equal(home.extensionPreferredModel, null);
  assert.deepEqual(home.sessionModelBindings, {});
  assert.equal(home.savedConnectionNeedsNewSession, true);
  const back = selectSavedConnection(home, 'work');
  assert.equal(back.gatewayUrl, 'https://work.example.test');
  assert.equal(back.apiKey, 'work-test-token');
  assert.equal(back.savedConnections.length, 2);
});

test('new connections have no inherited credentials; revoked keys are not resurrected', () => {
  const added = addSavedConnection(local, 'Work', 'work');
  assert.equal(added.apiKey, '');
  assert.equal(added.tokenSource, '');
  const revoked = { ...twoConnections(), apiKey: '', tokenSource: '' };
  const home = selectSavedConnection(revoked, 'default');
  assert.equal(selectSavedConnection(home, 'work').apiKey, '');
});

test('saved records allow only connection configuration and keep Cloud keyless', () => {
  const current = rememberSavedConnection({
    ...local, accountTokens: 'private', ticket: 'single-use', sessionId: 'session-private',
    savedConnections: [null, { id: 'bad id' }, { id: 7 }, { id: 'default', name: '<b>Home</b>', connection: null }, { id: 'default' }],
  });
  assert.equal(current.savedConnections.length, 1);
  assert.equal(current.savedConnections[0].name, '<b>Home</b>');
  for (const field of ['accountTokens', 'ticket', 'sessionId', 'savedConnections']) {
    assert.equal(field in current.savedConnections[0].connection, false, field);
  }
  const cloud = rememberSavedConnection({
    ...local, connectionSchemaVersion: 1, connectionMode: 'cloud', apiKey: 'stale-local-key',
  });
  assert.equal(cloud.savedConnections[0].connection.apiKey, '');
});

test('rename preserves configuration and deletion switches before removing the active record', () => {
  const renamed = renameSavedConnection(twoConnections(), 'work', 'Production');
  assert.equal(renamed.savedConnections.find((entry) => entry.id === 'work').name, 'Production');
  assert.equal(renamed.apiKey, 'work-test-token');
  const deleted = deleteSavedConnection(renamed, 'work');
  assert.equal(deleted.activeSavedConnectionId, 'default');
  assert.equal(deleted.apiKey, local.apiKey);
  assert.equal(JSON.stringify(deleted).includes('work-test-token'), false);
  assert.throws(() => deleteSavedConnection(deleted, 'default'));
  assert.throws(() => selectSavedConnection(deleted, 'missing'));
});

test('drafts and caches are separated while legacy connection keys keep working', () => {
  assert.equal(savedConnectionStorageKey({}, 'draft'), 'draft');
  assert.equal(savedConnectionStorageKey({ activeSavedConnectionId: 'default' }, 'draft'), 'draft');
  assert.equal(savedConnectionStorageKey({ activeSavedConnectionId: 'work' }, 'draft'), 'draft:connection:work');
});

test('the panel switch saves form edits, persists the selected key and reloads once', async () => {
  const h = await createSettingsSaveHarness({ settings: twoConnections() });
  try {
    h.scope.savedConnectionBusy = false;
    h.scope.sending = false;
    h.scope.reloadForSavedConnection = (next) => {
      h.calls.push({ name: 'reload', args: [next] });
      h.scope.settings = next;
    };
    h.scope.renderSavedConnections = () => {};
    h.scope.showOperationToast = (value) => h.calls.push({ name: 'toast', args: [value] });
    h.els.gatewayUrlInput.value = 'https://work.example.test';
    h.els.connectionModeInput.value = 'remote';
    h.els.apiKeyInput.value = 'updated-work-token';
    await h.fn('updateSavedConnection')('switch', 'default');
    assert.equal(h.store.hermesBrowserSettings.apiKey, local.apiKey);
    assert.equal(h.store.hermesBrowserSettings.activeSavedConnectionId, 'default');
    assert.equal(h.store.hermesBrowserSettings.savedConnections.find((entry) => entry.id === 'work').connection.apiKey, 'updated-work-token');
    assert.equal(h.callsTo('reload').length, 1);
    assert.equal(h.callsTo('toast').length, 0);
    h.scope.sending = true;
    await h.fn('updateSavedConnection')('switch', 'work');
    assert.equal(h.callsTo('reload').length, 1, 'an active reply blocks switching');
  } finally { h.close(); }
});

test('the real reload closes each socket once and preserves the departing draft first', async () => {
  const h = await createSettingsSaveHarness({ settings: twoConnections() });
  try {
    const events = [];
    const sharedClient = { close: () => events.push('close-shared') };
    h.scope.remoteWsConnection = { client: sharedClient };
    h.scope.activeDashboardWsConnection = { client: sharedClient };
    h.scope.profileWsConnection = { client: { close: () => events.push('close-profile') } };
    h.scope.savedConnectionReloading = false;
    h.scope.scopeRevision = createRevisionGate();
    h.scope.persistCurrentComposerDraft = () => events.push(`draft-${h.scope.settings.activeSavedConnectionId}`);
    h.scope.stopConnectionProbeLoop = () => events.push('stop-probe');
    h.scope.window = { location: { reload: () => events.push('reload') } };
    const next = selectSavedConnection(h.scope.settings, 'default');
    h.fn('reloadForSavedConnection')(next);
    h.fn('reloadForSavedConnection')(next);
    assert.deepEqual(events, ['draft-work', 'stop-probe', 'close-shared', 'close-profile', 'reload']);
    assert.equal(h.scope.settings.activeSavedConnectionId, 'default');
  } finally { h.close(); }
});

test('connection labels are rendered as text and the last connection cannot be deleted', async () => {
  const h = await createSettingsSaveHarness({ settings: rememberSavedConnection(local, '<img src=x>') });
  try {
    h.scope.savedConnectionBusy = false;
    h.fn('renderSavedConnections')();
    assert.equal(h.els.savedConnectionSelect.options[0].textContent, '<img src=x>');
    assert.equal(h.els.savedConnectionSelect.querySelector('img'), null);
    assert.equal(h.els.savedConnectionDelete.disabled, true);
  } finally { h.close(); }
});

test('clearing the token also clears it from the active saved connection right away', async () => {
  const h = await createSettingsSaveHarness({ settings: twoConnections() });
  try {
    Object.assign(h.scope, {
      els: { ...h.els, apiKeyInput: { value: 'work-test-token' } },
      setLocalDashboardUrl: () => {}, resetLocalDashboardState: () => {}, clearCachedRosterUrl: async () => {},
      browserControlMessage: async () => null, markConnectionProbe: () => {}, setGatewayCapabilities: () => {},
      normalizeGatewayCapabilities: () => ({}), setStatus: () => {},
    });
    await h.fn('clearStoredToken')();
    const stored = h.store.hermesBrowserSettings;
    assert.equal(stored.apiKey, '');
    const work = stored.savedConnections.find((entry) => entry.id === 'work');
    assert.equal(work.connection.apiKey, '');
    assert.equal(work.connection.tokenSource, '');
    assert.equal(JSON.stringify(stored).includes('work-test-token'), false);
  } finally { h.close(); }
});

test('a switch from another panel stops a pending scope change here from writing its old settings back', async () => {
  const h = await createSettingsSaveHarness({ settings: twoConnections() });
  try {
    const { scope } = h;
    const followActive = { mode: 'follow-active', pinnedTabId: null };
    const pinned = { mode: 'pinned-tab', pinnedTabId: 5 };
    const rejections = [];
    const openingSession = new Promise((resolve, reject) => rejections.push(reject));
    Object.assign(scope, {
      scopeRevision: createRevisionGate(),
      contextScope: followActive, previousConversationScope: followActive, selectedTabs: null,
      currentContext: { tabs: [] }, messages: [], availableSessions: [], activeSessionRuntime: null,
      sessionRoutesAvailable: null, loadedSessionContextEstimate: 0, activeGroupProjection: null,
      rememberNonPinnedConversationSession: () => {}, rememberConversationScope: () => {},
      saveConversationScopeForInstance: () => {}, saveContextScopeForInstance: () => {},
      syncSelectedTabsFromContextScope: () => {}, renderContextScopeControls: () => {},
      renderMessagesFromStorage: () => {}, updateSessionLabel: () => {}, renderSessionMenu: () => {},
      loadMessagesForActiveScope: async () => true,
      ensureSessionForActiveScope: () => openingSession,
      refreshContext: async () => {},
      persistCurrentComposerDraft: () => {}, stopConnectionProbeLoop: () => {},
      savedConnectionReloading: false, window: { location: { reload: () => {} } },
    });
    scope.remoteWsConnection = { client: { close: () => rejections.forEach((reject) => reject(new Error('socket closed'))) } };
    const revisionId = scope.scopeRevision.begin();
    const pending = h.fn('commitContextScope')(pinned, { ensureSession: true, scopeRevisionId: revisionId });
    await Promise.resolve();
    const selected = selectSavedConnection(scope.settings, 'default');
    h.store.hermesBrowserSettings = selected;
    h.fn('reloadForSavedConnection')(selected);
    await pending.catch(() => {});
    assert.equal(h.store.hermesBrowserSettings.activeSavedConnectionId, 'default');
    assert.equal(h.store.hermesBrowserSettings.apiKey, local.apiKey);
  } finally { h.close(); }
});
