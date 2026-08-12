/**
 * Phase 5 pre-gate (issue #71) — exact dashboard WS delivery identity and
 * bounded persisted delivery metadata.
 *
 * The dashboard gateway exposes two session identities: a live id that
 * addresses the runtime on the current WebSocket and a stored id that
 * survives disconnects. Delivery deduplication (full snapshot vs. unchanged
 * reference) must key on the durable stored identity ONLY. Using the live id
 * as a fallback key means the first turn records under the live id and every
 * later turn flips to the stored id — the delivery key changes, the previous
 * state is missed, and the same unchanged page is delivered as a full
 * snapshot twice.
 *
 * Rules:
 *  - exact identity: remote-WS delivery keys require `wsStoredSessionId`;
 *    a live-only or settings fallback fails closed (null) so no record is
 *    ever written under a non-durable key.
 *  - bounded minimal persistence: at most MAX_DELIVERY_STATE_ENTRIES entries,
 *    versioned, storing only { gatewayUrl, storedSessionId, contextHash,
 *    referenceCount, lastFullAt, lastSentAt } — never page text, URL, title,
 *    or transcript.
 *  - fail closed: corrupt, wrong-version, or shape-mismatched persisted state
 *    normalizes to an empty list; unknown keys are stripped, never trusted.
 *  - identity mismatch: an entry persisted under a different gateway or
 *    stored session id is never returned as "previous" for the active turn.
 *  - clear persistence on compaction so a rotated session cannot suppress a
 *    needed full snapshot.
 */

export const DELIVERY_STATE_VERSION = 1;
export const DELIVERY_STATE_STORAGE_KEY = 'hermesBrowserDeliveryState';
export const MAX_DELIVERY_STATE_ENTRIES = 8;

const ENTRY_FIELDS = Object.freeze([
  'gatewayUrl',
  'storedSessionId',
  'contextHash',
  'referenceCount',
  'lastFullAt',
  'lastSentAt',
]);

