// The "Opening Hermes Web" hand-off.
//
// A Hermes Web tab signed in by a one-use ticket opens at `<webapp>/webapp/launch#ticket=...`. That is the
// gateway's own redeem page: an unstyled page that spends a moment before the Webapp loads. This module makes
// sure nobody looks at it:
//
//   1. the launch URL always opens in a background tab (`active: false`);
//   2. the first time in a run of the gateway, an extension page (hermes-web-opening.html) is the visible tab
//      while it loads ("page" mode). Later Hermes Web tabs in the same run open with nothing in between: the
//      tab the person is on stays in front until the Webapp is there ("quiet" mode). A run is the gateway
//      process (its pid from /health/detailed); without one, the browser session stands in for it;
//   3. when the background tab reaches the Webapp itself (a finished load on the Webapp's origin, no longer
//      on /webapp/launch or /webapp/window) that tab is activated, its window focused, the opening tab
//      closed, and the run remembered as signed in;
//   4. if that does not happen within HERMES_WEB_OPENING_TIMEOUT_MS the opening page offers "Show it anyway",
//      which activates the background tab as it is; a quiet launch is shown as it is;
//   5. closing the opening page activates the Webapp tab, and closing the Webapp tab closes the opening page.
//
// The ticket lives only in the launch tab's URL fragment. The opening page's own URL never carries it: the
// launch target travels in a runtime message to the background worker, which holds it in memory and in
// storage.session (so a restarted worker keeps watching the same tab).
//
// Chrome and Firefox share this code. Both have tabs.create/update/remove/query/onUpdated/onRemoved,
// windows.update and runtime.getURL, and the page is opened by the extension itself, so it is not web-accessible.

export const HERMES_WEB_OPENING_PAGE = 'hermes-web-opening.html';
export const HERMES_WEB_OPENING_TIMEOUT_MS = 20_000;
export const HERMES_WEB_OPENING_STORAGE_KEY = 'hermesWebOpeningPending';
// storage.local: the gateway run a Hermes Web tab last reached the Webapp in (see `runtimeIdentity`).
export const HERMES_WEB_SIGNED_IN_KEY = 'hermesWebSignedInRuntime';

export const HERMES_WEB_OPENING_MESSAGES = Object.freeze({
  start: 'HERMES_WEB_OPENING_START',
  state: 'HERMES_WEB_OPENING_STATE',
  show: 'HERMES_WEB_OPENING_SHOW',
});

export const HERMES_WEB_OPENING_MODES = Object.freeze({ page: 'page', quiet: 'quiet' });

const MESSAGE_TYPES = new Set(Object.values(HERMES_WEB_OPENING_MESSAGES));
const STALE_AFTER_MS = 10 * 60_000;
const RUNTIME_IDENTITY_TIMEOUT_MS = 1_500;

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

