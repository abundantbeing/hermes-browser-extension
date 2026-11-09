// Tries a connection before it is saved: does the address answer as Hermes, and is the key accepted.
// Used by the Add connection window. Nothing here changes any setting.

import { connectionHeadersAsObject } from './connection-headers.mjs';

const DEFAULT_TIMEOUT_MS = 6000;

function withTimeout(ms) {
  return typeof AbortSignal?.timeout === 'function' ? { signal: AbortSignal.timeout(ms) } : {};
}

/**
 * @returns {Promise<{ ok: boolean, status: 'ok'|'unreachable'|'unauthorized'|'not-hermes'|'untested', detail?: string }>}
 * unreachable covers a refused connection, a timeout and a certificate the browser does not accept: a browser
 * reports all of them the same way, so the window offers to open the address when it is https.
 */
export async function probeConnection({
  gatewayUrl,
  apiKey = '',
  headers = [],
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const base = String(gatewayUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: true, status: 'untested' };
  const extra = connectionHeadersAsObject(headers);
  const request = (path, auth) => fetchImpl(`${base}${path}`, {
    method: 'GET',
    redirect: 'error',
    cache: 'no-store',
    headers: { Accept: 'application/json', ...extra, ...(auth && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    ...withTimeout(timeoutMs),
  });
  let health;
  try {
    health = await request('/health', false);
  } catch (error) {
    return { ok: false, status: 'unreachable', detail: String(error?.message || error) };
  }
  if (health.status === 401 || health.status === 403) {
    return apiKey ? { ok: false, status: 'unauthorized' } : { ok: true, status: 'untested', detail: 'needs-sign-in' };
  }
  if (!health.ok) return { ok: false, status: 'not-hermes', detail: `HTTP ${health.status}` };
  if (apiKey) {
    try {
      const sessions = await request('/api/sessions?limit=1', true);
      if (sessions.status === 401 || sessions.status === 403) return { ok: false, status: 'unauthorized' };
    } catch (error) {
      return { ok: false, status: 'unreachable', detail: String(error?.message || error) };
    }
  }
  return { ok: true, status: 'ok' };
}
