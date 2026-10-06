/**
 * Bot Mode browser context bridge.
 *
 * Connects Bot Mode session runners and group round loops to HBE active tab
 * context and explicit per-turn tab screenshots. Everything that crosses a
 * gateway boundary is routed through the Browser Context Protocol (BCP v2)
 * helpers so sanitization, restriction, redaction, and budgets cannot drift
 * from the main session path.
 *
 * Consent is deliberately NOT re-derived here: the parent passes the already
 * consent-gated scope (chat-only once consent is denied), and this module fails
 * closed on any restricted, sensitive, or credential-bearing URL.
 */
import {
  DEFAULT_BROWSER_CONTEXT_PROTOCOL_SETTINGS,
  clampText,
  contextCharLimit,
  isRestrictedUrl,
  normalizeReadableWhitespace,
  privacySafeTabForPrompt,
  redactSensitiveText,
} from './browser-context-protocol.mjs';
import { MAX_INLINE_SCREENSHOT_CHARS } from './screenshot-limits.mjs';
import {
  CONTEXT_SCOPE_MODES,
  normalizeContextScope,
} from './context-scope.mjs';

// A tab screenshot is only ever shipped on explicit per-turn intent. The
// gateway's own attach RPC caps at 25 MiB; Bot Mode holds a tighter bound so a
// runaway capture can never balloon a member turn.
export const BOT_SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;
export const BOT_EXTRACTED_TEXT_MAX_CHARS = 12_000;

const RASTER_DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif|bmp);base64,([A-Za-z0-9+/=]+)$/i;
const DEFAULT_SCREENSHOT_NAME = 'browser-tab-screenshot.png';

function clean(value) {
  return String(value ?? '').trim();
}

/** Resolve the effective scope mode from an explicit scope object or shorthand. */
export function botBrowserScopeMode(contextScope = null, scopeMode = '') {
  const fromScope = clean(contextScope?.mode);
  if (fromScope) return fromScope;
  const shorthand = clean(scopeMode);
  return shorthand || CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE;
}

/**
 * Resolve the tab a bot turn may capture. Pinned scope fails closed when the
 * pinned tab is absent from the tab list OR the active tab no longer matches
 * the pin, so a page the user did not pin can never be captured under a pin.
 */
export function resolveBotTargetTab({ mode = CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE, activeTab = null, tabs = [], contextScope = null } = {}) {
  if (mode === CONTEXT_SCOPE_MODES.PINNED_TAB) {
    const pinnedId = Number(contextScope?.pinnedTabId);
    if (!Number.isFinite(pinnedId)) return null;
    const list = Array.isArray(tabs) ? tabs : [];
    const pinnedTab = list.find((tab) => Number(tab?.id) === pinnedId) || null;
    if (!pinnedTab) return null;
    if (activeTab && activeTab.id !== undefined && activeTab.id !== null && Number(activeTab.id) !== pinnedId) return null;
    return pinnedTab;
  }
  return activeTab && typeof activeTab === 'object' ? activeTab : null;
}

/** True when this bot turn may carry the resolved browser context. */
export function shouldAttachBrowserContextToBotTurn({ scopeMode = '', activeTab = null, tabs = [], contextScope = null } = {}) {
  const mode = botBrowserScopeMode(contextScope, scopeMode);
  if (mode === CONTEXT_SCOPE_MODES.CHAT_ONLY) return false;
  const target = resolveBotTargetTab({ mode, activeTab, tabs, contextScope: contextScope || { mode } });
  if (!target || !clean(target.url)) return false;
  return !isRestrictedUrl(target.url);
}

function boundedExtractedText(text = '', depth = 'normal') {
  const limit = Math.min(BOT_EXTRACTED_TEXT_MAX_CHARS, contextCharLimit(depth));
  const normalized = normalizeReadableWhitespace(String(text || ''));
  return clampText(redactSensitiveText(normalized), limit);
}

function disabledResult({ reason, scope, settings, contextDelivery }) {
  return {
    enabled: false,
    reason,
    activeTab: null,
    tab: null,
    tabs: [],
    pageContext: null,
    contextScope: scope,
    settings,
    contextHash: '',
    contextDelivery,
    extractedText: '',
  };
}

