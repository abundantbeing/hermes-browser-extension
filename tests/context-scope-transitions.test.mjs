import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_SCOPE_MODES,
  DEFAULT_CONTEXT_SCOPE,
  contextScopeFromTab,
  normalizeContextScope,
} from '../extension/lib/context-scope.mjs';
import {
  createRevisionGate,
  resetContextScope,
  resolveContextScopeAction,
  restoreConversationSessionState,
  shouldPreserveDashboardTransport,
  snapshotConversationSessionState,
} from '../extension/lib/context-scope-transition.mjs';

const ownerTab = {
  id: 101,
  windowId: 7,
  title: 'Owner tab',
  url: 'https://owner.example/',
};

const otherTab = {
  id: 202,
  windowId: 7,
  title: 'Other tab',
  url: 'https://other.example/',
};

test('clicking the explicitly pinned row again resets global scope to follow-active page-only', () => {
  const currentScope = contextScopeFromTab(otherTab, {
    ...DEFAULT_CONTEXT_SCOPE,
    selectedTabIds: [101, 202],
  });
  const result = resolveContextScopeAction({
    currentScope,
    targetTab: otherTab,
    panelMode: 'global',
  });

  assert.equal(result.kind, 'reset');
  assert.deepEqual(result.scope, normalizeContextScope({
    mode: CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE,
    selectedTabIds: [],
  }));
});

test('clicking the pinned row again in an attached panel returns to the fresh owner tab', () => {
  const currentScope = contextScopeFromTab(otherTab, DEFAULT_CONTEXT_SCOPE);
  const result = resolveContextScopeAction({
    currentScope,
    targetTab: otherTab,
    panelMode: 'tab-attached',
    attachedTab: ownerTab,
  });

  assert.equal(result.kind, 'reset');
  assert.equal(result.scope.mode, CONTEXT_SCOPE_MODES.PINNED_TAB);
  assert.equal(result.scope.pinnedTabId, ownerTab.id);
  assert.equal(result.scope.pinnedTitle, ownerTab.title);
  assert.equal(result.scope.pinnedUrl, ownerTab.url);
  assert.deepEqual(result.scope.selectedTabIds, []);
});

test('explicit reset is available from Chat only without changing panel residency semantics', () => {
  const result = resetContextScope({
    panelMode: 'tab-attached',
    attachedTab: ownerTab,
    previousScope: { mode: CONTEXT_SCOPE_MODES.CHAT_ONLY },
  });

  assert.equal(result.mode, CONTEXT_SCOPE_MODES.PINNED_TAB);
  assert.equal(result.pinnedTabId, ownerTab.id);
  assert.deepEqual(result.selectedTabIds, []);
});

test('pinning a different tab remains a pin action and does not alter prompt inclusion policy', () => {
  const currentScope = normalizeContextScope({
    mode: CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE,
    selectedTabIds: [ownerTab.id],
  });
  const result = resolveContextScopeAction({
    currentScope,
    targetTab: otherTab,
    panelMode: 'global',
  });

  assert.equal(result.kind, 'pin');
  assert.equal(result.scope.mode, CONTEXT_SCOPE_MODES.PINNED_TAB);
  assert.equal(result.scope.pinnedTabId, otherTab.id);
  assert.deepEqual(result.scope.selectedTabIds, [ownerTab.id]);
});

test('revision gate rejects delayed work after a newer scope intent', () => {
  const gate = createRevisionGate();
  const first = gate.begin();
  const second = gate.begin();

  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  assert.equal(gate.current(), second);
});

test('dashboard session-operation errors preserve a healthy same-identity socket', () => {
  assert.equal(shouldPreserveDashboardTransport({
    requestedTransport: 'dashboard-ws',
    connectionReadyState: 1,
    error: new Error('session.create rejected'),
  }), true);
  assert.equal(shouldPreserveDashboardTransport({
    requestedTransport: 'dashboard-ws',
    connectionReadyState: 3,
    error: new Error('socket closed'),
  }), false);
  assert.equal(shouldPreserveDashboardTransport({
    requestedTransport: 'rest',
    connectionReadyState: 1,
    error: new Error('session failed'),
  }), false);
});

test('sidepanel pin/reset integration uses the production transition helper', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const pinStart = source.indexOf('async function pinContextTab(');
  const pinEnd = source.indexOf('\nasync function unlockContextScope', pinStart);
  const unlockStart = source.indexOf('async function unlockContextScope');
  const unlockEnd = source.indexOf('\nfunction setGatewayCapabilities', unlockStart);
  const pinRegion = source.slice(pinStart, pinEnd);
  const unlockRegion = source.slice(unlockStart, unlockEnd);
  assert.ok(pinStart >= 0 && pinEnd > pinStart, 'pin source region must exist');
  assert.ok(unlockStart >= 0 && unlockEnd > unlockStart, 'unlock source region must exist');
  assert.match(pinRegion, /resolveContextScopeAction/);
  assert.match(pinRegion, /isAttachedPanelResidency/);
  assert.match(unlockRegion, /resetContextScope/);
  assert.match(unlockRegion, /isAttachedPanelResidency/);
});

test('sidepanel async scope publication is revision-guarded at storage and capture boundaries', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const loadStart = source.indexOf('async function loadMessagesForActiveScope');
  const loadEnd = source.indexOf('\nasync function saveMessagesForActiveScope', loadStart);
  const refreshStart = source.indexOf('async function refreshContext(options');
  const refreshEnd = source.indexOf('\nfunction setRefreshButtonBusy', refreshStart);
  const loadRegion = source.slice(loadStart, loadEnd);
  const refreshRegion = source.slice(refreshStart, refreshEnd);
  assert.match(loadRegion, /scopeRevision/);
  assert.match(loadRegion, /isCurrent/);
  assert.match(refreshRegion, /scopeRevision/);
  assert.match(refreshRegion, /contextRefreshRevision/);
  assert.match(refreshRegion, /isCurrent/);
});

