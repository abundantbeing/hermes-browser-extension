import { formatBrowserControlApprovalReason } from './browser-control-ui.mjs';

// A background task tab can ask for approval while no Hermes panel is visibly
// showing that request. The side panel cannot be opened without a user gesture,
// and the extension has no notifications permission, so the request gets its own
// small extension window (the same card copy and the same controller grant path
// as the panel) and a toolbar badge while anything is waiting. The window stays
// closed only while the panel reports, with a short heartbeat, that it is
// visibly showing this request. A hidden, minimized, unresponsive or outdated
// panel, or a confirmation that has gone stale, opens the window instead.
export const BACKGROUND_APPROVAL_PAGE = 'background-approval.html';
export const BACKGROUND_APPROVAL_GET = 'HERMES_BACKGROUND_APPROVAL_GET';
export const BACKGROUND_APPROVAL_VISIBLE = 'HERMES_BACKGROUND_APPROVAL_VISIBLE';
const APPROVAL_DECISIONS = Object.freeze({
  approve: 'HERMES_CONTROLLER_APPROVAL_GRANT',
  reject: 'HERMES_CONTROLLER_APPROVAL_REJECT',
});
const BADGE_COLOR = '#b45309';
const WINDOW_SIZE = Object.freeze({ width: 440, height: 400 });
export const PANEL_RECHECK_MS = 1500;
export const VISIBLE_HEARTBEAT_MS = 1000;
export const VISIBLE_CONFIRMATION_TTL_MS = 2500;
export const VISIBLE_CONFIRMATION_GRACE_MS = 500;

// The panel may say it is showing a request only while the document is visible
// and the approval card itself is on screen. A minimized or hidden panel is not
// showing the request, even if a SIDE_PANEL context still exists.
export function backgroundApprovalVisibleNow({
  visibilityState,
  dialogOpen,
  approveVisible,
  approvalId,
  controllerId,
}) {
  const id = String(approvalId || '');
  if (visibilityState !== 'visible' || dialogOpen !== true || approveVisible !== true || !id) return '';
  return String(controllerId || '').startsWith('background-') ? id : '';
}

export function createBackgroundApprovalVisibleHeartbeat({
  getState,
  sendMessage,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  heartbeatMs = VISIBLE_HEARTBEAT_MS,
}) {
  let timer = null;

  function stop() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function pulse() {
    stop();
    const approvalId = backgroundApprovalVisibleNow(getState() || {});
    if (!approvalId) return;
    void Promise.resolve(sendMessage({ type: BACKGROUND_APPROVAL_VISIBLE, approvalId })).catch(() => {});
    timer = setTimer(pulse, heartbeatMs);
  }

  return { pulse, stop };
}

function manifestActionTitle(browserApi) {
  const title = String(browserApi?.runtime?.getManifest?.()?.action?.default_title || '');
  const key = /^__MSG_(\w+)__$/.exec(title)?.[1];
  return key ? String(browserApi?.i18n?.getMessage?.(key) || '') : title;
}

function approvalIdOfPage(url, pageUrl) {
  try {
    const parsed = new URL(String(url || ''));
    const page = new URL(pageUrl);
    if (parsed.origin !== page.origin || parsed.pathname !== page.pathname) return null;
    return parsed.searchParams.get('approval') || '';
  } catch {
    return null;
  }
}

// Approval windows and toolbar notices outlive a restarted service worker, whose
// requests were in memory. Every open approval page is found as a TAB context (or,
// without context lookup, as a tab) and closed unless its request is waiting again.
async function openApprovalPages(browserApi, pageUrl) {
  const runtime = browserApi?.runtime;
  if (typeof runtime?.getContexts === 'function') {
    const contexts = await runtime.getContexts({ contextTypes: ['TAB'] });
    return (contexts || []).map((context) => ({ tabId: context?.tabId, approvalId: approvalIdOfPage(context?.documentUrl, pageUrl) }));
  }
  const tabs = await browserApi?.tabs?.query?.({});
  return (tabs || []).map((tab) => ({ tabId: tab?.id, approvalId: approvalIdOfPage(tab?.url, pageUrl) }));
}