function normalizeDeliveryGatewayUrl(value = '') {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

function deliveryKey(gatewayUrl, storedSessionId) {
  return `${gatewayUrl}::${storedSessionId}`;
}

/**
 * Compute the exact delivery identity for a turn.
 *
 * Remote-WS mode requires the durable stored session id. If only the live id
 * (or nothing) is available, the identity fails closed to null: the turn gets
 * a full snapshot and nothing is recorded, so the later arrival of the stored
 * id cannot produce a duplicate full snapshot under a second key.
 *
 * Non-WS modes key on the durable settings session id (or the scope binding
 * key when no session exists yet).
 *
 * @returns {{ key: string, gatewayUrl: string, storedSessionId: string, identitySource: string } | null}
 */
export function deliveryIdentityForTurn({
  gatewayUrl = '',
  isRemoteWs = false,
  wsStoredSessionId = '',
  wsSessionId: _wsSessionId = '',
  settingsSessionId = '',
  scopeBindingKey = '',
} = {}) {
  const url = normalizeDeliveryGatewayUrl(gatewayUrl);
  if (!url) return null;
  if (isRemoteWs) {
    const stored = String(wsStoredSessionId || '').trim();
    if (!stored) return null;
    return {
      key: deliveryKey(url, stored),
      gatewayUrl: url,
      storedSessionId: stored,
      identitySource: 'ws-stored',
    };
  }
  const sessionId = String(settingsSessionId || '').trim() || String(scopeBindingKey || '').trim();
  if (!sessionId) return null;
  return {
    key: deliveryKey(url, sessionId),
    gatewayUrl: url,
    storedSessionId: sessionId,
    identitySource: 'session-settings',
  };
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const gatewayUrl = normalizeDeliveryGatewayUrl(entry.gatewayUrl);
  const storedSessionId = String(entry.storedSessionId || '').trim();
  const contextHash = String(entry.contextHash || '').trim();
  if (!gatewayUrl || !storedSessionId || !contextHash) return null;
  const referenceCount = Number(entry.referenceCount);
  const lastFullAt = Number(entry.lastFullAt);
  const lastSentAt = Number(entry.lastSentAt);
  if (!Number.isFinite(referenceCount) || referenceCount < 0) return null;
  if (!Number.isFinite(lastFullAt) || !Number.isFinite(lastSentAt)) return null;
  // Build the entry from an explicit allowlist so foreign keys (page text,
  // transcripts, or anything a corrupt writer smuggled in) are never kept.
  return {
    gatewayUrl,
    storedSessionId,
    contextHash,
    referenceCount,
    lastFullAt,
    lastSentAt,
  };
}

/**
 * Serialize the in-memory delivery records into bounded, minimal persisted
 * state. Newest (by lastSentAt) entries are kept first. Keys use the exact
 * `${gatewayUrl}::${storedSessionId}` identity produced by
 * deliveryIdentityForTurn; the separator is parsed from the end so IPv6
 * gateway URLs (which contain "::") stay intact.
 */
export function serializeDeliveryState(records = new Map(), { now = Date.now(), maxEntries = MAX_DELIVERY_STATE_ENTRIES } = {}) {
  const entries = [];
  for (const [key, state] of records instanceof Map ? records : Object.entries(records || {})) {
    if (!state || typeof state !== 'object') continue;
    const rawKey = String(key || '');
    const separator = rawKey.lastIndexOf('::');
    const gatewayUrl = separator > 0 ? rawKey.slice(0, separator) : state.gatewayUrl;
    const storedSessionId = separator > 0 ? rawKey.slice(separator + 2) : state.storedSessionId;
    const normalized = normalizeEntry({
      gatewayUrl,
      storedSessionId,
      contextHash: state.contextHash,
      referenceCount: state.referenceCount,
      lastFullAt: state.lastFullAt,
      lastSentAt: state.lastSentAt,
    });
    if (normalized) entries.push(normalized);
  }
  entries.sort((a, b) => Number(b.lastSentAt) - Number(a.lastSentAt));
  const bounded = entries.slice(0, Math.max(1, Number(maxEntries) || MAX_DELIVERY_STATE_ENTRIES));
  return { version: DELIVERY_STATE_VERSION, entries: bounded, savedAt: Number(now) };
}

/**
 * Normalize persisted delivery state. Fails closed: any corrupt, wrong-version,
 * or shape-mismatched payload yields an empty list.
 */
export function normalizeDeliveryState(raw, { maxEntries = MAX_DELIVERY_STATE_ENTRIES } = {}) {
  if (!raw || typeof raw !== 'object') return [];
  if (Number(raw.version) !== DELIVERY_STATE_VERSION) return [];
  if (!Array.isArray(raw.entries)) return [];
  const entries = raw.entries.map(normalizeEntry).filter(Boolean);
  const bounded = entries.slice(0, Math.max(1, Number(maxEntries) || MAX_DELIVERY_STATE_ENTRIES));
  // Stable by identity so hydration cannot inject duplicates under one key.
  const seen = new Set();
  return bounded.filter((entry) => {
    const key = deliveryKey(entry.gatewayUrl, entry.storedSessionId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Build the in-memory delivery map keyed by exact delivery identity.
 * An entry persisted under a different gateway or stored session id is simply
 * unreachable from the active identity — identity mismatch fails closed.
 */
export function deliveryStateToMap(entries = []) {
  const map = new Map();
  for (const entry of normalizeDeliveryState({ version: DELIVERY_STATE_VERSION, entries })) {
    map.set(deliveryKey(entry.gatewayUrl, entry.storedSessionId), {
      contextHash: entry.contextHash,
      referenceCount: entry.referenceCount,
      lastFullAt: entry.lastFullAt,
      lastSentAt: entry.lastSentAt,
    });
  }
  return map;
}

/** Read the previous delivery record for an exact identity, or null. */
export function deliveryStateEntryForIdentity(map, identity) {
  if (!identity || !(map instanceof Map)) return null;
  return map.get(identity.key) || null;
}

/** Canonical cleared persisted state (used on compaction). */
export function clearDeliveryState() {
  return { version: DELIVERY_STATE_VERSION, entries: [], savedAt: 0 };
}

export { ENTRY_FIELDS, normalizeEntry };
