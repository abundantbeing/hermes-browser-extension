// The Hermes Browser companion plugin's browser-context side channel, client side.
//
// Hermes has no route for browser context, but the companion plugin (when it is
// loaded and its status route lists them) serves three on the API server
// (companion-plugin/context_routes.py), behind the same paired token or API key:
//
//   GET  /api/plugins/hermes-browser-companion/context/status   what it holds for a session
//   POST /api/plugins/hermes-browser-companion/context          park one full-context envelope
//   GET  /api/plugins/hermes-browser-companion/actions          declarative action descriptors
//
// Status and upload name the session with X-Hermes-Session-Id. An upload is not
// readable on arrival: the plugin binds it to a turn only when a reference turn
// for that session names the same context hash, so the extension uploads right
// before it sends a reference turn (the one turn that otherwise carries no
// payload for the plugin to hold). Nothing here changes what a turn contains.
//
// Pure module: no DOM, no storage. The caller supplies `fetchFn(path, init)`,
// the panel's authenticated gateway fetch, so the base URL, the token and the
// remote-mode guards stay where they already live. Every function is bounded
// and never throws.

import {
  COMPANION_ACTIONS_PATH,
  COMPANION_CONTEXT_STATUS_PATH,
  COMPANION_CONTEXT_UPLOAD_PATH,
  companionRouteRecordFields,
} from './companion-plugin-status.mjs';

export { COMPANION_ACTIONS_PATH, COMPANION_CONTEXT_STATUS_PATH, COMPANION_CONTEXT_UPLOAD_PATH };
export const COMPANION_SESSION_HEADER = 'X-Hermes-Session-Id';

const CONTEXT_STATUS_OBJECT = 'hermes.browser_companion.context_status';
const CONTEXT_UPLOAD_OBJECT = 'hermes.browser_companion.context_upload';
const ACTIONS_OBJECT = 'hermes.browser_companion.actions';
const DEFAULT_TIMEOUT_MS = 2500;
// The plugin refuses a longer envelope; do not send one it will refuse.
export const COMPANION_MAX_ENVELOPE_CHARS = 64_000;

function clean(value = '') {
  return String(value ?? '').trim();
}

