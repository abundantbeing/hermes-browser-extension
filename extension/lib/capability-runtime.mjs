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
  capabilityIdentity,
  createCapabilityLedger,
} from './capability-status.mjs';
import {
  capabilityStatusRows,
  deriveCapabilityRecords,
} from './capabilities.mjs';

export const COMPACT_CAPABILITY = 'sessionCompress';

export function createCapabilityRuntime({ now = Date.now } = {}) {
  const ledger = createCapabilityLedger({ now });
  const unsupportedMethods = new Set();
  let lastCaps = null;
  let lastReady = null;
  let lastUnsupportedSize = -1;
  let lastCheckedAt = 0;

  function derive(caps, readyPayload) {
    ledger.ingest(deriveCapabilityRecords(caps, {
      identityKey: ledger.identityKey,
      readyPayload,
      checkedAt: lastCheckedAt,
      unsupportedMethods,
    }));
    lastCaps = caps;
    lastReady = readyPayload;
    lastUnsupportedSize = unsupportedMethods.size;
  }

  return {
    ledger,
    /** Methods this connection answered -32601 for. Pass it to the helpers that probe by calling. */
    unsupportedMethods,

    /** @returns {boolean} whether the ledger changed in a way a view should redraw for */
    sync({ caps = null, readyPayload = null, identity = null, connectionToken = '', connected = true } = {}) {
      let changed = false;
      const nextIdentity = identity && typeof identity === 'object' && 'key' in identity ? identity : capabilityIdentity(identity || {});
      if (ledger.rebind(nextIdentity)) {
        unsupportedMethods.clear();
        lastCaps = null;
        changed = true;
      }
      if (ledger.connect(connectionToken)) {
        unsupportedMethods.clear();
        lastCaps = null;
        changed = true;
      }
      if (ledger.connected !== (connected !== false)) {
        ledger.setConnected(connected);
        changed = true;
      }
      if (caps && (caps !== lastCaps || readyPayload !== lastReady || unsupportedMethods.size !== lastUnsupportedSize)) {
        if (caps !== lastCaps) lastCheckedAt = now();
        derive(caps, readyPayload);
        changed = true;
      }
      return changed;
    },

    rows(caps, options = {}) {
      return capabilityStatusRows(caps, { ...options, records: ledger.all(), now: now() });
    },

    record(id) {
      return ledger.get(id);
    },

    /** May this feature run a mutation right now? True only for a current, available record. */
    verdict(id) {
      return ledger.canExecute(id);
    },

    /** The compact control's verdict, and what an operation's result taught us. */
    noteOperation(id, outcome) {
      return ledger.observeOperation(id, outcome);
    },

    revoke(id, detail) {
      return ledger.revoke(id, detail);
    },
  };
}
