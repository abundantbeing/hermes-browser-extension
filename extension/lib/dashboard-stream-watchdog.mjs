export const DASHBOARD_STREAM_IDLE_MS = 5 * 60 * 1000;

export function isDashboardIdleTimeout(error = {}) {
  return /Dashboard response timed out/i.test(String(error?.message || error || ''));
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