function timeoutSignal(timeoutMs) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function failure(error, status = 0) {
  return { ok: false, status, reason: clean(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timed out' : (error?.message || error || 'failed')).slice(0, 80) };
}

async function request(fetchFn, path, { method = 'GET', sessionId = '', body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchFn !== 'function') return failure('no gateway fetch');
  const session = clean(sessionId);
  try {
    const response = await fetchFn(path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(session ? { [COMPANION_SESSION_HEADER]: session } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body }),
      cache: 'no-store',
      signal: timeoutSignal(timeoutMs),
    });
    const status = Number(response.status);
    if (!response.ok) return { ok: false, status, reason: `HTTP ${status}` };
    return { ok: true, status, json: await readJson(response) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Park a full-context envelope (the string serializeBrowserTurnEnvelope() built
 * with contextDelivery 'full') for `sessionId`. Resolves `{ ok, status, hash,
 * reason }`; `ok` only for the plugin's own "stored" answer.
 */
export async function uploadCompanionContext({ fetchFn, sessionId = '', envelope = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const text = typeof envelope === 'string' ? envelope : '';
  if (!clean(sessionId)) return { ok: false, status: 0, reason: 'no session' };
  if (!text || text.length > COMPANION_MAX_ENVELOPE_CHARS) return { ok: false, status: 0, reason: 'envelope not sendable' };
  const read = await request(fetchFn, COMPANION_CONTEXT_UPLOAD_PATH, { method: 'POST', sessionId, body: text, timeoutMs });
  if (!read.ok) return read;
  const body = read.json;
  if (!body || body.object !== CONTEXT_UPLOAD_OBJECT || body.stored !== true) return { ok: false, status: read.status, reason: 'unexpected answer' };
  return { ok: true, status: read.status, hash: clean(body.payload_hash), scope: clean(body.scope) };
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function age(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

/**
 * What the plugin holds for `sessionId`: `{ ok, held, consumed, hash, scope,
 * newestAgeMs, oldestAgeMs, expiresInMs, pendingUpload, live }`. Metadata only;
 * `live` is false whatever the plugin says, because a stored context is history.
 */
export async function readCompanionContextStatus({ fetchFn, sessionId = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!clean(sessionId)) return { ok: false, status: 0, reason: 'no session' };
  const read = await request(fetchFn, COMPANION_CONTEXT_STATUS_PATH, { sessionId, timeoutMs });
  if (!read.ok) return read;
  const body = read.json;
  if (!body || body.object !== CONTEXT_STATUS_OBJECT) return { ok: false, status: read.status, reason: 'unexpected answer' };
  const pending = body.pending_upload && typeof body.pending_upload === 'object' ? body.pending_upload : {};
  return {
    ok: true,
    status: read.status,
    held: count(body.held),
    consumed: count(body.consumed),
    hash: clean(body.payload_hash),
    scope: clean(body.scope),
    newestAgeMs: age(body.newest_age_ms),
    oldestAgeMs: age(body.oldest_age_ms),
    expiresInMs: age(body.expires_in_ms),
    pendingUpload: pending.present === true
      ? { present: true, hash: clean(pending.payload_hash), ageMs: age(pending.age_ms), expiresInMs: age(pending.expires_in_ms) }
      : { present: false },
    live: false,
  };
}

/** The plugin's declarative action descriptors: `{ ok, actions: [{ name, kind, safe, ... }] }`. Never runs one. */
export async function readCompanionActions({ fetchFn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const read = await request(fetchFn, COMPANION_ACTIONS_PATH, { timeoutMs });
  if (!read.ok) return read;
  const body = read.json;
  if (!body || body.object !== ACTIONS_OBJECT || !Array.isArray(body.actions)) return { ok: false, status: read.status, reason: 'unexpected answer' };
  const actions = body.actions
    .filter((row) => row && typeof row === 'object' && clean(row.name))
    .map((row) => ({
      name: clean(row.name).slice(0, 80),
      kind: clean(row.kind).slice(0, 40),
      safe: row.safe === true,
      usesModel: row.uses_model === true,
      usesNetwork: row.uses_network === true,
    }));
  return { ok: true, status: read.status, execution: clean(body.execution), actions };
}

// How long one status probe may vouch for the upload route before the panel asks again.
export const COMPANION_PROBE_MAX_AGE_MS = 5 * 60_000;

/**
 * Should the panel upload before this turn? `probe` is the latest result of
 * probeCompanionPlugin() for this connection. Only a ready plugin whose status
 * route listed the upload route uploads, and only for a reference turn (the one
 * turn that carries no payload for the plugin to hold). An old proof is re-probed
 * first; anything else (no probe, a plugin that does not list the route, a
 * dashboard chat) does nothing, so a gateway without the plugin behaves exactly
 * as before.
 */
export function companionUploadPlan(probe, { deliveryMode = '', dashboardTransport = false, sessionId = '', now = Date.now(), maxAgeMs = COMPANION_PROBE_MAX_AGE_MS } = {}) {
  if (deliveryMode !== 'reference' || dashboardTransport || !clean(sessionId)) return 'skip';
  if (!companionRouteRecordFields(probe, 'browserContextUpload')) return 'skip';
  const age = Number(now) - Number(probe.checkedAt);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs ? 'upload' : 'reprobe';
}

/** One diagnostics line for a status read; no page data, no ids. */
export function companionContextSummary(status) {
  if (!status || status.ok !== true) return '';
  const secs = (ms) => (ms === null || ms === undefined ? '?' : `${Math.round(ms / 1000)} s`);
  const parts = [`${status.held} held`];
  if (status.held) parts.push(`newest ${secs(status.newestAgeMs)} old`, `hash ${status.hash || 'none'}`);
  if (status.consumed) parts.push(`${status.consumed} already read`);
  parts.push(status.pendingUpload?.present ? `an upload is waiting (hash ${status.pendingUpload.hash || 'none'})` : 'no upload waiting');
  parts.push('not live control');
  return parts.join(', ');
}
