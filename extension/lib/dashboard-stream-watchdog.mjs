export const DASHBOARD_STREAM_IDLE_MS = 5 * 60 * 1000;

export function isDashboardIdleTimeout(error = {}) {
  return /Dashboard response timed out/i.test(String(error?.message || error || ''));
}

export function shouldReattachDashboardStream(error = {}) {
  const message = String(error?.message || error || '');
  return isDashboardIdleTimeout(error)
    || /Dashboard connection closed mid-turn/i.test(message);
}

export function matchesDashboardSessionEvent(event = {}, sessionIds = []) {
  const id = String(event?.sessionId || event?.session_id || event?.payload?.session_id || '').trim();
  const known = [...new Set((Array.isArray(sessionIds) ? sessionIds : [sessionIds])
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
  if (!id) return true;
  if (!known.length) return true;
  return known.includes(id);
}

export function isDashboardTurnActive(status = null) {
  if (status == null || typeof status !== 'object') return null;
  if (status.running === true || status.busy === true || status.in_progress === true || status.active === true) {
    return true;
  }
  const value = String(status.status || status.state || status.run_status || status.phase || '').trim().toLowerCase();
  if (!value) return null;
  if (['completed', 'complete', 'idle', 'ready', 'failed', 'cancelled', 'canceled', 'error', 'stopped'].includes(value)) {
    return false;
  }
  if (['running', 'in_progress', 'thinking', 'tool', 'streaming', 'active', 'busy', 'working'].includes(value)) {
    return true;
  }
  return null;
}

export function dashboardWatchdogTimeoutAction(status = null) {
  return isDashboardTurnActive(status) === false ? 'finish' : 'keep-listening';
}

export function createDashboardStreamWatchdog(onTimeout, {
  idleMs = DASHBOARD_STREAM_IDLE_MS,
  setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  let timer = null;
  const arm = () => {
    if (typeof setTimeoutFn !== 'function') return;
    if (timer != null && typeof clearTimeoutFn === 'function') clearTimeoutFn(timer);
    timer = setTimeoutFn(() => {
      timer = null;
      const error = new Error('Dashboard response timed out.');
      error.requestAccepted = true;
      onTimeout(error);
    }, idleMs);
  };
  arm();
  return {
    ping: arm,
    stop() {
      if (timer != null && typeof clearTimeoutFn === 'function') clearTimeoutFn(timer);
      timer = null;
    },
  };
}
