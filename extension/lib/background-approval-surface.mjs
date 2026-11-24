import { formatBrowserControlApprovalReason } from './browser-control-ui.mjs';

// A background task tab can ask for approval while no Hermes panel is open. The
// side panel cannot be opened without a user gesture, and the extension has no
// notifications permission, so the request gets its own small extension window
// (the same card copy and the same controller grant path as the panel) and a
// toolbar badge while anything is waiting.
export const BACKGROUND_APPROVAL_PAGE = 'background-approval.html';
export const BACKGROUND_APPROVAL_GET = 'HERMES_BACKGROUND_APPROVAL_GET';
const APPROVAL_DECISIONS = Object.freeze({
  approve: 'HERMES_CONTROLLER_APPROVAL_GRANT',
  reject: 'HERMES_CONTROLLER_APPROVAL_REJECT',
});
const BADGE_COLOR = '#b45309';
const WINDOW_SIZE = Object.freeze({ width: 440, height: 400 });

export function createBackgroundApprovalSurface({ browserApi, translate = (key) => key }) {
  const waiting = new Map();
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
    waiting.delete(approvalId);
    closeWindow(entry);
    void signal();
  }

  // A window the person closed is forgotten, never reopened for the same request.
  browserApi?.windows?.onRemoved?.addListener?.((windowId) => {
    for (const entry of waiting.values()) {
      if (entry.windowId === windowId) entry.windowId = null;
    }
  });

  return {
    show(approval, settled) {
      const approvalId = String(approval?.approvalId || '');
      if (!approvalId || waiting.has(approvalId)) return;
      const entry = { windowId: null, done: false };
      waiting.set(approvalId, entry);
      void signal();
      Promise.resolve(settled).catch(() => {}).finally(() => finish(approvalId));
      const url = browserApi?.runtime?.getURL?.(`${BACKGROUND_APPROVAL_PAGE}?approval=${encodeURIComponent(approvalId)}`);
      if (!url || !browserApi?.windows?.create) return;
      void Promise.resolve(browserApi.windows.create({ url, type: 'popup', focused: true, ...WINDOW_SIZE }))
        .then((created) => {
          if (created?.id === undefined || created?.id === null) return;
          entry.windowId = created.id;
          if (entry.done) closeWindow(entry);
        })
        .catch(() => {});
    },
    waitingCount: () => waiting.size,
  };
}

const DECISION_FIELDS = ['approvalId', 'approvalNonce', 'commandId', 'controllerId', 'leaseId', 'leaseGeneration',
  'action', 'tabId', 'frameId', 'documentGeneration', 'state'];

// The approval window: one request, the panel's card copy, the panel's decision messages.
export function createBackgroundApprovalPage({ doc, approvalId, t, translateText = (text) => text, sendMessage, closeWindow }) {
  const reason = doc.getElementById('backgroundApprovalReason');
  const approve = doc.getElementById('backgroundApprovalApprove');
  const reject = doc.getElementById('backgroundApprovalReject');
  const status = doc.getElementById('backgroundApprovalStatus');
  let request = null;
  let deciding = false;

  function showGone() {
    request = null;
    reason.textContent = t('browser_control.approval_window_gone');
    approve.hidden = true;
    reject.hidden = true;
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
    return next;
  }

  approve.addEventListener('click', () => { void decide('approve'); });
  reject.addEventListener('click', () => { void decide('reject'); });
  return { load, decide };
}