// Pending launches are keyed by the tab the person watches: the opening page, or (quiet) the launch tab itself.
function entryKey(entry) {
  return entry.mode === HERMES_WEB_OPENING_MODES.quiet ? `quiet:${entry.launchTabId}` : `page:${entry.openingTabId}`;
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
 * once per run, and later launches in that run are quiet.
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
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  /** key -> { mode, openingTabId, launchTabId, windowId, origin, basePath, startedAt, runtime } */
  const pending = new Map();
  const timers = new Map();
  let loaded = null;

  // A quiet launch has no page to offer "Show it anyway", so the worker shows it when the wait runs out.
  function arm(entry) {
    if (entry.mode !== HERMES_WEB_OPENING_MODES.quiet) return;
    const key = entryKey(entry);
    if (timers.has(key)) return;
    const remaining = Math.max(0, timeoutMs - Math.max(0, now() - Number(entry.startedAt || 0)));
    timers.set(key, setTimer(() => {
      timers.delete(key);
      const current = pending.get(key);
      if (current) void reveal(current, { reached: false });
    }, remaining));
  }

  function disarm(entry) {
    const key = entryKey(entry);
    if (!timers.has(key)) return;
    clearTimer(timers.get(key));
    timers.delete(key);
  }

  function load() {
    if (!loaded) {
      loaded = (async () => {
        if (typeof storageSession?.get !== 'function') return;
        try {
          const stored = await storageSession.get(HERMES_WEB_OPENING_STORAGE_KEY);
          const list = stored?.[HERMES_WEB_OPENING_STORAGE_KEY];
          for (const raw of Array.isArray(list) ? list : []) {
            const entry = { ...raw, mode: raw?.mode === HERMES_WEB_OPENING_MODES.quiet ? HERMES_WEB_OPENING_MODES.quiet : HERMES_WEB_OPENING_MODES.page };
            if (!isTabId(entry.launchTabId)) continue;
            if (entry.mode === HERMES_WEB_OPENING_MODES.page && !isTabId(entry.openingTabId)) continue;
            if (now() - Number(entry.startedAt || 0) > STALE_AFTER_MS) continue;
            const key = entryKey(entry);
            if (pending.has(key)) continue;
            pending.set(key, entry);
            arm(entry);
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

  async function currentRuntime(clean) {
    try {
      const value = await withTimeout(Promise.resolve(runtimeIdentity(clean)), RUNTIME_IDENTITY_TIMEOUT_MS);
      return typeof value === 'string' ? value : '';
    } catch {
      return '';
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
    disarm(entry);
    pending.delete(entryKey(entry));
    await save();
  }

  // The Webapp tab is ready (or the person asked for it, or a quiet wait ran out): show it, then close the opening
  // page. Only a tab that reached the Webapp itself marks the run as signed in.
  async function reveal(entry, { reached = false } = {}) {
    await forget(entry);
    if (reached) await rememberSignedIn(entry.runtime);
    try {
      await activate(entry);
    } catch {
      // The Webapp tab is gone. Nothing is left to show, so the opening page goes too.
    }
    if (entry.mode === HERMES_WEB_OPENING_MODES.page) await removeTab(entry.openingTabId);
  }

  // A launch tab that already reached the Webapp by the time its entry exists is shown at once.
  async function revealIfReached(entry) {
    try {
      const current = await tabsApi.get(entry.launchTabId);
      if (current?.status === 'complete' && isWebappReachedUrl(current.url, entry)) await reveal(entry, { reached: true });
    } catch {
      /* the tab listener still sees the next update */
    }
  }

  // Later launches in a signed-in run: the launch tab opens out of sight next to the tab the person is on.
  async function startQuiet(clean, runtime) {
    const options = { url: clean.url, active: false };
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
    const entry = {
      mode: HERMES_WEB_OPENING_MODES.quiet,
      openingTabId: null,
      launchTabId: launchTab.id,
      windowId: Number.isInteger(launchTab.windowId) ? launchTab.windowId : options.windowId,
      origin: clean.origin,
      basePath: clean.basePath,
      startedAt: now(),
      runtime,
    };
    pending.set(entryKey(entry), entry);
    await save();
    arm(entry);
    await revealIfReached(entry);
    return { ok: true, tabId: entry.launchTabId, mode: entry.mode };
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
      mode: HERMES_WEB_OPENING_MODES.page,
      openingTabId: openingTab.id,
      launchTabId: null,
      windowId: openingTab.windowId,
      origin: clean.origin,
      basePath: clean.basePath,
      startedAt: now(),
      runtime,
    };
    const key = entryKey(entry);
    pending.set(key, entry);
    let launchTab;
    try {
      const options = { url: clean.url, active: false };
      if (Number.isInteger(openingTab.windowId)) options.windowId = openingTab.windowId;
      if (Number.isInteger(openingTab.index)) options.index = openingTab.index + 1;
      launchTab = await tabsApi.create(options);
    } catch (error) {
      pending.delete(key);
      await removeTab(openingTab.id);
      return { ok: false, reason: error?.message || String(error) };
    }
    if (!isTabId(launchTab?.id)) {
      pending.delete(key);
      await removeTab(openingTab.id);
      return { ok: false, reason: 'no-tab' };
    }
    entry.launchTabId = launchTab.id;
    if (Number.isInteger(launchTab.windowId)) entry.windowId = launchTab.windowId;
    if (!pending.has(key)) {
      // The opening page was closed while the launch tab was being created: show the launch tab instead.
      try {
        await activate(entry);
      } catch {
        /* closed already */
      }
      return { ok: true, tabId: entry.launchTabId, openingTabId: entry.openingTabId, mode: entry.mode };
    }
    await save();
    await revealIfReached(entry);
    return { ok: true, tabId: entry.launchTabId, openingTabId: entry.openingTabId, mode: entry.mode };
  }

  async function start(request) {
    const clean = normalizeOpeningRequest(request);
    if (!clean) return { ok: false, reason: 'invalid-request' };
    await load();
    const runtime = await currentRuntime(clean);
    const quiet = Boolean(runtime) && (await signedInRuntime()) === runtime;
    return quiet ? startQuiet(clean, runtime) : startPage(clean, runtime);
  }

  async function handleTabUpdated(tabId, changeInfo, tab) {
    if (changeInfo?.status !== 'complete') return;
    await load();
    for (const entry of [...pending.values()]) {
      if (entry.launchTabId !== tabId) continue;
      if (isWebappReachedUrl(tab?.url, entry)) await reveal(entry, { reached: true });
    }
  }

  async function handleTabRemoved(tabId) {
    await load();
    for (const entry of [...pending.values()]) {
      if (entry.mode === HERMES_WEB_OPENING_MODES.page && entry.openingTabId === tabId) {
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
        if (entry.mode === HERMES_WEB_OPENING_MODES.page) await removeTab(entry.openingTabId);
      }
    }
  }

  async function handleMessage(message, sender) {
    const senderTabId = sender?.tab?.id;
    if (message?.type === HERMES_WEB_OPENING_MESSAGES.start) return start(message);
    await load();
    const entry = isTabId(senderTabId) ? pending.get(`page:${senderTabId}`) : null;
    if (message?.type === HERMES_WEB_OPENING_MESSAGES.state) {
      if (!entry) return { ok: true, status: 'none' };
      // The origin is only the Webapp's address, for the page to name; the launch URL and its ticket stay here.
      return { ok: true, status: 'waiting', startedAt: entry.startedAt, now: now(), timeoutMs, origin: entry.origin };
    }
    if (message?.type === HERMES_WEB_OPENING_MESSAGES.show) {
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

/**
 * Where no hand-off worker is available: open the launch URL out of sight and bring its tab forward once it reaches
 * the Webapp itself (or the wait runs out), so the gateway's hand-off page is never what the person sees. Needs
 * tabs.onUpdated and tabs.update; without them it resolves null and the caller opens the tab as before.
 */
export async function openLaunchTabOutOfSight({ url, origin, basePath = '', tabsApi, timeoutMs = HERMES_WEB_OPENING_TIMEOUT_MS } = {}) {
  if (typeof tabsApi?.onUpdated?.addListener !== 'function' || typeof tabsApi?.update !== 'function') return null;
  const tab = await tabsApi.create({ url, active: false });
  if (!isTabId(tab?.id)) return tab || null;
  let timer = null;
  const done = () => {
    tabsApi.onUpdated.removeListener?.(onUpdated);
    tabsApi.onRemoved?.removeListener?.(onRemoved);
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const show = () => {
    done();
    Promise.resolve(tabsApi.update(tab.id, { active: true })).catch(() => undefined);
  };
  function onUpdated(tabId, changeInfo, current) {
    if (tabId === tab.id && changeInfo?.status === 'complete' && isWebappReachedUrl(current?.url, { origin, basePath })) show();
  }
  function onRemoved(tabId) {
    if (tabId === tab.id) done();
  }
  tabsApi.onUpdated.addListener(onUpdated);
  tabsApi.onRemoved?.addListener?.(onRemoved);
  timer = setTimeout(show, timeoutMs);
  return tab;
}
