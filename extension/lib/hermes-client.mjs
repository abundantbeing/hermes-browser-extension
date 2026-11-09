import { connectionHeadersAsObject } from './connection-headers.mjs';

export const SESSION_LIST_TIMEOUT_MS = 15_000;
// Ordinary calls (status, session CRUD, run control) answer in seconds. A
// gateway that stops answering must not leave them pending forever, so they get
// this deadline unless the caller passes its own signal or timeoutMs.
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SESSION_LIMIT = 200;
const DEFAULT_MAX_PAGES = 10;
const MAX_ERROR_BODY = 500;
const AUTH_SCHEME = 'Bearer';
// Streams, uploads and agent turns run as long as the model or the transfer
// does, so they are not bounded by default. A turn is a non-stream chat POST;
// compaction also runs a model call.
const UNBOUNDED_REQUEST_PATH = /\/(?:stream|uploads?|transcribe|chat|compress)(?:[/?]|$)/i;

function normalizeBaseUrl(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

function profileScopedPath(path = '', profile = '') {
  const normalizedPath = String(path || '').startsWith('/') ? String(path || '') : `/${path}`;
  const selectedProfile = String(profile || '').trim();
  if (!selectedProfile || /^\/p\/[^/]+(?:\/|$)/.test(normalizedPath)) return normalizedPath;
  return `/p/${encodeURIComponent(selectedProfile)}${normalizedPath}`;
}

function normalizedRows(payload = {}) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.sessions)) return payload.sessions;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.messages)) return payload.messages;
  return [];
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function boundedErrorBody(payload = {}) {
  const value = payload?.error?.message || payload?.error || payload?.message || '';
  return String(value || '').replace(/\s+/g, ' ').slice(0, MAX_ERROR_BODY).trim();
}

function httpError(action, response, payload) {
  const detail = boundedErrorBody(payload);
  const error = new Error(`${action} failed (${response.status})${detail ? `: ${detail}` : ''}`);
  error.name = 'HermesClientHttpError';
  error.status = response.status;
  return error;
}

function isBinaryBody(body) {
  if (!body || typeof body !== 'object') return false;
  if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer) return true;
  for (const type of [globalThis.Blob, globalThis.FormData, globalThis.ReadableStream]) {
    if (typeof type === 'function' && body instanceof type) return true;
  }
  return false;
}

function isUnboundedRequest(path = '', options = {}) {
  if (UNBOUNDED_REQUEST_PATH.test(String(path || ''))) return true;
  const accept = options.headers?.Accept ?? options.headers?.accept ?? '';
  if (/text\/event-stream/i.test(String(accept))) return true;
  return isBinaryBody(options.body);
}

// The deadline a request runs under: an explicit timeoutMs wins (0 disables
// it), then streams, uploads and turns are unbounded, then the client default.
function requestDeadlineMs(path, options, defaultMs) {
  if (Number.isFinite(options.timeoutMs)) return Math.max(0, Number(options.timeoutMs));
  if (isUnboundedRequest(path, options)) return 0;
  return Math.max(0, Number(defaultMs) || 0);
}

export function createHermesClient({
  fetchImpl = globalThis.fetch,
  getConnection,
  defaultRequestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');
  if (typeof getConnection !== 'function') throw new TypeError('getConnection must be a function.');

  async function request(path, options = {}) {
    const connection = getConnection() || {};
    const base = normalizeBaseUrl(connection.gatewayUrl);
    if (!base) throw new Error('Hermes gateway URL is not configured.');
    const hasBody = typeof options.body !== 'undefined';
    const headers = {
      ...connectionHeadersAsObject(connection.connectionHeaders),
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(connection.apiKey ? { Authorization: `${AUTH_SCHEME} ${connection.apiKey}` } : {}),
      ...(connection.activeProfile ? { 'X-Hermes-Profile': connection.activeProfile } : {}),
      ...(options.headers || {}),
    };
    // A caller's own signal always wins; it may be a stream the caller cancels.
    const deadlineMs = options.signal ? 0 : requestDeadlineMs(path, options, defaultRequestTimeoutMs);
    // SECURITY BOUNDARY: Trusted Output — gateway fetch policy. Redirects are
    // always rejected (redirect: 'error' is non-overridable) so a compromised
    // endpoint can never bounce the extension to an attacker-controlled host.
    const fetchOptions = { ...options };
    delete fetchOptions.redirect;
    delete fetchOptions.timeoutMs;
    const deadline = deadlineMs > 0 && typeof AbortSignal?.timeout === 'function'
      ? { signal: AbortSignal.timeout(deadlineMs) }
      : {};
    return fetchImpl(`${base}${profileScopedPath(path, connection.activeProfile)}`, {
      redirect: 'error',
      ...fetchOptions,
      ...deadline,
      headers,
    });
  }

  async function listSessions({
    limit = DEFAULT_SESSION_LIMIT,
    maxPages = DEFAULT_MAX_PAGES,
    requestTimeoutMs = SESSION_LIST_TIMEOUT_MS,
  } = {}) {
    const cleanLimit = Math.max(1, Math.min(500, Number(limit) || DEFAULT_SESSION_LIMIT));
    const cleanMaxPages = Math.max(1, Math.min(20, Number(maxPages) || DEFAULT_MAX_PAGES));
    const merged = [];
    const seen = new Set();
    let offset = 0;
    for (let page = 0; page < cleanMaxPages; page += 1) {
      const response = await request(`/api/sessions?limit=${cleanLimit}&offset=${offset}&include_children=true&order=recent`, {
        method: 'GET',
        signal: typeof AbortSignal?.timeout === 'function'
          ? AbortSignal.timeout(Math.max(1, Number(requestTimeoutMs) || SESSION_LIST_TIMEOUT_MS))
          : undefined,
      });
      const payload = await readJson(response);
      if (!response.ok) throw httpError('Session list', response, payload);
      const rows = normalizedRows(payload);
      for (const row of rows) {
        const id = String(row?.id || row?.session_id || '');
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        merged.push(row);
      }
      // Pins are back-filled outside the server's recency window, and the
      // server may cap the requested limit. Neither changes its next offset.
      const pageLimit = Number(payload.limit ?? payload.pagination?.limit);
      const pageOffset = Number(payload.offset ?? payload.pagination?.offset);
      offset = (Number.isFinite(pageOffset) && pageOffset >= 0 ? pageOffset : offset)
        + (Number.isFinite(pageLimit) && pageLimit > 0 ? pageLimit : rows.length);
      const hasMore = Boolean(payload.has_more ?? payload.hasMore ?? payload.pagination?.hasMore);
      const total = Number(payload.total || payload.pagination?.total || 0);
      if (!rows.length || (!hasMore && (!total || offset >= total))) break;
    }
    return merged;
  }

  async function getSessionMessages(sessionId) {
    const cleanSessionId = String(sessionId || '').trim();
    if (!cleanSessionId) return [];
    const response = await request(`/api/sessions/${encodeURIComponent(cleanSessionId)}/messages`, { method: 'GET' });
    const payload = await readJson(response);
    if (!response.ok) throw httpError('Session messages', response, payload);
    return normalizedRows(payload);
  }

  return Object.freeze({
    fetch: request,
    getSessionMessages,
    listSessions,
    readJson,
  });
}
