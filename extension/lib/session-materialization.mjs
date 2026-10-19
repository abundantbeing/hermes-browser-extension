// Session routes on the Hermes API server, as the side panel uses them: look a
// Browser session up, create it on first send, and decide what a refused
// request means. Everything here is pure apart from the injected fetch, so the
// sequence can be tested without a DOM.
//
// Origin refusals (issue #89): the API server's CORS gate answers a request
// whose Origin it does not allow with a bare 403 that has no JSON body. Hermes'
// own 403s carry a JSON error object. So an empty or non-JSON 403 on a session
// route means "this extension origin is not in API_SERVER_CORS_ORIGINS". The
// refusal is reported for this session only: callers keep the composer draft
// and do not mark the connection unreachable.

export const CORS_ORIGINS_SETTING = 'API_SERVER_CORS_ORIGINS';

// Gateways from Oct 2026 admit a REST/SSE turn only for sessions stored as
// api_server or bot_room; any other stored source answers permission_denied.
// Older gateways accept every source.
export const REST_TURN_SOURCES = Object.freeze(['api_server', 'bot_room']);

// The source to store when creating a session over the API server. Those same
// gateways also refuse to relabel a session afterwards, so one created under the
// Browser's own label (hermes_browser) could never take a turn. The Browser still
// recognises its own sessions by their id prefix (isHermesBrowserOwnedSession).
export function restSessionCreateSource(source = '') {
  const value = String(source || '').trim().toLowerCase();
  return REST_TURN_SOURCES.includes(value) ? value : 'api_server';
}
const FALLBACK_EXTENSION_ORIGIN = 'chrome-extension://<extension-id>';

function defaultReadText(response) {
  return response.text();
}

// True for a 403 whose body is empty or is not JSON (the CORS gate's answer).
export function isBareForbiddenResponse({ status = 0, body = '' } = {}) {
  if (Number(status) !== 403) return false;
  const text = String(body ?? '').trim();
  if (!text) return true;
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}

// The extension origin as the API server sees it in the Origin header, with no
// trailing slash: browser.runtime.getURL('') minus its path.
export function normalizeExtensionOrigin(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function sessionRouteOriginRefusal({
  action = '',
  status = 0,
  body = '',
  extensionOrigin = '',
} = {}) {
  if (!isBareForbiddenResponse({ status, body })) return null;
  const origin = normalizeExtensionOrigin(extensionOrigin) || FALLBACK_EXTENSION_ORIGIN;
  return Object.freeze({
    action: String(action || '') || 'Hermes session request',
    status: 403,
    origin,
    envLine: `${CORS_ORIGINS_SETTING}=${origin}`,
  });
}

export function sessionRouteError({
  action = '',
  status = 0,
  message = '',
  originRefusal = null,
  remoteDiagnostic = null,
} = {}) {
  const actionText = String(action || '') || 'Hermes session request';
  const httpStatus = Number(status) || 0;
  const error = new Error(message || `${actionText} failed (${httpStatus}).`);
  error.name = 'HermesSessionRouteError';
  error.httpStatus = httpStatus;
  error.sessionRouteAction = actionText;
  error.remoteDiagnostic = remoteDiagnostic;
  error.originRefusal = originRefusal;
  error.originRefused = Boolean(originRefusal);
  error.hermesSetupFailure = Boolean(originRefusal)
    || Boolean(remoteDiagnostic)
    || httpStatus === 401
    || httpStatus === 403
    || httpStatus === 0;
  return error;
}

function failureDetails({ action, response, body, extensionOrigin }) {
  const status = Number(response?.status || 0);
  return {
    action,
    response,
    status,
    body,
    originRefusal: sessionRouteOriginRefusal({ action, status, body, extensionOrigin }),
  };
}

function defaultSessionFailure(details) {
  return sessionRouteError({
    action: details.action,
    status: details.status,
    originRefusal: details.originRefusal,
  });
}

// Looks the session up and creates it when the gateway does not know it yet.
// Resolves to one of:
//   { outcome: 'present', response }   the session exists (GET ok)
//   { outcome: 'created', response }   the session was created (POST ok or 409)
//   { outcome: 'unavailable' }         the gateway has no session routes (404/405)
// Any other answer throws failure(details), where details carries the action,
// the response, the body text and, for a bare 403, the originRefusal.
export async function materializeSessionRoute({
  apiFetch,
  sessionPath,
  createBody,
  beforeCreate = null,
  extensionOrigin = '',
  readText = defaultReadText,
  failure = defaultSessionFailure,
} = {}) {
  if (typeof apiFetch !== 'function') throw new TypeError('apiFetch must be a function.');
  const lookup = await apiFetch(sessionPath, { method: 'GET' });
  if (lookup.ok) return Object.freeze({ outcome: 'present', response: lookup });
  if (lookup.status !== 404) {
    const body = await readText(lookup);
    throw failure(failureDetails({
      action: 'Inspect Hermes Browser Extension session',
      response: lookup,
      body,
      extensionOrigin,
    }));
  }

  if (beforeCreate) await beforeCreate();
  const created = await apiFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(createBody()),
  });
  if (created.status === 404 || created.status === 405) return Object.freeze({ outcome: 'unavailable' });
  if (!created.ok && created.status !== 409) {
    const body = await readText(created);
    throw failure(failureDetails({
      action: 'Create Hermes Browser Extension session',
      response: created,
      body,
      extensionOrigin,
    }));
  }
  return Object.freeze({ outcome: 'created', response: created });
}
