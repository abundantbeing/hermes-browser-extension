// Pure decisions for following a Hermes session that is already running when
// the user opens it. The side panel owns the DOM and gateway subscriptions;
// this module only answers "is it live?" and "may we attach now?".
//
// Attach is read-only: it paints the gateway's live deltas and tool events
// for that one session. It never starts or interrupts a run.

import { liveStateFromSessionRow, mergeLiveSignals } from './session-live-state.mjs';
import { subagentsFromListResult } from './subagent-stack.mjs';
import { browserDisplayMessages } from './web-run-state.mjs';
import { sanitizeToolPreview } from './common.mjs';
import { WS_METHODS, isUnknownMethodError, readGatewaySessionStatus } from './gateway-ws.mjs';

// Only decorate sessions from the current profile's historical list. The
// process-wide active_list RPC is not itself a profile-scoped session browser.
export function sessionLiveRoster(payload, allowedIds = [], { subagentRosters = null } = {}) {
  const allowed = new Set(allowedIds.map(String));
  const result = new Map();
  for (const row of Array.isArray(payload?.sessions) ? payload.sessions : []) {
    const id = String(row.session_key || '');
    if (!id || !allowed.has(id)) continue;
    // A turn that ended while its subagents still run is a live session: the roster of its
    // children (subagent.list) keeps it lit, as it already does for the session being viewed.
    const children = subagentRosters instanceof Map ? subagentRosters.get(id) : null;
    const own = liveStateFromSessionRow(row);
    const state = children ? mergeLiveSignals({ row, roster: children }) : own;
    // childrenOnly: live only because its children run. The drawer lights it, but there is no turn of
    // its own to wait on, follow or Stop.
    result.set(id, { ...state, childrenOnly: state.live && !own.live, liveId: String(row.id || ''), status: row.status });
  }
  return result;
}

// Sources the gateway never lists in a session picker (hermes_state_sessions INTERNAL_LISTING_SOURCES).
const INTERNAL_LISTING_SOURCES = new Set(['kanban', 'tool', 'oneshot']);

/**
 * Live sessions the gateway reports that the panel's loaded list does not contain: a run started in
 * the CLI, Desktop or another window, beyond the page of history the panel fetched. Rows are shaped
 * like session-list rows (normalizeHermesSessions input) with the durable id as `id`.
 *
 * Only a connection scoped to the profile may discover: a session authority scopes active_list to
 * the actor on the server. The legacy sidecar's active_list lists every profile's live sessions for
 * a launch ticket and its rows name no profile, so there `scoped` is false and nothing is returned;
 * those sessions are still only ever shown when they are already in the profile's own list.
 */
export function discoverLiveSessions(payload, { knownIds = [], scoped = false } = {}) {
  if (scoped !== true) return [];
  const known = new Set(Array.from(knownIds || []).map(String));
  const found = [];
  for (const row of Array.isArray(payload?.sessions) ? payload.sessions : []) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.session_key || '').trim();
    if (!id || known.has(id) || INTERNAL_LISTING_SOURCES.has(String(row.source || '').toLowerCase())) continue;
    if (!liveStateFromSessionRow(row).live) continue;
    found.push({
      id,
      title: String(row.title || ''),
      source: String(row.source || ''),
      preview: String(row.preview || ''),
      model: String(row.model || ''),
      message_count: Number(row.message_count || 0),
      last_active: Number(row.last_active || row.started_at || 0),
    });
    known.add(id);
  }
  return found;
}

const SUBAGENT_READ_LIMIT = 6;
const SUBAGENT_READ_MAX_AGE_MS = 8_000;
const SUBAGENT_REFUSED_MAX_AGE_MS = 60_000;

/**
 * For every roster row that reads idle, ask the gateway for the children still running under its
 * live id. Bounded (a few reads per poll, oldest answer first), cached per live id so a 2 s poll
 * does not become a 2 s fan-out, and tolerant: a session this connection does not own answers an
 * error, which is cached like an empty roster and never reaches the caller.
 * Returns Map(durable id -> subagent rows) for the rows that have any.
 */
export async function readIdleRowSubagents(client, rows, {
  cache = new Map(),
  now = () => Date.now(),
  limit = SUBAGENT_READ_LIMIT,
  maxAgeMs = SUBAGENT_READ_MAX_AGE_MS,
} = {}) {
  const found = new Map();
  if (!client?.request || !(rows instanceof Map)) return found;
  const idle = [...rows].filter(([, row]) => row && row.live !== true && row.liveId);
  const stamp = now();
  // A refusal (a session this connection does not own) will not change on the
  // next poll, so it is asked again after a minute instead of every few seconds.
  const fresh = (entry) => (entry?.at ?? -Infinity) > stamp - (entry?.refused ? SUBAGENT_REFUSED_MAX_AGE_MS : maxAgeMs);
  const stale = idle
    .filter(([, row]) => !fresh(cache.get(row.liveId)))
    .sort((a, b) => (cache.get(a[1].liveId)?.at ?? 0) - (cache.get(b[1].liveId)?.at ?? 0))
    .slice(0, Math.max(0, limit));
  await Promise.all(stale.map(async ([, row]) => {
    let items = [];
    let refused = false;
    try {
      items = subagentsFromListResult(await client.request(WS_METHODS.subagentList, { session_id: row.liveId }));
    } catch {
      items = [];
      refused = true;
    }
    cache.set(row.liveId, { at: stamp, items, refused });
  }));
  const known = new Set([...rows.values()].map((row) => row?.liveId).filter(Boolean));
  for (const liveId of cache.keys()) if (!known.has(liveId)) cache.delete(liveId);
  for (const [key, row] of idle) {
    const items = cache.get(row.liveId)?.items;
    if (Array.isArray(items) && items.length) found.set(key, items);
  }
  return found;
}

