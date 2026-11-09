import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addSavedConnection,
  deleteSavedConnection,
  hydrateHermesBrowserSettingsFromStorage,
  hydrateSavedConnectionSecrets,
  packSavedConnectionStorage,
  rememberSavedConnection,
  renameSavedConnection,
  SAVED_CONNECTION_SECRETS_STORAGE_KEY,
  savedConnectionStorageKey,
  savedConnectionSummary,
  selectSavedConnection,
  savedConnectionsBase,
  withSavedConnectionsLock,
} from '../extension/lib/saved-connections.mjs';
import {
  decryptSavedConnectionSecretBag,
  isEncryptedSecretRecord,
} from '../extension/lib/saved-connection-secrets-crypto.mjs';
import { createRevisionGate } from '../extension/lib/context-scope-transition.mjs';
import { createSettingsSaveHarness } from './helpers/settings-save-harness.mjs';
import {
  CONTROLLER_WORKER_MESSAGES,
  createControllerServiceWorker,
} from '../extension/lib/controller-service-worker.mjs';

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
  assert.equal(home.savedConnectionSwitchRevision, work.savedConnectionSwitchRevision + 1);
  assert.equal(selectSavedConnection(home, 'work').savedConnectionSwitchRevision, home.savedConnectionSwitchRevision + 1);
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
    await h.fn('updateSavedConnection')('switch', { id: 'default' });
    assert.equal(h.store.hermesBrowserSettings.apiKey, '', 'packed storage does not keep a plaintext top-level key');
    assert.equal(h.store.hermesBrowserSettings.activeSavedConnectionId, 'default');
    assert.equal(h.store.hermesBrowserSettings.savedConnections.find((entry) => entry.id === 'work').connection.apiKey, '');
    assert.equal(JSON.stringify(h.store[SAVED_CONNECTION_SECRETS_STORAGE_KEY]).includes('updated-work-token'), false);
    const roundTrip = await hydrateSavedConnectionSecrets(
      h.store.hermesBrowserSettings,
      h.store[SAVED_CONNECTION_SECRETS_STORAGE_KEY],
    );
    assert.equal(roundTrip.apiKey, local.apiKey, 'hydrate restores the active connection key from the sidecar');
    assert.equal(roundTrip.savedConnections.find((entry) => entry.id === 'work').connection.apiKey, 'updated-work-token');
    assert.equal(h.callsTo('reload').length, 1);
    assert.equal(h.callsTo('toast').length, 0);
    h.scope.sending = true;
    await h.fn('updateSavedConnection')('switch', { id: 'work' });
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
    h.scope.savedConnectionTool = '';
    h.fn('renderSavedConnections')();
    assert.equal(h.els.savedConnectionList.querySelector('.conn-mode-title').textContent, '<img src=x>');
    assert.equal(h.els.savedConnectionList.querySelector('img'), null);
    assert.equal(h.els.savedConnectionDelete.disabled, true);
  } finally { h.close(); }
});

test('the cards mark the active connection and show the address, never the key', async () => {
  const h = await createSettingsSaveHarness({ settings: twoConnections() });
  try {
    h.scope.savedConnectionBusy = false;
    h.scope.savedConnectionTool = '';
    h.fn('renderSavedConnections')();
    const cards = [...h.els.savedConnectionList.querySelectorAll('[data-saved-connection-id]')];
    assert.deepEqual(cards.map((card) => card.dataset.savedConnectionId), ['default', 'work']);
    assert.deepEqual(cards.map((card) => card.getAttribute('aria-current')), [null, 'true']);
    assert.ok(cards[1].classList.contains('selected'));
    assert.doesNotMatch(h.els.savedConnectionList.textContent, /test-token/);
  } finally { h.close(); }
});

