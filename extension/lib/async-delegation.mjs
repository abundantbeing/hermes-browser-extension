export const DELEGATION_WATCH_STORAGE_KEY = 'hermesAsyncDelegationWatchesV1';

const DELEGATION_ID_PATTERN = /^deleg_[A-Za-z0-9_-]{8,128}$/;
const WATCH_STATES = new Set(['pending', 'completed', 'timed_out', 'cancelled', 'load_failed']);
const WATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const WATCH_LIMIT = 100;


function textValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textValue).join('');
  if (!value || typeof value !== 'object') return '';
  return textValue(value.text ?? value.output_text ?? value.content ?? value.message ?? '');
}

function parseStructuredValue(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function eventToolName(event = {}) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  return String(
    event?.toolName
    || event?.tool_name
    || data.tool_name
    || data.toolName
    || data.tool
    || event?.name
    || event?.rawName
    || '',
  ).trim();
}

function canonicalToolName(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^mcp__/, '')
    .replace(/[\s_-]+/g, '.');
}

function terminalToolEvent(event = {}) {
  const type = String(event?.type || event?.event || event?.name || event?.rawName || '').trim().toLowerCase();
  const status = String(event?.status || event?.data?.status || '').trim().toLowerCase();
  return /(?:^|\.)tool\.(?:complete|completed)$/.test(type)
    || ['complete', 'completed', 'success', 'succeeded'].includes(status);
}

function dispatchPayloadFromEvent(event = {}) {
  const values = [
    event?.result,
    event?.data?.result,
    event?.payload?.result,
    event?.data?.output,
    event?.output,
    event?.content,
  ];
  for (const value of values) {
    const parsed = parseStructuredValue(value);
    if (!parsed) continue;
    if (parsed.result && typeof parsed.result === 'object') return parsed.result;
    return parsed;
  }
  return null;
}

function watchKey(value = {}) {
  return [value.scopeKey, value.durableSessionId, value.delegationId].map((part) => String(part || '').trim()).join('::');
}

function normalizedWatchRow(value = {}, now = Date.now()) {
  const scopeKey = String(value?.scopeKey || '').trim().slice(0, 600);
  const durableSessionId = String(value?.durableSessionId || '').trim().slice(0, 300);
  const liveSessionId = String(value?.liveSessionId || '').trim().slice(0, 300);
  const delegationId = normalizeDelegationId(value?.delegationId);
  const transport = value?.transport === 'dashboard-ws' ? 'dashboard-ws' : 'rest';
  const state = WATCH_STATES.has(value?.state) ? value.state : 'pending';
  const dispatchedAt = Number.isFinite(Number(value?.dispatchedAt)) ? Number(value.dispatchedAt) : now;
  const updatedAt = Number.isFinite(Number(value?.updatedAt)) ? Number(value.updatedAt) : dispatchedAt;
  if (!scopeKey || !durableSessionId || !delegationId) return null;
  return {
    scopeKey,
    durableSessionId,
    liveSessionId,
    delegationId,
    transport,
    state,
    dispatchedAt,
    updatedAt,
    attempts: Math.max(0, Math.min(10_000, Number(value?.attempts) || 0)),
    nextPollAt: Math.max(0, Number(value?.nextPollAt) || 0),
    lastError: String(value?.lastError || '').slice(0, 300),
  };
}

export function normalizeDelegationId(value = '') {
  const id = String(value || '').trim();
  return DELEGATION_ID_PATTERN.test(id) ? id : '';
}

export function isDelegationCompletionMarkerMessage(message = {}) {
  if (String(message?.role || '').trim().toLowerCase() !== 'user') return false;
  const content = textValue(message?.content).replaceAll(String.fromCharCode(13, 10), String.fromCharCode(10));
  const marker = content.match(
    /^\[ASYNC DELEGATION(?: BATCH)? COMPLETE\s*[—-]\s*(deleg_[A-Za-z0-9_-]{8,128})\](?:\n|$)/i,
  );
  return Boolean(marker && normalizeDelegationId(marker[1]));
}

export function isDelegationToolEvent(event = {}) {
  const name = canonicalToolName(eventToolName(event));
  return name === 'delegate.task'
    || name === 'tools.subagent'
    || name === 'subagent'
    || name.startsWith('subagent.');
}

export function delegationDispatchFromToolEvent(event = {}) {
  if (!isDelegationToolEvent(event) || !terminalToolEvent(event)) return null;
  const payload = dispatchPayloadFromEvent(event);
  if (!payload || String(payload.status || '').toLowerCase() !== 'dispatched') return null;
  if (String(payload.mode || '').toLowerCase() !== 'background') return null;
  const delegationId = normalizeDelegationId(payload.delegation_id || payload.delegationId);
  if (!delegationId) return null;
  return {
    delegationId,
    count: Math.max(1, Number(payload.count) || 1),
    mode: 'background',
  };
}