test('sidepanel dashboard session failures do not unconditionally discard a healthy transport', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const createStart = source.indexOf('async function createHermesBrowserSession');
  const createEnd = source.indexOf('\nfunction renderSessionHistoryLoading', createStart);
  const createRegion = source.slice(createStart, createEnd);
  assert.doesNotMatch(createRegion, /activeConversationTransport = 'rest';\s*\n\s*activeDashboardWsConnection = null;\s*\n\s*const sessionId/);
  assert.match(createRegion, /shouldPreserveDashboardTransport/);
});

test('scope transitions propagate superseded or failed session operations', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function ensureSessionForActiveScope');
  const end = source.indexOf('\nasync function initializeSessionForPanelOpen', start);
  const region = source.slice(start, end);

  assert.match(region, /return openHermesSession\(session, \{ scopeRevisionId \}\)/);
  assert.match(region, /return beginHermesBrowserDraft\(\{/);
});

test('failed session binding restores the coherent pre-transition scope', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function commitContextScope');
  const end = source.indexOf('\nfunction applyContextScope', start);
  const region = source.slice(start, end);

  assert.match(region, /const sessionReady = await ensureSessionForActiveScope/);
  assert.match(region, /if \(!sessionReady\)/);
  assert.match(region, /restoreScopeTransitionSnapshot\(snapshot\)/);
});

test('pin and global reset preserve the prior non-pinned conversation identity', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function commitContextScope');
  const end = source.indexOf('\nfunction applyContextScope', start);
  const region = source.slice(start, end);

  assert.match(source, /function rememberNonPinnedConversationSession[\s\S]*snapshotConversationSessionState/);
  assert.match(source, /function restoreNonPinnedConversationSession[\s\S]*restoreConversationSessionState/);
  assert.match(region, /openHermesSession\(restoredSession/);
});

test('chat-only scope intents publish privacy immediately but still join the transition queue', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const start = source.indexOf('function applyContextScope');
  const end = source.indexOf('\nasync function resolveAttachedPanelOwnerTab', start);
  const region = source.slice(start, end);

  assert.match(region, /const normalizedScope = normalizeContextScope\(nextScope\)/);
  assert.match(region, /normalizedScope\.mode === CONTEXT_SCOPE_MODES\.CHAT_ONLY/);
  assert.match(region, /contextScope = normalizedScope/);
  assert.match(region, /scopeTransitionQueue\.then\(transition, transition\)/);
});

test('scope transitions derive pin/reset boundaries from the remembered conversation and rollback durable settings', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function commitContextScope');
  const end = source.indexOf('\nfunction applyContextScope', start);
  const region = source.slice(start, end);
  const refreshIndex = region.indexOf('await refreshContext({ scopeRevisionId })');
  const tryIndex = region.indexOf('try {');

  assert.match(region, /const conversationScope = conversationScopeForContextScope\(contextScope, previousConversationScope\)/);
  assert.match(region, /conversationScope\.mode !== CONTEXT_SCOPE_MODES\.PINNED_TAB/);
  assert.ok(tryIndex >= 0 && tryIndex < refreshIndex, 'refresh must be inside the rollback boundary');
  assert.match(region, /browserApi\.storage\.local\.set\(\{ hermesBrowserSettings: snapshot\.settings \}\)/);
});

test('pinning a stale menu row fails closed instead of reusing a closed tab snapshot', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function pinContextTabById');
  const end = source.indexOf('\nasync function unlockContextScope', start);
  const region = source.slice(start, end);

  assert.match(region, /catch \(_error\) \{[\s\S]*return false;/);
  assert.doesNotMatch(region, /Fall back to the snapshot from the menu/);
});

test('check:js syntax-checks the transition helper', async () => {
  const { readFile } = await import('node:fs/promises');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(packageJson.scripts['check:js'], /node --check extension\/lib\/context-scope-transition\.mjs/);
});

test('conversation snapshots restore non-pinned identity without copying connection secrets', () => {
  const secretField = ['api', 'Key'].join('');
  const snapshot = snapshotConversationSessionState({
    settings: {
      [secretField]: 'credential-placeholder',
      sessionId: 'global-session',
      sessionTitle: 'Global chat',
      sessionSource: 'Browser',
      model: 'model-a',
      provider: 'provider-a',
      sessionModelBindings: { 'global-session': { modelId: 'model-a' } },
      sessionModelOptionBindings: { 'global-session': { reasoning: 'low' } },
    },
    activeSessionRuntime: { sessionId: 'global-session', usedTokens: 4 },
    sessionRoutesAvailable: true,
    transport: 'dashboard-ws',
  });

  assert.equal(snapshot.settings[secretField], undefined);
  assert.equal(snapshot.settings.sessionId, 'global-session');

  const restored = restoreConversationSessionState({
    [secretField]: 'credential-placeholder',
    sessionId: 'pinned-session',
  }, snapshot);
  assert.equal(restored.settings[secretField], 'credential-placeholder');
  assert.equal(restored.settings.sessionId, 'global-session');
  assert.equal(restored.activeSessionRuntime.sessionId, 'global-session');
  assert.equal(restored.transport, 'dashboard-ws');
});
