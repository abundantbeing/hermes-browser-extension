// Evidence-backed capability records.
//
// capabilities.mjs keeps a flat set of booleans; a boolean cannot say who said
// it, when, for which connection, or why it is off. A record can:
//
//   { id, state, source, checkedAt, identityKey, reason, reasonCode, params }
//
//   state    available    seen on this connection, recently enough to rely on;
//            cached       seen before and still shown, but NOT current: the
//                         connection closed or the answer is old. Visible, never
//                         permission to run something;
//            degraded     works with a caveat, or assumed without proof;
//            blocked      the gateway or the user said no (a refusal, a revoke);
//            unsupported  the gateway answered that it does not offer it;
//            unknown      nobody has said either way (never advertised).
//   source   who said it (CAPABILITY_SOURCES): an official advertisement first
//            (gateway.ready, /v1/capabilities), then an observed refusal such
//            as -32601 or a finished operation. A probe is for documented gaps
//            only and must be bounded and non-mutating. `extension` marks a
//            statement about this extension, not a fact the gateway confirmed.
//   identityKey  endpoint + principal + profile (+ controller), the same
//            identity projects-client.mjs scopes its caches by. A record never
//            outlives a change of any part of it.
//
// The rule the whole module exists for: a stale or cached positive record is
// shown to the user and is never permission to execute a mutation. Use
// canExecute() before sending anything that changes state.
//
// Pure module: no DOM, no storage, no socket.

import { projectsIdentity } from './projects-client.mjs';

export const CAPABILITY_STATES = Object.freeze({
  available: 'available',
  cached: 'cached',
  degraded: 'degraded',
  blocked: 'blocked',
  unsupported: 'unsupported',
  unknown: 'unknown',
});

export const CAPABILITY_SOURCES = Object.freeze({
  ready: 'gateway.ready',
  capabilities: '/v1/capabilities',
  methodNotFound: 'method-not-found',
  operation: 'operation-result',
  probe: 'probe',
  extension: 'extension',
  derived: 'derived',
  revocation: 'revocation',
  none: 'none',
});

const STATE_SET = new Set(Object.values(CAPABILITY_STATES));
const SOURCE_SET = new Set(Object.values(CAPABILITY_SOURCES));

// How long a positive answer may be used to run something. A socket's own
// gateway.ready is true for as long as that socket is open (the ledger demotes
// it the moment the socket closes), so it has no age limit. Everything fetched
// separately ages out.
export const CAPABILITY_MAX_AGE_MS = Object.freeze({
  [CAPABILITY_SOURCES.ready]: Infinity,
  [CAPABILITY_SOURCES.capabilities]: 5 * 60_000,
  [CAPABILITY_SOURCES.operation]: 5 * 60_000,
  [CAPABILITY_SOURCES.probe]: 60_000,
  [CAPABILITY_SOURCES.derived]: 5 * 60_000,
  [CAPABILITY_SOURCES.extension]: Infinity,
  [CAPABILITY_SOURCES.methodNotFound]: Infinity,
  [CAPABILITY_SOURCES.revocation]: Infinity,
  [CAPABILITY_SOURCES.none]: Infinity,
});

function clean(value = '') {
  return String(value ?? '').trim();
}