export function delegationDispatchesFromMessages(messages = []) {
  const dispatches = [];
  const seen = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const toolName = message.tool_name || message.toolName || message.name || message.rawName;
    const dispatch = delegationDispatchFromToolEvent({
      type: 'tool.complete',
      status: 'complete',
      tool_name: toolName,
      result: message.result ?? message.output ?? message.content,
    });
    if (!dispatch || seen.has(dispatch.delegationId)) continue;
    seen.add(dispatch.delegationId);
    dispatches.push(dispatch);
  }
  return dispatches;
}

export function delegationCompletionState(messages = [], delegationId = '') {
  const id = normalizeDelegationId(delegationId);
  if (!id) return { state: 'pending' };
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marker = new RegExp(`^\\[ASYNC DELEGATION(?: BATCH)? COMPLETE\\s*[—-]\\s*${escaped}\\](?:\\r?\\n|$)`, 'i');
  const rows = Array.isArray(messages) ? messages : [];
  for (let markerIndex = rows.length - 1; markerIndex >= 0; markerIndex -= 1) {
    if (!marker.test(textValue(rows[markerIndex]?.content))) continue;
    for (let assistantIndex = markerIndex + 1; assistantIndex < rows.length; assistantIndex += 1) {
      const row = rows[assistantIndex] || {};
      if (String(row.role || '').toLowerCase() !== 'assistant') continue;
      if (!textValue(row.content).trim()) continue;
      if (Array.isArray(row.tool_calls) && row.tool_calls.length) continue;
      return { state: 'completed', markerIndex, assistantIndex };
    }
    return { state: 'pending', markerIndex };
  }
  return { state: 'pending' };
}

export function delegationScopeKey({ mode = '', gatewayUrl = '', profile = '' } = {}) {
  let normalizedUrl = '';
  try {
    const parsed = new URL(String(gatewayUrl || '').trim());
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    normalizedUrl = parsed.toString().replace(/\/$/, '');
  } catch {
    normalizedUrl = String(gatewayUrl || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
  return [String(mode || '').trim(), normalizedUrl, String(profile || '').trim()].join('|');
}

export function pollDelayForAttempt(attempt = 0) {
  return [2_000, 4_000, 8_000, 15_000, 30_000][Math.min(4, Math.max(0, Number(attempt) || 0))];
}

export function normalizeDelegationWatchStore(value = [], { now = Date.now(), retentionMs = WATCH_RETENTION_MS, limit = WATCH_LIMIT } = {}) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.watches) ? value.watches : [];
  const merged = new Map();
  for (const candidate of rows) {
    const row = normalizedWatchRow(candidate, now);
    if (!row || now - row.updatedAt > retentionMs) continue;
    const key = watchKey(row);
    const previous = merged.get(key);
    const completedIsMonotonic = previous?.state === 'completed' && row.state !== 'completed';
    if (!previous || (!completedIsMonotonic && (row.state === 'completed' || row.updatedAt >= previous.updatedAt))) {
      merged.set(key, row);
    }
  }
  return [...merged.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, Math.max(1, Math.min(WATCH_LIMIT, Number(limit) || WATCH_LIMIT)));
}

export function mergeDelegationWatchStores(current = [], incoming = [], options = {}) {
  return normalizeDelegationWatchStore([...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])], options);
}

// Compatibility exports for older callers. Prose never starts polling, and the
// boolean helper now means exact durable completion only rather than timeout.
export function turnMentionsDelegation() {
  return false;
}

export function delegationBatchSettled(messages = [], _baseline = 0, _startedAt = 0, _maxWaitMs = 0, delegationId = '') {
  return delegationCompletionState(messages, delegationId).state === 'completed';
}

