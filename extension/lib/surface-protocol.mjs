// Surface ids, and nothing else. This module mints identifiers; it is not a window registry, a lease,
// or a cross-surface lock, and nothing here makes a claim about which surface owns a session (the
// gateway is the only writer). The side panel is the only surface this extension has: Hermes Web is the
// Webapp the user's own gateway serves, so there is no extension-owned full tab to hand a session to.
export const SURFACE_KINDS = Object.freeze({
  SIDE_PANEL: 'sidepanel',
});

const MAX_SURFACE_ID_LENGTH = 160;
const SAFE_ID = /^[\w.:/@+-]+$/;

function safeIdentifier(value, maxLength) {
  const clean = String(value || '').trim();
  if (!clean || clean.length > maxLength || !SAFE_ID.test(clean)) return '';
  return clean;
}

export function createSurfaceId({ kind, instanceId } = {}) {
  if (!Object.values(SURFACE_KINDS).includes(kind)) {
    throw new Error(`Unknown surface kind: ${String(kind || '')}`);
  }
  const cleanInstanceId = safeIdentifier(instanceId, MAX_SURFACE_ID_LENGTH);
  if (!cleanInstanceId) throw new Error('Surface instance id is required.');
  return `${kind}:${cleanInstanceId}`;
}
