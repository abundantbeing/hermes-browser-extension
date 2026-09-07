import {
  CONTEXT_SCOPE_MODES,
  DEFAULT_CONTEXT_SCOPE,
  contextScopeFromTab,
  normalizeContextScope,
} from './context-scope.mjs';
import { normalizePanelResidencyMode, PANEL_RESIDENCY_MODES } from './panel-residency.mjs';
import { isSessionBindingValid, sessionBindingIdentity } from './common.mjs';

function finiteTabId(value) {
  if (value == null || typeof value === 'boolean' || String(value).trim() === '') return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

function conversationIdentity(settings) {
  return sessionBindingIdentity({
    gatewayUrl: settings.gatewayUrl,
    gatewayMode: settings.gatewayMode,
    profile: settings.activeProfile,
  });
}

function conversationSettings(settings) {
  return {
    sessionId: String(settings.sessionId || ''),
    sessionTitle: String(settings.sessionTitle || ''),
    sessionSource: String(settings.sessionSource || ''),
    model: String(settings.model || ''),
    provider: String(settings.provider || ''),
    modelContextTokens: settings.modelContextTokens,
    sessionModelBindings: cloneSessionStateRecord(settings.sessionModelBindings),
    sessionModelOptionBindings: cloneSessionStateRecord(settings.sessionModelOptionBindings),
  };
}

export function resetContextScope({
  panelMode = PANEL_RESIDENCY_MODES.GLOBAL,
  attachedTab = null,
  attachedTabId = null,
  previousScope = DEFAULT_CONTEXT_SCOPE,
} = {}) {
  const normalizedMode = normalizePanelResidencyMode(panelMode);
  const ownerId = finiteTabId(attachedTab?.id ?? attachedTabId);
  if (normalizedMode === PANEL_RESIDENCY_MODES.TAB_ATTACHED && ownerId !== null) {
    return normalizeContextScope({
      ...previousScope,
      mode: CONTEXT_SCOPE_MODES.PINNED_TAB,
      pinnedTabId: ownerId,
      pinnedWindowId: attachedTab?.windowId ?? null,
      pinnedTitle: attachedTab?.title || '',
      pinnedUrl: attachedTab?.url || '',
      selectedTabIds: [],
    });
  }
  return normalizeContextScope({
    ...previousScope,
    mode: CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE,
    pinnedTabId: null,
    pinnedWindowId: null,
    pinnedTitle: '',
    pinnedUrl: '',
    selectedTabIds: [],
  });
}

export function resolveContextScopeAction({
  currentScope = DEFAULT_CONTEXT_SCOPE,
  targetTab = null,
  panelMode = PANEL_RESIDENCY_MODES.GLOBAL,
  attachedTab = null,
  attachedTabId = null,
} = {}) {
  const normalizedCurrent = normalizeContextScope(currentScope);
  const targetId = finiteTabId(targetTab?.id);
  if (targetId === null) return { kind: 'noop', scope: normalizedCurrent };
  if (
    normalizedCurrent.mode === CONTEXT_SCOPE_MODES.PINNED_TAB
    && finiteTabId(normalizedCurrent.pinnedTabId) === targetId
  ) {
    return {
      kind: 'reset',
      scope: resetContextScope({
        panelMode,
        attachedTab,
        attachedTabId,
        previousScope: normalizedCurrent,
      }),
    };
  }
  return {
    kind: 'pin',
    scope: contextScopeFromTab(targetTab, normalizedCurrent),
  };
}

function cloneSessionStateRecord(value, fallback = {}) {
  if (!value || typeof value !== 'object') return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

export function snapshotConversationSessionState({
  settings = {},
  activeSessionRuntime = null,
  sessionRoutesAvailable = false,
  transport = 'rest',
} = {}) {
  const safeTransport = transport === 'dashboard-ws' ? 'dashboard-ws' : 'rest';
  return {
    identity: conversationIdentity(settings),
    settings: conversationSettings(settings),
    activeSessionRuntime: cloneSessionStateRecord(activeSessionRuntime, null),
    sessionRoutesAvailable: Boolean(sessionRoutesAvailable),
    transport: safeTransport,
  };
}

export function restoreConversationSessionState(currentSettings = {}, snapshot = null) {
  if (typeof snapshot?.settings?.sessionId !== 'string' || !snapshot.settings.sessionId.trim()
    || typeof snapshot.identity?.gatewayUrl !== 'string'
    || typeof snapshot.identity?.gatewayMode !== 'string'
    || typeof snapshot.identity?.profile !== 'string'
    || !isSessionBindingValid(snapshot, conversationIdentity(currentSettings))) {
    return {
      settings: currentSettings,
      activeSessionRuntime: null,
      sessionRoutesAvailable: false,
      transport: 'rest',
      restored: false,
    };
  }
  const settings = {
    ...currentSettings,
    ...conversationSettings(snapshot.settings),
    // Settings may have accumulated newer bindings while this snapshot was pinned.
    sessionModelBindings: {
      ...cloneSessionStateRecord(snapshot.settings.sessionModelBindings),
      ...cloneSessionStateRecord(currentSettings.sessionModelBindings),
    },
    sessionModelOptionBindings: {
      ...cloneSessionStateRecord(snapshot.settings.sessionModelOptionBindings),
      ...cloneSessionStateRecord(currentSettings.sessionModelOptionBindings),
    },
  };
  return {
    settings,
    activeSessionRuntime: cloneSessionStateRecord(snapshot.activeSessionRuntime, {
      sessionId: snapshot.settings.sessionId,
    }),
    sessionRoutesAvailable: Boolean(snapshot.sessionRoutesAvailable),
    transport: snapshot.transport === 'dashboard-ws' ? 'dashboard-ws' : 'rest',
    restored: true,
  };
}

export function createRevisionGate() {
  let revision = 0;
  return {
    begin() {
      revision += 1;
      return revision;
    },
    invalidate() {
      revision += 1;
      return revision;
    },
    isCurrent(candidate) {
      return Number(candidate) === revision;
    },
    current() {
      return revision;
    },
  };
}

export function shouldPreserveDashboardTransport({
  requestedTransport = '',
  connectionReadyState = -1,
  error = null,
} = {}) {
  if (requestedTransport !== 'dashboard-ws' || Number(connectionReadyState) !== 1) return false;
  if (error?.transportFailure === true || error?.kind === 'transport') return false;
  return !['socket-closed', 'gateway-disconnected', 'auth-failed', 'unauthorized'].includes(String(error?.code || ''));
}
