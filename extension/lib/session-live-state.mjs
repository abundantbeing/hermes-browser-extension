// Honest live-state model for Hermes sessions in the Browser extension.
//
// WHY THIS EXISTS: a persisted session row (REST `GET /api/sessions`,
// WS `session.list`) carries NO live fields — its client-safe keys are
// id/source/model/title/started_at/ended_at/end_reason/message_count/
// tool_call_count/token totals/last_active/pinned/archived/hidden/… —
// there is no state, status, busy, running, active, updated_at or
// running_turns on the wire. Liveness is only observable through the
// dashboard gateway WebSocket: `message.start` / `message.complete` /
// `session.info` (a `running` boolean plus `turn_started_at`),
// `subagent.*` events and the `subagent.list` roster RPC. So a row alone
// can never prove a session is live, and this module refuses to pretend
// otherwise: missing fields produce `unknown`, never a fabricated live
// session. Live signals override the row, so a locally-connected session
// always reads live.
//
// Pure + dependency-free: no imports, no timers, no IO. Every returned
// object is frozen.

export const LIVE_STATES = Object.freeze(['idle', 'running', 'waiting', 'error', 'unknown']);

const LIVE_STATE_SET = new Set(LIVE_STATES);

// ── field probes ────────────────────────────────────────────────────────────
// Raw dashboard rows use snake_case; normalized extension rows (common.mjs
// normalizeHermesSessions) use camelCase. Both are probed.

const ROW_STATUS_KEYS = ['state', 'status', 'session_state', 'sessionState', 'turn_state', 'turnState', 'live_state', 'liveState'];
const ROW_BUSY_KEYS = ['busy', 'is_busy', 'isBusy', 'working', 'is_working', 'isWorking'];
const ROW_RUNNING_KEYS = ['running', 'is_running', 'isRunning'];
const ROW_ACTIVE_KEYS = ['active', 'is_active', 'isActive', 'live', 'is_live', 'isLive'];
const ROW_NEEDS_INPUT_KEYS = ['needs_input', 'needsInput', 'awaiting_input', 'awaitingInput', 'waiting_for_input', 'waitingForInput'];
const ROW_AWAITING_KEYS = ['awaiting_response', 'awaitingResponse'];
const ROW_INFLIGHT_KEYS = ['inflight', 'in_flight', 'inFlight'];
const ROW_RUNNING_TURNS_KEYS = ['running_turns', 'runningTurns'];
const ROW_ENDED_KEYS = ['ended_at', 'endedAt'];
const ROW_END_REASON_KEYS = ['end_reason', 'endReason'];
const ROW_TIME_KEYS = ['last_active', 'lastActive', 'updated_at', 'updatedAt', 'last_activity_at', 'lastActivityAt', 'started_at', 'startedAt'];
const ROW_SUBAGENT_COUNT_KEYS = ['active_subagents', 'activeSubagents', 'running_subagents', 'runningSubagents', 'subagent_count', 'subagentCount', 'subagents_running', 'subagentsRunning'];
const ROW_SUBAGENT_ARRAY_KEYS = ['subagents', 'subagent_list', 'subagentList'];

const RUN_PHASE_KEYS = ['phase'];
const RUN_TERMINAL_STATUS_KEYS = ['terminalStatus', 'terminal_status'];

// Status vocabularies. Anything unrecognized maps to NO claim (unknown),
// never to a guess.
const STOPPING_STATUSES = new Set(['stopping', 'cancelling', 'canceling']);
const RUNNING_STATUSES = new Set(['running', 'streaming', 'busy', 'working', 'active', 'in_progress', 'processing', 'generating', 'live']);
const WAITING_STATUSES = new Set(['waiting', 'waiting_for_approval', 'waiting_for_input', 'waiting_for_user', 'needs_input', 'awaiting_input', 'awaiting_response', 'awaiting_user', 'blocked', 'paused', 'queued', 'pending']);
const ERROR_STATUSES = new Set(['error', 'failed', 'failure', 'crashed', 'exception']);
const IDLE_STATUSES = new Set(['idle', 'ready', 'settled', 'done', 'complete', 'completed', 'finished', 'stopped', 'cancelled', 'canceled', 'ok', 'success', 'closed', 'ended', 'inactive']);

