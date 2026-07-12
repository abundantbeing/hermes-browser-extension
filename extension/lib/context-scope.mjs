export const CONTEXT_SCOPE_MODES = Object.freeze({
  CHAT_ONLY: 'chat-only',
  FOLLOW_ACTIVE: 'follow-active',
  PINNED_TAB: 'pinned-tab',
});

export const DEFAULT_CONTEXT_SCOPE = Object.freeze({
  mode: CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE,
  pinnedTabId: null,
  pinnedWindowId: null,
  pinnedTitle: '',
  pinnedUrl: '',
  selectedTabIds: [],
});

export const MAX_PINNED_TITLE_CHARS = 72;

export function compactPinnedTitle(value = '', max = MAX_PINNED_TITLE_CHARS) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeSelectedTabIds(value, fallback = DEFAULT_CONTEXT_SCOPE.selectedTabIds) {
  if (typeof value === 'undefined') return fallback;
  if (value === null) return null;
  if (!Array.isArray(value)) return fallback;
  return [...new Set(value.map((item) => Number(item)).filter(Number.isFinite))];
}

function normalizeScopeMode(value) {
  if (value === CONTEXT_SCOPE_MODES.CHAT_ONLY) return CONTEXT_SCOPE_MODES.CHAT_ONLY;
  if (value === CONTEXT_SCOPE_MODES.PINNED_TAB) return CONTEXT_SCOPE_MODES.PINNED_TAB;
  return CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE;
}

export function normalizeContextScope(scope = {}) {
  const mode = normalizeScopeMode(scope?.mode);
  const hasSelectedTabIds = Object.prototype.hasOwnProperty.call(scope || {}, 'selectedTabIds');
  return {
    ...DEFAULT_CONTEXT_SCOPE,
    ...scope,
    mode,
    pinnedTabId: mode === CONTEXT_SCOPE_MODES.CHAT_ONLY ? null : finiteNumberOrNull(scope?.pinnedTabId),
    pinnedWindowId: mode === CONTEXT_SCOPE_MODES.CHAT_ONLY ? null : finiteNumberOrNull(scope?.pinnedWindowId),
    pinnedTitle: mode === CONTEXT_SCOPE_MODES.CHAT_ONLY ? '' : compactPinnedTitle(scope?.pinnedTitle || ''),
    pinnedUrl: mode === CONTEXT_SCOPE_MODES.CHAT_ONLY ? '' : String(scope?.pinnedUrl || ''),
    selectedTabIds: mode === CONTEXT_SCOPE_MODES.CHAT_ONLY
      ? []
      : normalizeSelectedTabIds(hasSelectedTabIds ? scope.selectedTabIds : undefined),
  };
}

export function contextScopeForGateway(scope = DEFAULT_CONTEXT_SCOPE, gatewayMode = '') {
  if (String(gatewayMode || '').trim().toLowerCase() === 'remote-dashboard') {
    return normalizeContextScope({ mode: CONTEXT_SCOPE_MODES.CHAT_ONLY });
  }
  return normalizeContextScope(scope);
}

export function tabScopeId(scope = DEFAULT_CONTEXT_SCOPE, conversationScope = scope) {
  const normalized = normalizeContextScope(scope);
  if (normalized.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY) {
    const conversation = normalizeContextScope(conversationScope);
    if (conversation.mode !== CONTEXT_SCOPE_MODES.CHAT_ONLY) return tabScopeId(conversation, conversation);
    return CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE;
  }
  return normalized.mode === CONTEXT_SCOPE_MODES.PINNED_TAB && normalized.pinnedTabId !== null
    ? `tab:${normalized.pinnedTabId}`
    : CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE;
}

export function messageStorageKeyForScope(scope = DEFAULT_CONTEXT_SCOPE, conversationScope = scope) {
  return `hermesBrowserMessages:${tabScopeId(scope, conversationScope)}`;
}

export function sessionBindingKeyForScope(scope = DEFAULT_CONTEXT_SCOPE, conversationScope = scope) {
  return `hermesBrowserSession:${tabScopeId(scope, conversationScope)}`;
}

export function resolveContextTargetTab({ activeTab = null, tabs = [], scope = DEFAULT_CONTEXT_SCOPE } = {}) {
  const normalized = normalizeContextScope(scope);
  if (normalized.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY) return null;
  if (normalized.mode !== CONTEXT_SCOPE_MODES.PINNED_TAB) return activeTab;
  return tabs.find((tab) => Number(tab.id) === normalized.pinnedTabId) || null;
}

export function filterPromptTabs(tabs = [], scope = DEFAULT_CONTEXT_SCOPE) {
  const normalized = normalizeContextScope(scope);
  if (normalized.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY) return [];
  if (!Array.isArray(normalized.selectedTabIds)) return tabs;
  const ids = new Set(normalized.selectedTabIds);
  return tabs.filter((tab) => ids.has(Number(tab.id)));
}

export function shouldRefreshForTabEvent({ scope = DEFAULT_CONTEXT_SCOPE, eventTabId = null, eventType = 'activated' } = {}) {
  const normalized = normalizeContextScope(scope);
  if (normalized.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY) return false;
  if (normalized.mode !== CONTEXT_SCOPE_MODES.PINNED_TAB) return true;
  if (eventType === 'activated') return false;
  return Number(eventTabId) === normalized.pinnedTabId;
}

export function contextScopeFromTab(tab = {}, previousScope = DEFAULT_CONTEXT_SCOPE) {
  return normalizeContextScope({
    ...previousScope,
    mode: CONTEXT_SCOPE_MODES.PINNED_TAB,
    pinnedTabId: tab.id,
    pinnedWindowId: tab.windowId,
    pinnedTitle: tab.title || '',
    pinnedUrl: tab.url || '',
  });
}
