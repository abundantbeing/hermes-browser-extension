// Per-session context telemetry store for the Hermes Browser side panel.
//
// WHY THIS EXISTS: the panel used to keep ONE reported snapshot, keyed by the
// gateway's live runtime id, and compared it against the durable session id the
// view is bound to. Those two ids differ after every session.resume, so the
// reported numbers were dropped and the panel fell back to its own estimate.
// Switching sessions also threw the previous snapshot away, and every 1 Hz
// session.usage tick (which carries no categories) replaced the category
// breakdown with nothing.
//
// This store keeps one entry per DURABLE session id, holding the two gateway
// readings separately so neither erases the other:
//
//   breakdown  the `session.context_breakdown` RPC result
//              (agent/context_breakdown.py::compute_session_context_breakdown):
//              categories [{ id, label, tokens, color }], context_used,
//              context_max, context_percent, context_source,
//              context_estimated, estimated_total, model, context_files[]
//   usage      the `session.usage` snapshot (RPC result, or the `{ usage }`
//              payload of the pushed event and of message.complete;
//              tui_gateway/server.py::_get_usage): context_used, context_max,
//              context_percent, context_source, context_estimated,
//              compressions, cache_hit_pct, calls, input, output, model
//
// Only fields the gateway really sends are read. A breakdown with neither a
// context_max nor any category is the gateway's "no agent to measure, nothing
// stored" answer and is refused, the same rule the desktop app applies. A
// breakdown with categories and no window (no resident agent, the session's
// frozen prompt measured) is kept. Nothing here estimates a number.
//
// The store is a plain JSON object so the panel can persist it to
// storage.local and show a session's last known context the moment it opens.

export const SESSION_CONTEXT_STORAGE_KEY = 'hermesBrowserSessionContext';
export const SESSION_CONTEXT_STORE_VERSION = 1;
export const SESSION_CONTEXT_MAX_SESSIONS = 100;

// Declaration order of agent/context_breakdown.py::_CATEGORIES, which is also
// the display order.
export const CONTEXT_CATEGORY_IDS = Object.freeze([
  'system_prompt',
  'tool_definitions',
  'rules',
  'skills',
  'mcp',
  'subagent_definitions',
  'memory',
  'conversation',
]);

const CONTEXT_SOURCES = new Set(['provider_usage', 'provider_usage_plus_estimate', 'local_estimate']);
const MAX_CATEGORIES = 16;
const MAX_CONTEXT_FILES = 24;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toTokens(value) {
  const parsed = toNumber(value);
  return parsed !== null && parsed >= 0 ? Math.round(parsed) : null;
}

