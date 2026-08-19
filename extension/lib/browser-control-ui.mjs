import { validateBrowserControlUrl } from './browser-control-safety.mjs';

const CONTROL_SCOPES = new Set(['this-tab', 'selected-tabs', 'task-set']);
const VIEW_BEHAVIORS = new Set(['stay', 'follow']);

const ACTION_LABELS = Object.freeze({
  browser_back: 'Going back',
  browser_click: 'Clicking',
  browser_navigate: 'Navigating',
  browser_press: 'Pressing a key',
  browser_screenshot: 'Capturing the tab',
  browser_scroll: 'Scrolling',
  browser_snapshot: 'Reading the page',
  browser_tab_activate: 'Switching tabs',
  browser_tabs: 'Checking tabs',
  browser_type: 'Typing',
});

function tabIdsFrom(selectedTabs = []) {
  if (!Array.isArray(selectedTabs)) return [];
  return [...new Set(selectedTabs
    .map((tab) => Number(tab?.id ?? tab))
    .filter((tabId) => Number.isInteger(tabId) && tabId > 0))];
}

export function controlLeaseRequest({
  scope = 'this-tab',
  activeTab = null,
  selectedTabs = [],
  taskSetId = '',
} = {}) {
  const normalizedScope = CONTROL_SCOPES.has(scope) ? scope : 'this-tab';
  const activeTabId = Number(activeTab?.id);
  const windowId = Number(activeTab?.windowId) || null;
  if (normalizedScope === 'this-tab') {
    if (!Number.isInteger(activeTabId) || activeTabId <= 0) return { ok: false, error: 'active_tab_required' };
    return { ok: true, kind: 'this-tab', tabIds: [activeTabId], windowId };
  }
  const selectedTabIds = tabIdsFrom(selectedTabs);
  if (!selectedTabIds.length) return { ok: false, error: 'explicit_selection_required' };
  if (normalizedScope === 'task-set') {
    const normalizedTaskSetId = String(taskSetId || '').trim();
    if (!normalizedTaskSetId) return { ok: false, error: 'task_set_required' };
    return { ok: true, kind: 'task-set', tabIds: selectedTabIds, windowId, taskSetId: normalizedTaskSetId };
  }
  return { ok: true, kind: 'selected-tabs', tabIds: selectedTabIds, windowId };
}

export function followTargetTabId({ viewBehavior = 'stay', status = {}, activeTabId = null } = {}) {
  if ((VIEW_BEHAVIORS.has(viewBehavior) ? viewBehavior : 'stay') !== 'follow') return null;
  const targetTabId = Number(status?.activeAction?.tabId);
  const leased = new Set(tabIdsFrom(status?.leasedTabIds));
  if (!Number.isInteger(targetTabId) || targetTabId <= 0 || !leased.has(targetTabId)) return null;
  return targetTabId === Number(activeTabId) ? null : targetTabId;
}

export function currentTabLeaseReplacement({ status = {}, activeTab = null, allowLocalFiles = true } = {}) {
  if (status?.connected !== true || !String(status?.controllerId || '').trim()) {
    return { ok: false, error: 'controller_unavailable' };
  }
  if (status?.activeAction || Number(status?.pendingCommands) > 0 || status?.pendingApproval) {
    return { ok: false, error: 'controller_busy' };
  }
  const eligible = validateBrowserControlUrl(activeTab?.url, { allowLocalFiles });
  if (!eligible.ok) return { ok: false, error: eligible.error };
  const request = controlLeaseRequest({ scope: 'this-tab', activeTab });
  if (!request.ok) return request;
  const leaseRequest = {
    kind: request.kind,
    tabIds: request.tabIds,
    windowId: request.windowId,
  };
  const ownerId = String(status.controllerId).trim();
  const activeTabId = Number(activeTab.id);
  return {
    ok: true,
    ownerId,
    releaseTabIds: tabIdsFrom(status.leasedTabIds).filter((tabId) => tabId !== activeTabId),
    acquire: {
      ...leaseRequest,
      ownership: 'owned',
      ownerId,
    },
  };
}

function baseView(overrides = {}) {
  return {
    state: 'off',
    tone: 'neutral',
    title: 'Control is off',
    detail: 'Hermes can read approved context but cannot operate tabs.',
    canEnable: true,
    canAttach: false,
    canPause: false,
    canStop: false,
    canDetach: false,
    ...overrides,
  };
}

