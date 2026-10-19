import { validateBrowserControlUrl } from './browser-control-safety.mjs';
import { isGatewayAuthRejection, isGatewayControlKeyUnconfigured, isMissingGatewayCredential } from './connection-modes.mjs';

const CONTROL_SCOPES = new Set(['this-tab', 'selected-tabs', 'task-set']);

const ACTION_LABELS = Object.freeze({
  browser_back: 'Going back',
  browser_batch: 'Running steps',
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

// The attached tab the Show tab button brings forward. Hermes never picks this
// for the user: the button only switches tabs on an explicit click. The target
// is the tab an approval waits on, else the tab of the action running now, else
// the tab of Hermes's most recent action, else the only attached tab. Each
// candidate must be attached. Null when control is off or not connected, when
// no tab qualifies, or when the target is already the panel window's active tab.
export function showTabTargetId({ status = {}, activeTabId = null } = {}) {
  if (status?.connected !== true || status?.controlEnabled !== true) return null;
  const attached = new Set(tabIdsFrom(status?.leasedTabIds));
  const attachedId = (value) => {
    const tabId = Number(value);
    return Number.isInteger(tabId) && attached.has(tabId) ? tabId : null;
  };
  const targetTabId = attachedId(status?.pendingApproval?.tabId)
    ?? attachedId(status?.activeAction?.tabId)
    ?? attachedId(status?.lastActionTabId)
    ?? (attached.size === 1 ? [...attached][0] : null);
  if (targetTabId === null) return null;
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
    canAuthorize: false,
    canPause: false,
    canStop: false,
    canDetach: false,
    // True only when the person must act (approve, attach, authorize, or fix a blocker).
    attention: false,
    ...overrides,
  };
}

// The status light is on only while Hermes can act on the attached tab now: ready,
// working, or waiting for an approval that would let it act. Every other state is off.
// A pause blocks new actions, so the light is off while paused even if an approval waits.
const LIGHT_ON_STATES = new Set(['ready', 'active', 'approval']);

export function browserControlLightState(view = {}, { paused = false } = {}) {
  if (paused === true) return 'off';
  return LIGHT_ON_STATES.has(String(view?.state || '')) ? 'on' : 'off';
}

// One line for the status light's tooltip and accessible name: the title, then the detail.
export function browserControlStatusLine({ title = '', detail = '' } = {}) {
  const head = String(title || '').trim();
  const body = String(detail || '').trim();
  if (!head) return body;
  if (!body) return head;
  return /[.!?。！？…]$/.test(head) ? `${head} ${body}` : `${head}. ${body}`;
}

export function browserControlView({ settings = {}, status = {}, activeTab = null, currentTarget = null } = {}) {
  if (settings?.browserControlEnabled !== true) return baseView();
  if (status?.connected !== true) {
    const failure = status?.lastConnectFailure;
    let detail = 'Hermes Control is reconnecting. No tab actions can run yet.';
    let canAuthorize = false;
    if (failure?.reason === 'missing_session') {
      detail = 'No Hermes session is active yet. Start or select a session, then attach this tab.';
    } else if (failure?.reason === 'connect_failed' && isGatewayControlKeyUnconfigured(failure.detail)) {
      detail = 'This Hermes gateway has no Hermes Control API key configured. Set API_SERVER_KEY on the gateway, then reconnect.';
    } else if (failure?.reason === 'connect_failed' && isMissingGatewayCredential(failure.detail)) {
      // Tab control needs its own credential. The panel is already connected for
      // chat (often over the local Desktop dashboard), so never send the reader
      // back through the first-run connect flow; the control strip owns the one
      // action that fixes this.
      canAuthorize = true;
      detail = 'Hermes Control needs one authorization from Hermes before it can operate tabs.';
    } else if (failure?.reason === 'connect_failed' && isGatewayAuthRejection(failure.detail)) {
      canAuthorize = true;
      detail = "Hermes rejected this browser's saved control token. Authorize again to restore control.";
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
      canAuthorize,
      attention: canAuthorize || failure?.reason === 'missing_session',
    });
  }
  if (status?.controlEnabled !== true) {
    return baseView({
      state: 'unavailable',
      tone: 'warn',
      title: 'Control unavailable',
      detail: 'Chromium debugger access is not available for this browser profile, so Hermes cannot operate tabs.',
      canEnable: false,
      canDetach: true,
      attention: true,
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
      attention: true,
    });
  }
  if (status?.paused === true) {
    return baseView({
      state: 'paused',
      tone: 'warn',
      title: 'Control paused',
      detail: `${tabIdsFrom(status.leasedTabIds).length} attached tab${tabIdsFrom(status.leasedTabIds).length === 1 ? '' : 's'} kept. New actions are blocked.`,
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
        : 'Hermes is using an attached tab now.',
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
      attention: true,
    });
  }
  if (!leasedTabIds.includes(activeTabId)) {
    return baseView({
      state: 'unattached',
      tone: 'warn',
      title: 'This tab is not attached',
      detail: leaseCount
        ? `Control is active on ${leaseCount} other tab${leaseCount === 1 ? '' : 's'}. Attach this tab before asking Hermes to operate it.`
        : 'Hermes Control is connected, but no tab is attached. Attach this tab before asking Hermes to operate it.',
      canEnable: false,
      canAttach: true,
      canDetach: true,
      attention: true,
    });
  }
  if (currentTarget?.availability !== 'available'
    || Number(currentTarget?.tabId) !== activeTabId
    || currentTarget?.leaseOwned !== true) {
    return baseView({
      state: 'preparing',
      tone: 'warn',
      title: 'Preparing this tab',
      detail: 'This tab is attached. Hermes is waiting for the exact page document to become ready.',
      canEnable: false,
      canPause: true,
      canDetach: true,
    });
  }
  return baseView({
    state: 'ready',
    tone: 'ok',
    title: 'This tab is ready',
    detail: 'This exact tab is attached. Hermes can operate it on the first controlled turn.',
    canEnable: false,
    canPause: true,
    canStop: Number(status.pendingCommands) > 0,
    canDetach: true,
  });
}
