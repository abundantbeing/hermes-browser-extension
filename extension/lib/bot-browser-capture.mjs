import { isRestrictedUrl } from './browser-context-protocol.mjs';
import { MAX_INLINE_SCREENSHOT_CHARS } from './screenshot-limits.mjs';

function readableTab(tab, { allowLocalDocuments = false } = {}) {
  return Number.isInteger(tab?.id) && !isRestrictedUrl(tab?.url || '', { allowLocalDocuments });
}

export async function collectBotPageContext({ browserApi, scope = { mode: 'chat-only' }, settings = {} } = {}) {
  const empty = { activeTab: null, tabs: [], pageContext: null, contextScope: scope };
  if (scope.mode === 'chat-only') return empty;
  const active = scope.mode === 'pinned-tab'
    ? await browserApi.tabs.get(Number(scope.pinnedTabId)).catch(() => null)
    : (await browserApi.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!readableTab(active)) return empty;
  let pageContext = { ok: true, url: active.url, text: '', selectedText: '', meta: {} };
  if (settings.includePageText !== false || settings.includeSelectedText === true) {
    pageContext = await browserApi.tabs.sendMessage(active.id, {
      type: 'HERMES_GET_PAGE_CONTEXT', options: { depth: settings.contextDepth || 'normal' },
    }).catch(() => ({ ok: false, url: active.url, text: '', selectedText: '', meta: {} }));
    const latest = await browserApi.tabs.get(active.id).catch(() => null);
    if (!latest || latest.url !== active.url || (pageContext?.url && pageContext.url !== active.url)) return empty;
    pageContext = {
      ...pageContext,
      text: settings.includePageText === false ? '' : String(pageContext?.text || ''),
      selectedText: settings.includeSelectedText === true ? String(pageContext?.selectedText || '') : '',
    };
  }
  return { activeTab: active, tabs: [active], pageContext, contextScope: scope };
}

// captureVisibleTab captures the WINDOW's active tab, not an arbitrary tab ID.
// Verify both identity and URL before and after capture; never switch tabs.
export async function captureBotTabScreenshot({ browserApi, tab, scopeMode = 'chat-only', allowed = false, allowLocalDocuments = false } = {}) {
  if (!allowed || scopeMode === 'chat-only' || !readableTab(tab, { allowLocalDocuments })) {
    throw new Error('Browser context is disabled or this page cannot be captured.');
  }
  const current = await browserApi.tabs.get(tab.id);
  const visible = (await browserApi.tabs.query({ active: true, windowId: tab.windowId }))[0];
  if (!current?.active || current.url !== tab.url || visible?.id !== tab.id) {
    throw new Error('The selected tab is not visible or changed before screenshot capture.');
  }
  const dataUrl = await browserApi.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const latest = await browserApi.tabs.get(tab.id).catch(() => null);
  const stillVisible = (await browserApi.tabs.query({ active: true, windowId: tab.windowId }))[0];
  if (!latest || latest.url !== tab.url || stillVisible?.id !== tab.id) {
    throw new Error('The selected tab changed during screenshot capture.');
  }
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(String(dataUrl || '')) || dataUrl.length > MAX_INLINE_SCREENSHOT_CHARS) {
    throw new Error('The browser screenshot is invalid or too large to attach.');
  }
  return {
    id: `browser-tab-${tab.id}-${Date.now()}`, kind: 'image', label: `browser-tab-${tab.id}.png`,
    detail: tab.title || 'Browser tab screenshot', dataUrl, browserTabScreenshot: true,
    tabId: tab.id, tabUrl: tab.url,
  };
}
