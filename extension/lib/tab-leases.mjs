/**
 * Phase 5 — tab leases (pure module).
 *
 * One lease per tab. Kinds:
 *  - this-tab       — exactly one leased tab (the active/controlled tab);
 *  - selected-tabs  — one lease per user-selected tab;
 *  - task-set       — a shared task identity across several tabs, backed by a
 *                     native tab group when supported and an internal tab-id
 *                     set when not (Firefox fallback).
 *
 * Ownership:
 *  - owned leases   — released only by their owning controller;
 *  - borrowed leases — granted to transient surfaces (side panel) and
 *                     reclaimed wholesale when the borrower disconnects.
 *
 * Safety:
 *  - idle expiry: leases without successful owned activity for the TTL are
 *    reclaimed; renewal never changes lease identity or ownership;
 *  - restart/generation: a new service-worker generation invalidates every
 *    lease from an older generation; hydrate preserves generations so a
 *    restart cannot resurrect stale leases under a rolled-back generation;
 *  - bounded, versioned, fail-closed storage: snapshots contain lease
 *    metadata only — never page URL, title, transcript, or page content.
 *
 * Pure module: no browser APIs; `now` is injectable for tests.
 */

export const TAB_LEASE_VERSION = 1;
export const TAB_LEASE_STORAGE_KEY = 'hermesBrowserTabLeases';
export const TAB_LEASE_DEFAULT_TTL_MS = 30 * 60_000;
export const MAX_TAB_LEASES = 32;

export const TAB_LEASE_KINDS = Object.freeze({
  THIS_TAB: 'this-tab',
  SELECTED_TABS: 'selected-tabs',
  TASK_SET: 'task-set',
});

export const TAB_LEASE_OWNERSHIPS = Object.freeze({
  OWNED: 'owned',
  BORROWED: 'borrowed',
});

const KNOWN_KINDS = new Set(Object.values(TAB_LEASE_KINDS));

function normalizeLease(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const tabId = Number(entry.tabId);
  const windowId = Number(entry.windowId) || null;
  const kind = String(entry.kind || '').trim();
  const ownership = String(entry.ownership || '').trim();
  const ownerId = String(entry.ownerId || '').trim();
  const leaseId = String(entry.leaseId || `${ownerId}:${Number(entry.tabId)}:${Number(entry.acquiredAt)}`).trim();
  const groupSource = entry.groupSource === 'internal' ? 'internal' : 'native';
  if (!Number.isInteger(tabId) || tabId <= 0) return null;
  if (!KNOWN_KINDS.has(kind)) return null;
  if (![TAB_LEASE_OWNERSHIPS.OWNED, TAB_LEASE_OWNERSHIPS.BORROWED].includes(ownership)) return null;
  if (!ownerId) return null;
  if (!leaseId) return null;
  const generation = Number(entry.generation);
  const acquiredAt = Number(entry.acquiredAt);
  const expiresAt = Number(entry.expiresAt);
  if (!Number.isInteger(generation) || generation < 1) return null;
  if (!Number.isFinite(acquiredAt) || !Number.isFinite(expiresAt)) return null;
  const taskSetId = kind === TAB_LEASE_KINDS.TASK_SET ? String(entry.taskSetId || '').trim() : null;
  if (kind === TAB_LEASE_KINDS.TASK_SET && !taskSetId) return null;
  return {
    tabId,
    windowId,
    kind,
    ownership,
    ownerId,
    leaseId,
    generation,
    acquiredAt,
    expiresAt,
    taskSetId,
    groupSource,
  };
}

/**
 * Create a tab lease store.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] - current epoch ms
 * @param {number} [options.ttlMs] - lease lifetime
 * @param {number} [options.maxLeases] - bounded lease count
 * @param {boolean} [options.supportsTabGroups] - native tab group availability
 * @param {number} [options.generation] - service-worker generation
 */
