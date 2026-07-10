import {
  normalizeBrowserActionRequest,
  sanitizeBrowserActionResult,
  validateBrowserActionRequest,
} from './browser-actions.mjs';

export const BROWSER_ACTION_EVENTS = Object.freeze({
  requested: 'browser.action.requested',
  result: 'browser.action.result',
});

function resultForFailure(reason, actionType = '') {
  return sanitizeBrowserActionResult({ ok: false, reason, actionType });
}

export function installBrowserActionBridge({
  client,
  sessionId = () => '',
  runtime = globalThis.chrome?.runtime,
  requestApproval = async () => false,
  onReceipt = () => {},
} = {}) {
  if (!client?.on || !client?.request) throw new Error('gateway client is required');
  if (!runtime?.sendMessage) throw new Error('extension runtime is required');

  async function report(requestId, result) {
    const cleanResult = sanitizeBrowserActionResult(result);
    await client.request(BROWSER_ACTION_EVENTS.result, {
      session_id: String(sessionId() || '').trim(),
      request_id: requestId,
      result: cleanResult,
    });
    onReceipt({ requestId, result: cleanResult });
    return cleanResult;
  }

  async function handleRequested(event = {}) {
    const activeSessionId = String(sessionId() || '').trim();
    if (!activeSessionId || !event.sessionId || event.sessionId !== activeSessionId) return;
    const requestId = String(event.payload?.request_id || '').trim();
    const action = event.payload?.action || {};
    const actionType = String(action.type || '');
    if (!requestId) return;

    const validation = validateBrowserActionRequest(action);
    if (!validation.ok) {
      await report(requestId, resultForFailure(validation.reason, actionType));
      return;
    }

    const normalized = normalizeBrowserActionRequest(action);
    if (normalized.requiresApproval) {
      const approved = await requestApproval(normalized);
      if (!approved) {
        await report(requestId, resultForFailure('denied_by_user', actionType));
        return;
      }
      normalized.approvedByUser = true;
    }

    let result;
    try {
      result = await runtime.sendMessage({
        type: 'HERMES_RUN_BROWSER_ACTION',
        action: normalized,
      });
    } catch (error) {
      result = { ok: false, reason: error?.message || String(error), actionType };
    }
    await report(requestId, { actionType, ...(result || { ok: false, reason: 'empty_result' }) });
  }

  const off = client.on(BROWSER_ACTION_EVENTS.requested, (event) => {
    handleRequested(event).catch((error) => {
      const requestId = String(event?.payload?.request_id || '').trim();
      if (!requestId) return;
      report(requestId, resultForFailure(error?.message || String(error), event?.payload?.action?.type)).catch(() => {});
    });
  });

  return { dispose: off, handleRequested };
}