test('the connection tools show one state at a time: the buttons, the name field or the delete question', async () => {
  const h = await createSettingsSaveHarness({ settings: twoConnections() });
  try {
    h.scope.savedConnectionBusy = false;
    const shown = (tool) => {
      h.scope.savedConnectionTool = tool;
      h.fn('renderSavedConnections')();
      return ['savedConnectionActions', 'savedConnectionEditor', 'savedConnectionConfirm'].filter((id) => !h.els[id].hidden);
    };
    assert.deepEqual(shown(''), ['savedConnectionActions']);
    assert.deepEqual(shown('add'), ['savedConnectionEditor']);
    assert.deepEqual(shown('rename'), ['savedConnectionEditor']);
    assert.deepEqual(shown('delete'), ['savedConnectionConfirm']);
    assert.match(h.els.savedConnectionConfirmTitle.textContent, /connections\.delete_confirm .*work/i);
    h.scope.savedConnectionBusy = true;
    h.fn('renderSavedConnections')();
    assert.ok(h.els.savedConnectionDeleteConfirm.disabled && h.els.savedConnectionNameSave.disabled);
    assert.ok([...h.els.savedConnectionList.querySelectorAll('button')].every((card) => card.disabled));
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
    assert.equal(h.store[SAVED_CONNECTION_SECRETS_STORAGE_KEY]?.work?.apiKey || '', '');
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

test('switching after packed storage restores keys from the sidecar', async () => {
  const work = twoConnections();
  const packed = await packSavedConnectionStorage(work);
  assert.equal(packed.hermesBrowserSettings.savedConnections.find((entry) => entry.id === 'work').connection.apiKey, '');
  const storedSettings = await hydrateSavedConnectionSecrets(
    packed.hermesBrowserSettings,
    packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY],
  );
  const base = savedConnectionsBase(work, storedSettings, 'work');
  const next = selectSavedConnection(base, 'default');
  assert.equal(next.apiKey, local.apiKey);
  assert.equal(next.activeSavedConnectionId, 'default');
  assert.equal(selectSavedConnection(next, 'work').apiKey, 'work-test-token');
});

test('deleting a connection drops its sidecar credentials when packed', async () => {
  const packed = await packSavedConnectionStorage(twoConnections());
  const hydrated = await hydrateSavedConnectionSecrets(
    packed.hermesBrowserSettings,
    packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY],
  );
  const deleted = deleteSavedConnection(rememberSavedConnection(hydrated), 'work');
  const repacked = await packSavedConnectionStorage(deleted, packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY]);
  assert.equal(repacked[SAVED_CONNECTION_SECRETS_STORAGE_KEY].work, undefined);
  assert.equal(JSON.stringify(repacked[SAVED_CONNECTION_SECRETS_STORAGE_KEY]).includes('work-test-token'), false);
});

test('saved gateway keys live in a sidecar, not inside inactive savedConnections entries', async () => {
  const packed = await packSavedConnectionStorage(twoConnections());
  assert.equal(packed.hermesBrowserSettings.savedConnections.find((entry) => entry.id === 'work').connection.apiKey, '');
  const sidecarJson = JSON.stringify(packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY]);
  assert.match(sidecarJson, /"v":1/, 'sidecar stores encrypted v1 records');
  assert.equal(sidecarJson.includes('work-test-token'), false, 'plaintext key must not appear in storage');
  const restored = rememberSavedConnection(await hydrateSavedConnectionSecrets(
    packed.hermesBrowserSettings,
    packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY],
  ));
  assert.equal(restored.savedConnections.find((entry) => entry.id === 'work').connection.apiKey, 'work-test-token');
});

test('every open panel starts its own fresh chat after a switch, and later panels resume as set', async () => {
  const resumeLast = { ...twoConnections(), sessionStartupMode: 'resume-last' };
  const h = await createSettingsSaveHarness({ settings: resumeLast });
  const realSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const sessionStores = new Map();
  const openPanel = async (panelId) => {
    if (!sessionStores.has(panelId)) sessionStores.set(panelId, new Map([['hermesBrowserInstanceId', panelId]]));
    const map = sessionStores.get(panelId);
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)) },
    });
    h.scope.settings = structuredClone(h.store.hermesBrowserSettings);
    h.fn('noteSavedConnectionSwitchBaseline')?.();
    h.calls.length = 0;
    await h.fn('initializeSessionForPanelOpen')({ focus: false });
    return h.callsTo('beginHermesBrowserDraft').length ? 'fresh' : 'resumed';
  };
  try {
    Object.assign(h.scope, {
      minimumConnectionReady: () => true, setStatus: () => {}, makeBrowserSessionTitle: () => 'draft',
      beginHermesBrowserDraft: async () => { h.calls.push({ name: 'beginHermesBrowserDraft', args: [] }); },
      ensureSessionForActiveScope: async () => { h.calls.push({ name: 'ensureSessionForActiveScope', args: [] }); },
    });
    h.store.hermesBrowserSettings = selectSavedConnection(resumeLast, 'default');
    // Panels A and B were already open before the switch.
    for (const id of ['A', 'B']) sessionStores.set(id, new Map([['hermesBrowserInstanceId', id], ['hermesBrowserSavedConnectionSwitch:' + id, '0']]));
    assert.equal(await openPanel('A'), 'fresh');
    assert.equal(await openPanel('B'), 'fresh');
    assert.equal(await openPanel('A'), 'resumed', 'a panel that already started its chat resumes it');
    assert.equal(await openPanel('C'), 'resumed', 'a panel opened after the switch resumes as set');
  } finally {
    if (realSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', realSessionStorage);
    else delete globalThis.sessionStorage;
    h.close();
  }
});