const DEFAULT_LABELS = Object.freeze({
  idle: 'Idle',
  running: 'Running',
  waiting: 'Waiting for input',
  error: 'Failed',
  unknown: 'No live signal',
});

const STATE_LIVENESS = Object.freeze({
  idle: Object.freeze({ live: false, busy: false }),
  running: Object.freeze({ live: true, busy: true }),
  // A live turn blocked on the user: the session is live, but the agent
  // itself is not producing — `busy` stays false, the badge turns amber.
  waiting: Object.freeze({ live: true, busy: false }),
  error: Object.freeze({ live: false, busy: false }),
  unknown: Object.freeze({ live: false, busy: false }),
});

const SUBAGENT_ACTIVE_STATUSES = new Set(['queued', 'running']);

// ── primitive readers ───────────────────────────────────────────────────────

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// First key that is present AND non-null. JSON payloads use `null` for
// "no value" — a null must not count as a signal.
function readFirst(record, keys) {
  if (!isRecord(record)) return { found: false, value: undefined };
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return { found: true, value };
  }
  return { found: false, value: undefined };
}

function readText(record, keys) {
  const { found, value } = readFirst(record, keys);
  return found ? String(value).trim() : '';
}

// true | false | null (null = no usable signal; strings/objects are not
// guessed at).
function readBool(record, keys) {
  const { found, value } = readFirst(record, keys);
  if (!found) return null;
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
  }
  return null;
}

// Epoch seconds (dashboard/run payloads: 1789153520.913) and epoch
// milliseconds (>= 1e12) both normalize to rounded milliseconds. Anything
// non-numeric / non-positive becomes 0 (unknown).
function toEpochMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num >= 1e12 ? Math.round(num) : Math.round(num * 1000);
}

function readEpochMs(record, keys) {
  const { found, value } = readFirst(record, keys);
  return found ? toEpochMs(value) : 0;
}

function freezeState(state, label, updatedAt) {
  const liveness = STATE_LIVENESS[state] || STATE_LIVENESS.unknown;
  const finalState = LIVE_STATE_SET.has(state) ? state : 'unknown';
  return Object.freeze({
    live: liveness.live,
    busy: liveness.busy,
    state: finalState,
    label: String(label || DEFAULT_LABELS[finalState]),
    hasSubagents: false,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.round(updatedAt) : 0,
  });
}

// ── status classification ───────────────────────────────────────────────────

function normalizeStatusText(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

// -> { state, label? } | null (null = unrecognized, contributes no claim)
function classifyStatus(value = '') {
  const norm = normalizeStatusText(value);
  if (!norm) return null;
  if (STOPPING_STATUSES.has(norm)) return { state: 'running', label: 'Stopping' };
  if (WAITING_STATUSES.has(norm)) {
    const label = norm === 'waiting_for_approval' ? 'Waiting for approval'
      : (norm === 'queued' || norm === 'pending') ? 'Queued'
        : 'Waiting for input';
    return { state: 'waiting', label };
  }
  if (RUNNING_STATUSES.has(norm)) return { state: 'running' };
  if (ERROR_STATUSES.has(norm)) return { state: 'error' };
  if (IDLE_STATUSES.has(norm)) return { state: 'idle' };
  return null;
}

// ── subagent roster ─────────────────────────────────────────────────────────

function rosterItems(roster) {
  if (Array.isArray(roster)) return roster;
  if (isRecord(roster)) {
    for (const key of ['subagents', 'children', 'items', 'roster']) {
      if (Array.isArray(roster[key])) return roster[key];
    }
  }
  return [];
}

// Active = queued or running. Terminal statuses (completed/failed/
// interrupted) and unrecognized shapes contribute nothing — a finished
// roster must not keep a session lit.
function isActiveSubagent(item) {
  if (!isRecord(item)) return false;
  const status = normalizeStatusText(item.status ?? item.state ?? '');
  return SUBAGENT_ACTIVE_STATUSES.has(status);
}

function countActiveSubagents(roster) {
  return rosterItems(roster).filter(isActiveSubagent).length;
}

function rowHasSubagents(row) {
  if (!isRecord(row)) return false;
  for (const key of ROW_SUBAGENT_COUNT_KEYS) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return true;
  }
  for (const key of ROW_SUBAGENT_ARRAY_KEYS) {
    if (countActiveSubagents(row[key]) > 0) return true;
  }
  return false;
}

