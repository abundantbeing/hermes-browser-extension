// Surface ids and the side-panel -> full-tab handoff URL, and nothing else. This module mints and parses
// identifiers; it is not a window registry, a lease, or a cross-surface lock, and nothing here makes a
// claim about which surface owns a session (the gateway is the only writer). The `sourceSurfaceId` it
// carries is only printed as "opened from" text by the full tab.
export const SURFACE_KINDS = Object.freeze({
  SIDE_PANEL: 'sidepanel',
  FULL_TAB: 'fulltab',
});

export function fullTabEntryPathForPage(pageUrl = '') {
  let pathname = '';
  try {
    pathname = new URL(String(pageUrl || '')).pathname;
  } catch {
    pathname = String(pageUrl || '');
  }
  return pathname.startsWith('/extension/') ? 'extension/app.html' : 'app.html';
}

const MAX_SESSION_ID_LENGTH = 512;
const MAX_SURFACE_ID_LENGTH = 160;
const SAFE_ID = /^[\w.:/@+-]+$/;

function safeIdentifier(value, maxLength) {
  const clean = String(value || '').trim();
  if (!clean || clean.length > maxLength || !SAFE_ID.test(clean)) return '';
  return clean;
}

function safeSurfaceId(value) {
  const clean = safeIdentifier(value, MAX_SURFACE_ID_LENGTH);
  return /^(sidepanel|fulltab):/.test(clean) ? clean : '';
}

export function createSurfaceId({ kind, instanceId } = {}) {
  if (!Object.values(SURFACE_KINDS).includes(kind)) {
    throw new Error(`Unknown surface kind: ${String(kind || '')}`);
  }
  const cleanInstanceId = safeIdentifier(instanceId, MAX_SURFACE_ID_LENGTH);
  if (!cleanInstanceId) throw new Error('Surface instance id is required.');
  return `${kind}:${cleanInstanceId}`;
}

export function buildFullTabHandoffUrl({ runtimeUrl, entryPath = 'app.html', sessionId = '', newChat = false, sourceTabId = null, sourceSurfaceId = '' } = {}) {
  if (typeof runtimeUrl !== 'function') throw new TypeError('runtimeUrl must be a function.');
  const url = new URL(runtimeUrl(entryPath));
  const opensFreshChat = newChat === true;
  const cleanSessionId = opensFreshChat ? '' : safeIdentifier(sessionId, MAX_SESSION_ID_LENGTH);
  const cleanSurfaceId = safeSurfaceId(sourceSurfaceId);
  const cleanTabId = Number(sourceTabId);
  if (cleanSessionId) url.searchParams.set('sessionId', cleanSessionId);
  if (opensFreshChat) url.searchParams.set('newChat', '1');
  if (Number.isInteger(cleanTabId) && cleanTabId > 0) url.searchParams.set('sourceTabId', String(cleanTabId));
  if (cleanSurfaceId) url.searchParams.set('sourceSurfaceId', cleanSurfaceId);
  return url.href;
}

export function parseFullTabHandoff(search = '') {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const sourceTabId = Number(params.get('sourceTabId'));
  const newChat = params.get('newChat') === '1';
  return {
    sessionId: newChat ? '' : safeIdentifier(params.get('sessionId'), MAX_SESSION_ID_LENGTH),
    newChat,
    sourceTabId: Number.isInteger(sourceTabId) && sourceTabId > 0 ? sourceTabId : null,
    sourceSurfaceId: safeSurfaceId(params.get('sourceSurfaceId')),
  };
}
