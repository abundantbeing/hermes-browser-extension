// The "Opening Hermes Web" hand-off.
//
// A Hermes Web tab signed in by a one-use ticket opens at `<webapp>/webapp/launch#ticket=...`. That is the
// gateway's own redeem page: an unstyled page that spends a few seconds before the Webapp loads. This module
// keeps that moment on brand:
//
//   1. an extension page (hermes-web-opening.html) is opened as the visible tab,
//   2. the launch URL opens in a background tab beside it (`active: false`),
//   3. when the background tab reaches the Webapp itself (a finished load on the Webapp's origin, no longer
//      on /webapp/launch or /webapp/window) that tab is activated, its window focused, and the opening
//      tab closed,
//   4. if that does not happen within HERMES_WEB_OPENING_TIMEOUT_MS the opening page offers "Show it anyway",
//      which activates the background tab as it is,
//   5. closing the opening page activates the Webapp tab, and closing the Webapp tab closes the opening page.
//
// The ticket lives only in the launch tab's URL fragment. The opening page's own URL never carries it: the
// launch target travels in a runtime message to the background worker, which holds it in memory and in
// storage.session (so a restarted worker keeps watching the same tab).
//
// Chrome and Firefox share this code. Both have tabs.create/update/remove/onUpdated/onRemoved, windows.update
// and runtime.getURL, and the page is opened by the extension itself, so it is not web-accessible.

export const HERMES_WEB_OPENING_PAGE = 'hermes-web-opening.html';
export const HERMES_WEB_OPENING_TIMEOUT_MS = 20_000;
export const HERMES_WEB_OPENING_STORAGE_KEY = 'hermesWebOpeningPending';

export const HERMES_WEB_OPENING_MESSAGES = Object.freeze({
  start: 'HERMES_WEB_OPENING_START',
  state: 'HERMES_WEB_OPENING_STATE',
  show: 'HERMES_WEB_OPENING_SHOW',
});

const MESSAGE_TYPES = new Set(Object.values(HERMES_WEB_OPENING_MESSAGES));
const STALE_AFTER_MS = 10 * 60_000;

/** True for the runtime message types this module's controller handles. */
export function handlesHermesWebOpeningMessage(type) {
  return MESSAGE_TYPES.has(type);
}

function cleanBasePath(value) {
  const text = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  return text.startsWith('/') ? text : '';
}

function parseUrl(value) {
  try {
    return new URL(String(value || ''));
  } catch {
    return null;
  }
}

// The gateway's own hand-off pages. A tab on either one has not reached the Webapp yet.
function isHandoffPath(pathname, basePath) {
  const prefix = `${cleanBasePath(basePath)}/webapp/`;
  const path = String(pathname || '');
  for (const name of ['launch', 'window']) {
    const handoff = `${prefix}${name}`;
    if (path === handoff || path.startsWith(`${handoff}/`)) return true;
  }
  return false;
}

/**
 * Whether `url` is the Webapp itself: the Webapp's origin (and base path, when it is served under one) and not the
 * `/webapp/launch` or `/webapp/window` hand-off pages. The fragment and query are not looked at.
 */
export function isWebappReachedUrl(url, { origin = '', basePath = '' } = {}) {
  const parsed = parseUrl(url);
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) return false;
  if (parsed.origin !== origin) return false;
  const base = cleanBasePath(basePath);
  if (base && parsed.pathname !== base && !parsed.pathname.startsWith(`${base}/`)) return false;
  return !isHandoffPath(parsed.pathname, base);
}

/**
 * Check a start request from the panel: `url` must be the launch page of `origin` (http or https, no credentials),
 * which is what a ticket launch is. Returns the clean request or null.
 */
export function normalizeOpeningRequest(request) {
  const url = parseUrl(request?.url);
  const origin = parseUrl(request?.origin);
  if (!url || !origin) return null;
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  if (origin.origin !== url.origin) return null;
  const basePath = cleanBasePath(request?.basePath);
  if (url.pathname !== `${basePath}/webapp/launch`) return null;
  return { url: url.href, origin: url.origin, basePath };
}