test('a failed fresh chat after a switch still retries as a fresh chat', async () => {
  const resumeLast = { ...twoConnections(), sessionStartupMode: 'resume-last' };
  const h = await createSettingsSaveHarness({ settings: resumeLast });
  const realSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const session = new Map([
    ['hermesBrowserInstanceId', 'panel-1'],
    ['hermesBrowserSavedConnectionSwitch:panel-1', '0'],
  ]);
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key) => (session.has(key) ? session.get(key) : null),
      setItem: (key, value) => session.set(key, String(value)),
    },
  });
  try {
    let failDraft = true;
    Object.assign(h.scope, {
      minimumConnectionReady: () => true,
      setStatus: () => {},
      makeBrowserSessionTitle: () => 'draft',
      beginHermesBrowserDraft: async () => {
        if (failDraft) {
          failDraft = false;
          throw new Error('dashboard offline');
        }
        h.calls.push({ name: 'beginHermesBrowserDraft', args: [] });
      },
      ensureSessionForActiveScope: async () => { h.calls.push({ name: 'ensureSessionForActiveScope', args: [] }); },
    });
    h.store.hermesBrowserSettings = selectSavedConnection(resumeLast, 'default');
    h.scope.settings = structuredClone(h.store.hermesBrowserSettings);
    h.fn('noteSavedConnectionSwitchBaseline')();
    h.calls.length = 0;
    await assert.rejects(() => h.fn('initializeSessionForPanelOpen')({ focus: false }));
    assert.equal(h.callsTo('ensureSessionForActiveScope').length, 0, 'switch pending blocks resume path');
    h.calls.length = 0;
    await h.fn('initializeSessionForPanelOpen')({ focus: false });
    assert.equal(h.callsTo('beginHermesBrowserDraft').length, 1, 'retry still starts a fresh chat');
  } finally {
    if (realSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', realSessionStorage);
    else delete globalThis.sessionStorage;
    h.close();
  }
});

test('deleting a connection removes its stored records and does not save its departing draft', async () => {
  const h = await createSettingsSaveHarness({
    settings: twoConnections(),
    storage: {
      'hermesBrowserMessages:connection:work': [{ role: 'user', content: 'work chat' }],
      'hermesBrowserSessionBinding:tab:5:connection:work': { sessionId: 'work-session' },
      'hermesBrowserMessages:connection:other': [{ role: 'user', content: 'other chat' }],
      hermesBrowserMessages: [{ role: 'user', content: 'home chat' }],
    },
  });
  const realSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const session = new Map([['hermesBrowserInstanceId', 'panel-1'], ['hermesBrowserContextScope:panel-1:connection:work', '{}'], ['hermesBrowserContextScope:panel-1', '{}']]);
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key) => (session.has(key) ? session.get(key) : null),
      setItem: (key, value) => session.set(key, String(value)),
      removeItem: (key) => session.delete(key),
      get length() { return session.size; },
      key: (index) => [...session.keys()][index] ?? null,
    },
  });
  try {
    const reloads = [];
    Object.assign(h.scope, {
      savedConnectionBusy: false, sending: false, savedConnectionReloading: false,
      scopeRevision: createRevisionGate(), restoringComposerDraft: false, composerDraftSaveTimer: 0, attachments: [],
      renderSavedConnections: () => {}, showOperationToast: () => {}, stopConnectionProbeLoop: () => {},
      window: { confirm: () => true, location: { reload: () => reloads.push('reload') } },
    });
    h.els.input.value = 'half-written message';
    await h.fn('updateSavedConnection')('delete');
    assert.equal(reloads.length, 1);
    assert.equal(h.store.hermesBrowserSettings.activeSavedConnectionId, 'default');
    assert.deepEqual(Object.keys(h.store).filter((key) => key.endsWith(':connection:work')), []);
    assert.deepEqual([...session.keys()].filter((key) => key.endsWith(':connection:work')), []);
    assert.ok(h.store['hermesBrowserMessages:connection:other'], 'other connections keep their records');
    assert.ok(h.store.hermesBrowserMessages, 'the unsuffixed records are untouched');
    assert.ok(session.has('hermesBrowserContextScope:panel-1'));
  } finally {
    if (realSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', realSessionStorage);
    else delete globalThis.sessionStorage;
    h.close();
  }
});

