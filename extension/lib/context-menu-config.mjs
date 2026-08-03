import { isEligibleBrowserContentUrl } from './browser-context-protocol.mjs';

const CONTEXT_MENU_CONFIG_STORAGE_KEY = 'hermesBrowserContextMenuConfig';
const CONTEXT_MENU_ROOT_ID = 'hermes-browser-root';
const CONTEXT_MENU_BROWSER_ID_PREFIX = 'hermes-browser-action';
const CONTEXT_MENU_CONFIG_VERSION = 1;
const CONTEXT_MENU_MAX_ITEMS = 20;
const CONTEXT_MENU_MAX_TITLE_LENGTH = 80;
const CONTEXT_MENU_MAX_PROMPT_LENGTH = 2_000;
const CONTEXT_MENU_REQUEST_TTL_MS = 5 * 60 * 1_000;

const CONTEXT_MENU_ACTION_TYPES = Object.freeze({
  PROMPT: 'prompt',
  INLINE: 'inline',
  OPEN: 'open',
});

const CONTEXT_MENU_CONTEXTS = Object.freeze([
  'selection',
  'editable',
  'page',
  'link',
  'image',
  'video',
  'audio',
]);

const INLINE_CONTEXT_ACTIONS = Object.freeze(['improve', 'draft-reply']);
const ROUTES = Object.freeze(['ask', 'current', 'new', 'background']);
const RESERVED_IDS = new Set([CONTEXT_MENU_ROOT_ID]);

const DEFAULT_CONTEXT_MENU_CONFIG = Object.freeze({
  version: CONTEXT_MENU_CONFIG_VERSION,
  revision: 0,
  items: Object.freeze([
    Object.freeze({
      id: 'hermes-browser-ask-selection',
      title: 'Ask Hermes about this selection',
      titleKey: 'ui.ask.hermes.about.this.selection',
      enabled: true,
      contexts: Object.freeze(['selection']),
      action: Object.freeze({ type: CONTEXT_MENU_ACTION_TYPES.PROMPT, prompt: 'Help me understand or work with this selected text:' }),
    }),
    Object.freeze({
      id: 'hermes-browser-summarize-selection',
      title: 'Summarize selection',
      titleKey: 'ui.summarize.selection',
      enabled: true,
      contexts: Object.freeze(['selection']),
      action: Object.freeze({ type: CONTEXT_MENU_ACTION_TYPES.PROMPT, prompt: 'Summarize this selected text concisely:' }),
    }),
    Object.freeze({
      id: 'hermes-browser-explain-selection',
      title: 'Explain selection',
      titleKey: 'ui.explain.selection',
      enabled: true,
      contexts: Object.freeze(['selection']),
      action: Object.freeze({ type: CONTEXT_MENU_ACTION_TYPES.PROMPT, prompt: 'Explain this selected text clearly:' }),
    }),
    Object.freeze({
      id: 'hermes-browser-improve-editable',
      title: 'Improve selected text',
      titleKey: 'ui.improve.selected.text',
      enabled: true,
      contexts: Object.freeze(['editable']),
      action: Object.freeze({ type: CONTEXT_MENU_ACTION_TYPES.INLINE, actionId: 'improve' }),
    }),
    Object.freeze({
      id: 'hermes-browser-draft-reply',
      title: 'Draft reply with Hermes',
      titleKey: 'ui.draft.reply.with.hermes',
      enabled: true,
      contexts: Object.freeze(['editable']),
      action: Object.freeze({ type: CONTEXT_MENU_ACTION_TYPES.INLINE, actionId: 'draft-reply' }),
    }),
    Object.freeze({
      id: 'hermes-browser-open',
      title: 'Open Hermes Browser',
      titleKey: 'ui.open.hermes.browser',
      enabled: true,
      contexts: Object.freeze(['page', 'link', 'image', 'video', 'audio']),
      action: Object.freeze({ type: CONTEXT_MENU_ACTION_TYPES.OPEN }),
    }),
  ]),
});