function isTabId(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * The background worker's side. `tabsApi`, `windowsApi` and `runtimeApi` are the browser's; `storageSession` is
 * optional (without it a restarted worker forgets what it was watching, and the opening page's button still works).
 */
export function createHermesWebOpening({
  tabsApi,
  windowsApi,
  runtimeApi,
  storageSession,
  now = () => Date.now(),
  timeoutMs = HERMES_WEB_OPENING_TIMEOUT_MS,
} = {}) {
  /** openingTabId -> { openingTabId, launchTabId, windowId, origin, basePath, startedAt } */
  const pending = new Map();
  let loaded = null;

  function load() {
    if (!loaded) {
      loaded = (async () => {
        if (typeof storageSession?.get !== 'function') return;
        try {
          const stored = await storageSession.get(HERMES_WEB_OPENING_STORAGE_KEY);
          const list = stored?.[HERMES_WEB_OPENING_STORAGE_KEY];
          for (const entry of Array.isArray(list) ? list : []) {
            if (!isTabId(entry?.openingTabId) || !isTabId(entry?.launchTabId)) continue;
            if (now() - Number(entry.startedAt || 0) > STALE_AFTER_MS) continue;
            if (!pending.has(entry.openingTabId)) pending.set(entry.openingTabId, entry);
          }
        } catch {
          /* an unreadable store only means this worker starts with nothing pending */
        }
      })();
    }
    return loaded;
  }

  async function save() {
    if (typeof storageSession?.set !== 'function') return;
    try {
      await storageSession.set({ [HERMES_WEB_OPENING_STORAGE_KEY]: [...pending.values()].filter((entry) => isTabId(entry.launchTabId)) });
    } catch {
      /* best effort */
    }
  }

  async function removeTab(tabId) {
    try {
      await tabsApi.remove(tabId);
    } catch {
      /* already closed */
    }
  }

  async function activate(entry) {
    if (!isTabId(entry.launchTabId)) return;
    await tabsApi.update(entry.launchTabId, { active: true });
    const windowId = Number.isInteger(entry.windowId) ? entry.windowId : null;
    if (windowId !== null && typeof windowsApi?.update === 'function') {
      try {
        await windowsApi.update(windowId, { focused: true });
      } catch {
        /* the tab is already selected; raising its window is best effort */
      }
    }
  }

  async function forget(entry) {
    pending.delete(entry.openingTabId);
    await save();
  }

  // The Webapp tab is ready (or the person asked for it): show it, then close the opening page.
  async function reveal(entry) {
    await forget(entry);
    try {
      await activate(entry);
    } catch {
      // The Webapp tab is gone. Nothing is left to show, so the opening page goes too.
    }
    await removeTab(entry.openingTabId);
  }

  async function start(request) {
    const clean = normalizeOpeningRequest(request);
    if (!clean) return { ok: false, reason: 'invalid-request' };
    await load();
    let openingTab;
    try {
      openingTab = await tabsApi.create({ url: runtimeApi.getURL(HERMES_WEB_OPENING_PAGE), active: true });
    } catch (error) {
      return { ok: false, reason: error?.message || String(error) };
    }
    if (!isTabId(openingTab?.id)) return { ok: false, reason: 'no-tab' };
    // Registered before the launch tab exists: the opening page asks for its state as soon as it loads.
    const entry = {
      openingTabId: openingTab.id,
      launchTabId: null,
      windowId: openingTab.windowId,
      origin: clean.origin,
      basePath: clean.basePath,
      startedAt: now(),
    };
    pending.set(entry.openingTabId, entry);
    let launchTab;
    try {
      const options = { url: clean.url, active: false };
      if (Number.isInteger(openingTab.windowId)) options.windowId = openingTab.windowId;
      if (Number.isInteger(openingTab.index)) options.index = openingTab.index + 1;
      launchTab = await tabsApi.create(options);
    } catch (error) {
      pending.delete(entry.openingTabId);
      await removeTab(openingTab.id);
      return { ok: false, reason: error?.message || String(error) };
    }
    if (!isTabId(launchTab?.id)) {
      pending.delete(entry.openingTabId);
      await removeTab(openingTab.id);
      return { ok: false, reason: 'no-tab' };
    }
    entry.launchTabId = launchTab.id;
    if (Number.isInteger(launchTab.windowId)) entry.windowId = launchTab.windowId;
    if (!pending.has(entry.openingTabId)) {
      // The opening page was closed while the launch tab was being created: show the launch tab instead.
      try {
        await activate(entry);
      } catch {
        /* closed already */
      }
      return { ok: true, tabId: entry.launchTabId, openingTabId: entry.openingTabId };
    }
    await save();
    // A fast Webapp could have finished loading before the entry existed.
    try {
      const current = await tabsApi.get(entry.launchTabId);
      if (current?.status === 'complete' && isWebappReachedUrl(current.url, entry)) await reveal(entry);
    } catch {
      /* the listener below still sees the next update */
    }
    return { ok: true, tabId: entry.launchTabId, openingTabId: entry.openingTabId };
  }

  async function handleTabUpdated(tabId, changeInfo, tab) {
    if (changeInfo?.status !== 'complete') return;
    await load();
    for (const entry of [...pending.values()]) {
      if (entry.launchTabId !== tabId) continue;
      if (isWebappReachedUrl(tab?.url, entry)) await reveal(entry);
    }
  }

  async function handleTabRemoved(tabId) {
    await load();
    for (const entry of [...pending.values()]) {
      if (entry.openingTabId === tabId) {
        // The person closed the opening page: show what is loading rather than leave it hidden.
        await forget(entry);
        try {
          await activate(entry);
        } catch {
          /* the Webapp tab is gone too */
        }
      } else if (entry.launchTabId === tabId) {
        // The Webapp tab was closed before it arrived: the opening page has nothing left to wait for.
        await forget(entry);
        await removeTab(entry.openingTabId);
      }
    }
  }

  async function handleMessage(message, sender) {
    const senderTabId = sender?.tab?.id;
    if (message?.type === HERMES_WEB_OPENING_MESSAGES.start) return start(message);
    await load();
    if (message?.type === HERMES_WEB_OPENING_MESSAGES.state) {
      const entry = pending.get(senderTabId);
      if (!entry) return { ok: true, status: 'none' };
      return { ok: true, status: 'waiting', startedAt: entry.startedAt, now: now(), timeoutMs };
    }
    if (message?.type === HERMES_WEB_OPENING_MESSAGES.show) {
      const entry = pending.get(senderTabId);
      if (entry && !isTabId(entry.launchTabId)) {
        // Still opening the Webapp tab: there is nothing to show yet.
      } else if (entry) {
        await reveal(entry);
      } else if (isTabId(senderTabId)) {
        // Nothing is being opened for this page (a restored tab): there is nothing to show, so close it.
        await removeTab(senderTabId);
      }
      return { ok: true };
    }
    return { ok: false, reason: 'unknown-message' };
  }

  return {
    start,
    handleTabUpdated,
    handleTabRemoved,
    handleMessage,
    handles: handlesHermesWebOpeningMessage,
    /** Test and diagnostics only. */
    pendingCount: () => pending.size,
  };
}

/**
 * The panel's side: an `opener` for openHermesWebapp that asks the background worker to run the hand-off.
 * `sendMessage` is the browser's runtime.sendMessage. Resolves { ok, tabId } and never throws.
 */
export function createHermesWebOpener({ sendMessage } = {}) {
  return {
    async open({ url, origin, basePath = '' } = {}) {
      if (typeof sendMessage !== 'function') return { ok: false, reason: 'unavailable' };
      try {
        const response = await sendMessage({ type: HERMES_WEB_OPENING_MESSAGES.start, url, origin, basePath });
        return response?.ok === true ? { ok: true, tabId: response.tabId } : { ok: false, reason: response?.reason || 'refused' };
      } catch (error) {
        return { ok: false, reason: error?.message || String(error) };
      }
    },
  };
}