// English wording for every reason code. The side panel shows the locale's
// `capability.reason.<code>` instead; these are the fallback and what support
// diagnostics print (diagnostics stay English so a report reads the same for
// everyone).
export const CAPABILITY_REASONS = Object.freeze({
  advertised: () => 'Advertised by this gateway.',
  'advertised-off': () => 'This gateway advertises it as off.',
  'not-advertised': () => 'Not advertised by this gateway.',
  'not-advertised-plugin': () => 'Not advertised by this gateway. Hermes Browser cannot tell whether the companion plugin is loaded, so this does not mean it is missing.',
  'ws-connected': () => 'The Hermes dashboard WebSocket is connected.',
  'ws-not-reported': () => 'The dashboard WebSocket does not report this, and this connection does not read /v1/capabilities.',
  'authority-ready': () => 'gateway.ready reports session authority.',
  'no-session-authority': () => 'gateway.ready did not report session authority.',
  'rest-only': () => 'This connection only reaches the REST API. The dashboard WebSocket is needed.',
  'not-connected': () => 'The dashboard WebSocket has not delivered gateway.ready yet.',
  'method-not-found': ({ method } = {}) => `The gateway answered "method not found" (-32601) for ${clean(method) || 'this method'}.`,
  'legacy-ws-compress': () => 'This dashboard gateway has no session authority, so the legacy session.compress serves compaction.',
  'authority-compress': () => 'Compaction runs as session.mutate operation compress, which a session-authority gateway serves.',
  'legacy-compress-suppressed': () => 'A session-authority gateway does not route the legacy session.compress.',
  'rest-no-compress': () => 'This connection only reaches the REST API, which does not advertise a compact route. Compaction needs the dashboard WebSocket with session authority.',
  'connection-closed': ({ ageMs } = {}) => `The connection closed. Last confirmed ${formatAge(ageMs)} ago. Shown, not used to run anything.`,
  stale: ({ ageMs } = {}) => `Last confirmed ${formatAge(ageMs)} ago. An old answer is shown, not used to run anything.`,
  revoked: ({ detail } = {}) => `Turned off: ${clean(detail) || 'revoked'}.`,
  'legacy-gateway': () => 'This gateway has no /v1/capabilities, so the extension cannot see what it offers.',
  'legacy-assumed': () => 'Assumed because /health answered with a token. /v1/capabilities was unavailable, so this is not confirmed.',
  'extension-side': () => 'Provided by this extension. This gateway has not confirmed that it accepts it.',
  'operation-ok': () => 'Worked the last time it was used.',
  'operation-refused': ({ detail } = {}) => `Hermes refused the last attempt: ${clean(detail) || 'no reason given'}.`,
  'identity-changed': () => 'The connection, account or profile changed. Not checked again yet.',
  'no-record': () => 'Not checked yet.',
});

