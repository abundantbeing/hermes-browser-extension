export const CONTEXT_DELIVERY_MODES = Object.freeze({
  NONE: 'none',
  FULL: 'full',
  REFERENCE: 'reference',
});

export const MAX_UNCHANGED_CONTEXT_REFERENCES = 3;
export const MAX_FULL_CONTEXT_AGE_MS = 10 * 60 * 1000;

export function contextDeliveryDecision({
  scopeMode = 'follow-active',
  contextHash = '',
  previous = null,
  now = Date.now(),
  maxReferences = MAX_UNCHANGED_CONTEXT_REFERENCES,
  maxFullAgeMs = MAX_FULL_CONTEXT_AGE_MS,
} = {}) {
  if (scopeMode === 'chat-only') return { mode: CONTEXT_DELIVERY_MODES.NONE, reason: 'chat-only' };
  const hash = String(contextHash || '').trim();
  if (!hash) return { mode: CONTEXT_DELIVERY_MODES.FULL, reason: 'missing-hash' };
  if (!previous || previous.contextHash !== hash) return { mode: CONTEXT_DELIVERY_MODES.FULL, reason: previous ? 'context-changed' : 'first-context' };
  const fullAge = Math.max(0, Number(now) - Number(previous.lastFullAt || 0));
  if (!Number.isFinite(fullAge) || fullAge >= maxFullAgeMs) return { mode: CONTEXT_DELIVERY_MODES.FULL, reason: 'full-snapshot-aged' };
  if (Number(previous.referenceCount || 0) >= maxReferences) return { mode: CONTEXT_DELIVERY_MODES.FULL, reason: 'reference-limit' };
  return { mode: CONTEXT_DELIVERY_MODES.REFERENCE, reason: 'context-unchanged' };
}

export function recordContextDelivery(previous, {
  mode,
  contextHash = '',
  now = Date.now(),
} = {}) {
  const hash = String(contextHash || '').trim();
  if (mode === CONTEXT_DELIVERY_MODES.FULL) {
    return { contextHash: hash, referenceCount: 0, lastFullAt: Number(now), lastSentAt: Number(now) };
  }
  if (mode === CONTEXT_DELIVERY_MODES.REFERENCE && previous?.contextHash === hash) {
    return {
      ...previous,
      referenceCount: Number(previous.referenceCount || 0) + 1,
      lastSentAt: Number(now),
    };
  }
  return previous || null;
}