export function createDelegationWatchManager({
  now = Date.now,
  maxPollMs = 30 * 60 * 1000,
  isBusy = () => false,
  isActive = () => true,
  loadHistory,
  onComplete = async () => {},
  onState = () => {},
  persist = async () => {},
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  if (typeof loadHistory !== 'function') throw new TypeError('loadHistory must be a function.');
  if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') throw new TypeError('Timer functions are required.');

  const watches = new Map();
  const timers = new Map();
  const revisions = new Map();
  const inFlight = new Map();
  let disposed = false;

  const snapshot = () => normalizeDelegationWatchStore([...watches.values()], { now: now() });

  async function save() {
    try {
      await persist(snapshot());
      return true;
    } catch {
      // Storage failures are transient. Keep the in-memory watch and poll chain
      // alive so a later state transition can retry the bounded snapshot.
      return false;
    }
  }

  function notify(row) {
    try { onState({ ...row }); } catch { /* UI notification must not break watching. */ }
  }

  function bump(key) {
    const revision = (revisions.get(key) || 0) + 1;
    revisions.set(key, revision);
    return revision;
  }

  function cancelTimer(key) {
    const timer = timers.get(key);
    if (timer != null) clearTimer(timer);
    timers.delete(key);
  }

  function schedule(row, delay = pollDelayForAttempt(row.attempts)) {
    if (disposed || ['completed', 'cancelled', 'timed_out'].includes(row.state) || !isActive(row)) return;
    const key = watchKey(row);
    cancelTimer(key);
    row.nextPollAt = now() + Math.max(0, Number(delay) || 0);
    const timer = setTimer(() => {
      timers.delete(key);
      reconcile(row).catch(() => {});
    }, Math.max(0, Number(delay) || 0));
    timers.set(key, timer);
  }

  async function start(candidate = {}) {
    if (disposed) return null;
    const timestamp = now();
    const normalized = normalizedWatchRow({ ...candidate, state: 'pending', dispatchedAt: candidate.dispatchedAt || timestamp, updatedAt: timestamp }, timestamp);
    if (!normalized) return null;
    const key = watchKey(normalized);
    const previous = watches.get(key);
    if (previous?.state === 'completed') return { ...previous };
    const row = previous
      ? { ...previous, liveSessionId: normalized.liveSessionId || previous.liveSessionId, transport: normalized.transport, updatedAt: timestamp }
      : normalized;
    watches.set(key, row);
    bump(key);
    notify(row);
    await save();
    schedule(row, 0);
    return { ...row };
  }

  async function reconcile(candidate = {}) {
    if (disposed) return null;
    const key = watchKey(candidate);
    const row = watches.get(key);
    if (!row || ['completed', 'cancelled'].includes(row.state)) return row ? { ...row } : null;
    if (inFlight.has(key)) return inFlight.get(key);

    const operation = (async () => {
      cancelTimer(key);
      const revision = revisions.get(key) || 0;
      if (!isActive(row)) return { ...row };
      if (now() - row.dispatchedAt >= maxPollMs) {
        row.state = 'timed_out';
        row.updatedAt = now();
        row.nextPollAt = 0;
        row.lastError = '';
        watches.set(key, row);
        bump(key);
        notify(row);
        await save();
        return { ...row };
      }
      if (isBusy(row)) {
        schedule(row, 1_000);
        return { ...row };
      }

      let result;
      try {
        result = await loadHistory({ ...row });
      } catch (error) {
        if (disposed || revisions.get(key) !== revision || !watches.has(key) || !isActive(row)) return { ...row };
        row.state = 'load_failed';
        row.lastError = error?.message || String(error);
        row.attempts += 1;
        row.updatedAt = now();
        watches.set(key, row);
        notify(row);
        await save();
        schedule(row);
        return { ...row };
      }

      if (disposed || revisions.get(key) !== revision || !watches.has(key) || !isActive(row)) return { ...row };
      const completion = delegationCompletionState(result?.messages || result || [], row.delegationId);
      if (completion.state === 'completed') {
        try {
          await onComplete({ ...row }, result, completion);
        } catch (error) {
          if (disposed || revisions.get(key) !== revision || !isActive(row)) return { ...row };
          row.state = 'load_failed';
          row.lastError = error?.message || String(error);
          row.attempts += 1;
          row.updatedAt = now();
          watches.set(key, row);
          notify(row);
          await save();
          schedule(row);
          return { ...row };
        }
        if (disposed || revisions.get(key) !== revision || !isActive(row)) return { ...row };
        row.state = 'completed';
        row.lastError = '';
        row.nextPollAt = 0;
        row.updatedAt = now();
        watches.set(key, row);
        bump(key);
        notify(row);
        await save();
        return { ...row };
      }

      row.state = 'pending';
      row.lastError = '';
      row.attempts += 1;
      row.updatedAt = now();
      watches.set(key, row);
      notify(row);
      await save();
      schedule(row);
      return { ...row };
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, operation);
    return operation;
  }

  async function activate({ scopeKey = '', durableSessionId = '', liveSessionId = '' } = {}) {
    const timestamp = now();
    for (const [key, row] of watches) {
      if (row.scopeKey !== scopeKey || row.durableSessionId !== durableSessionId || row.state === 'completed' || row.state === 'cancelled') continue;
      cancelTimer(key);
      row.liveSessionId = String(liveSessionId || '').trim();
      const resumedAfterTimeout = row.state === 'timed_out';
      if (row.state === 'timed_out' || row.state === 'load_failed') row.state = 'pending';
      if (resumedAfterTimeout) row.dispatchedAt = timestamp;
      row.updatedAt = timestamp;
      row.nextPollAt = 0;
      watches.set(key, row);
      bump(key);
      schedule(row, 0);
    }
    await save();
    return snapshot();
  }

  async function hydrate(value = []) {
    if (disposed) return [];
    for (const row of normalizeDelegationWatchStore(value, { now: now() })) {
      const key = watchKey(row);
      watches.set(key, row);
      bump(key);
      if (!['completed', 'cancelled'].includes(row.state) && isActive(row)) schedule(row, 0);
    }
    await save();
    return snapshot();
  }

  function dispose() {
    disposed = true;
    for (const key of timers.keys()) cancelTimer(key);
    for (const key of watches.keys()) bump(key);
  }

  return Object.freeze({ start, reconcile, activate, hydrate, snapshot, dispose });
}
