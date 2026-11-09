// Tries a connection before it is saved: does the address answer as Hermes, can it serve chat, and is the
// key accepted. Used by the Add connection window. Nothing here changes any setting.

import { PROBE_PARAM, connectionHeadersAsObject } from './connection-headers.mjs';

const DEFAULT_TIMEOUT_MS = 6000;
const HERMES_PLATFORM = 'hermes-agent';

function cancellation(signal, ms) {
  const timeout = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : null;
  const signals = [signal, timeout].filter(Boolean);
  if (!signals.length) return {};
  if (signals.length === 1) return { signal: signals[0] };
  return typeof AbortSignal?.any === 'function' ? { signal: AbortSignal.any(signals) } : { signal };
}

async function jsonOf(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{ ok: boolean, status: 'ok'|'unreachable'|'unauthorized'|'not-hermes'|'untested', detail?: string }>}
 * unreachable covers a refused connection, a timeout and a certificate the browser does not accept: a browser
 * reports all of them the same way, so the window offers to open the address when it is https.
 * 'untested' with detail 'needs-sign-in' means the gateway asks for a sign-in this test cannot make.
 * `marker` rides in each request's query so a rule made for this test alone can match it.
 */
export async function probeConnection({
  gatewayUrl,
  apiKey = '',
  headers = [],
  marker = '',
  signal = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const base = String(gatewayUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: true, status: 'untested' };
  const extra = connectionHeadersAsObject(headers);
  const withMarker = (path) => (marker ? `${path}${path.includes('?') ? '&' : '?'}${PROBE_PARAM}=${marker}` : path);
  const request = (path, auth) => fetchImpl(`${base}${withMarker(path)}`, {
    method: 'GET',
    redirect: 'error',
    cache: 'no-store',
    headers: { Accept: 'application/json', ...extra, ...(auth && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    ...cancellation(signal, timeoutMs),
  });
  const refused = (response) => response.status === 401 || response.status === 403;
  const needsSignIn = () => (apiKey ? { ok: false, status: 'unauthorized' } : { ok: true, status: 'untested', detail: 'needs-sign-in' });
  let health;
  try {
    health = await request('/health', false);
  } catch (error) {
    return { ok: false, status: 'unreachable', detail: String(error?.message || error) };
  }
  if (refused(health)) return needsSignIn();
  if (!health.ok) return { ok: false, status: 'not-hermes', detail: `HTTP ${health.status}` };
  if ((await jsonOf(health))?.platform !== HERMES_PLATFORM) return { ok: false, status: 'not-hermes', detail: 'platform' };
  let sessions;
  try {
    sessions = await request('/api/sessions?limit=1', true);
  } catch (error) {
    return { ok: false, status: 'unreachable', detail: String(error?.message || error) };
  }
  if (refused(sessions)) return needsSignIn();
  if (!sessions.ok) return { ok: false, status: 'not-hermes', detail: `HTTP ${sessions.status}` };
  return { ok: true, status: 'ok' };
}
