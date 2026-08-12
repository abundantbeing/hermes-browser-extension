/**
 * Phase 5 — durable controller registry (pure module).
 *
 * Tracks the extension's controller identity across service-worker
 * suspensions and restarts:
 *  - durable controller/profile identity (controllerId + browserProfileId +
 *    product) registered once per controller;
 *  - exact Hermes session binding; rebinding to another session is a new
 *    epoch and bumps a monotonic generation;
 *  - heartbeat/expiry: entries stay live only while touched within expiryMs;
 *  - bounded, versioned, fail-closed storage: corrupt, wrong-version, or
 *    shape-mismatched persisted state hydrates to empty, and snapshots never
 *    carry tickets, tokens, or credentials.
 *
 * Pure module: no browser APIs; `now` is injectable for tests.
 */

export const CONTROLLER_REGISTRY_VERSION = 1;
export const CONTROLLER_REGISTRY_STORAGE_KEY = 'hermesBrowserControllerRegistry';
export const CONTROLLER_DEFAULT_HEARTBEAT_MS = 60_000;
export const CONTROLLER_DEFAULT_EXPIRY_MS = 5 * 60_000;
export const MAX_CONTROLLER_REGISTRY_ENTRIES = 8;

function normalizeProduct(product) {
  if (!product || typeof product !== 'object') return null;
  const id = String(product.id || '').trim();
  const engine = String(product.engine || '').trim();
  const label = String(product.label || '').trim();
  if (!id || !engine || !label) return null;
  return { id, engine, label };
}

function normalizeRecord(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const controllerId = String(entry.controllerId || '').trim();
  const browserProfileId = String(entry.browserProfileId || '').trim();
  const hermesSessionId = String(entry.hermesSessionId || '').trim();
  const product = normalizeProduct(entry.product);
  if (!controllerId || !browserProfileId || !product) return null;
  const generation = Number(entry.generation);
  const heartbeatAt = Number(entry.heartbeatAt);
  const boundAt = Number(entry.boundAt);
  const updatedAt = Number(entry.updatedAt);
  if (!Number.isInteger(generation) || generation < 1) return null;
  if (!Number.isFinite(heartbeatAt) || !Number.isFinite(boundAt) || !Number.isFinite(updatedAt)) return null;
  return {
    controllerId,
    browserProfileId,
    product,
    hermesSessionId,
    generation,
    heartbeatAt,
    boundAt,
    updatedAt,
  };
}

/**
 * Create a controller registry.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] - current epoch ms
 * @param {number} [options.heartbeatMs] - expected heartbeat cadence
 * @param {number} [options.expiryMs] - entry lifetime without a heartbeat
 * @param {number} [options.maxEntries] - bounded registry size
 */