async function openPanel(settings, shareWith) {
  const h = await createSettingsSaveHarness({ settings });
  if (shareWith) h.scope.browserApi = shareWith.scope.browserApi;
  else h.store.hermesBrowserSettings = structuredClone(settings);
  Object.assign(h.scope, {
    savedConnectionBusy: false, sending: false, savedConnectionReloading: false,
    scopeRevision: createRevisionGate(), restoringComposerDraft: false, composerDraftSaveTimer: 0, attachments: [],
    renderSavedConnections: () => {}, showOperationToast: () => {}, stopConnectionProbeLoop: () => {},
    persistCurrentComposerDraft: () => {},
    window: { location: { reload: () => {} } },
  });
  return h;
}

test('overlapping panel Add and Rename cannot lose a saved connection', async () => {
  const first = await openPanel(rememberSavedConnection(local), null);
  const second = await openPanel(rememberSavedConnection(local), first);
  try {
    await Promise.all([
      first.fn('updateSavedConnection')('add', { name: 'Added' }),
      second.fn('updateSavedConnection')('rename', { name: 'Renamed' }),
    ]);
    const stored = first.store.hermesBrowserSettings;
    assert.equal(stored.savedConnections.length, 2, 'the added connection is still saved');
    assert.ok(stored.savedConnections.some((entry) => entry.name === 'Added'));
    assert.ok(stored.savedConnections.some((entry) => entry.id === stored.activeSavedConnectionId), 'the active ID names a saved connection');
  } finally { first.close(); second.close(); }
});

test('Save from a panel holding an old connection list keeps the connections other panels added', async () => {
  const first = await openPanel(rememberSavedConnection(local), null);
  try {
    const base = rememberSavedConnection(local);
    first.store.hermesBrowserSettings = { ...base, savedConnections: [...base.savedConnections, { id: 'added', name: 'Added', connection: {} }] };
    await first.save();
    assert.deepEqual(first.store.hermesBrowserSettings.savedConnections.map((entry) => entry.id), ['default', 'added']);
  } finally { first.close(); }
});

test('saved connection changes queue behind each other, with or without cross-document locks', async () => {
  const events = [];
  const task = (name) => async () => { events.push(`${name}-start`); await Promise.resolve(); events.push(`${name}-end`); };
  await Promise.all([withSavedConnectionsLock(task('a'), null), withSavedConnectionsLock(task('b'), null)]);
  assert.deepEqual(events, ['a-start', 'a-end', 'b-start', 'b-end']);
  const requested = [];
  const locks = { request: (name, run) => { requested.push(name); return run(); } };
  assert.equal(await withSavedConnectionsLock(async () => 'ran', locks), 'ran');
  assert.deepEqual(requested, ['hermes-saved-connections']);
});

test('a stored record replaces the panel copy of the list and a changed active ID is refused', () => {
  const stale = rememberSavedConnection(local);
  const stored = addSavedConnection(stale, 'Work', 'work');
  assert.equal(savedConnectionsBase(stale, { ...stored, activeSavedConnectionId: 'work' }, 'work').savedConnections.length, 2);
  assert.throws(() => savedConnectionsBase(stale, stored, 'default'), /changed/);
  assert.equal(savedConnectionsBase(stale, {}, 'default'), stale);
});

