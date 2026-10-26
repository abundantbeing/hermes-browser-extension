// The side panel's one capability ledger, kept in step with the connection.
//
// The panel calls sync() with what it can see right now (the capability object,
// the dashboard's gateway.ready payload, which socket, whether it is open, and
// the endpoint + principal + profile + controller identity) every time any of
// that may have changed. sync() is cheap and idempotent:
//   * a different identity empties the ledger (and the remembered -32601s);
//   * a different socket forgets what was observed on the old one;
//   * a new capability object (or a newly observed -32601) is re-derived, but a
//     record keeps the time its capability object was read, so re-deriving never
//     makes an old answer look fresh;
//   * whether the connection is open is applied at read time, so a closed socket
//     turns every positive into `cached` without anyone having to remember to.
//
// Views read rows() and verdict(); nothing else holds a capability flag.

import {
  CAPABILITY_SOURCES,
  CAPABILITY_STATES,
  capabilityIdentity,
  createCapabilityLedger,
  createCapabilityRecord,
} from './capability-status.mjs';
import {
  capabilityStatusRows,
  deriveCapabilityRecords,
} from './capabilities.mjs';

export const COMPACT_CAPABILITY = 'sessionCompress';

// A refusal that belongs to one session (compression_checkpoint_required,
// invalid_params, permission_denied ...) is kept per session id, never as a
// connection-wide record: the next session on the same socket may compact fine.
const SESSION_REFUSAL_LIMIT = 32;

export function createCapabilityRuntime({ now = Date.now } = {}) {
  const ledger = createCapabilityLedger({ now });
  const unsupportedMethods = new Set();
  // feature + NUL + session id -> blocked record, oldest first. Forgotten with
  // whatever the old socket or identity taught us.
  const sessionRefusals = new Map();
  let lastCaps = null;
  let lastReady = null;
  let lastToken = '';
  let lastWsActive = false;
  let lastSideSocket = false;
  let lastUnsupportedSize = -1;
  let lastCheckedAt = 0;

  function refusalKey(id, sessionId) {
    return `${String(id)}\u0000${String(sessionId)}`;
  }

  function sessionRefusal(id, sessionId) {
    const session = String(sessionId || '').trim();
    return session ? sessionRefusals.get(refusalKey(id, session)) || null : null;
  }

  function derive(caps, readyPayload, dashboardWsActive, sideSocket) {
    ledger.ingest(deriveCapabilityRecords(caps, {
      identityKey: ledger.identityKey,
      readyPayload,
      dashboardWsActive,
      sideSocket,
      checkedAt: lastCheckedAt,
      unsupportedMethods,
    }));
    lastCaps = caps;
    lastReady = readyPayload;
    lastWsActive = dashboardWsActive;
    lastSideSocket = sideSocket;
    lastUnsupportedSize = unsupportedMethods.size;
  }

  return {
    ledger,
    /** Methods this connection answered -32601 for. Pass it to the helpers that probe by calling. */
    unsupportedMethods,

    /** @returns {boolean} whether the ledger changed in a way a view should redraw for */
    sync({ caps = null, readyPayload = null, identity = null, connectionToken = '', connected = true, dashboardWsActive = false, sideSocket = false } = {}) {
      let changed = false;
      const nextIdentity = identity && typeof identity === 'object' && 'key' in identity ? identity : capabilityIdentity(identity || {});
      if (ledger.rebind(nextIdentity)) {
        unsupportedMethods.clear();
        sessionRefusals.clear();
        lastCaps = null;
        changed = true;
      }
      if (ledger.connect(connectionToken)) {
        unsupportedMethods.clear();
        sessionRefusals.clear();
        lastCaps = null;
        changed = true;
      }
      // A socket drops its gateway.ready payload when it closes. Keep the one it
      // had, so the records turn `cached` instead of forgetting what they knew;
      // a different socket starts from nothing.
      const ready = readyPayload ?? (connectionToken === lastToken ? lastReady : null);
      lastToken = connectionToken;
      if (ledger.connected !== (connected !== false)) {
        ledger.setConnected(connected);
        changed = true;
      }
      const side = sideSocket === true;
      if (caps && (caps !== lastCaps || ready !== lastReady || dashboardWsActive !== lastWsActive || side !== lastSideSocket || unsupportedMethods.size !== lastUnsupportedSize)) {
        if (caps !== lastCaps) lastCheckedAt = now();
        derive(caps, ready, dashboardWsActive, side);
        changed = true;
      }
      return changed;
    },

    rows(caps, options = {}) {
      return capabilityStatusRows(caps, { ...options, records: ledger.all(), now: now() });
    },

    /** The record for a feature; with `sessionId`, what was learned about that session too. */
    record(id, { sessionId = '' } = {}) {
      const base = ledger.get(id);
      const refusal = sessionRefusal(id, sessionId);
      if (!refusal || !base) return base;
      // A connection that is not available says so first; a session's refusal
      // only narrows a connection that would otherwise run.
      if (base.state !== CAPABILITY_STATES.available) return base;
      return refusal;
    },

    /** May this feature run a mutation right now (for this session)? True only for a current, available record. */
    verdict(id, { sessionId = '' } = {}) {
      const base = ledger.canExecute(id);
      if (!base.allowed) return base;
      const refusal = sessionRefusal(id, sessionId);
      if (!refusal) return base;
      return {
        allowed: false,
        state: refusal.state,
        reasonCode: refusal.reasonCode,
        reason: refusal.reason,
        params: refusal.params,
      };
    },

    /**
     * The compact control's verdict, and what an operation's result taught us.
     * With `sessionId`, a refusal is remembered for that session only; a success
     * lifts that session's refusal and still counts as a fact about the connection.
     */
    noteOperation(id, outcome, { sessionId = '' } = {}) {
      // The route (which verb the panel uses) is a property of the connection,
      // not of the last result, so it rides along.
      const route = ledger.get(id)?.params?.route;
      const session = String(sessionId || '').trim();
      if (session && outcome?.ok !== true) {
        const record = createCapabilityRecord({
          id,
          state: CAPABILITY_STATES.blocked,
          source: CAPABILITY_SOURCES.operation,
          checkedAt: now(),
          identityKey: ledger.identityKey,
          reasonCode: 'operation-refused',
          params: { ...(route ? { route } : {}), detail: String(outcome?.detail ?? '').trim(), sessionId: session },
        });
        const key = refusalKey(id, session);
        sessionRefusals.delete(key);
        sessionRefusals.set(key, record);
        while (sessionRefusals.size > SESSION_REFUSAL_LIMIT) sessionRefusals.delete(sessionRefusals.keys().next().value);
        return record;
      }
      if (session) sessionRefusals.delete(refusalKey(id, session));
      return ledger.observeOperation(id, outcome, route ? { params: { route } } : {});
    },

    revoke(id, detail) {
      return ledger.revoke(id, detail);
    },
  };
}
