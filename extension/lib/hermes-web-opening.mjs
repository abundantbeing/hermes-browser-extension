// The "Opening Hermes Web" hand-off.
//
// A Hermes Web tab signed in by a one-use ticket opens at `<webapp>/webapp/launch#ticket=...`. That is the
// gateway's own redeem page: an unstyled page that spends a moment before the Webapp loads. Nobody should see
// it as it is:
//
//   1. the first time in a run of the gateway ("page" mode), an extension page (hermes-web-opening.html) is the
//      visible tab while the launch URL loads in a background tab beside it (`active: false`). When that tab
//      reaches the Webapp itself (a finished load on the Webapp's origin, no longer on /webapp/launch or
//      /webapp/window) it is activated, its window focused, the opening tab closed, and the run remembered as
//      signed in. If that does not happen within HERMES_WEB_OPENING_TIMEOUT_MS the opening page offers "Show it
//      anyway". Closing the opening page activates the Webapp tab; closing the Webapp tab closes the page;
//   2. later in the same run ("quiet" mode) the launch URL opens as the visible tab straight away, with nothing in
//      between. A run is the gateway process (its pid from /health/detailed); without one, the browser session
//      stands in for it;
//   3. on the gateway's hand-off pages themselves, a content script (hermes-web-launch.js) covers the plain page
//      before it paints and asks `handleLaunchLook` how: the opening page's design for a first launch (also on the
//      background tab of page mode, should someone switch to it), or Hermes Web's own background for a quiet one.
//      A launch the extension did not start (`hermes webapp` in a terminal) is covered the same way, and its run
//      remembered once it reaches the Webapp.
//
// The ticket lives only in the launch tab's URL fragment. The opening page's own URL never carries it: the
// launch target travels in a runtime message to the background worker, which holds it in memory and in
// storage.session (so a restarted worker keeps watching the same tab).
//
// Chrome and Firefox share this code. Both have tabs.create/update/remove/query/onUpdated/onRemoved,
// windows.update and runtime.getURL. The opening page is web-accessible to loopback pages only, so the content
// script can frame it on the hand-off page; framed, it sends no messages, and the worker ignores a framed "show".

export const HERMES_WEB_OPENING_PAGE = 'hermes-web-opening.html';
export const HERMES_WEB_OPENING_TIMEOUT_MS = 20_000;
export const HERMES_WEB_OPENING_STORAGE_KEY = 'hermesWebOpeningPending';
// storage.local: the gateway run a Hermes Web tab last reached the Webapp in (see `runtimeIdentity`).
export const HERMES_WEB_SIGNED_IN_KEY = 'hermesWebSignedInRuntime';

// Sent by the extension's own pages (the panel, the opening page).
export const HERMES_WEB_OPENING_MESSAGES = Object.freeze({
  start: 'HERMES_WEB_OPENING_START',
  state: 'HERMES_WEB_OPENING_STATE',
  show: 'HERMES_WEB_OPENING_SHOW',
});
// Sent by the content script on the gateway's hand-off page, so page-reachable: it only ever learns a look.
export const HERMES_WEB_LAUNCH_LOOK_MESSAGE = 'HERMES_WEB_LAUNCH_LOOK';

export const HERMES_WEB_OPENING_MODES = Object.freeze({ page: 'page', quiet: 'quiet' });

const MESSAGE_TYPES = new Set(Object.values(HERMES_WEB_OPENING_MESSAGES));
const STALE_AFTER_MS = 10 * 60_000;
const RUNTIME_IDENTITY_TIMEOUT_MS = 1_500;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True for the runtime message types this module's controller handles from the extension's own pages. */
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

