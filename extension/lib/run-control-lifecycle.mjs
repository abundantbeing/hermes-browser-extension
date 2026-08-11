export const RUN_CONTROL_REQUEST_TIMEOUT_MS = 8_000;
export const RUN_TERMINAL_CONFIRM_TIMEOUT_MS = 30_000;
export const RUN_STATUS_POLL_MS = 250;

export const RUN_CONTROL_PHASES = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  STOPPING: 'stopping',
  TERMINAL: 'terminal',
  UNCONFIRMED: 'unconfirmed',
});

export const RUN_TERMINAL_STATUSES = Object.freeze({
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const TERMINAL = new Set(Object.values(RUN_TERMINAL_STATUSES));

function freeze(state) {
  return Object.freeze(state);
}

export function beginRunControl({ runId = '', transport = '', now = Date.now() } = {}) {
  return freeze({
    runId: String(runId || ''),
    transport: String(transport || ''),
    phase: RUN_CONTROL_PHASES.RUNNING,
    controlStatus: 'idle',
    terminalStatus: '',
    writerLease: 'held',
    streamOpen: true,
    startedAt: Number(now) || Date.now(),
    stopRequestedAt: 0,
    terminalAt: 0,
    detail: '',
  });
}

export function withRunControlId(state, runId = '') {
  return freeze({ ...state, runId: String(runId || state?.runId || '') });
}

export function requestRunStop(state, now = Date.now()) {
  if (!state || state.phase === RUN_CONTROL_PHASES.TERMINAL) return state;
  return freeze({
    ...state,
    phase: RUN_CONTROL_PHASES.STOPPING,
    controlStatus: 'pending',
    stopRequestedAt: Number(now) || Date.now(),
    detail: '',
  });
}

export function acknowledgeStopRequest(state, payload = {}) {
  if (!state || state.phase === RUN_CONTROL_PHASES.TERMINAL) return state;
  return freeze({
    ...state,
    phase: RUN_CONTROL_PHASES.STOPPING,
    controlStatus: 'accepted',
    detail: String(payload?.status || payload?.detail || 'stopping'),
  });
}

export function markStopRequestFailed(state, detail = '') {
  if (!state || state.phase === RUN_CONTROL_PHASES.TERMINAL) return state;
  return freeze({
    ...state,
    phase: RUN_CONTROL_PHASES.UNCONFIRMED,
    controlStatus: 'failed',
    detail: String(detail || 'stop request was not acknowledged'),
  });
}

export function markRunStreamClosed(state) {
  if (!state) return state;
  return freeze({ ...state, streamOpen: false });
}

export function markRunTerminal(state, status, now = Date.now()) {
  const terminalStatus = String(status || '').toLowerCase();
  if (!TERMINAL.has(terminalStatus)) throw new TypeError(`Unknown terminal run status: ${status}`);
  return freeze({
    ...(state || beginRunControl()),
    phase: RUN_CONTROL_PHASES.TERMINAL,
    terminalStatus,
    writerLease: 'released',
    streamOpen: false,
    terminalAt: Number(now) || Date.now(),
    detail: '',
  });
}

export function markTerminalTimeout(state, detail = 'terminal confirmation timed out') {
  if (!state || state.phase === RUN_CONTROL_PHASES.TERMINAL) return state;
  return freeze({
    ...state,
    phase: RUN_CONTROL_PHASES.UNCONFIRMED,
    writerLease: 'held',
    detail: String(detail || 'terminal confirmation timed out'),
  });
}

export function canFlushQueuedTurn(turn = null, state = null) {
  return Boolean(
    turn
    && turn.autoSend !== false
    && turn.kind !== 'steer-fallback'
    && state?.phase === RUN_CONTROL_PHASES.TERMINAL
    && state?.writerLease === 'released',
  );
}

export function canSwitchActiveSession({ sending = false, runControl = null } = {}) {
  if (sending) return false;
  if (!runControl) return true;
  return runControl.phase === RUN_CONTROL_PHASES.TERMINAL
    && runControl.writerLease === 'released';
}

function statusValue(payload = {}) {
  return String(
    payload?.status
    || payload?.data?.status
    || payload?.run?.status
    || payload?.session?.status
    || payload?.state
    || '',
  ).trim().toLowerCase();
}

export function restTerminalStatus(payload = {}) {
  const status = statusValue(payload);
  return TERMINAL.has(status) ? status : '';
}

export function runStopFailureTerminalStatus({ httpStatus = 0, payload = null } = {}) {
  if (![404, 409].includes(Number(httpStatus))) return '';
  const code = String(
    payload?.error?.code
    || payload?.code
    || (typeof payload?.error === 'string' ? payload.error : ''),
  ).trim().toLowerCase();
  return ['run_not_found', 'run_not_running', 'run_finished', 'not_found'].includes(code)
    ? RUN_TERMINAL_STATUSES.CANCELLED
    : '';
}

export function runControlGenerationMatches(expectedGeneration, currentGeneration) {
  return Number.isInteger(expectedGeneration)
    && Number.isInteger(currentGeneration)
    && expectedGeneration === currentGeneration;
}

export function dashboardTerminalStatus(payload = {}, { stopRequested = false } = {}) {
  const status = statusValue(payload);
  if (TERMINAL.has(status)) return status;
  if (status === 'stopped') return RUN_TERMINAL_STATUSES.CANCELLED;
  if (['running', 'busy', 'working', 'stopping'].includes(status)) return '';
  const running = payload?.running ?? payload?.is_running ?? payload?.busy ?? payload?.session?.running ?? payload?.session?.busy;
  if (running === true) return '';
  if (running === false || ['idle', 'ready'].includes(status)) {
    return stopRequested ? RUN_TERMINAL_STATUSES.CANCELLED : RUN_TERMINAL_STATUSES.COMPLETED;
  }
  return '';
}

export async function runControlRequestWithTimeout(operation, { timeoutMs = RUN_CONTROL_REQUEST_TIMEOUT_MS } = {}) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  const controlRequestController = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controlRequestController.abort();
      reject(new Error(`Runtime control request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controlRequestController.signal), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function waitForTerminalStatus({
  readStatus,
  terminalStatus,
  timeoutMs = 30_000,
  pollMs = 250,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof readStatus !== 'function' || typeof terminalStatus !== 'function') {
    throw new TypeError('readStatus and terminalStatus functions are required');
  }
  const startedAt = Number(now());
  let attempts = 0;
  while (Number(now()) - startedAt <= timeoutMs) {
    attempts += 1;
    const payload = await readStatus();
    const status = terminalStatus(payload);
    if (status) return { status, payload, attempts };
    await sleep(pollMs);
  }
  throw new Error(`Runtime terminal confirmation timed out after ${timeoutMs}ms`);
}