export function createBackgroundApprovalSurface({
  browserApi,
  translate = (key) => key,
  now = Date.now,
  visibleTtlMs = VISIBLE_CONFIRMATION_TTL_MS,
  visibleGraceMs = VISIBLE_CONFIRMATION_GRACE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const waiting = new Map();
  const confirmedAt = new Map();
  let defaultTitle = null;
  let signalChain = Promise.resolve();

  async function applySignal() {
    const action = browserApi?.action;
    if (!action?.setBadgeText) return;
    if (waiting.size) {
      if (defaultTitle === null && action.getTitle) defaultTitle = String(await action.getTitle({}) ?? '');
      await action.setBadgeBackgroundColor?.({ color: BADGE_COLOR });
      await action.setBadgeText({ text: String(waiting.size) });
      await action.setTitle?.({ title: translate('browser_control.approval_waiting') });
      return;
    }
    await action.setBadgeText({ text: '' });
    if (defaultTitle !== null) {
      await action.setTitle?.({ title: defaultTitle });
      defaultTitle = null;
    }
  }

  function signal() {
    signalChain = signalChain.then(applySignal).catch(() => {});
    return signalChain;
  }

  async function sweepPreviousWorker() {
    const action = browserApi?.action;
    if (!waiting.size) {
      await action?.setBadgeText?.({ text: '' });
      const title = manifestActionTitle(browserApi);
      if (title && defaultTitle === null) await action?.setTitle?.({ title });
    }
    const pageUrl = browserApi?.runtime?.getURL?.(BACKGROUND_APPROVAL_PAGE);
    if (!pageUrl || !browserApi?.tabs?.remove) return;
    const pages = await openApprovalPages(browserApi, pageUrl);
    for (const { tabId, approvalId } of pages) {
      if (approvalId === null || waiting.has(approvalId) || !Number.isInteger(tabId)) continue;
      await Promise.resolve(browserApi.tabs.remove(tabId)).catch(() => {});
    }
  }

  function closeWindow(entry) {
    const id = entry.windowId;
    entry.windowId = null;
    if (id === null || id === undefined) return;
    void Promise.resolve(browserApi?.windows?.remove?.(id)).catch(() => {});
  }

  function finish(approvalId) {
    const entry = waiting.get(approvalId);
    if (!entry) return;
    entry.done = true;
    if (entry.recheck !== null) clearTimer(entry.recheck);
    entry.recheck = null;
    waiting.delete(approvalId);
    confirmedAt.delete(approvalId);
    closeWindow(entry);
    void signal();
  }

  signalChain = signalChain.then(sweepPreviousWorker).catch(() => {});

  // A window the person closed is forgotten, never reopened for the same request.
  browserApi?.windows?.onRemoved?.addListener?.((windowId) => {
    for (const entry of waiting.values()) {
      if (entry.windowId === windowId) entry.windowId = null;
    }
  });

  function openWindow(approvalId, entry) {
    const url = browserApi?.runtime?.getURL?.(`${BACKGROUND_APPROVAL_PAGE}?approval=${encodeURIComponent(approvalId)}`);
    if (!url || !browserApi?.windows?.create) return;
    void Promise.resolve(browserApi.windows.create({ url, type: 'popup', focused: true, ...WINDOW_SIZE }))
      .then((created) => {
        if (created?.id === undefined || created?.id === null) return;
        entry.windowId = created.id;
        if (entry.done) closeWindow(entry);
      })
      .catch(() => {});
  }

  function isFresh(approvalId) {
    const seen = confirmedAt.get(approvalId);
    return seen != null && (Number(now()) - seen) < visibleTtlMs;
  }

  // The window stays closed only while a fresh confirmation for this request is
  // on file. The first look waits a short grace so a visible panel can report;
  // after that, a missing or stale confirmation opens the window.
  function askWhereVisible(approvalId, entry, allowOpen) {
    entry.recheck = null;
    if (entry.done) return;
    if (isFresh(approvalId)) {
      entry.recheck = setTimer(() => { askWhereVisible(approvalId, entry, true); }, PANEL_RECHECK_MS);
      return;
    }
    if (allowOpen || visibleGraceMs <= 0) {
      openWindow(approvalId, entry);
      return;
    }
    entry.recheck = setTimer(() => { askWhereVisible(approvalId, entry, true); }, visibleGraceMs);
  }

  return {
    show(approval, settled) {
      const approvalId = String(approval?.approvalId || '');
      if (!approvalId || waiting.has(approvalId)) return;
      const entry = { windowId: null, done: false, recheck: null };
      waiting.set(approvalId, entry);
      void signal();
      Promise.resolve(settled).catch(() => {}).finally(() => finish(approvalId));
      askWhereVisible(approvalId, entry, false);
    },
    noteVisible(approvalId) {
      const id = String(approvalId || '');
      if (!id) return;
      confirmedAt.set(id, Number(now()));
    },
    waitingCount: () => waiting.size,
  };
}

const DECISION_FIELDS = ['approvalId', 'approvalNonce', 'commandId', 'controllerId', 'leaseId', 'leaseGeneration',
  'action', 'tabId', 'frameId', 'documentGeneration', 'state'];

export const APPROVAL_PAGE_RECHECK_MS = 2000;

// The approval window: one request, the panel's card copy, the panel's decision
// messages. It re-checks its request on focus and every few seconds, so a request
// that was decided elsewhere, expired or died with its worker reads as gone.
export function createBackgroundApprovalPage({
  doc,
  approvalId,
  t,
  translateText = (text) => text,
  sendMessage,
  closeWindow,
  win = doc?.defaultView,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const reason = doc.getElementById('backgroundApprovalReason');
  const approve = doc.getElementById('backgroundApprovalApprove');
  const reject = doc.getElementById('backgroundApprovalReject');
  const status = doc.getElementById('backgroundApprovalStatus');
  let request = null;
  let deciding = false;
  let recheck = null;

  function stopRecheck() {
    if (recheck !== null) clearTimer(recheck);
    recheck = null;
  }

  function scheduleRecheck() {
    stopRecheck();
    recheck = setTimer(() => {
      recheck = null;
      void refresh();
    }, APPROVAL_PAGE_RECHECK_MS);
  }

  function refresh() {
    if (deciding || !request) return Promise.resolve(request);
    return load();
  }

  const close = doc.getElementById('backgroundApprovalClose');

  function showGone() {
    stopRecheck();
    request = null;
    reason.textContent = t('browser_control.approval_window_gone');
    approve.hidden = true;
    reject.hidden = true;
    if (close) close.hidden = false;
  }

  async function decide(kind) {
    if (!request || deciding) return;
    deciding = true;
    approve.disabled = true;
    reject.disabled = true;
    status.textContent = '';
    try {
      const message = { type: APPROVAL_DECISIONS[kind] };
      for (const field of DECISION_FIELDS) message[field] = field === 'frameId' ? (request.frameId ?? 0) : request[field];
      const result = await sendMessage(message);
      if (result?.ok) {
        stopRecheck();
        closeWindow();
        return;
      }
      status.textContent = t('browser_control.error_approval_failed');
      await load();
    } catch {
      status.textContent = t('browser_control.error_approval_failed');
    } finally {
      deciding = false;
      approve.disabled = false;
      reject.disabled = false;
    }
  }

  async function load() {
    const result = await sendMessage({ type: BACKGROUND_APPROVAL_GET, approvalId }).catch(() => null);
    const next = result?.ok ? result.approval : null;
    if (!next) {
      showGone();
      return null;
    }
    request = next;
    reason.textContent = formatBrowserControlApprovalReason(next, { t, translateText });
    approve.hidden = false;
    reject.hidden = false;
    if (close) close.hidden = true;
    scheduleRecheck();
    return next;
  }

  approve.addEventListener('click', () => { void decide('approve'); });
  reject.addEventListener('click', () => { void decide('reject'); });
  close?.addEventListener('click', () => { closeWindow(); });
  win?.addEventListener?.('focus', () => { void refresh(); });
  doc.addEventListener?.('visibilitychange', () => {
    if (doc.visibilityState !== 'hidden') void refresh();
  });
  return { load, decide, refresh };
}