export function browserControlView({ settings = {}, status = {}, activeTab = null, currentTarget = null } = {}) {
  if (settings?.browserControlEnabled !== true) return baseView();
  if (status?.connected !== true) {
    const failure = status?.lastConnectFailure;
    let detail = 'Hermes is restoring the controller connection. No tab actions can run yet.';
    if (failure?.reason === 'missing_session') {
      detail = 'No Hermes session is active yet. Start or select a session, then attach this tab.';
    } else if (failure?.reason === 'connect_failed' && /401|403|credential|api key|token|auth/i.test(String(failure.detail || ''))) {
      detail = 'The gateway rejected the saved token. Reconnect from Settings, then attach this tab.';
    } else if (failure?.reason === 'connect_failed' && failure?.detail) {
      detail = `Could not reach the controller. ${String(failure.detail).slice(0, 140)}`;
    }
    return baseView({
      state: 'reconnecting',
      tone: 'warn',
      title: 'Reconnecting control',
      detail,
      canEnable: false,
      canDetach: true,
    });
  }
  if (status?.controlEnabled !== true) {
    return baseView({
      state: 'unavailable',
      tone: 'warn',
      title: 'Control unavailable',
      detail: 'Browser debugging access is not available for this browser profile, so Hermes cannot operate tabs.',
      canEnable: false,
      canDetach: true,
    });
  }
  const pendingApproval = status?.pendingApproval;
  if (pendingApproval) {
    return baseView({
      state: 'approval',
      tone: 'warn',
      title: 'Approval needed',
      detail: String(pendingApproval.reason || 'This browser action requires approval.'),
      canEnable: false,
      canPause: true,
      canStop: true,
      canDetach: true,
    });
  }
  if (status?.paused === true) {
    return baseView({
      state: 'paused',
      tone: 'warn',
      title: 'Control paused',
      detail: `${tabIdsFrom(status.leasedTabIds).length} leased tab${tabIdsFrom(status.leasedTabIds).length === 1 ? '' : 's'} retained. New actions are blocked.`,
      canEnable: false,
      canPause: true,
      canStop: Number(status.pendingCommands) > 0,
      canDetach: true,
    });
  }
  const activeAction = status?.activeAction;
  if (activeAction) {
    const actionLabel = ACTION_LABELS[String(activeAction.action || '')] || 'Working';
    return baseView({
      state: 'active',
      tone: 'ok',
      title: `${actionLabel} in tab ${Number(activeAction.tabId)}`,
      detail: Number(status.pendingCommands) > 1
        ? `${Number(status.pendingCommands) - 1} more action${Number(status.pendingCommands) === 2 ? '' : 's'} queued.`
        : 'Hermes is operating the leased tab now.',
      canEnable: false,
      canPause: true,
      canStop: true,
      canDetach: true,
    });
  }
  const leasedTabIds = tabIdsFrom(status.leasedTabIds);
  const leaseCount = leasedTabIds.length;
  const activeTabId = Number(activeTab?.id);
  const eligible = validateBrowserControlUrl(activeTab?.url, { allowLocalFiles: true });
  if (!Number.isInteger(activeTabId) || activeTabId <= 0 || !eligible.ok) {
    return baseView({
      state: 'unavailable',
      tone: 'warn',
      title: 'Unavailable on this page',
      detail: 'Open a normal HTTP or HTTPS page before attaching Hermes Control.',
      canEnable: false,
      canDetach: true,
    });
  }
  if (!leasedTabIds.includes(activeTabId)) {
    return baseView({
      state: 'unattached',
      tone: 'warn',
      title: 'This tab is not attached',
      detail: leaseCount
        ? `Control is active on ${leaseCount} other tab${leaseCount === 1 ? '' : 's'}. Attach this tab before asking Hermes to operate it.`
        : 'The controller is connected, but no tab is leased. Attach this tab before asking Hermes to operate it.',
      canEnable: false,
      canAttach: true,
      canDetach: true,
    });
  }
  if (currentTarget?.availability !== 'available'
    || Number(currentTarget?.tabId) !== activeTabId
    || currentTarget?.leaseOwned !== true) {
    return baseView({
      state: 'preparing',
      tone: 'warn',
      title: 'Preparing this tab',
      detail: 'The lease is owned. Hermes is waiting for the exact page document to become ready.',
      canEnable: false,
      canPause: true,
      canDetach: true,
    });
  }
  return baseView({
    state: 'ready',
    tone: 'ok',
    title: 'This tab is ready',
    detail: 'This exact tab is leased. Hermes can operate it on the first controlled turn.',
    canEnable: false,
    canPause: true,
    canStop: Number(status.pendingCommands) > 0,
    canDetach: true,
  });
}