function boundedText(value, maximum) {
  return String(value ?? '').trim().slice(0, maximum);
}

function cloneContextMenuItem(item) {
  return {
    ...item,
    contexts: [...item.contexts],
    action: { ...item.action },
  };
}

function cloneDefaultContextMenuConfig() {
  return {
    version: DEFAULT_CONTEXT_MENU_CONFIG.version,
    revision: DEFAULT_CONTEXT_MENU_CONFIG.revision,
    items: DEFAULT_CONTEXT_MENU_CONFIG.items.map(cloneContextMenuItem),
  };
}

function normalizeContextMenuRoute(value = '') {
  const route = boundedText(value, 24).toLowerCase();
  return ROUTES.includes(route) ? route : 'ask';
}

function normalizeContextMenuRevision(value = 0) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function normalizeItemId(value = '') {
  const id = boundedText(value, 64);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) return '';
  if (RESERVED_IDS.has(id) || id.startsWith(`${CONTEXT_MENU_BROWSER_ID_PREFIX}:`)) return '';
  return id;
}

function actionFromLegacyItem(value = {}) {
  if (value.action && typeof value.action === 'object') return value.action;
  if (value.inlineAction) return { type: CONTEXT_MENU_ACTION_TYPES.INLINE, actionId: value.inlineAction };
  if (value.open === true || value.mode === CONTEXT_MENU_ACTION_TYPES.OPEN || value.id === 'hermes-browser-open') {
    return { type: CONTEXT_MENU_ACTION_TYPES.OPEN };
  }
  return { type: CONTEXT_MENU_ACTION_TYPES.PROMPT, prompt: value.prompt };
}

function normalizeContextMenuItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = normalizeItemId(value.id);
  const title = boundedText(value.title, CONTEXT_MENU_MAX_TITLE_LENGTH);
  const rawContexts = Array.isArray(value.contexts) ? value.contexts : [];
  let contexts = [...new Set(rawContexts.map((entry) => boundedText(entry, 16).toLowerCase()))]
    .filter((entry) => CONTEXT_MENU_CONTEXTS.includes(entry));
  const rawAction = actionFromLegacyItem(value);
  const actionType = boundedText(rawAction?.type, 16).toLowerCase();

  if (!id || !title || !contexts.length) return null;

  let action;
  if (actionType === CONTEXT_MENU_ACTION_TYPES.INLINE) {
    const actionId = boundedText(rawAction.actionId, 32).toLowerCase();
    if (!INLINE_CONTEXT_ACTIONS.includes(actionId)) return null;
    contexts = contexts.filter((context) => context === 'editable');
    if (!contexts.length) return null;
    action = { type: CONTEXT_MENU_ACTION_TYPES.INLINE, actionId };
  } else if (actionType === CONTEXT_MENU_ACTION_TYPES.OPEN) {
    action = { type: CONTEXT_MENU_ACTION_TYPES.OPEN };
  } else if (actionType === CONTEXT_MENU_ACTION_TYPES.PROMPT) {
    const prompt = boundedText(rawAction.prompt, CONTEXT_MENU_MAX_PROMPT_LENGTH);
    if (!prompt) return null;
    action = { type: CONTEXT_MENU_ACTION_TYPES.PROMPT, prompt };
  } else {
    return null;
  }

  return {
    id,
    title,
    titleKey: boundedText(value.titleKey, 120),
    enabled: value.enabled !== false,
    contexts,
    action,
  };
}

function configItemsInput(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.contextMenuItems)) return value.contextMenuItems;
  return null;
}

function normalizeContextMenuConfig(value) {
  const rawItems = configItemsInput(value);
  if (rawItems === null) return cloneDefaultContextMenuConfig();

  const seen = new Set();
  const items = [];
  for (const rawItem of rawItems) {
    if (items.length >= CONTEXT_MENU_MAX_ITEMS) break;
    const item = normalizeContextMenuItem(rawItem);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }

  const revision = normalizeContextMenuRevision(value?.revision);
  return { version: CONTEXT_MENU_CONFIG_VERSION, revision, items };
}

