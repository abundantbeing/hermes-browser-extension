// The turn queue a session-authority gateway owns (#106742, #141864). It lives on
// the gateway, survives a restart and is shared by every window attached to the
// session, so the panel only mirrors it: it reads the rows, shows them, and offers
// Discard for a turn lost in a restart. It never resends and never invents rows.
//
// Wire shapes (tui_gateway/contracts/canonical.py, canonical_sessions.py):
//   pending row   {admission_id, ref: {profile_id, session_id}, sequence,
//                  status: queued | started | unknown | terminal, outcome,
//                  authority_epoch, execution_generation, input_id, text,
//                  controls?, steering?}
//   read from     the `pending` list of a session.resume result, and of every
//                 `session.info` event (published on admission, claim,
//                 cancellation and settlement)
//   Discard       prompt.resolve_unknown {session_id, admission_id,
//                 execution_generation}; the generation is the one stamped on
//                 the unknown row, a stale one is refused with stale_generation.
//   `unknown`     a turn that was `started` when its owner died. It is never
//                 replayed and it holds back every queued turn behind it.

export const GATEWAY_QUEUE_METHODS = Object.freeze({
  resume: 'session.resume',
  resolveUnknown: 'prompt.resolve_unknown',
});

const MAX_ROWS = 50;
const MAX_TEXT = 600;

function cleanText(value, limit) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

/** The pending rows worth showing, oldest first; anything malformed is dropped. */
export function normalizePendingRows(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const normalized = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const admissionId = cleanText(row.admission_id, 200);
    const status = typeof row.status === 'string' ? row.status.trim().toLowerCase() : '';
    if (!admissionId || seen.has(admissionId)) continue;
    // A started admission is the turn running now, not queue; a queued one in transfer
    // to the running turn (steering) reads started but is still queued.
    const queued = status === 'queued' || (status === 'started' && row.steering === true);
    if (status !== 'unknown' && !queued) continue;
    seen.add(admissionId);
    const generation = typeof row.execution_generation === 'number' ? row.execution_generation : Number.NaN;
    normalized.push(Object.freeze({
      admissionId,
      sequence: Number.isFinite(Number(row.sequence)) ? Number(row.sequence) : 0,
      status: status === 'unknown' ? 'unknown' : 'queued',
      text: cleanText(row.text, MAX_TEXT),
      executionGeneration: Number.isInteger(generation) ? generation : null,
      sessionId: cleanText(row.ref?.session_id, 200),
    }));
  }
  return normalized.sort((a, b) => a.sequence - b.sequence).slice(0, MAX_ROWS);
}

/** {lost, queued}: turns lost in a restart, and turns waiting their turn. */
export function gatewayQueueView(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    lost: list.filter((row) => row.status === 'unknown'),
    queued: list.filter((row) => row.status === 'queued'),
  };
}

/** The RPC that discards one lost turn, or null when the row cannot be discarded. */
export function discardLostTurnRequest(row, sessionId = '') {
  if (!row || row.status !== 'unknown' || !Number.isInteger(row.executionGeneration)) return null;
  const target = String(row.sessionId || sessionId || '').trim();
  if (!target) return null;
  return {
    method: GATEWAY_QUEUE_METHODS.resolveUnknown,
    params: {
      session_id: target,
      admission_id: row.admissionId,
      execution_generation: row.executionGeneration,
    },
  };
}

/** Refusals that mean the row is already settled elsewhere: drop it quietly. */
export function isLostTurnAlreadyResolved(error) {
  const reason = String(error?.data?.reason ?? error?.reason ?? '').trim().toLowerCase();
  return ['stale_generation', 'not_found', 'admission_conflict'].includes(reason);
}

/**
 * Rows per stored session id, fed by resume snapshots and session.info events.
 * `onChange(sessionId)` fires after any change.
 */
export function createGatewayQueueStore({ onChange = null } = {}) {
  const rowsBySession = new Map();

  function set(sessionId, rows) {
    const id = String(sessionId || '').trim();
    if (!id) return false;
    const next = normalizePendingRows(rows);
    const previous = rowsBySession.get(id) || [];
    if (JSON.stringify(previous) === JSON.stringify(next)) return false;
    if (next.length) rowsBySession.set(id, next);
    else rowsBySession.delete(id);
    onChange?.(id);
    return true;
  }

  return {
    /** A session.resume result: its `pending` list replaces what was held. */
    ingestResume(result) {
      if (!result || typeof result !== 'object' || !Array.isArray(result.pending)) return false;
      return set(result.stored_session_id || result.session_id, result.pending);
    },
    /** A session.info event: its `pending` list, when it carries one, replaces what was held. */
    ingestEvent(event) {
      const payload = event?.payload;
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.pending)) return false;
      return set(payload.stored_session_id || event.sessionId, payload.pending);
    },
    /** A row the gateway confirmed settled (a discard it accepted). */
    drop(sessionId, admissionId) {
      const id = String(sessionId || '').trim();
      const rows = rowsBySession.get(id);
      if (!rows) return false;
      return set(id, rows.filter((row) => row.admissionId !== admissionId).map((row) => ({
        admission_id: row.admissionId,
        sequence: row.sequence,
        status: row.status === 'unknown' ? 'unknown' : 'queued',
        text: row.text,
        execution_generation: row.executionGeneration,
        ref: { session_id: row.sessionId },
      })));
    },
    forSession(sessionId) {
      return rowsBySession.get(String(sessionId || '').trim()) || [];
    },
    /** A connection ended: what it reported can no longer be trusted. */
    clear() {
      const ids = [...rowsBySession.keys()];
      rowsBySession.clear();
      for (const id of ids) onChange?.(id);
    },
  };
}

/**
 * Wrap `client.request` so a session.resume result feeds the store. Every resume the
 * panel makes (send, attach, switch) goes through the client, so none needs to know.
 */
export function observeSessionResume(client, onResult) {
  if (!client || typeof client.request !== 'function' || client.__gatewayQueueObserved) return client;
  const request = client.request.bind(client);
  client.request = async (method, params, options) => {
    const result = await request(method, params, options);
    if (method === GATEWAY_QUEUE_METHODS.resume) {
      try {
        onResult(result);
      } catch {
        // Mirroring is a convenience; the resume itself already succeeded.
      }
    }
    return result;
  };
  client.__gatewayQueueObserved = true;
  return client;
}