/** Whether `url` is a gateway hand-off page (`.../webapp/launch` or `.../webapp/window`) on this computer. */
export function isLoopbackHandoffUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname)) return false;
  return /\/webapp\/(?:launch|window)$/.test(parsed.pathname);
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

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(''), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The background worker's side. `tabsApi`, `windowsApi` and `runtimeApi` are the browser's; `storageSession` and
 * `storageLocal` are optional (without storage.session a restarted worker forgets what it was watching, and the
 * opening page's button still works; without storage.local every launch shows the opening page).
 * `runtimeIdentity(request)` names the current run of the gateway ('' when it cannot tell): the opening page shows
 * once per run, and later launches in that run open straight away.
 */
export function createHermesWebOpening({
  tabsApi,
  windowsApi,
  runtimeApi,
  storageSession,
  storageLocal,
  runtimeIdentity = async () => '',
  now = () => Date.now(),
  timeoutMs = HERMES_WEB_OPENING_TIMEOUT_MS,
} = {}) {
  /** openingTabId -> { openingTabId, launchTabId, windowId, origin, basePath, startedAt, runtime } */
  const pending = new Map();
  /** launch tab id -> the run it was covered as a first launch in; remembered once it reaches the Webapp */
  const watching = new Map();
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

  async function signedInRuntime() {
    if (typeof storageLocal?.get !== 'function') return '';
    try {
      const stored = await storageLocal.get(HERMES_WEB_SIGNED_IN_KEY);
      return typeof stored?.[HERMES_WEB_SIGNED_IN_KEY] === 'string' ? stored[HERMES_WEB_SIGNED_IN_KEY] : '';
    } catch {
      return '';
    }
  }

  async function rememberSignedIn(runtime) {
    if (!runtime || typeof storageLocal?.set !== 'function') return;
    try {
      await storageLocal.set({ [HERMES_WEB_SIGNED_IN_KEY]: runtime });
    } catch {
      /* best effort: the next launch shows the opening page again */
    }
  }

  async function currentRuntime(request) {
    try {
      const value = await withTimeout(Promise.resolve(runtimeIdentity(request)), RUNTIME_IDENTITY_TIMEOUT_MS);
      return typeof value === 'string' ? value : '';
    } catch {
      return '';
    }
  }

  // Signed in already this run: no opening page, nothing in between.
  async function isSignedInRun(runtime) {
    return Boolean(runtime) && (await signedInRuntime()) === runtime;
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

  // The Webapp tab is ready (or the person asked for it): show it, then close the opening page. Only a tab that
  // reached the Webapp itself marks the run as signed in.
  async function reveal(entry, { reached = false } = {}) {
    await forget(entry);
    if (reached) await rememberSignedIn(entry.runtime);
    try {
      await activate(entry);
    } catch {
      // The Webapp tab is gone. Nothing is left to show, so the opening page goes too.
    }
    await removeTab(entry.openingTabId);
  }

  // Later launches in a signed-in run: the launch tab opens in front, next to the tab the person is on.
  async function startQuiet(clean) {
    const options = { url: clean.url, active: true };
    try {
      const [current] = typeof tabsApi.query === 'function' ? await tabsApi.query({ active: true, lastFocusedWindow: true }) : [];
      if (Number.isInteger(current?.windowId)) options.windowId = current.windowId;
      if (Number.isInteger(current?.index)) options.index = current.index + 1;
    } catch {
      /* the browser places the tab */
    }
    let launchTab;
    try {
      launchTab = await tabsApi.create(options);
    } catch (error) {
      return { ok: false, reason: error?.message || String(error) };
    }
    if (!isTabId(launchTab?.id)) return { ok: false, reason: 'no-tab' };
    return { ok: true, tabId: launchTab.id, mode: HERMES_WEB_OPENING_MODES.quiet };
  }

  // The first launch in a run: the opening page is the visible tab and the launch tab loads beside it.
  async function startPage(clean, runtime) {
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
      runtime,
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
    const result = { ok: true, tabId: entry.launchTabId, openingTabId: entry.openingTabId, mode: HERMES_WEB_OPENING_MODES.page };
    if (!pending.has(entry.openingTabId)) {
      // The opening page was closed while the launch tab was being created: show the launch tab instead.
      try {
        await activate(entry);
      } catch {
        /* closed already */
      }
      return result;
    }
    await save();
    // A fast Webapp could have finished loading before the entry existed.
    try {
      const current = await tabsApi.get(entry.launchTabId);
      if (current?.status === 'complete' && isWebappReachedUrl(current.url, entry)) await reveal(entry, { reached: true });
    } catch {
      /* the listener below still sees the next update */
    }
    return result;
  }

  async function start(request) {
    const clean = normalizeOpeningRequest(request);
    if (!clean) return { ok: false, reason: 'invalid-request' };
    await load();
    const runtime = await currentRuntime(clean);
    return (await isSignedInRun(runtime)) ? startQuiet(clean) : startPage(clean, runtime);
  }

  /**
   * The content script on a gateway hand-off page asks how to cover it. `sender` is the browser's: only the top
   * frame of a loopback hand-off page is answered. Resolves { look: 'page' | 'quiet' } or { look: '' }.
   */
  async function handleLaunchLook(sender) {
    const tabId = sender?.tab?.id;
    if (!isTabId(tabId) || (sender?.frameId !== undefined && sender.frameId !== 0) || !isLoopbackHandoffUrl(sender?.url)) {
      return { look: '' };
    }
    await load();
    // Page mode's background tab: someone who switches to it sees the opening page's design too.
    for (const entry of pending.values()) {
      if (entry.launchTabId === tabId) return { look: HERMES_WEB_OPENING_MODES.page };
    }
    const runtime = await currentRuntime();
    if (await isSignedInRun(runtime)) return { look: HERMES_WEB_OPENING_MODES.quiet };
    // A first launch the extension did not run as page mode (a terminal launch, or a direct open): its run counts
    // as signed in once it reaches the Webapp.
    if (runtime) watching.set(tabId, runtime);
    return { look: HERMES_WEB_OPENING_MODES.page };
  }

  async function handleTabUpdated(tabId, changeInfo, tab) {
    if (changeInfo?.status !== 'complete') return;
    await load();
    for (const entry of [...pending.values()]) {
      if (entry.launchTabId !== tabId) continue;
      if (isWebappReachedUrl(tab?.url, entry)) await reveal(entry, { reached: true });
    }
    if (watching.has(tabId)) {
      const parsed = parseUrl(tab?.url);
      if (parsed && LOOPBACK_HOSTS.has(parsed.hostname) && !isLoopbackHandoffUrl(tab.url)) {
        const runtime = watching.get(tabId);
        watching.delete(tabId);
        await rememberSignedIn(runtime);
      }
    }
  }

  async function handleTabRemoved(tabId) {
    await load();
    watching.delete(tabId);
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
      // The origin is only the Webapp's address, for the page to name; the launch URL and its ticket stay here.
      return { ok: true, status: 'waiting', startedAt: entry.startedAt, now: now(), timeoutMs, origin: entry.origin };
    }
    if (message?.type === HERMES_WEB_OPENING_MESSAGES.show) {
      // Only the opening page as its own tab acts; the same page framed on the hand-off page never does.
      if (sender?.frameId !== undefined && sender.frameId !== 0) return { ok: true };
      const entry = pending.get(senderTabId);
      if (entry && !isTabId(entry.launchTabId)) {
        // Still opening the Webapp tab: there is nothing to show yet.
      } else if (entry) {
        await reveal(entry, { reached: false });
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
    handleLaunchLook,
    handles: handlesHermesWebOpeningMessage,
    /** Test and diagnostics only. */
    pendingCount: () => pending.size,
  };
}

/**
 * The panel's side: an `opener` for openHermesWebapp that asks the background worker to run the hand-off.
 * `sendMessage` is the browser's runtime.sendMessage. Resolves { ok, tabId, mode } and never throws.
 */
export function createHermesWebOpener({ sendMessage } = {}) {
  return {
    async open({ url, origin, basePath = '' } = {}) {
      if (typeof sendMessage !== 'function') return { ok: false, reason: 'unavailable' };
      try {
        const response = await sendMessage({ type: HERMES_WEB_OPENING_MESSAGES.start, url, origin, basePath });
        return response?.ok === true
          ? { ok: true, tabId: response.tabId, mode: response.mode === HERMES_WEB_OPENING_MODES.quiet ? HERMES_WEB_OPENING_MODES.quiet : HERMES_WEB_OPENING_MODES.page }
          : { ok: false, reason: response?.reason || 'refused' };
      } catch (error) {
        return { ok: false, reason: error?.message || String(error) };
      }
    },
  };
}
