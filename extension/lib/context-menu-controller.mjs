import {
  CONTEXT_MENU_ACTION_TYPES,
  CONTEXT_MENU_CONFIG_STORAGE_KEY,
  CONTEXT_MENU_ROOT_ID,
  applyContextMenuConfigMutation,
  browserMenuIdForItem,
  contextMenuClickEnvelope,
  contextMenuUrlDigest,
  normalizeContextMenuConfig,
  normalizeContextMenuRoute,
  parseBrowserMenuId,
} from './context-menu-config.mjs';
import { getBrowserApi } from './browser-api.mjs';

const CONTEXT_MENU_REQUEST_STORAGE_KEY = 'hermesBrowserContextMenuRequest';
const CONTEXT_MENU_REQUEST_CLAIM = 'HERMES_CONTEXT_MENU_REQUEST_CLAIM';
const CONTEXT_MENU_CONFIG_GET = 'HERMES_CONTEXT_MENU_CONFIG_GET';
const CONTEXT_MENU_CONFIG_MUTATE = 'HERMES_CONTEXT_MENU_CONFIG_MUTATE';

function createContextMenuController({
  chromeApi = getBrowserApi(),
  now = () => Date.now(),
  openHermesSurface = async () => false,
  translate = (_key, fallback) => fallback,
  digestContextUrl = contextMenuUrlDigest,
} = {}) {
  let cachedConfig = null;
  let lastGoodMenuConfig = null;
  let activeConfiguration = null;
  let mutationQueue = Promise.resolve();
  let rebuildQueue = Promise.resolve();
  let requestQueue = Promise.resolve();

  function createMenu(options) {
    return new Promise((resolve, reject) => {
      chromeApi.contextMenus.create(options, () => {
        const message = chromeApi.runtime?.lastError?.message || '';
        if (message) reject(new Error(message));
        else resolve();
      });
    });
  }

  async function loadState({ persistMissing = false } = {}) {
    const stored = await chromeApi.storage.local.get([
      CONTEXT_MENU_CONFIG_STORAGE_KEY,
      'hermesBrowserSettings',
    ]);
    const dedicated = stored?.[CONTEXT_MENU_CONFIG_STORAGE_KEY];
    const legacyItems = stored?.hermesBrowserSettings?.contextMenuItems;
    const source = dedicated === undefined && Array.isArray(legacyItems)
      ? { version: 1, revision: 0, items: legacyItems }
      : dedicated;
    const config = normalizeContextMenuConfig(source);
    cachedConfig = config;
    if (persistMissing && dedicated === undefined && chromeApi.storage.local.set) {
      await chromeApi.storage.local.set({ [CONTEXT_MENU_CONFIG_STORAGE_KEY]: config });
    }
    return {
      config,
      route: normalizeContextMenuRoute(stored?.hermesBrowserSettings?.contextMenuDefaultRoute),
    };
  }

  async function currentState() {
    if (cachedConfig) {
      const stored = await chromeApi.storage.local.get('hermesBrowserSettings');
      return {
        config: cachedConfig,
        route: normalizeContextMenuRoute(stored?.hermesBrowserSettings?.contextMenuDefaultRoute),
      };
    }
    return loadState({ persistMissing: true });
  }

  function queueRequestOperation(task) {
    const operation = requestQueue
      .catch(() => undefined)
      .then(task);
    requestQueue = operation;
    return operation;
  }

  function pendingRequests(value) {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return list.filter((request) => request && typeof request === 'object' && Number(request.expiresAt) > now());
  }

  function enqueueRequest(request) {
    return queueRequestOperation(async () => {
      const stored = await chromeApi.storage.session.get(CONTEXT_MENU_REQUEST_STORAGE_KEY);
      const requests = pendingRequests(stored?.[CONTEXT_MENU_REQUEST_STORAGE_KEY]);
      requests.push(request);
      await chromeApi.storage.session.set({ [CONTEXT_MENU_REQUEST_STORAGE_KEY]: requests.slice(-20) });
      return request;
    });
  }

  function claimRequest({ sourceTabId = null } = {}) {
    return queueRequestOperation(async () => {
      const stored = await chromeApi.storage.session.get(CONTEXT_MENU_REQUEST_STORAGE_KEY);
      const raw = stored?.[CONTEXT_MENU_REQUEST_STORAGE_KEY];
      const requests = pendingRequests(raw);
      const requestedTabId = Number(sourceTabId);
      const index = Number.isFinite(requestedTabId) && requestedTabId > 0
        ? requests.findIndex((request) => Number(request.tabId) === requestedTabId)
        : (requests.length ? 0 : -1);
      const request = index >= 0 ? requests.splice(index, 1)[0] : null;
      const originalLength = Array.isArray(raw) ? raw.length : raw ? 1 : 0;
      if (request || !Array.isArray(raw) || requests.length !== originalLength) {
        await chromeApi.storage.session.set({ [CONTEXT_MENU_REQUEST_STORAGE_KEY]: requests });
      }
      return request ? { ok: true, request } : { ok: false, reason: 'no-pending-request' };
    });
  }

  async function createMenuTree(config) {
    const enabledItems = config.items.filter((item) => item.enabled !== false);
    if (!enabledItems.length) return;

    await createMenu({
      id: CONTEXT_MENU_ROOT_ID,
      title: translate('ui.hermes.browser', 'Hermes Browser'),
      contexts: ['page', 'selection', 'editable', 'link', 'image', 'video', 'audio'],
    });
    for (const item of enabledItems) {
      await createMenu({
        id: browserMenuIdForItem(item, config.revision),
        parentId: CONTEXT_MENU_ROOT_ID,
        title: item.titleKey ? translate(item.titleKey, item.title) : item.title,
        contexts: item.contexts,
      });
    }
  }

  async function rebuild(config) {
    if (!chromeApi.contextMenus?.create || !chromeApi.contextMenus?.removeAll) return config;
    let removed = false;
    try {
      await chromeApi.contextMenus.removeAll();
      removed = true;
      await createMenuTree(config);
      lastGoodMenuConfig = normalizeContextMenuConfig(config);
    } catch (error) {
      if (removed) {
        await chromeApi.contextMenus.removeAll().catch(() => undefined);
        if (lastGoodMenuConfig) await createMenuTree(lastGoodMenuConfig).catch(() => undefined);
      }
      throw error;
    }
    return config;
  }

  function queueRebuild(configLoader) {
    const operation = rebuildQueue
      .catch(() => undefined)
      .then(async () => rebuild(await configLoader()));
    rebuildQueue = operation;
    return operation;
  }

  function configure() {
    if (activeConfiguration) return activeConfiguration;
    const operation = queueRebuild(async () => (await loadState({ persistMissing: true })).config);
    activeConfiguration = operation;
    operation.finally(() => {
      if (activeConfiguration === operation) activeConfiguration = null;
    }).catch(() => undefined);
    return operation;
  }

  function mutate(mutation) {
    const operation = mutationQueue
      .catch(() => undefined)
      .then(async () => {
        const { config } = await loadState({ persistMissing: true });
        const next = applyContextMenuConfigMutation(config, mutation);
        if (next.revision === config.revision) return config;
        await queueRebuild(async () => next);
        await chromeApi.storage.local.set({ [CONTEXT_MENU_CONFIG_STORAGE_KEY]: next });
        cachedConfig = next;
        return next;
      });
    mutationQueue = operation;
    return operation;
  }

  function handleClick(info = {}, tab = {}) {
    const parsed = parseBrowserMenuId(info.menuItemId);
    if (!parsed) return Promise.resolve({ ok: false, reason: 'unknown-menu-item' });

    let openPromise = null;
    if (parsed.actionType !== CONTEXT_MENU_ACTION_TYPES.INLINE) {
      try {
        openPromise = Promise.resolve(openHermesSurface(tab));
      } catch (error) {
        openPromise = Promise.reject(error);
      }
    }

    return (async () => {
      const { config, route } = await currentState();
      if (parsed.revision !== config.revision) {
        if (openPromise) await openPromise.catch(() => false);
        return { ok: false, reason: 'stale-menu-revision' };
      }
      const item = config.items.find((candidate) => candidate.id === parsed.itemId);
      if (!item || item.enabled === false || item.action.type !== parsed.actionType) {
        if (openPromise) await openPromise.catch(() => false);
        return { ok: false, reason: 'stale-menu-item' };
      }

      if (parsed.actionType === CONTEXT_MENU_ACTION_TYPES.INLINE) {
        const frameId = Number.isFinite(Number(info.frameId)) && Number(info.frameId) >= 0 ? Number(info.frameId) : 0;
        await chromeApi.tabs.sendMessage(
          Number(tab.id),
          { type: 'HERMES_INLINE_CONTEXT_ACTION', actionId: item.action.actionId },
          { frameId },
        ).catch(() => null);
        return { ok: true, actionType: parsed.actionType };
      }

      if (parsed.actionType === CONTEXT_MENU_ACTION_TYPES.OPEN) {
        const opened = await openPromise.catch(() => false);
        return { ok: opened !== false, actionType: parsed.actionType };
      }

      const sourceUrlDigest = await digestContextUrl(info.pageUrl || tab.url || tab.pendingUrl);
      const request = contextMenuClickEnvelope({ item, info, tab, route, now: now(), sourceUrlDigest });
      if (!request || !item.contexts.includes(request.trigger)) {
        await openPromise.catch(() => false);
        return { ok: false, reason: 'invalid-click-context' };
      }
      await enqueueRequest(request);
      const opened = await openPromise.catch(() => false);
      return { ok: opened !== false, actionType: parsed.actionType, request };
    })();
  }

  async function getConfig() {
    return (await loadState({ persistMissing: true })).config;
  }

  function handleStorageChanged(changes, areaName) {
    if (areaName && areaName !== 'local') return Promise.resolve(null);
    const changed = changes?.[CONTEXT_MENU_CONFIG_STORAGE_KEY];
    if (!changed) return Promise.resolve(null);
    const next = normalizeContextMenuConfig(changed.newValue);
    if (cachedConfig?.revision === next.revision) return Promise.resolve(next);
    cachedConfig = next;
    return queueRebuild(async () => cachedConfig);
  }

  async function handleMessage(message = {}) {
    if (message.type === CONTEXT_MENU_CONFIG_GET) {
      return { ok: true, config: await getConfig() };
    }
    if (message.type === CONTEXT_MENU_CONFIG_MUTATE) {
      const config = await mutate(message.mutation || {});
      return { ok: true, config };
    }
    if (message.type === CONTEXT_MENU_REQUEST_CLAIM) {
      return claimRequest(message);
    }
    return null;
  }

  return Object.freeze({
    configure,
    getConfig,
    handleClick,
    handleMessage,
    handleStorageChanged,
    mutate,
  });
}

export {
  CONTEXT_MENU_CONFIG_GET,
  CONTEXT_MENU_CONFIG_MUTATE,
  CONTEXT_MENU_REQUEST_CLAIM,
  CONTEXT_MENU_REQUEST_STORAGE_KEY,
  createContextMenuController,
};