function contextMenuItemIdentity(item) {
  const id = normalizeItemId(item?.id);
  const actionType = boundedText(item?.action?.type, 16).toLowerCase();
  if (!id || !Object.values(CONTEXT_MENU_ACTION_TYPES).includes(actionType)) return null;
  return { id, actionType };
}

function browserMenuIdForItem(item, revision = 0) {
  const identity = contextMenuItemIdentity(item);
  if (!identity) return '';
  return `${CONTEXT_MENU_BROWSER_ID_PREFIX}:${normalizeContextMenuRevision(revision)}:${identity.actionType}:${identity.id}`;
}

function parseBrowserMenuId(value = '') {
  const match = String(value).match(/^hermes-browser-action:(\d+):(prompt|inline|open):([a-z0-9][a-z0-9._-]{0,63})$/i);
  if (!match) return null;
  const itemId = normalizeItemId(match[3]);
  if (!itemId) return null;
  return { revision: normalizeContextMenuRevision(match[1]), actionType: match[2].toLowerCase(), itemId };
}

function safeContextUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

async function contextMenuUrlDigest(value = '', { cryptoApi = globalThis.crypto } = {}) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    if (!isEligibleBrowserContentUrl(url.href)) return '';
    if (!cryptoApi?.subtle?.digest) return '';
    const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(url.href));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

function normalizeContextMenuUrlDigest(value = '') {
  const digest = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(digest) ? digest : '';
}

function contextMenuTrigger(info = {}) {
  if (info.linkUrl) return 'link';
  if (info.srcUrl && ['image', 'video', 'audio'].includes(info.mediaType)) return info.mediaType;
  if (info.editable) return 'editable';
  if (String(info.selectionText || '').trim()) return 'selection';
  return 'page';
}

function contextMenuClickEnvelope({ item, info = {}, tab = {}, route = 'ask', now = Date.now(), sourceUrlDigest = '' } = {}) {
  const identity = contextMenuItemIdentity(item);
  const parsedId = parseBrowserMenuId(info.menuItemId);
  const tabId = Number(tab.id);
  if (!identity || !parsedId || parsedId.itemId !== identity.id || parsedId.actionType !== identity.actionType) return null;
  if (!Number.isFinite(tabId) || tabId <= 0) return null;

  const frameId = Number.isFinite(Number(info.frameId)) && Number(info.frameId) >= 0 ? Number(info.frameId) : 0;
  const windowId = Number.isFinite(Number(tab.windowId)) ? Number(tab.windowId) : -1;
  const trigger = contextMenuTrigger(info);
  const resourceUrl = safeContextUrl(info.linkUrl || info.srcUrl || '');
  const normalizedSourceUrlDigest = normalizeContextMenuUrlDigest(sourceUrlDigest);
  if (!normalizedSourceUrlDigest) return null;
  return {
    version: CONTEXT_MENU_CONFIG_VERSION,
    itemId: identity.id,
    actionType: identity.actionType,
    prompt: boundedText(item?.action?.prompt, CONTEXT_MENU_MAX_PROMPT_LENGTH),
    route: normalizeContextMenuRoute(route),
    trigger,
    selection: boundedText(info.selectionText, 8_000),
    pageUrl: safeContextUrl(info.pageUrl || tab.url || tab.pendingUrl),
    sourceUrlDigest: normalizedSourceUrlDigest,
    resourceUrl,
    tabId,
    windowId,
    frameId,
    createdAt: now,
    expiresAt: now + CONTEXT_MENU_REQUEST_TTL_MS,
  };
}

function contextMenuContextPolicy(envelope = {}) {
  const trigger = CONTEXT_MENU_CONTEXTS.includes(envelope.trigger) ? envelope.trigger : 'page';
  return {
    capturePage: trigger === 'page',
    selectedText: boundedText(envelope.selection, 8_000),
    resourceUrl: safeContextUrl(envelope.resourceUrl),
    target: {
      tabId: Number(envelope.tabId),
      frameId: Number.isFinite(Number(envelope.frameId)) ? Number(envelope.frameId) : 0,
      pageUrl: safeContextUrl(envelope.pageUrl),
    },
  };
}