/**
 * Build an envelope-ready browser context for a bot or group turn. Returns
 * `enabled: false` (with a machine-readable reason) whenever context must not
 * cross the boundary: chat-only scope, no tab, a restricted/sensitive/
 * credential-bearing URL, or a pinned-tab mismatch.
 */
export function resolveBotBrowserContext({
  scopeMode = '',
  activeTab = null,
  tabs = [],
  pageContext = null,
  contextScope = null,
  settings = {},
  contextHash = '',
  contextDelivery = 'full',
} = {}) {
  const mode = botBrowserScopeMode(contextScope, scopeMode);
  const scope = normalizeContextScope({ ...(contextScope || {}), mode });
  const mergedSettings = { ...DEFAULT_BROWSER_CONTEXT_PROTOCOL_SETTINGS, ...(settings || {}) };
  const shared = { scope, settings: mergedSettings, contextDelivery };

  if (mode === CONTEXT_SCOPE_MODES.CHAT_ONLY) {
    return disabledResult({ reason: 'chat-only', ...shared });
  }

  const target = resolveBotTargetTab({ mode, activeTab, tabs, contextScope: scope });
  if (mode === CONTEXT_SCOPE_MODES.PINNED_TAB && !target) {
    return disabledResult({ reason: 'pinned-mismatch', ...shared });
  }
  if (!target || !clean(target.url)) {
    return disabledResult({ reason: 'no-tab', ...shared });
  }
  if (isRestrictedUrl(target.url)) {
    return disabledResult({ reason: 'restricted-url', ...shared });
  }

  const safe = privacySafeTabForPrompt(target);
  const safeTabs = Array.isArray(tabs) ? tabs.map((tab) => privacySafeTabForPrompt(tab)) : [];
  return {
    enabled: true,
    reason: 'ok',
    activeTab: safe,
    tab: { id: safe.id ?? null, url: safe.url, title: safe.title },
    tabs: safeTabs,
    pageContext: pageContext && typeof pageContext === 'object' ? pageContext : {},
    contextScope: scope,
    settings: mergedSettings,
    contextHash: clean(contextHash),
    contextDelivery,
    extractedText: boundedExtractedText(pageContext?.text, mergedSettings.contextDepth),
  };
}

function estimatedBase64Bytes(base64 = '') {
  const text = String(base64 || '').replace(/=+$/, '');
  if (!text) return 0;
  return Math.floor((text.length * 3) / 4);
}

/**
 * Validate and shape one explicit tab screenshot. Returns null for anything
 * that is not a bounded raster data URL, so a caller can never stage an
 * arbitrary blob through the image RPC.
 */
export function prepareTabScreenshotAttachment(dataUrl, { tabId = null, title = '', filename = '', maxBytes = BOT_SCREENSHOT_MAX_BYTES } = {}) {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(RASTER_DATA_URL_RE);
  if (!match) return null;
  const mime = `image/${match[1].toLowerCase().replace('jpg', 'jpeg')}`;
  const bytes = estimatedBase64Bytes(match[2]);
  if (bytes <= 0 || bytes > Math.max(0, Number(maxBytes) || BOT_SCREENSHOT_MAX_BYTES) || dataUrl.length > MAX_INLINE_SCREENSHOT_CHARS) return null;
  const requested = clean(filename);
  const numericTabId = Number(tabId);
  const defaultName = Number.isFinite(numericTabId) ? `browser-tab-${numericTabId}.png` : DEFAULT_SCREENSHOT_NAME;
  return {
    type: 'image',
    mime,
    name: requested || defaultName,
    title: clean(title) || 'Browser Tab Screenshot',
    data: dataUrl,
    bytes,
  };
}

/**
 * Shape the exact `image.attach_bytes` request. Deliberately NOT a generic
 * `attachments` field: the gateway contract is `{ session_id, content_base64,
 * filename }`.
 */
export function screenshotAttachParams(attachment, sessionId = '') {
  if (!attachment || attachment.type !== 'image' || !attachment.data) return null;
  return {
    session_id: sessionId,
    content_base64: attachment.data,
    filename: attachment.name || DEFAULT_SCREENSHOT_NAME,
  };
}