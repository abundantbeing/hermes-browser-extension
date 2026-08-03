import {
  contextMenuContextPolicy,
  contextMenuUrlDigest,
  normalizeContextMenuUrlDigest,
} from './context-menu-config.mjs';

const PROMPT_LIMIT = 2_000;
const SELECTION_LIMIT = 8_000;
const CONTEXT_MENU_ROUTES = new Set(['ask', 'current', 'new', 'background']);
const CONTEXT_MENU_TRIGGERS = new Set(['page', 'selection', 'editable', 'link', 'image', 'video', 'audio']);

function safePageUrl(value = '') {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}

function boundedText(value = '', limit = PROMPT_LIMIT) {
  return String(value || '').trim().slice(0, limit);
}

export function normalizeContextMenuRequest(value, { now = Date.now() } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prompt = boundedText(value.prompt, PROMPT_LIMIT);
  const itemId = boundedText(value.itemId, 64);
  const tabId = Number(value.tabId);
  const windowId = Number(value.windowId);
  const frameId = Number(value.frameId);
  const createdAt = Number(value.createdAt);
  const expiresAt = Number(value.expiresAt);
  const pageUrl = safePageUrl(value.pageUrl);
  const sourceUrlDigest = normalizeContextMenuUrlDigest(value.sourceUrlDigest);
  const trigger = CONTEXT_MENU_TRIGGERS.has(value.trigger) ? value.trigger : 'page';
  if (
    Number(value.version) !== 1
    || value.actionType !== 'prompt'
    || !prompt
    || !itemId
    || !Number.isFinite(tabId)
    || !Number.isFinite(windowId)
    || !Number.isFinite(frameId)
    || !Number.isFinite(createdAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= now
    || !pageUrl
    || !sourceUrlDigest
  ) return null;

  return {
    version: 1,
    itemId,
    actionType: 'prompt',
    prompt,
    route: CONTEXT_MENU_ROUTES.has(value.route) ? value.route : 'ask',
    trigger,
    selection: boundedText(value.selection, SELECTION_LIMIT),
    pageUrl,
    sourceUrlDigest,
    resourceUrl: safePageUrl(value.resourceUrl),
    tabId,
    windowId,
    frameId,
    createdAt,
    expiresAt,
  };
}

function resourceAttachment(request) {
  if (!request.resourceUrl) return [];
  const resourceKind = request.trigger === 'link' ? 'link' : 'media';
  const label = `Right-click ${resourceKind} target`;
  return [{
    id: `context-menu-resource-${request.itemId}`,
    kind: 'url',
    label,
    detail: request.resourceUrl,
    text: `${label} URL: ${request.resourceUrl}`,
  }];
}

export async function contextMenuRequestMatchesTab(rawRequest, tab, { digestContextUrl = contextMenuUrlDigest } = {}) {
  const request = normalizeContextMenuRequest(rawRequest, { now: Number(rawRequest?.createdAt || 0) + 1 });
  if (
    !request
    || Number(tab?.id) !== request.tabId
    || Number(tab?.windowId) !== request.windowId
  ) return false;
  const currentUrl = tab?.url || tab?.pendingUrl;
  if (safePageUrl(currentUrl) !== request.pageUrl) return false;
  return await digestContextUrl(currentUrl) === request.sourceUrlDigest;
}

export async function buildContextMenuTurn({ request: rawRequest, tab, capturedPageContext = null } = {}) {
  const request = normalizeContextMenuRequest(rawRequest, { now: Number(rawRequest?.createdAt || 0) + 1 });
  if (!request || !await contextMenuRequestMatchesTab(request, tab)) return null;
  const policy = contextMenuContextPolicy(request);
  const activeTab = { ...tab };
  const pageContext = policy.capturePage
    ? {
      ...(capturedPageContext && typeof capturedPageContext === 'object'
        ? capturedPageContext
        : { ok: false, text: '', meta: {} }),
      selectedText: request.selection,
    }
    : {
      ok: true,
      restricted: false,
      text: '',
      selectedText: request.selection,
      meta: {},
    };

  return {
    humanInput: request.prompt,
    attachments: resourceAttachment(request),
    capturePage: policy.capturePage,
    context: {
      activeTab,
      tabs: [activeTab],
      selectedTabs: [activeTab],
      pageContext,
      contextScope: {
        mode: 'pinned-tab',
        pinnedTabId: request.tabId,
        pinnedWindowId: request.windowId,
        pinnedTitle: String(tab?.title || ''),
        pinnedUrl: request.pageUrl,
        selectedTabIds: [request.tabId],
      },
      settingsOverride: {
        includePageText: policy.capturePage,
        includeSelectedText: true,
        includeTabs: false,
      },
    },
  };
}
