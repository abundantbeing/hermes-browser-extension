import { hydrateHermesBrowserSettingsFromStorage, SAVED_CONNECTION_SECRETS_STORAGE_KEY } from './saved-connections.mjs';
import { BACKGROUND_BROWSER_SESSION, CONTROLLER_METHODS } from './controller-protocol.mjs';
import { createLoadWaiter } from './browser-control-browser-adapters.mjs';
import { sha256Hex } from './browser-control-artifacts.mjs';
import { validateBrowserControlUrl } from './browser-control-safety.mjs';
import { safeNetworkUrl } from './browser-control-executor.mjs';
import { redactSensitiveText } from './browser-context-protocol.mjs';

export const BACKGROUND_BROWSER_CONSENT = 'hermesBackgroundBrowserConsent';
export const BACKGROUND_BROWSER_ALARM = 'hermes-background-browser-reconnect';

function backgroundBrowserGateway(settings = {}) {
  try {
    const url = new URL(settings.gatewayUrl);
    if (settings.connectionTransport !== 'local-api' || !backgroundBrowserApiKey(settings)
      || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return '';
    return JSON.stringify([url.href, String(settings.activeProfile || '')]);
  } catch {
    return '';
  }
}

function backgroundBrowserApiKey(settings) {
  return String(settings?.apiKey || '').trim();
}

export async function backgroundBrowserConsentIdentity(settings) {
  const gateway = backgroundBrowserGateway(settings);
  if (!gateway) return '';
  const fingerprint = await sha256Hex(backgroundBrowserApiKey(settings));
  return JSON.stringify([gateway, fingerprint]);
}

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

function tabView(tab) {
  const urls = [tab.url, tab.pendingUrl].filter(Boolean);
  const restricted = !urls.length || urls.some((url) => !validateBrowserControlUrl(url).ok);
  return {
    id: tab.id,
    windowId: tab.windowId,
    ...(restricted ? { title: 'Restricted page' } : {
      title: redactSensitiveText(String(tab.title || '').slice(0, 500)),
      url: safeNetworkUrl(tab.url || tab.pendingUrl),
    }),
    active: tab.active === true,
    loading: tab.status === 'loading',
  };
}

const PAGE_ACTIONS = new Set([
  'browser_back', 'browser_click', 'browser_fill', 'browser_navigate', 'browser_press',
  'browser_scroll', 'browser_scroll_to', 'browser_select', 'browser_snapshot', 'browser_type',
]);

export const BACKGROUND_BROWSER_ACTIONS = [
  ...PAGE_ACTIONS, 'browser_tabs', 'browser_tab_create', 'browser_tab_group',
];

export function createBackgroundTaskBrowser({ browserApi, connector, runtime, product }) {
  const { tabs, windows, tabGroups, storage, alarms } = browserApi;
  const { waitForLoad } = createLoadWaiter({ browserApi });
  const sessions = new Map();
  const pending = new Map();
  const controllerId = `background-${crypto.randomUUID()}`;
  let connection;
  let route;
  /** Consent identity background task tab leases were opened under. */
  let sessionRoute;
  let revision = 0;
  let sync = Promise.resolve();
  const sessionQueues = new Map();

  async function getTab(id) {
    try {
      return await tabs.get(id);
    } catch {
      return null;
    }
  }

  async function groupTab(state, tab, signal) {
    const members = state.groupId === null ? [] : await tabs.query({ groupId: state.groupId });
    signal.throwIfAborted();
    // A person may move their own tab into the group. Leave that group alone.
    if (members.length && members.every((member) => (
      state.tabs.has(member.id) && member.windowId === tab.windowId
    ))) {
      return tabs.group({ tabIds: [tab.id], groupId: state.groupId });
    }
    const groupId = await tabs.group({ tabIds: [tab.id] });
    signal.throwIfAborted();
    await tabGroups.update(groupId, { title: 'Hermes', color: 'blue' });
    return groupId;
  }

  async function createTab(state, rawUrl, signal) {
    const destination = validateBrowserControlUrl(rawUrl);
    if (!destination.ok) return failure('restricted_url', 'The destination is restricted.');
    const owner = state.lastTab ? await getTab(state.lastTab) : null;
    const window = owner
      ? await windows.get(owner.windowId)
      : await windows.getLastFocused({ windowTypes: ['normal'] });
    if (window.incognito || window.type !== 'normal') {
      return failure('no_normal_window', 'Open a regular Chrome window for Hermes background tasks.');
    }
    signal.throwIfAborted();
    const tab = await tabs.create({ windowId: window.id, url: 'about:blank', active: false });
    try {
      signal.throwIfAborted();
      state.groupId = await groupTab(state, tab, signal);
      signal.throwIfAborted();
      const updated = await tabs.update(tab.id, { url: destination.url });
      const { timedOut } = await waitForLoad(tab.id, {
        signal, startUrl: 'about:blank', sawLoading: updated.status === 'loading', timeoutMs: 10_000,
      });
      const loaded = await tabs.get(tab.id);
      signal.throwIfAborted();
      state.tabs.set(tab.id, { document: 1, leaseId: crypto.randomUUID(), url: loaded.url });
      state.lastTab = tab.id;
      return { ok: true, result: { tab: { ...tabView(loaded), loading: timedOut || loaded.status === 'loading' }, groupId: state.groupId } };
    } catch (error) {
      await tabs.remove(tab.id).catch(() => {});
      throw error;
    }
  }

  async function execute(params, controller) {
    const { signal } = controller;
    const { action, arguments: args = {}, background_session: sessionId } = params;
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) {
      return failure('no_session', 'The background command has no Hermes session.');
    }
    const state = sessions.get(sessionId) || { tabs: new Map(), groupId: null, lastTab: null };
    signal.throwIfAborted();
    if (action === 'browser_tabs') {
      const owned = await Promise.all([...state.tabs.keys()].map(getTab));
      return { ok: true, result: { tabs: owned.filter(Boolean).map(tabView) } };
    }
    if (action === 'browser_tab_group') {
      const ids = args.tab_ids;
      if (!Array.isArray(ids) || !ids.length || ids.some((id) => !state.tabs.has(Number(id)))) {
        return failure('lease_not_owned', 'Every tab must have been opened by this Hermes session.');
      }
      const members = await Promise.all(ids.map((id) => getTab(Number(id))));
      if (state.groupId !== null && members.every((tab) => tab?.groupId === state.groupId)) {
        return { ok: true, result: { status: 'tabs-grouped', groupId: state.groupId } };
      }
      return failure('group_changed', 'Chrome tabs opened by Hermes are grouped automatically.');
    }
    if (action === 'browser_tab_create' || (action === 'browser_navigate' && !state.tabs.size && args.tab_id == null)) {
      const result = await createTab(state, args.url, signal);
      if (result.ok) sessions.set(sessionId, state);
      return result;
    }
    if (!PAGE_ACTIONS.has(action)) {
      return failure('background_action_unavailable', 'This action is unavailable in background task tabs.');
    }

    const id = Number(args.tab_id ?? (state.tabs.has(state.lastTab) ? state.lastTab : state.tabs.keys().next().value));
    const lease = state.tabs.get(id);
    if (!lease) return failure('lease_not_owned', 'Use tab_create to open a tab owned by this Hermes session.');
    const tab = await getTab(id);
    if (!tab || tab.incognito || !state.tabs.has(id)) return failure('lease_not_owned', 'The task tab is no longer available.');
    if (lease.url !== tab.url) {
      lease.url = tab.url;
      lease.document += 1;
    }
    signal.throwIfAborted();
    const scope = {
      controllerId, leaseOwnerId: controllerId, leaseId: lease.leaseId, leaseGeneration: 1,
      tabId: id, frameId: 0, documentGeneration: lease.document,
    };
    lease.abort = () => controller.abort();
    try {
      const result = await runtime.execute({
        ...params, tab_id: id, frame_id: 0, document_generation: lease.document,
      }, {
        scope, signal, backgroundTask: true, leasedTabIds: [id], ownedTabIds: [id],
        currentWindowId: tab.windowId,
        currentDocumentGeneration: () => lease.document,
        controlHalted: () => signal.aborted || !state.tabs.has(id),
      }, { browserControlEnabled: true });
      if (result.ok) state.lastTab = id;
      return result;
    } finally {
      delete lease.abort;
    }
  }

  function onFrame(frame, socket, connectionRevision) {
    const params = frame?.params || {};
    const id = params.command_id;
    if (!id || connectionRevision !== revision) return;
    if (frame.method === CONTROLLER_METHODS.cancel) {
      pending.get(id)?.abort();
      return;
    }
    if (frame.method !== CONTROLLER_METHODS.command || pending.has(id)) return;
    const controller = new AbortController();
    pending.set(id, controller);
    const timer = setTimeout(() => controller.abort(), 28_000);
    const sessionId = params.background_session;
    const queue = (sessionQueues.get(sessionId) || Promise.resolve()).then(async () => {
      let outcome;
      try {
        controller.signal.throwIfAborted();
        outcome = await execute(params, controller);
      } catch {
        outcome = controller.signal.aborted
          ? failure('cancelled', 'The background command was cancelled.')
          : failure('background_browser_error', 'Chrome could not complete the background command.');
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
      await socket()?.send({ method: CONTROLLER_METHODS.result, params: { command_id: id, ...outcome } });
    }).catch(() => {}).finally(() => {
      if (sessionQueues.get(sessionId) === queue) sessionQueues.delete(sessionId);
    });
    sessionQueues.set(sessionId, queue);
  }

  function close() {
    revision += 1;
    for (const controller of pending.values()) controller.abort();
    connection?.close();
    connection = null;
  }

  async function reconcile() {
    const readRevision = revision;
    const saved = await storage.local.get([
      'hermesBrowserSettings', SAVED_CONNECTION_SECRETS_STORAGE_KEY, BACKGROUND_BROWSER_CONSENT,
    ]);
    const settings = await hydrateHermesBrowserSettingsFromStorage(saved);
    const consentIdentity = await backgroundBrowserConsentIdentity(settings);
    if (readRevision !== revision) return;
    const enabled = consentIdentity && saved[BACKGROUND_BROWSER_CONSENT] === consentIdentity;
    const nextRoute = enabled ? consentIdentity : null;
    if (nextRoute !== route) {
      const releaseSessions = sessionRoute !== undefined && nextRoute !== sessionRoute;
      if (releaseSessions) {
        close();
        const resetRevision = revision;
        for (const state of sessions.values()) {
          for (const id of state.tabs.keys()) await runtime.releaseTab(id);
        }
        sessions.clear();
        if (resetRevision !== revision) return;
      }
      route = nextRoute;
      if (releaseSessions || sessionRoute === undefined) sessionRoute = nextRoute;
    }
    if (!enabled) {
      await alarms.clear(BACKGROUND_BROWSER_ALARM);
      return;
    }
    const alarmRevision = revision;
    await alarms.create(BACKGROUND_BROWSER_ALARM, { periodInMinutes: 0.5 });
    if (alarmRevision !== revision) return;
    if (connection) {
      try {
        await connection.heartbeat();
        return;
      } catch {
        if (alarmRevision !== revision) return;
        close();
      }
    }
    const connectionRevision = revision;
    let candidate;
    candidate = await connector.connect({
      settings,
      identity: { controllerId, browserProfileId: controllerId, hermesSessionId: BACKGROUND_BROWSER_SESSION,
        product, capabilities: BACKGROUND_BROWSER_ACTIONS },
      onFrame: (frame) => onFrame(frame, () => candidate, connectionRevision),
      onClose: () => { if (connection === candidate) close(); },
    });
    if (connectionRevision !== revision) {
      candidate.close();
      return;
    }
    connection = candidate;
  }

  return {
    settingsChanged(changes) {
      const change = changes.hermesBrowserSettings;
      if (changes[BACKGROUND_BROWSER_CONSENT] || changes[SAVED_CONNECTION_SECRETS_STORAGE_KEY] || (change && (
        backgroundBrowserGateway(change.oldValue) !== backgroundBrowserGateway(change.newValue)
        || backgroundBrowserApiKey(change.oldValue) !== backgroundBrowserApiKey(change.newValue)
      ))) {
        // Invalidate before the reconcile queue can wait on an older handshake.
        close();
        route = undefined;
      }
      return this.sync();
    },
    sync() {
      sync = sync.catch(() => {}).then(reconcile);
      return sync;
    },
    tabUpdated(id, change) {
      if (change.status !== 'loading' && change.url === undefined) return;
      for (const state of sessions.values()) {
        const lease = state.tabs.get(id);
        if (lease) {
          lease.document += 1;
          if (change.url !== undefined) lease.url = change.url;
        }
      }
    },
    releaseTab(id) {
      for (const [session, state] of sessions) {
        state.tabs.get(id)?.abort?.();
        if (state.tabs.delete(id) && !state.tabs.size) sessions.delete(session);
      }
    },
  };
}
