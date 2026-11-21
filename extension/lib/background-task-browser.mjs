import { hydrateHermesBrowserSettingsFromStorage, SAVED_CONNECTION_SECRETS_STORAGE_KEY } from './saved-connections.mjs';
import { BACKGROUND_BROWSER_SESSION, CONTROLLER_METHODS } from './controller-protocol.mjs';
import { createLoadWaiter } from './browser-control-browser-adapters.mjs';
import { sha256Hex } from './browser-control-artifacts.mjs';
import { validateBrowserControlUrl } from './browser-control-safety.mjs';
import { safeNetworkUrl } from './browser-control-executor.mjs';
import { redactSensitiveText } from './browser-context-protocol.mjs';

export const BACKGROUND_BROWSER_CONSENT = 'hermesBackgroundBrowserConsent';
export const BACKGROUND_BROWSER_ALARM = 'hermes-background-browser-reconnect';
// Opt-in. Off keeps Background task tabs in the background and refuses tab switches.
export const ACTIVE_TASK_TABS = 'hermesActiveTaskTabs';

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
  // One lock per window so two task sessions cannot hide each other's tab mid-action.
  const windowLocks = new Map();
  // Read at connect time. Off is the original background-tab behavior.
  let activeTaskTabs = false;

  function taskCapabilities() {
    return activeTaskTabs
      ? [...BACKGROUND_BROWSER_ACTIONS, 'browser_tab_activate', 'browser_screenshot', 'browser_hover']
      : BACKGROUND_BROWSER_ACTIONS;
  }

  function needsVisibleTab(action, args = {}) {
    if (action === 'browser_screenshot' || action === 'browser_hover') return true;
    if (action !== 'browser_click') return false;
    if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) return true;
    return /^@xy:/i.test(String(args.ref || ''));
  }

  function withWindowLock(windowId, task) {
    const key = Number(windowId) || 0;
    const previous = windowLocks.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const settled = run.then(() => {}, () => {});
    windowLocks.set(key, settled);
    settled.finally(() => {
      if (windowLocks.get(key) === settled) windowLocks.delete(key);
    });
    return run;
  }

  function waitFor(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason || new Error('cancelled'));
        return;
      }
      const timer = setTimeout(finish, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason || new Error('cancelled'));
      };
      function finish() {
        signal?.removeEventListener?.('abort', onAbort);
        resolve();
      }
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }


  // Approvals for a task-tab switch are bound to this controller's leases, not
  // to the attached Hermes Control worker. The panel still sends the same grant
  // and reject messages; those are routed here when the pending request is ours.
  function sourceCommandId(commandId) {
    return String(commandId || '').endsWith(':switch')
      ? String(commandId).slice(0, -':switch'.length)
      : String(commandId || '');
  }

  function leaseForTab(tabId) {
    for (const state of sessions.values()) {
      const lease = state.tabs.get(tabId);
      if (lease) return lease;
    }
    return null;
  }

  function handleApproval(message = {}) {
    const grant = message?.type === 'HERMES_CONTROLLER_APPROVAL_GRANT';
    const reject = message?.type === 'HERMES_CONTROLLER_APPROVAL_REJECT';
    if (!grant && !reject) return null;
    const store = runtime?.approvals;
    if (!store?.pending || !store.grant) return null;
    const approvalId = String(message.approvalId || '').trim();
    const request = store.pending().find((entry) => entry.approvalId === approvalId);
    if (!request || request.controllerId !== controllerId) return null;
    const commandId = String(message.commandId || '').trim();
    const tabId = Number(message.tabId);
    const requestedFrame = Number.isInteger(Number(message.frameId)) ? Number(message.frameId) : 0;
    if (
      request.commandId !== commandId
      || request.action !== String(message.action || '').trim()
      || request.tabId !== tabId
      || (request.frameId ?? 0) !== requestedFrame
      || request.documentGeneration !== Number(message.documentGeneration)
    ) {
      return { ok: false, error: 'approval_missing' };
    }
    const parentId = sourceCommandId(commandId);
    if (!pending.has(parentId) && !pending.has(commandId)) {
      store.cancelRequest?.(approvalId, 'approval_cancelled');
      return { ok: false, error: 'approval_terminal' };
    }
    const lease = leaseForTab(tabId);
    if (!lease) return { ok: false, error: 'lease_required' };
    if (request.leaseId && request.leaseId !== lease.leaseId) return { ok: false, error: 'approval_mismatch' };
    if (request.leaseGeneration && request.leaseGeneration !== 1) return { ok: false, error: 'approval_mismatch' };
    if (Number(lease.document) !== Number(request.documentGeneration)) return { ok: false, error: 'stale_document' };
    if (reject) {
      store.cancelRequest?.(approvalId, 'approval_denied');
      return { ok: true, commandId, cancelled: true };
    }
    if (request.state !== 'paused') {
      store.cancelRequest?.(approvalId, 'approval_cancelled');
      return { ok: false, error: 'approval_terminal' };
    }
    return store.grant(request);
  }

  // View changes go through the executor so the approval is bound to this tab.
  // backgroundTask is omitted: that flag refuses the ask instead of showing it.
  async function approvedFocus(tabId, lease, params, controller, scope) {
    lease.abort = () => controller.abort();
    const approved = await runtime.execute({
      action: 'browser_tab_activate',
      arguments: { tab_id: tabId },
      command_id: `${params.command_id || 'focus'}:switch`,
      tab_id: tabId,
      frame_id: 0,
      document_generation: lease.document,
    }, {
      scope: { ...scope, tabId },
      signal: controller.signal,
      leasedTabIds: [tabId],
      ownedTabIds: [tabId],
      currentWindowId: scope.windowId,
      currentDocumentGeneration: () => lease.document,
      controlHalted: () => controller.signal.aborted,
    }, { browserControlEnabled: true });
    if (!approved?.ok) return approved;
    if (controller.signal.aborted) return failure('cancelled', 'The background command was cancelled.');
    await focusTaskTab(tabId);
    return approved;
  }

  async function focusTaskTab(tabId) {
    const activated = await tabs.update(tabId, { active: true });
    const windowId = Number(activated?.windowId);
    if (windowId && typeof windows.update === 'function') {
      try {
        await windows.update(windowId, { focused: true });
      } catch {
        // The tab is in front in its own window either way.
      }
    }
    return activated;
  }

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
      if (result.ok) {
        sessions.set(sessionId, state);
        if (activeTaskTabs) {
          const createdId = result.result.tab.id;
          const lease = state.tabs.get(createdId);
          const createdTab = await getTab(createdId);
          if (lease && createdTab) {
            const raised = await withWindowLock(createdTab.windowId, () => approvedFocus(createdId, lease, params, controller, {
              controllerId, leaseOwnerId: controllerId, leaseId: lease.leaseId, leaseGeneration: 1,
              tabId: createdId, frameId: 0, documentGeneration: lease.document, windowId: createdTab.windowId,
            }));
            delete lease.abort;
            if (!raised?.ok) {
              return {
                ok: true,
                result: {
                  ...result.result,
                  focus_error: raised?.error || { code: 'approval_required', message: 'The tab was created, but bringing it forward was not approved.' },
                },
              };
            }
            const shown = await getTab(createdId);
            if (shown) result.result.tab = { ...tabView(shown), loading: result.result.tab.loading };
          }
        }
      }
      return result;
    }
    if (action === 'browser_tab_activate') {
      if (!activeTaskTabs) {
        return failure('background_action_unavailable', 'This action is unavailable in background task tabs.');
      }
      const activateId = Number(args.tab_id);
      const lease = state.tabs.get(activateId);
      if (!lease) return failure('lease_not_owned', 'Use tab_create to open a tab owned by this Hermes session.');
      const target = await getTab(activateId);
      if (!target) return failure('lease_not_owned', 'The task tab is no longer available.');
      return withWindowLock(target.windowId, async () => {
        const raised = await approvedFocus(activateId, lease, params, controller, {
          controllerId, leaseOwnerId: controllerId, leaseId: lease.leaseId, leaseGeneration: 1,
          tabId: activateId, frameId: 0, documentGeneration: lease.document, windowId: target.windowId,
        });
        if (!raised?.ok) return raised;
        if (!state.tabs.has(activateId)) return failure('lease_not_owned', 'The task tab is no longer available.');
        const activated = await getTab(activateId);
        if (!activated) return failure('lease_not_owned', 'The task tab is no longer available.');
        state.lastTab = activateId;
        return { ok: true, result: { status: 'tab-activated', tab: tabView(activated) } };
      });
    }
    if (!PAGE_ACTIONS.has(action) && !(activeTaskTabs && (action === 'browser_screenshot' || action === 'browser_hover'))) {
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
      tabId: id, frameId: 0, documentGeneration: lease.document, windowId: tab.windowId,
    };
    // Installed before any wait so cancelling the debugger banner aborts the command.
    lease.abort = () => controller.abort();
    const runPageAction = async () => {
      if (activeTaskTabs && needsVisibleTab(action, args)) {
        const raised = await approvedFocus(id, lease, params, controller, scope);
        if (!raised?.ok) return raised;
        await waitFor(300, signal);
        if (signal.aborted || !state.tabs.has(id)) {
          return failure('lease_not_owned', 'The task tab is no longer available.');
        }
      }
      if (!state.tabs.has(id)) return failure('lease_not_owned', 'The task tab is no longer available.');
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
    };
    try {
      // The window lock is only for work that must keep a tab visible. Background-only
      // page actions in the same window must not wait behind each other.
      if (activeTaskTabs && needsVisibleTab(action, args)) {
        return await withWindowLock(tab.windowId, runPageAction);
      }
      return await runPageAction();
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
      ACTIVE_TASK_TABS,
    ]);
    const settings = await hydrateHermesBrowserSettingsFromStorage(saved);
    const consentIdentity = await backgroundBrowserConsentIdentity(settings);
    if (readRevision !== revision) return;
    activeTaskTabs = saved[ACTIVE_TASK_TABS] === true;
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
        product, capabilities: taskCapabilities() },
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
      if (changes[ACTIVE_TASK_TABS] || changes[BACKGROUND_BROWSER_CONSENT] || changes[SAVED_CONNECTION_SECRETS_STORAGE_KEY] || (change && (
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
    handleApproval,
  };
}