// One failed poll is not evidence that every Running badge is wrong; the last good roster stays for
// it. A second failure in a row, or a gateway that has no active_list at all, clears it.
export function rosterAfterFailure({ rows, failures = 0, error = null } = {}) {
  const unsupported = Number(error?.rpcCode ?? error?.code) === -32601;
  if (unsupported || failures >= 2 || !(rows instanceof Map)) return new Map();
  return rows;
}

export function sessionIsLiveFromStatus(statusPayload = null) {
  if (!statusPayload || typeof statusPayload !== 'object') return false;
  const state = liveStateFromSessionRow(statusPayload)?.state;
  if (state !== 'unknown') return state === 'running';
  // session.status is a human-readable RPC on released gateways.
  return /^Agent Running:\s*Yes\s*$/mi.test(String(statusPayload.output || ''));
}

/**
 * Read a running session's state for an attached view. A released gateway answers
 * `session.activate` with the inflight text and display history. A session authority
 * does not serve it (-32601) or `session.status`: there the run state comes from the
 * authority reader (its `session.active_list` row, or the resume snapshot) and the
 * transcript from `session.history`. Pass `activateUnsupported` once a client has
 * answered -32601, so the later polls skip the call; `includeMessages: false` skips
 * the transcript read on those polls, since only the run state changes.
 * Never submits, steers or interrupts anything.
 */
export async function readLiveAttachSnapshot({
  client,
  liveId,
  storedId = '',
  profile = '',
  activateUnsupported = false,
  includeMessages = true,
} = {}) {
  if (!activateUnsupported) {
    try {
      return { snapshot: await client.request('session.activate', { session_id: liveId }), activateUnsupported: false };
    } catch (error) {
      if (!isUnknownMethodError(error)) throw error;
    }
  }
  const status = await readGatewaySessionStatus(client, liveId, { storedSessionId: storedId });
  const running = sessionIsLiveFromStatus(status);
  const history = includeMessages || !running
    ? await client.request(WS_METHODS.sessionHistory, { session_id: liveId, ...(profile ? { profile } : {}) })
    : {};
  return { snapshot: { ...history, running }, activateUnsupported: true };
}

/**
 * The live run to Stop for the viewed session when this panel is neither running it
 * nor attached to it yet: the roster says it is live on the connection the roster was
 * read from. Null when there is nothing the roster can prove.
 */
export function rosterStopTarget({ rows, sessionId = '', client = null, scopeMatches = false } = {}) {
  const id = String(sessionId || '').trim();
  const row = id && rows instanceof Map ? rows.get(id) : null;
  if (!scopeMatches || !row || row.live !== true || row.childrenOnly === true || client?.readyState !== 1) return null;
  const liveId = String(row.liveId || '').trim();
  return liveId ? { client, liveId, sessionId: id } : null;
}

export function shouldAttachLiveSession({
  dashboardTransport = false,
  connectionReady = false,
  sending = false,
  sessionId = '',
  currentSessionId = '',
  alreadyAttachedTo = '',
} = {}) {
  const target = String(sessionId || '').trim();
  if (!dashboardTransport || !connectionReady) return false;
  if (!target) return false;
  // This panel's own turn already paints the bubble; never double-attach.
  if (sending) return false;
  if (String(currentSessionId || '').trim() !== target) return false;
  if (String(alreadyAttachedTo || '').trim() === target) return false;
  return true;
}

// Display receipts, never raw tool output. Support both the REST conversation
// and the gateway's display projection without changing model-facing history.
export function sessionToolDisplayMessages(rows = []) {
  if (!Array.isArray(rows)) return [];
  const output = [];
  const calls = new Map();
  const completed = new Set(rows.filter(row => row?.role === 'tool' && row.display_kind !== 'hidden')
    .map(row => String(row.tool_call_id || '')));
  const receipt = (name, args, preview, done, id = '') => {
    const hint = args?.command || args?.path || args?.query || args?.url || preview || '';
    return {
      role: 'assistant', content: '',
      toolActivity: { tool_name: name || 'Hermes tool', tool_call_id: id,
        type: done ? 'tool.complete' : 'tool.start', status: done ? 'completed' : 'progress',
        preview: sanitizeToolPreview(hint) },
    };
  };
  for (const row of rows) {
    if (!row || row.display_kind === 'hidden') continue;
    if (browserDisplayMessages([row]).length) output.push(row);
    for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
      const fn = call.function || call;
      let args = fn.arguments || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      const id = String(call.id || call.call_id || '');
      calls.set(id, { name: fn.name, args });
      if (!id || !completed.has(id)) output.push(receipt(fn.name, args, '', false, id));
    }
    if (row.role === 'tool') {
      const id = String(row.tool_call_id || '');
      const call = calls.get(id);
      output.push(receipt(call?.name || row.tool_name || row.name, call?.args || row.args, row.context || '', true, id));
    }
  }
  return output;
}