// ── row-derived live state ──────────────────────────────────────────────────

/**
 * Derive an honest live-state model from ONE session row.
 *
 * Decision order (first decisive signal wins):
 *   1. needs_input truthy                      -> waiting
 *   2. state/status string                     -> its family (unrecognized -> no claim)
 *   3. busy/running/active/live boolean true   -> running
 *   4. awaiting_response truthy                -> running
 *   5. inflight object (non-null)              -> running
 *   6. running_turns numeric                   -> >0: running, 0: idle
 *   7. busy/running/active/live boolean false  -> idle
 *   8. ended_at/end_reason present             -> idle (a finished row)
 *   9. otherwise                               -> unknown (NO fabricated liveness)
 */
export function liveStateFromSessionRow(row) {
  if (!isRecord(row)) return freezeState('unknown', DEFAULT_LABELS.unknown, 0);

  const updatedAt = readEpochMs(row, ROW_TIME_KEYS);
  const hasSubagents = rowHasSubagents(row);
  const withFlags = (state, label) => {
    const base = freezeState(state, label, updatedAt);
    return Object.freeze({ ...base, hasSubagents });
  };

  if (readBool(row, ROW_NEEDS_INPUT_KEYS) === true) {
    return withFlags('waiting', 'Waiting for input');
  }

  const fromStatus = classifyStatus(readText(row, ROW_STATUS_KEYS));
  if (fromStatus) return withFlags(fromStatus.state, fromStatus.label);

  const boolSignals = [
    readBool(row, ROW_BUSY_KEYS),
    readBool(row, ROW_RUNNING_KEYS),
    readBool(row, ROW_ACTIVE_KEYS),
  ];
  if (boolSignals.includes(true)) return withFlags('running', DEFAULT_LABELS.running);
  if (readBool(row, ROW_AWAITING_KEYS) === true) return withFlags('running', DEFAULT_LABELS.running);

  const inflight = readFirst(row, ROW_INFLIGHT_KEYS);
  if (inflight.found && isRecord(inflight.value)) return withFlags('running', DEFAULT_LABELS.running);

  const runningTurns = readFirst(row, ROW_RUNNING_TURNS_KEYS);
  if (runningTurns.found && Number.isFinite(Number(runningTurns.value))) {
    const turns = Number(runningTurns.value);
    if (turns > 0) return withFlags('running', DEFAULT_LABELS.running);
    if (turns === 0) return withFlags('idle', DEFAULT_LABELS.idle);
  }

  if (boolSignals.includes(false)) return withFlags('idle', DEFAULT_LABELS.idle);

  const endedAt = readEpochMs(row, ROW_ENDED_KEYS);
  const endReason = readText(row, ROW_END_REASON_KEYS);
  if (endedAt > 0 || endReason) return withFlags('idle', DEFAULT_LABELS.idle);

  return withFlags('unknown', DEFAULT_LABELS.unknown);
}

// ── local run signal (WS run state) ─────────────────────────────────────────

function runModel(state, label, updatedAt) {
  const base = freezeState(state, label, updatedAt);
  return { state: base.state, live: base.live, busy: base.busy, label: base.label, updatedAt: base.updatedAt };
}

/**
 * Map the locally-observed run state to a model, or null when the shape
 * carries no recognizable signal (row decision stands).
 *
 * Accepted shapes:
 *   - extension run-control phases: phase 'running' | 'stopping' |
 *     'unconfirmed' | 'terminal' (+ terminalStatus completed|cancelled|failed)
 *   - REST /v1/runs status: status 'queued' | 'running' |
 *     'waiting_for_approval' | 'stopping' | 'completed' | 'failed' |
 *     'cancelled' (+ updated_at epoch seconds)
 *   - bare booleans: { running | busy: true|false }
 */