export function createControllerRegistry({
  now = Date.now,
  heartbeatMs: _heartbeatMs = CONTROLLER_DEFAULT_HEARTBEAT_MS,
  expiryMs = CONTROLLER_DEFAULT_EXPIRY_MS,
  maxEntries = MAX_CONTROLLER_REGISTRY_ENTRIES,
} = {}) {
  /** @type {Map<string, object>} */
  const records = new Map();

  function register({ controllerId = '', browserProfileId = '', product = null, hermesSessionId = '', generation: targetGeneration = null } = {}) {
    const id = String(controllerId || '').trim();
    if (!id) throw new Error('Controller id is required.');
    const profileId = String(browserProfileId || '').trim();
    if (!profileId) throw new Error('Browser profile id is required.');
    const normalizedProduct = normalizeProduct(product);
    if (!normalizedProduct) throw new Error('Controller product id, engine, and label are required.');
    const sessionId = String(hermesSessionId || '').trim();
    if (!sessionId) throw new Error('Hermes session id is required.');

    const at = Number(now());
    const existing = records.get(id);
    const sameDurableIdentity = existing
      && existing.browserProfileId === profileId
      && existing.product.id === normalizedProduct.id
      && existing.product.engine === normalizedProduct.engine
      && existing.hermesSessionId === sessionId;
    // Identity change (or first registration) is a new epoch; a pure heartbeat
    // refresh of the same durable identity preserves the generation.
    const baseGeneration = existing && sameDurableIdentity ? existing.generation : (existing?.generation || 0) + 1;
    const requestedGeneration = Number(targetGeneration);
    const generation = Number.isInteger(requestedGeneration) && requestedGeneration >= 1
      ? Math.max(baseGeneration, requestedGeneration)
      : baseGeneration;
    const record = {
      controllerId: id,
      browserProfileId: profileId,
      product: normalizedProduct,
      hermesSessionId: sessionId,
      generation,
      heartbeatAt: at,
      boundAt: existing?.boundAt ?? at,
      updatedAt: at,
    };
    records.set(id, record);
    evictBounded();
    return { ...record };
  }

  function bindSession({ controllerId = '', hermesSessionId = '', generation: targetGeneration = null } = {}) {
    const id = String(controllerId || '').trim();
    const sessionId = String(hermesSessionId || '').trim();
    if (!sessionId) throw new Error('Hermes session id is required.');
    const existing = records.get(id);
    if (!existing) throw new Error(`Controller ${id} is not registered.`);
    const at = Number(now());
    const requestedGeneration = Number(targetGeneration);
    const generation = Number.isInteger(requestedGeneration) && requestedGeneration >= 1
      ? Math.max(existing.generation, requestedGeneration)
      : existing.generation + 1;
    const record = {
      ...existing,
      hermesSessionId: sessionId,
      generation,
      heartbeatAt: at,
      updatedAt: at,
    };
    records.set(id, record);
    return { ...record };
  }

  function evictBounded() {
    if (records.size <= maxEntries) return;
    const order = [...records.values()].sort((a, b) => Number(a.updatedAt) - Number(b.updatedAt));
    const evictable = records.size - maxEntries;
    for (const record of order.slice(0, evictable)) records.delete(record.controllerId);
  }

  function touch(controllerId) {
    const existing = records.get(String(controllerId || '').trim());
    if (!existing) return null;
    const at = Number(now());
    if (at - Number(existing.heartbeatAt) > Number(expiryMs)) {
      records.delete(existing.controllerId);
      return null;
    }
    const record = { ...existing, heartbeatAt: at, updatedAt: at };
    records.set(existing.controllerId, record);
    return { ...record };
  }

  function get(controllerId) {
    const existing = records.get(String(controllerId || '').trim());
    if (!existing) return null;
    const at = Number(now());
    if (at - Number(existing.heartbeatAt) > Number(expiryMs)) return null;
    return { ...existing };
  }

  function generation(controllerId) {
    return records.get(String(controllerId || '').trim())?.generation ?? 0;
  }

  function expire({ at = Number(now()) } = {}) {
    let evicted = 0;
    for (const [id, record] of records) {
      if (at - Number(record.heartbeatAt) > Number(expiryMs)) {
        records.delete(id);
        evicted += 1;
      }
    }
    return evicted;
  }

  function count() {
    return records.size;
  }

  function snapshot() {
    const entries = [...records.values()]
      .map((record) => ({ ...record, product: { ...record.product } }))
      .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
      .slice(0, Math.max(1, Number(maxEntries) || MAX_CONTROLLER_REGISTRY_ENTRIES));
    return { version: CONTROLLER_REGISTRY_VERSION, entries };
  }

  function hydrate(raw) {
    if (!raw || typeof raw !== 'object') return [];
    if (Number(raw.version) !== CONTROLLER_REGISTRY_VERSION) return [];
    if (!Array.isArray(raw.entries)) return [];
    const valid = raw.entries.map(normalizeRecord).filter(Boolean);
    for (const record of valid) {
      if (!records.has(record.controllerId)) records.set(record.controllerId, record);
    }
    evictBounded();
    return valid;
  }

  return {
    register,
    bindSession,
    touch,
    get,
    generation,
    expire,
    count,
    snapshot,
    hydrate,
  };
}
