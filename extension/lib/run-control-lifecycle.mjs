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

export const RUN_UNCONFIRMED_REASONS = Object.freeze({
  RUN_ID_UNKNOWN: 'run-id-unknown',
});

const RUN_UNCONFIRMED_DETAIL = Object.freeze({
  [RUN_UNCONFIRMED_REASONS.RUN_ID_UNKNOWN]: 'Hermes has not reported a run id for this turn, so Browser cannot confirm the run stopped. The session writer and queued messages stay held until Hermes confirms a terminal state.',
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
    // The execution generation the gateway admitted this run under (session authority only). Stop is
    // fenced with it, so it can never be applied to a newer run. Null until the gateway says.
    executionGeneration: null,
  });
}

/**
 * Record the generation the run was admitted under. Set once: the run keeps the generation it
 * started with, and anything that is not a non-negative integer is not a generation.
 */
export function withRunGeneration(state, generation) {
  if (!state || Number.isInteger(state.executionGeneration)) return state;
  if (!Number.isInteger(generation) || generation < 0) return state;
  return freeze({ ...state, executionGeneration: generation });
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

/**
 * Stop was requested but Hermes cannot say what happened to the run, for
 * example because no run id was ever published. The writer stays held and the
 * state is never reported as stopped; only a terminal confirmation releases it.
 */
export function markRunUnconfirmed(state, reason = '', detail = '') {
  if (!state || state.phase === RUN_CONTROL_PHASES.TERMINAL) return state;
  return freeze({
    ...state,
    phase: RUN_CONTROL_PHASES.UNCONFIRMED,
    controlStatus: 'unconfirmed',
    writerLease: 'held',
    unconfirmedReason: String(reason || ''),
    detail: String(detail || RUN_UNCONFIRMED_DETAIL[reason] || 'Hermes has not confirmed the stop.'),
  });
}

/**
 * A Stop that never learned a run id cannot be confirmed by polling: there is
 * no run to ask about. Retrying status can never succeed, so this is the one
 * held state the person may release by hand, after checking Hermes themselves.
 */
export function canReleaseUnconfirmedRun(state = null) {
  return Boolean(
    state
    && state.phase === RUN_CONTROL_PHASES.UNCONFIRMED
    && state.unconfirmedReason === RUN_UNCONFIRMED_REASONS.RUN_ID_UNKNOWN
    && !state.runId,
  );
}

export function markRunStreamClosed(state) {
  if (!state) return state;
  return freeze({ ...state, streamOpen: false });
}

export function canRecoverStaleDashboardRunControl({
  sending = false,
  dashboardTransport = false,
  runControl = null,
} = {}) {
  return Boolean(
    dashboardTransport
    && !sending
    && runControl?.streamOpen === false
    && [RUN_CONTROL_PHASES.RUNNING, RUN_CONTROL_PHASES.UNCONFIRMED].includes(runControl.phase),
  );
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
  if (TERMINAL.has(status)) return status;
  // The gateway reports a run it interrupted itself (a restart, a shutdown) as
  // `interrupted`; nothing is running any more, and it was not completed.
  return status === 'interrupted' ? RUN_TERMINAL_STATUSES.CANCELLED : '';
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

/** Run id a session payload reports for its in-flight run, or an empty string. */
export function activeRunIdFromSessionPayload(payload = {}) {
  const candidates = [
    payload?.active_run_id,
    payload?.session?.active_run_id,
    payload?.data?.active_run_id,
    payload?.run?.id,
    payload?.session?.run_id,
  ];
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim();
    if (value && /^[A-Za-z0-9._:-]{1,200}$/.test(value)) return value;
  }
  return '';
}

/** What a controller Stop reported: how many pending Hermes Control commands it cancelled. */
export function controllerStopSummary(result = null) {
  if (!result || typeof result !== 'object' || result.ok === false) return { ok: false, cancelled: 0 };
  const cancelled = Number(result.cancelled);
  return { ok: true, cancelled: Number.isInteger(cancelled) && cancelled > 0 ? cancelled : 0 };
}

export function runControlGenerationMatches(expectedGeneration, currentGeneration) {
  return Number.isInteger(expectedGeneration)
    && Number.isInteger(currentGeneration)
    && expectedGeneration === currentGeneration;
}

// `session.status` answers with rendered text, not fields: a line reading
// "Agent Running: Yes" or "Agent Running: No".
function agentRunningFromStatusText(payload = {}) {
  const match = /^Agent Running:\s*(Yes|No)\s*$/mi.exec(String(payload?.output ?? ''));
  if (!match) return undefined;
  return match[1].toLowerCase() === 'yes';
}

export function dashboardTerminalStatus(payload = {}, { stopRequested = false } = {}) {
  const status = statusValue(payload);
  if (TERMINAL.has(status)) return status;
  if (status === 'stopped' || status === 'interrupted') return RUN_TERMINAL_STATUSES.CANCELLED;
  if (['running', 'busy', 'working', 'stopping', 'waiting', 'starting'].includes(status)) return '';
  const running = payload?.running ?? payload?.is_running ?? payload?.busy ?? payload?.session?.running ?? payload?.session?.busy
    ?? agentRunningFromStatusText(payload);
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