export function formatAge(ageMs) {
  const ms = Number(ageMs);
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

export function capabilityReasonText(code, params = {}) {
  const make = CAPABILITY_REASONS[clean(code)];
  return make ? make(params || {}) : '';
}

// ---- Identity ------------------------------------------------------------

/**
 * The connection a record belongs to: endpoint + signed-in principal + profile
 * (the projectsIdentity triple) plus the browser-control controller. Returns
 * null when there is no usable endpoint, and a record without an identity key
 * can never be executed on.
 */
export function capabilityIdentity({ endpoint = '', principal = '', profile = '', controller = '' } = {}) {
  const base = projectsIdentity({ endpoint, principal, profile });
  if (!base) return null;
  const controllerId = clean(controller);
  return {
    endpoint: base.endpoint,
    principal: base.principal,
    profile: base.profile,
    controller: controllerId,
    key: JSON.stringify([2, base.key, controllerId]),
  };
}

// ---- Records -------------------------------------------------------------

/**
 * Build one record. `reason` defaults to the English text for `reasonCode`.
 * Throws a TypeError for an unknown state or source so a typo cannot quietly
 * become an "available" claim.
 */
export function createCapabilityRecord({
  id = '',
  state = CAPABILITY_STATES.unknown,
  source = CAPABILITY_SOURCES.none,
  checkedAt = null,
  identityKey = '',
  reasonCode = '',
  params = {},
  reason = '',
} = {}) {
  const featureId = clean(id);
  if (!featureId) throw new TypeError('A capability record needs an id.');
  if (!STATE_SET.has(state)) throw new TypeError(`Unknown capability state: ${state}`);
  if (!SOURCE_SET.has(source)) throw new TypeError(`Unknown capability source: ${source}`);
  const stamp = Number(checkedAt);
  const code = clean(reasonCode);
  const details = params && typeof params === 'object' ? { ...params } : {};
  return Object.freeze({
    id: featureId,
    state,
    source,
    checkedAt: checkedAt === null || checkedAt === undefined || !Number.isFinite(stamp) ? null : stamp,
    identityKey: clean(identityKey),
    reasonCode: code,
    params: Object.freeze(details),
    reason: clean(reason) || capabilityReasonText(code, details),
  });
}

function ageOf(record, now) {
  if (!record || record.checkedAt === null) return null;
  return Math.max(0, Number(now) - record.checkedAt);
}

/**
 * The record as it must be treated at `now`. A positive record that is older
 * than its source allows, or whose connection is gone, is `cached`: still
 * displayed (with its age) but never permission. Everything else passes through.
 */
export function effectiveCapability(record, { now = Date.now(), maxAgeMs, connected = true } = {}) {
  if (!record) return null;
  if (record.state !== CAPABILITY_STATES.available) return record;
  const ageMs = ageOf(record, now);
  const limit = Number.isFinite(maxAgeMs) || maxAgeMs === Infinity
    ? maxAgeMs
    : (CAPABILITY_MAX_AGE_MS[record.source] ?? CAPABILITY_MAX_AGE_MS[CAPABILITY_SOURCES.capabilities]);
  const selfContained = record.source === CAPABILITY_SOURCES.extension;
  if (!connected && !selfContained) {
    const params = { ...record.params, ageMs };
    return createCapabilityRecord({ ...record, state: CAPABILITY_STATES.cached, reasonCode: 'connection-closed', params, reason: '' });
  }
  if (ageMs !== null && ageMs > limit) {
    const params = { ...record.params, ageMs };
    return createCapabilityRecord({ ...record, state: CAPABILITY_STATES.cached, reasonCode: 'stale', params, reason: '' });
  }
  return record;
}

/**
 * May this record authorize a mutation right now? Only a current `available`
 * record for the identity the caller is acting under. A cached, stale, degraded,
 * blocked, unsupported or unknown record answers no, with the reason to show.
 */
export function canExecute(record, { now = Date.now(), maxAgeMs, identityKey = '', connected = true } = {}) {
  if (!record) return { allowed: false, state: CAPABILITY_STATES.unknown, reasonCode: 'no-record', reason: capabilityReasonText('no-record') };
  const wanted = clean(identityKey);
  if (wanted && record.identityKey !== wanted) {
    return { allowed: false, state: CAPABILITY_STATES.unknown, reasonCode: 'identity-changed', reason: capabilityReasonText('identity-changed') };
  }
  if (!record.identityKey && record.source !== CAPABILITY_SOURCES.extension) {
    return { allowed: false, state: record.state, reasonCode: 'identity-changed', reason: capabilityReasonText('identity-changed') };
  }
  const current = effectiveCapability(record, { now, maxAgeMs, connected });
  return {
    allowed: current.state === CAPABILITY_STATES.available,
    state: current.state,
    reasonCode: current.reasonCode,
    reason: current.reason,
    params: current.params,
  };
}

// ---- Ledger ----------------------------------------------------------------

/**
 * One source of truth for what the UI may claim about the current connection.
 * Views read records from here; none keeps a flag of its own.
 *
 *   rebind(identity)      a different endpoint, account, profile or controller
 *                         drops every record, observation and revocation;
 *   ingest(records)       the records derived from the latest advertisement. A
 *                         record for another identity is rejected (an answer that
 *                         arrives after the identity moved says nothing here);
 *   connect(token)        a new connection (a new socket, a reconnect): what was
 *                         observed on the old one (a -32601, an operation result)
 *                         is forgotten, because a restarted gateway may differ;
 *   setConnected(flag)    false demotes positive records to `cached`;
 *   observeMethodNotFound / observeOperation / revoke   evidence that overrides
 *                         the advertisement. A revocation outlives reconnects
 *                         until the identity changes or clearRevocation().
 */
export function createCapabilityLedger({ now = Date.now } = {}) {
  let identity = null;
  let connected = true;
  let connectionToken = '';
  const advertised = new Map();
  const observed = new Map();
  const revoked = new Map();

  function stamp(options = {}) {
    return Number.isFinite(options.checkedAt) ? options.checkedAt : now();
  }

  function resolve(id) {
    const key = clean(id);
    return revoked.get(key) || observed.get(key) || advertised.get(key) || null;
  }

  const ledger = {
    get identity() { return identity; },
    get identityKey() { return identity?.key || ''; },
    get connected() { return connected; },

    rebind(next = null) {
      const nextKey = next?.key || '';
      if (nextKey === (identity?.key || '')) return false;
      identity = next || null;
      advertised.clear();
      observed.clear();
      revoked.clear();
      return true;
    },

    connect(token = '') {
      const next = clean(token);
      if (next === connectionToken) return false;
      connectionToken = next;
      observed.clear();
      return true;
    },

    setConnected(flag) {
      connected = flag !== false;
    },

    ingest(records = []) {
      let accepted = 0;
      let rejected = 0;
      const incoming = new Map();
      for (const record of Array.isArray(records) ? records : []) {
        if (!record || !record.id || (identity && record.identityKey !== identity.key) || (!identity && record.identityKey)) {
          rejected += 1;
          continue;
        }
        incoming.set(record.id, record);
        accepted += 1;
      }
      // A fresh advertisement replaces the previous one as a whole: a feature it
      // no longer lists must not linger as available from the last snapshot.
      if (accepted || !records.length) {
        advertised.clear();
        for (const [id, record] of incoming) advertised.set(id, record);
      }
      return { accepted, rejected };
    },

    observeMethodNotFound(id, method, options = {}) {
      const record = createCapabilityRecord({
        id,
        state: CAPABILITY_STATES.unsupported,
        source: CAPABILITY_SOURCES.methodNotFound,
        checkedAt: stamp(options),
        identityKey: ledger.identityKey,
        reasonCode: 'method-not-found',
        params: { method: clean(method) },
      });
      observed.set(record.id, record);
      return record;
    },

    observeOperation(id, outcome = {}, options = {}) {
      const ok = outcome.ok === true;
      const record = createCapabilityRecord({
        id,
        state: ok ? CAPABILITY_STATES.available : CAPABILITY_STATES.blocked,
        source: CAPABILITY_SOURCES.operation,
        checkedAt: stamp(options),
        identityKey: ledger.identityKey,
        reasonCode: ok ? 'operation-ok' : 'operation-refused',
        params: ok ? {} : { detail: clean(outcome.detail) },
      });
      observed.set(record.id, record);
      return record;
    },

    revoke(id, detail = '', options = {}) {
      const record = createCapabilityRecord({
        id,
        state: CAPABILITY_STATES.blocked,
        source: CAPABILITY_SOURCES.revocation,
        checkedAt: stamp(options),
        identityKey: ledger.identityKey,
        reasonCode: 'revoked',
        params: { detail: clean(detail) },
      });
      revoked.set(record.id, record);
      return record;
    },

    clearRevocation(id) {
      return revoked.delete(clean(id));
    },

    get(id, options = {}) {
      const record = resolve(id);
      if (!record) return null;
      return effectiveCapability(record, { now: options.now ?? now(), maxAgeMs: options.maxAgeMs, connected });
    },

    all(options = {}) {
      const ids = new Set([...advertised.keys(), ...observed.keys(), ...revoked.keys()]);
      return [...ids].map((id) => ledger.get(id, options)).filter(Boolean);
    },

    canExecute(id, options = {}) {
      return canExecute(resolve(id), {
        now: options.now ?? now(),
        maxAgeMs: options.maxAgeMs,
        identityKey: options.identityKey ?? ledger.identityKey,
        connected,
      });
    },
  };
  return ledger;
}

// ---- Presentation helpers ---------------------------------------------------

const POSITIVE_STATES = new Set([CAPABILITY_STATES.available]);

/** The two-state view the older rows used: `ok` only for a current available record. */
export function capabilityRowStatus(record) {
  return record && POSITIVE_STATES.has(record.state) ? 'ok' : 'warn';
}

/**
 * What a row shows, with the age the record carries. `age` is null when the
 * record has no timestamp (an extension statement, a never-checked feature).
 */
export function describeCapability(record, { now = Date.now() } = {}) {
  if (!record) return null;
  const ageMs = ageOf(record, now);
  return {
    id: record.id,
    state: record.state,
    status: capabilityRowStatus(record),
    source: record.source,
    reasonCode: record.reasonCode,
    reason: record.reason,
    params: record.params,
    checkedAt: record.checkedAt,
    ageMs,
  };
}