function toPositiveTokens(value) {
  const parsed = toTokens(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function toPercent(value) {
  const parsed = toNumber(value);
  return parsed === null ? null : Math.max(0, Math.min(100, Math.round(parsed)));
}

function toText(value, max = 160) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function toSource(value) {
  const source = toText(value, 64);
  return CONTEXT_SOURCES.has(source) ? source : '';
}

function toTimestamp(value) {
  const parsed = toNumber(value);
  return parsed !== null && parsed > 0 ? parsed : 0;
}

function normalizeSessionId(sessionId) {
  const id = String(sessionId || '').trim();
  // Entries live in a plain object; this key would set its prototype instead.
  return id === '__proto__' ? '' : id;
}

function normalizeCategories(entries) {
  if (!Array.isArray(entries)) return [];
  const rows = [];
  for (const entry of entries.slice(0, MAX_CATEGORIES)) {
    if (!isPlainObject(entry)) continue;
    const id = toText(entry.id, 64);
    const label = toText(entry.label) || id;
    const tokens = toTokens(entry.tokens);
    if (!label || tokens === null) continue;
    rows.push({ id, label, tokens });
  }
  return rows;
}

// agent/context_file_sources.py: one row per file Hermes considered, with a
// status of loaded / truncated / flagged / shadowed / blocked / empty /
// unreadable / suppressed and an `est_tokens` cost.
function normalizeContextFiles(entries) {
  if (!Array.isArray(entries)) return [];
  const rows = [];
  for (const entry of entries.slice(0, MAX_CONTEXT_FILES)) {
    if (!isPlainObject(entry)) continue;
    const label = toText(entry.label) || toText(entry.path);
    if (!label) continue;
    rows.push({
      label,
      status: toText(entry.status, 32),
      tokens: toTokens(entry.est_tokens ?? entry.tokens) ?? 0,
    });
  }
  return rows;
}

// The occupancy fields both readings share.
function occupancyFields(source) {
  const limitTokens = toPositiveTokens(source.context_max);
  const usedTokens = toTokens(source.context_used);
  return {
    usedTokens: limitTokens || (usedTokens !== null && usedTokens > 0) ? usedTokens : null,
    limitTokens,
    percent: limitTokens ? toPercent(source.context_percent) : null,
    source: toSource(source.context_source),
    estimated: typeof source.context_estimated === 'boolean' ? source.context_estimated : null,
  };
}

/**
 * Parse a `session.context_breakdown` result.
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
export function parseContextBreakdown(payload) {
  if (!isPlainObject(payload)) return { ok: false, reason: 'invalid-input' };
  const occupancy = occupancyFields(payload);
  const categories = normalizeCategories(payload.categories);
  // The agent-is-None branch with nothing frozen to measure is empty metadata, not data. With no resident agent
  // the gateway still measures the session's stored prompt, tools and transcript but knows no window
  // (context_max 0): categories without a capacity are data (the desktop app's isZeroedBreakdown says the same).
  if (!occupancy.limitTokens && !categories.length) return { ok: false, reason: 'zeroed' };
  return {
    ok: true,
    value: {
      ...occupancy,
      categories,
      estimatedTotal: toTokens(payload.estimated_total),
      contextFiles: normalizeContextFiles(payload.context_files),
      model: toText(payload.model),
    },
  };
}

/**
 * Parse a `session.usage` snapshot: the RPC result itself, or a payload that
 * nests it under `usage` (the pushed event and message.complete).
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
export function parseContextUsage(payload) {
  if (!isPlainObject(payload)) return { ok: false, reason: 'invalid-input' };
  const usage = isPlainObject(payload.usage) ? payload.usage : payload;
  const occupancy = occupancyFields({
    ...usage,
    context_used: usage.context_used ?? usage.context_tokens ?? usage.last_prompt_tokens,
    context_max: usage.context_max ?? usage.context_length,
  });
  const compressions = toTokens(usage.compressions ?? usage.compression_count);
  const promptTokens = toPositiveTokens(usage.prompt_tokens);
  const cacheReadTokens = toTokens(usage.cache_read_tokens);
  const cacheHitPercent = Object.hasOwn(usage, 'cache_hit_pct') ? toPercent(usage.cache_hit_pct)
    : promptTokens && cacheReadTokens !== null ? toPercent(Math.round(cacheReadTokens / promptTokens * 100)) : null;
  if (occupancy.limitTokens === null && occupancy.usedTokens === null && compressions === null && cacheHitPercent === null) {
    return { ok: false, reason: 'no-context-usage' };
  }
  return {
    ok: true,
    value: {
      ...occupancy,
      compressions,
      cacheHitPercent,
      calls: toTokens(usage.calls),
      inputTokens: toTokens(usage.input),
      outputTokens: toTokens(usage.output),
      model: toText(usage.model),
    },
  };
}

export function emptySessionContextStore() {
  return { version: SESSION_CONTEXT_STORE_VERSION, entries: {} };
}

function entriesOf(store) {
  return isPlainObject(store?.entries) ? store.entries : {};
}

export function sessionContextEntry(store, sessionId) {
  const id = normalizeSessionId(sessionId);
  const entries = entriesOf(store);
  return id && Object.hasOwn(entries, id) ? entries[id] : null;
}

function writeEntry(store, sessionId, patch, now) {
  const id = normalizeSessionId(sessionId);
  if (!id) return store;
  const entries = entriesOf(store);
  const previous = (Object.hasOwn(entries, id) && entries[id]) || { breakdown: null, usage: null, breakdownStale: false, updatedAt: 0 };
  return {
    version: SESSION_CONTEXT_STORE_VERSION,
    entries: { ...entries, [id]: { ...previous, ...patch, updatedAt: now } },
  };
}

/**
 * Record a `session.context_breakdown` result for a durable session id.
 * A refused payload leaves the store untouched.
 */
export function recordContextBreakdown(store, sessionId, payload, now = Date.now()) {
  const parsed = parseContextBreakdown(payload);
  if (!parsed.ok) return { store, recorded: false, reason: parsed.reason };
  return {
    store: writeEntry(store, sessionId, { breakdown: { ...parsed.value, at: now }, breakdownStale: false }, now),
    recorded: true,
    reason: '',
  };
}

/**
 * Record a `session.usage` snapshot. Fields the snapshot leaves out keep their
 * previous values (a usage tick never erases a known compression count), and a
 * new compression marks the category breakdown stale: the transcript it
 * measured is gone.
 */
export function recordContextUsage(store, sessionId, payload, now = Date.now()) {
  const parsed = parseContextUsage(payload);
  if (!parsed.ok) return { store, recorded: false, reason: parsed.reason };
  const previous = sessionContextEntry(store, sessionId);
  const prior = previous?.usage || null;
  const next = { ...parsed.value, at: now };
  for (const key of Object.keys(next)) {
    if (next[key] === null && prior && prior[key] !== null && prior[key] !== undefined) next[key] = prior[key];
  }
  if (parsed.value.usedTokens === null && parsed.value.limitTokens === null && prior) {
    // A compressions-only snapshot carries no occupancy; keep when that was read.
    next.occupancyAt = prior.occupancyAt || prior.at || 0;
  } else {
    next.occupancyAt = now;
  }
  const compacted = Number.isFinite(prior?.compressions) && Number.isFinite(next.compressions)
    && next.compressions > prior.compressions;
  return {
    store: writeEntry(store, sessionId, {
      usage: next,
      breakdownStale: Boolean(previous?.breakdownStale || (compacted && previous?.breakdown)),
    }, now),
    recorded: true,
    reason: '',
  };
}

/** Mark the breakdown stale (after a compaction the panel itself ran). */
export function markContextBreakdownStale(store, sessionId, now = Date.now()) {
  const previous = sessionContextEntry(store, sessionId);
  if (!previous?.breakdown) return store;
  return writeEntry(store, sessionId, { breakdownStale: true }, now);
}

/** Move an entry when a compaction rotates the session onto a new id. */
export function renameSessionContextEntry(store, fromId, toId) {
  const from = normalizeSessionId(fromId);
  const to = normalizeSessionId(toId);
  const entries = entriesOf(store);
  if (!from || !to || from === to || !Object.hasOwn(entries, from)) return store;
  const next = { ...entries, [to]: entries[from] };
  delete next[from];
  return { version: SESSION_CONTEXT_STORE_VERSION, entries: next };
}

/** Keep the most recently updated sessions. */
export function pruneSessionContextStore(store, max = SESSION_CONTEXT_MAX_SESSIONS) {
  const entries = Object.entries(entriesOf(store));
  if (entries.length <= max) return store;
  entries.sort((left, right) => (right[1]?.updatedAt || 0) - (left[1]?.updatedAt || 0));
  return { version: SESSION_CONTEXT_STORE_VERSION, entries: Object.fromEntries(entries.slice(0, Math.max(0, max))) };
}

function restoreReading(raw, keys) {
  if (!isPlainObject(raw)) return null;
  const reading = {};
  for (const key of keys) reading[key] = raw[key] ?? null;
  return reading;
}

function restoreBreakdown(raw) {
  const reading = restoreReading(raw, ['usedTokens', 'limitTokens', 'percent', 'source', 'estimated', 'estimatedTotal', 'model']);
  if (!reading) return null;
  const limitTokens = toPositiveTokens(reading.limitTokens);
  if (!limitTokens) return null;
  return {
    usedTokens: toTokens(reading.usedTokens),
    limitTokens,
    percent: toPercent(reading.percent),
    source: toSource(reading.source),
    estimated: typeof reading.estimated === 'boolean' ? reading.estimated : null,
    estimatedTotal: toTokens(reading.estimatedTotal),
    model: toText(reading.model),
    categories: normalizeCategories(raw.categories),
    contextFiles: normalizeContextFiles(raw.contextFiles),
    at: toTimestamp(raw.at),
  };
}

function restoreUsage(raw) {
  if (!isPlainObject(raw)) return null;
  const limitTokens = toPositiveTokens(raw.limitTokens);
  const usedTokens = toTokens(raw.usedTokens);
  return {
    usedTokens,
    limitTokens,
    percent: limitTokens ? toPercent(raw.percent) : null,
    source: toSource(raw.source),
    estimated: typeof raw.estimated === 'boolean' ? raw.estimated : null,
    compressions: toTokens(raw.compressions),
    cacheHitPercent: toPercent(raw.cacheHitPercent),
    calls: toTokens(raw.calls),
    inputTokens: toTokens(raw.inputTokens),
    outputTokens: toTokens(raw.outputTokens),
    model: toText(raw.model),
    at: toTimestamp(raw.at),
    occupancyAt: toTimestamp(raw.occupancyAt),
  };
}

/** Validate a store read back from storage; anything malformed is dropped. */
export function restoreSessionContextStore(raw) {
  if (!isPlainObject(raw) || raw.version !== SESSION_CONTEXT_STORE_VERSION) return emptySessionContextStore();
  const entries = {};
  for (const [id, entry] of Object.entries(entriesOf(raw))) {
    const sessionId = normalizeSessionId(id);
    if (!sessionId || !isPlainObject(entry)) continue;
    const breakdown = restoreBreakdown(entry.breakdown);
    const usage = restoreUsage(entry.usage);
    if (!breakdown && !usage) continue;
    entries[sessionId] = {
      breakdown,
      usage,
      breakdownStale: entry.breakdownStale === true,
      updatedAt: toTimestamp(entry.updatedAt),
    };
  }
  return pruneSessionContextStore({ version: SESSION_CONTEXT_STORE_VERSION, entries });
}