export function createTabLeaseStore({
  now = Date.now,
  ttlMs = TAB_LEASE_DEFAULT_TTL_MS,
  maxLeases = MAX_TAB_LEASES,
  supportsTabGroups = true,
  generation = 1,
} = {}) {
  let currentGeneration = Math.max(1, Number(generation) || 1);
  /** @type {Map<number, object>} */
  const leases = new Map();

  function leaseForTab(tabId) {
    const lease = leases.get(Number(tabId));
    return lease ? { ...lease } : null;
  }

  function acquire({
    tabId,
    kind = '',
    ownerId = '',
    ownership = TAB_LEASE_OWNERSHIPS.OWNED,
    windowId = null,
    taskSetId = null,
    at = Number(now()),
  } = {}) {
    const normalizedTabId = Number(tabId);
    if (!Number.isInteger(normalizedTabId) || normalizedTabId <= 0) {
      throw new Error('Tab id is required.');
    }
    if (!KNOWN_KINDS.has(kind)) throw new Error(`Unknown tab lease kind: ${String(kind || '')}`);
    const normalizedOwner = String(ownerId || '').trim();
    if (!normalizedOwner) throw new Error('Lease owner id is required.');
    if (kind === TAB_LEASE_KINDS.TASK_SET && !String(taskSetId || '').trim()) {
      throw new Error('Task-set leases require a task set id.');
    }
    if (kind !== TAB_LEASE_KINDS.TASK_SET && taskSetId !== null && taskSetId !== undefined && String(taskSetId).trim()) {
      throw new Error('Only task-set leases may carry a task set id.');
    }
    if (leases.has(normalizedTabId)) {
      return { ok: false, error: 'already-leased', lease: leaseForTab(normalizedTabId) };
    }
    if (leases.size >= maxLeases) {
      return { ok: false, error: 'lease-limit' };
    }
    const lease = {
      leaseId: `${normalizedOwner}:${normalizedTabId}:${Number(at)}`,
      tabId: normalizedTabId,
      windowId: Number(windowId) || null,
      kind,
      ownership,
      ownerId: normalizedOwner,
      generation: currentGeneration,
      acquiredAt: Number(at),
      expiresAt: Number(at) + Number(ttlMs),
      taskSetId: kind === TAB_LEASE_KINDS.TASK_SET ? String(taskSetId).trim() : null,
      groupSource: supportsTabGroups ? 'native' : 'internal',
    };
    leases.set(normalizedTabId, lease);
    return { ok: true, lease: { ...lease } };
  }

  function release({ tabId, ownerId }) {
    const normalizedTabId = Number(tabId);
    const lease = leases.get(normalizedTabId);
    if (!lease) return { ok: false, error: 'not-leased' };
    if (String(ownerId || '').trim() !== lease.ownerId) {
      return { ok: false, error: 'not-owner' };
    }
    leases.delete(normalizedTabId);
    return { ok: true, lease: { ...lease } };
  }

  function renew({ tabId, ownerId, leaseId, generation, at = Number(now()) } = {}) {
    const normalizedTabId = Number(tabId);
    const lease = leases.get(normalizedTabId);
    if (!lease) return { ok: false, error: 'not-leased' };
    if (String(ownerId || '').trim() !== lease.ownerId) return { ok: false, error: 'not-owner' };
    if (String(leaseId || '').trim() !== lease.leaseId) return { ok: false, error: 'stale-lease' };
    if (Number(generation) !== lease.generation) return { ok: false, error: 'stale-generation' };
    const renewed = { ...lease, expiresAt: Number(at) + Number(ttlMs) };
    leases.set(normalizedTabId, renewed);
    return { ok: true, lease: { ...renewed } };
  }

  function removeTab(tabId) {
    const normalizedTabId = Number(tabId);
    const lease = leases.get(normalizedTabId);
    if (!lease) return { ok: false, error: 'not-leased' };
    leases.delete(normalizedTabId);
    return { ok: true, lease: { ...lease } };
  }

  /** Reclaim every borrowed lease owned by a disconnected borrower. */
  function reclaimBorrowed({ ownerId }) {
    const normalizedOwner = String(ownerId || '').trim();
    let reclaimed = 0;
    for (const [tabId, lease] of leases) {
      if (lease.ownership === TAB_LEASE_OWNERSHIPS.BORROWED && lease.ownerId === normalizedOwner) {
        leases.delete(tabId);
        reclaimed += 1;
      }
    }
    return reclaimed;
  }

  function reclaimExpired({ at = Number(now()) } = {}) {
    let reclaimed = 0;
    for (const [tabId, lease] of leases) {
      if (at >= Number(lease.expiresAt)) {
        leases.delete(tabId);
        reclaimed += 1;
      }
    }
    return reclaimed;
  }

  /** Invalidate every lease acquired under an older generation (restart). */
  function invalidateGeneration({ generation: newerGeneration }) {
    let invalidated = 0;
    for (const [tabId, lease] of leases) {
      if (Number(lease.generation) !== Number(newerGeneration)) {
        leases.delete(tabId);
        invalidated += 1;
      }
    }
    return invalidated;
  }

  /** Adopt recovered leases into a newer service-worker generation. */
  function adoptGeneration({ generation: newerGeneration }) {
    const normalizedGeneration = Number(newerGeneration);
    if (!Number.isInteger(normalizedGeneration) || normalizedGeneration < currentGeneration) return 0;
    currentGeneration = normalizedGeneration;
    let adopted = 0;
    for (const [tabId, lease] of leases) {
      if (lease.generation === normalizedGeneration) continue;
      leases.set(tabId, { ...lease, generation: normalizedGeneration });
      adopted += 1;
    }
    return adopted;
  }

  function leasedTabIds() {
    return [...leases.keys()];
  }

  function leasesForKind(kind) {
    return [...leases.values()].filter((lease) => lease.kind === kind).map((lease) => ({ ...lease }));
  }

  function taskSetTabIds(taskSetId) {
    const normalized = String(taskSetId || '').trim();
    return [...leases.values()]
      .filter((lease) => lease.kind === TAB_LEASE_KINDS.TASK_SET && lease.taskSetId === normalized)
      .map((lease) => lease.tabId);
  }

  function count() {
    return leases.size;
  }

  function usesNativeGroups() {
    return supportsTabGroups;
  }

  function snapshot() {
    const entries = [...leases.values()]
      .map((lease) => ({ ...lease }))
      .sort((a, b) => Number(a.acquiredAt) - Number(b.acquiredAt))
      .slice(0, Math.max(1, Number(maxLeases) || MAX_TAB_LEASES));
    return { version: TAB_LEASE_VERSION, entries };
  }

  function hydrate(raw) {
    if (!raw || typeof raw !== 'object') return [];
    if (Number(raw.version) !== TAB_LEASE_VERSION) return [];
    if (!Array.isArray(raw.entries)) return [];
    const valid = raw.entries.map(normalizeLease).filter(Boolean);
    const at = Number(now());
    for (const lease of valid) {
      if (at >= Number(lease.expiresAt)) continue; // expired leases never resurrect
      if (!leases.has(lease.tabId)) leases.set(lease.tabId, lease);
    }
    while (leases.size > maxLeases) {
      const oldest = [...leases.values()].sort((a, b) => Number(a.acquiredAt) - Number(b.acquiredAt))[0];
      leases.delete(oldest.tabId);
    }
    return valid;
  }

  return {
    acquire,
    renew,
    release,
    removeTab,
    reclaimBorrowed,
    reclaimExpired,
    invalidateGeneration,
    adoptGeneration,
    leaseForTab,
    leasedTabIds,
    leasesForKind,
    taskSetTabIds,
    count,
    usesNativeGroups,
    snapshot,
    hydrate,
  };
}