function nextRevision(config) {
  return Math.max(0, Number(config.revision) || 0) + 1;
}

function unchangedConfig(config) {
  return {
    version: CONTEXT_MENU_CONFIG_VERSION,
    revision: config.revision,
    items: config.items.map(cloneContextMenuItem),
  };
}

function applyContextMenuConfigMutation(value, mutation = {}) {
  const config = normalizeContextMenuConfig(value);
  let items = config.items.map(cloneContextMenuItem);
  const type = boundedText(mutation.type, 24).toLowerCase();

  if (type === 'restore') {
    items = cloneDefaultContextMenuConfig().items;
  } else if (type === 'replace') {
    items = normalizeContextMenuConfig({ items: mutation.items }).items;
  } else if (type === 'add') {
    const item = normalizeContextMenuItem(mutation.item);
    if (!item || items.some((candidate) => candidate.id === item.id) || items.length >= CONTEXT_MENU_MAX_ITEMS) return unchangedConfig(config);
    items.push(item);
  } else if (type === 'remove') {
    const next = items.filter((item) => item.id !== mutation.id);
    if (next.length === items.length) return unchangedConfig(config);
    items = next;
  } else if (type === 'move') {
    const index = items.findIndex((item) => item.id === mutation.id);
    const offset = Number(mutation.offset);
    const destination = index + offset;
    if (index < 0 || ![-1, 1].includes(offset) || destination < 0 || destination >= items.length) return unchangedConfig(config);
    [items[index], items[destination]] = [items[destination], items[index]];
  } else if (type === 'update') {
    const index = items.findIndex((item) => item.id === mutation.id);
    if (index < 0) return unchangedConfig(config);
    const candidate = normalizeContextMenuItem({
      ...items[index],
      ...(mutation.patch || {}),
      action: {
        ...items[index].action,
        ...(mutation.patch?.action || {}),
      },
    });
    if (!candidate || items.some((item, itemIndex) => itemIndex !== index && item.id === candidate.id)) return unchangedConfig(config);
    items[index] = candidate;
  } else {
    return unchangedConfig(config);
  }

  return {
    version: CONTEXT_MENU_CONFIG_VERSION,
    revision: nextRevision(config),
    items,
  };
}

function createContextMenuItemId({ randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto), now = Date.now } = {}) {
  const entropy = String(randomUUID?.() || `${now()}-${Math.random().toString(16).slice(2)}`)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 20);
  return `custom-${entropy || Number(now()).toString(36)}`;
}

export {
  CONTEXT_MENU_ACTION_TYPES,
  CONTEXT_MENU_BROWSER_ID_PREFIX,
  CONTEXT_MENU_CONFIG_STORAGE_KEY,
  CONTEXT_MENU_CONFIG_VERSION,
  CONTEXT_MENU_CONTEXTS,
  CONTEXT_MENU_MAX_ITEMS,
  CONTEXT_MENU_MAX_PROMPT_LENGTH,
  CONTEXT_MENU_MAX_TITLE_LENGTH,
  CONTEXT_MENU_REQUEST_TTL_MS,
  CONTEXT_MENU_ROOT_ID,
  DEFAULT_CONTEXT_MENU_CONFIG,
  INLINE_CONTEXT_ACTIONS,
  applyContextMenuConfigMutation,
  browserMenuIdForItem,
  cloneDefaultContextMenuConfig,
  contextMenuClickEnvelope,
  contextMenuContextPolicy,
  contextMenuUrlDigest,
  createContextMenuItemId,
  normalizeContextMenuConfig,
  normalizeContextMenuItem,
  normalizeContextMenuRoute,
  normalizeContextMenuUrlDigest,
  parseBrowserMenuId,
  safeContextUrl,
};