test('legacy plaintext sidecar entries migrate through hydrate and encrypt on pack', async () => {
  const work = twoConnections();
  const merged = rememberSavedConnection(work);
  const legacySidecar = {
    work: { apiKey: 'work-test-token', tokenSource: 'manual' },
  };
  const hydrated = await hydrateSavedConnectionSecrets(merged, legacySidecar);
  assert.equal(hydrated.savedConnections.find((e) => e.id === 'work').connection.apiKey, 'work-test-token');
  const packed = await packSavedConnectionStorage(hydrated, legacySidecar);
  const rec = packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY].work;
  assert.ok(isEncryptedSecretRecord(rec), 're-pack encrypts legacy plaintext');
  assert.equal(JSON.stringify(packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY]).includes('work-test-token'), false);
  const round = await hydrateSavedConnectionSecrets(packed.hermesBrowserSettings, packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY]);
  assert.equal(round.savedConnections.find((e) => e.id === 'work').connection.apiKey, 'work-test-token');
});

test('when ciphertext cannot be decrypted, saved keys are treated as absent', async () => {
  const packed = await packSavedConnectionStorage(twoConnections());
  const encrypted = packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY].work;
  assert.ok(isEncryptedSecretRecord(encrypted));
  const tampered = { ...encrypted, ct: encrypted.ct.slice(0, -4) + 'BBBB' };
  assert.equal(await decryptSavedConnectionSecretBag(tampered), null);
  const hydrated = await hydrateSavedConnectionSecrets(
    packed.hermesBrowserSettings,
    { ...packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY], work: tampered },
  );
  assert.equal(hydrated.savedConnections.find((e) => e.id === 'work').connection.apiKey, '');
  assert.equal(hydrated.savedConnections.find((e) => e.id === 'work').connection.tokenSource, '');
});

test('hydrateHermesBrowserSettingsFromStorage restores packed credentials on worker boot', async () => {
  const packed = await packSavedConnectionStorage(rememberSavedConnection(local));
  const hydrated = await hydrateHermesBrowserSettingsFromStorage(packed);
  assert.equal(hydrated.apiKey, local.apiKey);
  assert.equal(packed.hermesBrowserSettings.apiKey, '');
});

test('controller worker boot hydrates apiKey when storage was packed', async () => {
  const packed = await packSavedConnectionStorage(rememberSavedConnection({
    ...local,
    browserControlEnabled: true,
    sessionId: 'boot-session',
  }));
  const connections = [];
  const worker = createControllerServiceWorker({
    storageArea: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.filter((key) => key === 'hermesBrowserSettings' || key === SAVED_CONNECTION_SECRETS_STORAGE_KEY)
          .map((key) => [key, structuredClone(packed[key])]));
      },
      async set() {},
    },
    connector: {
      async connect(options) {
        const connection = { options, async send() {}, async heartbeat() { return { ok: true }; }, close() {} };
        connections.push(connection);
        return connection;
      },
    },
    product: { id: 'chromium', engine: 'chromium', label: 'Chromium browser' },
    randomUUID: () => 'controller-boot-hydrate',
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });
  await worker.boot();
  assert.equal(connections[0]?.options?.settings?.apiKey, local.apiKey);
  assert.equal(packed.hermesBrowserSettings.apiKey, '');
});

test('saveSettingsFromForm and saved-connection packing leave no plaintext apiKey in stored blobs', async () => {
  const plaintextToken = 'sk-stored-blob-proof-token';
  const h = await createSettingsSaveHarness({ settings: twoConnections() });
  try {
    h.els.apiKeyInput.value = plaintextToken;
    await h.save();
    const blob = h.store.hermesBrowserSettings;
    assert.equal(blob.apiKey, '');
    assert.equal(blob.tokenSource, '');
    for (const entry of blob.savedConnections) {
      assert.equal(entry.connection.apiKey, '', `connection ${entry.id} must not store a plaintext apiKey`);
      assert.equal(entry.connection.tokenSource, '', `connection ${entry.id} must not store a plaintext tokenSource`);
    }
    assert.equal(JSON.stringify(h.store).includes(plaintextToken), false, 'no plaintext secret in any storage key');

    const switched = await packSavedConnectionStorage(
      selectSavedConnection(twoConnections(), 'work'),
      h.store[SAVED_CONNECTION_SECRETS_STORAGE_KEY],
    );
    for (const entry of switched.hermesBrowserSettings.savedConnections) {
      assert.equal(entry.connection.apiKey, '');
      assert.equal(entry.connection.tokenSource, '');
    }
    assert.equal(switched.hermesBrowserSettings.apiKey, '');
  } finally {
    h.close();
  }
});