function liveRunModel(liveRun) {
  if (!isRecord(liveRun)) return null;
  const updatedAt = readEpochMs(liveRun, ROW_TIME_KEYS);

  const phase = readText(liveRun, RUN_PHASE_KEYS).toLowerCase();
  if (phase === 'idle') return null;
  if (phase === 'unconfirmed') return runModel('waiting', 'Stop unconfirmed', updatedAt);
  if (phase === 'terminal') {
    const terminal = normalizeStatusText(readText(liveRun, RUN_TERMINAL_STATUS_KEYS));
    if (ERROR_STATUSES.has(terminal)) return runModel('error', DEFAULT_LABELS.error, updatedAt);
    return runModel('idle', DEFAULT_LABELS.idle, updatedAt);
  }
  if (phase === 'running' || phase === 'stopping') {
    return runModel('running', phase === 'stopping' ? 'Stopping' : DEFAULT_LABELS.running, updatedAt);
  }

  const fromStatus = classifyStatus(readText(liveRun, ROW_STATUS_KEYS));
  if (fromStatus) return runModel(fromStatus.state, fromStatus.label, updatedAt);

  const terminal = normalizeStatusText(readText(liveRun, RUN_TERMINAL_STATUS_KEYS));
  if (ERROR_STATUSES.has(terminal)) return runModel('error', DEFAULT_LABELS.error, updatedAt);
  if (IDLE_STATUSES.has(terminal)) return runModel('idle', DEFAULT_LABELS.idle, updatedAt);

  const boolSignals = [
    readBool(liveRun, ROW_BUSY_KEYS),
    readBool(liveRun, ROW_RUNNING_KEYS),
    readBool(liveRun, ROW_ACTIVE_KEYS),
  ];
  if (boolSignals.includes(true)) return runModel('running', DEFAULT_LABELS.running, updatedAt);
  if (boolSignals.includes(false)) return runModel('idle', DEFAULT_LABELS.idle, updatedAt);

  const inflight = readFirst(liveRun, ROW_INFLIGHT_KEYS);
  if (inflight.found && isRecord(inflight.value)) return runModel('running', DEFAULT_LABELS.running, updatedAt);

  return null;
}

// ── merged live state ───────────────────────────────────────────────────────

/**
 * Merge a session row with the local WS run state and the live subagent
 * roster.
 *
 * Precedence: liveRun > row; a roster with active (queued/running) children
 * keeps the session live even when the row and the local run read idle —
 * async delegation outlives the parent turn (subagent.list returns only
 * live children; subagent.* events feed the same roster).
 */
export function mergeLiveSignals(input = {}) {
  const { row = null, liveRun = null, roster = null } = input || {};
  const base = liveStateFromSessionRow(row);
  const run = liveRunModel(liveRun);

  let state = base.state;
  let live = base.live;
  let busy = base.busy;
  let label = base.label;
  let updatedAt = base.updatedAt;

  if (run) {
    state = run.state;
    live = run.live;
    busy = run.busy;
    label = run.label;
    updatedAt = Math.max(updatedAt, run.updatedAt);
  }

  const hasSubagents = base.hasSubagents || countActiveSubagents(roster) > 0;
  if (countActiveSubagents(roster) > 0 && !live) {
    // Parent turn (if any) has ended; the children are still working.
    state = 'running';
    live = true;
    busy = true;
    label = 'Subagents running';
  }

  return Object.freeze({ live, busy, state, label, hasSubagents, updatedAt });
}

// ── badge ───────────────────────────────────────────────────────────────────

/**
 * Compact UI badge for a state. Unknown/invalid input badges as 'Unknown'
 * (never as 'Idle').
 */
export function liveStateBadge(state) {
  const normalized = String(state || '').trim().toLowerCase();
  if (normalized === 'running') return Object.freeze({ text: 'Live', tone: 'live' });
  if (normalized === 'waiting') return Object.freeze({ text: 'Waiting', tone: 'warn' });
  if (normalized === 'idle') return Object.freeze({ text: 'Idle', tone: 'idle' });
  if (normalized === 'error') return Object.freeze({ text: 'Error', tone: 'error' });
  return Object.freeze({ text: 'Unknown', tone: 'idle' });
}
