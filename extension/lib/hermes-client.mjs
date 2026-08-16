const DEFAULT_SESSION_LIMIT = 200;
const DEFAULT_MAX_PAGES = 10;
const MAX_ERROR_BODY = 500;
const AUTH_SCHEME = 'Bearer';

function normalizeBaseUrl(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
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

export function createHermesClient({ fetchImpl = globalThis.fetch, getConnection } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');
  if (typeof getConnection !== 'function') throw new TypeError('getConnection must be a function.');

  async function request(path, options = {}) {
    const connection = getConnection() || {};
    const base = normalizeBaseUrl(connection.gatewayUrl);
    if (!base) throw new Error('Hermes gateway URL is not configured.');
    const hasBody = typeof options.body !== 'undefined';
    const headers = {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(connection.apiKey ? { Authorization: AUTH_SCHEME.concat(' ', connection.apiKey) } : {}),
      ...(connection.activeProfile ? { 'X-Hermes-Profile': connection.activeProfile } : {}),
      ...(options.headers || {}),
    };
    // SECURITY BOUNDARY: Trusted Output — gateway fetch policy. Redirects are
    // always rejected (redirect: 'error' is non-overridable) so a compromised
    // endpoint can never bounce the extension to an attacker-controlled host.
    const { redirect: _ignoredRedirect, ...rest } = options;
    return fetchImpl(`${base}${String(path || '').startsWith('/') ? path : `/${path}`}`, {
      redirect: 'error',
      ...rest,
      headers,
    });
  }

  async function listSessions({ limit = DEFAULT_SESSION_LIMIT, maxPages = DEFAULT_MAX_PAGES } = {}) {
    const cleanLimit = Math.max(1, Math.min(500, Number(limit) || DEFAULT_SESSION_LIMIT));
    const cleanMaxPages = Math.max(1, Math.min(20, Number(maxPages) || DEFAULT_MAX_PAGES));
    const merged = [];
    let offset = 0;
    for (let page = 0; page < cleanMaxPages; page += 1) {
      const response = await request(`/api/sessions?limit=${cleanLimit}&offset=${offset}&include_children=true&order=recent`, { method: 'GET' });
      const payload = await readJson(response);
      if (!response.ok) throw httpError('Session list', response, payload);
      const rows = normalizedRows(payload);
      merged.push(...rows);
      offset += rows.length;
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