test('after Save, hydrated storage reads restore the active gateway key for followers', async () => {
  const h = await createSettingsSaveHarness({ settings: twoConnections() });
  try {
    h.els.apiKeyInput.value = 'rotated-work-token';
    await h.save();
    assert.equal(h.store.hermesBrowserSettings.apiKey, '', 'pack clears the top-level key in storage');
    const hydrated = await hydrateHermesBrowserSettingsFromStorage(h.store);
    assert.equal(hydrated.apiKey, 'rotated-work-token', 'readers must hydrate before using credentials');
    assert.equal(
      hydrated.savedConnections.find((entry) => entry.id === 'work').connection.apiKey,
      'rotated-work-token',
    );
    assert.equal(JSON.stringify(h.store).includes('rotated-work-token'), false);
  } finally {
    h.close();
  }
});

test('pause in another panel keeps a saved-connection switch already in storage', async () => {
  const panelSettings = rememberSavedConnection(local);
  const state = {
    hermesBrowserSettings: structuredClone(panelSettings),
    [SAVED_CONNECTION_SECRETS_STORAGE_KEY]: {},
  };
  const worker = createControllerServiceWorker({
    storageArea: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.filter((key) => Object.hasOwn(state, key))
          .map((key) => [key, structuredClone(Reflect.get(state, key))]));
      },
      async set(values) { Object.assign(state, structuredClone(values)); },
    },
    connector: {
      async connect() {
        return { async send() {}, async heartbeat() { return { ok: true }; }, close() {} };
      },
    },
    product: { id: 'chromium', engine: 'chromium', label: 'Chromium browser' },
    randomUUID: () => 'controller-pause-fixture',
    extensionOrigin: 'chrome-extension://fixture',
    now: () => 1_000,
  });
  await worker.boot();
  Object.assign(state, await packSavedConnectionStorage(selectSavedConnection(twoConnections(), 'default'), {
    work: { apiKey: 'work-test-token', tokenSource: 'manual' },
  }));
  await worker.handleMessage(
    { type: CONTROLLER_WORKER_MESSAGES.pause },
    { url: 'chrome-extension://fixture/sidepanel.html' },
  );
  assert.equal(state.hermesBrowserSettings.activeSavedConnectionId, 'default');
  assert.equal(state.hermesBrowserSettings.savedConnections.length, 2);
  assert.equal(state.hermesBrowserSettings.browserControlPaused, true);
});

test('a saved connection is summarised by its kind and address, never by its credential', () => {
  const labels = { local: 'Local gateway', cloud: 'Hermes Cloud', remote: 'Remote gateway' };
  assert.equal(savedConnectionSummary({ connectionMode: 'local', gatewayUrl: 'http://127.0.0.1:8642', apiKey: 'secret-value' }, labels), 'Local gateway · 127.0.0.1:8642');
  assert.equal(savedConnectionSummary({ connectionMode: 'remote', gatewayUrl: 'https://hermes.example/path?token=abc' }, labels), 'Remote gateway · hermes.example');
  assert.equal(savedConnectionSummary({ connectionMode: 'cloud', gatewayUrl: 'https://cloud.example' }, labels), 'Hermes Cloud');
  assert.equal(savedConnectionSummary({ connectionMode: 'remote', gatewayUrl: 'not a url' }, labels), 'Remote gateway');
  assert.equal(savedConnectionSummary({}, labels), 'Local gateway');
  assert.doesNotMatch(savedConnectionSummary({ connectionMode: 'remote', gatewayUrl: 'https://user:pass@hermes.example/x' }, labels), /pass|user/);
});
