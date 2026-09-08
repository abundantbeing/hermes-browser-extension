// Chrome-extension pages talking to Hermes Desktop (`hermes serve --port 0`)
// are cross-origin. The dashboard CORS allowlist is only http://127.0.0.1 and
// http://localhost, so Comet/Chromium will hide /api/status and /api/profiles
// unless we rewrite the response ACAO for loopback XHR. The API server on 8642
// already sends Access-Control-Allow-Origin: *; the dashboard does not.
//
// Comet also may skip declarativeNetRequest. The service worker still has
// host_permissions, so dashboard fetches are proxied through the worker.

export const LOOPBACK_CORS_RULE_ID = 7745;
export const LOOPBACK_FETCH_MESSAGE = 'HERMES_LOOPBACK_FETCH';

export function isAllowedLoopbackUrl(url = '') {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'http:') return false;
    if (parsed.username || parsed.password) return false;
    return ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function loopbackCorsRules() {
  return [];
}

export async function installLoopbackCorsRules(dnr = globalThis.chrome?.declarativeNetRequest || globalThis.browser?.declarativeNetRequest) {
  if (!dnr?.updateSessionRules) return false;
  await dnr.updateSessionRules({
    removeRuleIds: [LOOPBACK_CORS_RULE_ID],
    addRules: loopbackCorsRules(),
  });
  return true;
}

export async function handleLoopbackFetchMessage(message, fetchFn = globalThis.fetch?.bind(globalThis)) {
  if (message?.type !== LOOPBACK_FETCH_MESSAGE) return null;
  const url = String(message.url || '');
  if (!isAllowedLoopbackUrl(url)) return { ok: false, error: 'loopback-url-rejected' };
  const method = String(message.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) return { ok: false, error: 'loopback-method-rejected' };
  if (typeof fetchFn !== 'function') return { ok: false, error: 'loopback-fetch-unavailable' };
  const headers = {};
  const incoming = message.headers && typeof message.headers === 'object' ? message.headers : {};
  for (const [key, value] of Object.entries(incoming)) {
    const name = String(key || '').trim();
    if (!name || /[\r\n]/.test(name) || /[\r\n]/.test(String(value ?? ''))) continue;
    headers[name] = String(value ?? '');
  }
  try {
    const timeoutMs = Math.max(250, Math.min(15_000, Number(message.timeoutMs) || 8_000));
    const response = await fetchFn(url, {
      method,
      headers,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    const body = await response.text();
    return {
      ok: true,
      status: response.status,
      body,
      contentType: typeof response.headers?.get === 'function' ? (response.headers.get('content-type') || '') : '',
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), status: 0, body: '' };
  }
}

function asFetchResponse(result) {
  const status = Number(result.status) || 0;
  const body = String(result.body || '');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name = '') => (String(name).toLowerCase() === 'content-type' ? result.contentType || '' : ''),
    },
    text: async () => body,
    json: async () => JSON.parse(body || 'null'),
  };
}

export function createBackgroundLoopbackFetch({ sendMessage, fetchFn = globalThis.fetch?.bind(globalThis) } = {}) {
  return async (url, options = {}) => {
    if (isAllowedLoopbackUrl(url)) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(String(options.method || 'GET').toUpperCase())) {
        throw new Error('loopback-method-rejected');
      }
      options = { ...options, credentials: 'omit', redirect: 'error', cache: 'no-store' };
    }
    if (typeof sendMessage === 'function' && isAllowedLoopbackUrl(url)) {
      try {
        const result = await sendMessage({
          type: LOOPBACK_FETCH_MESSAGE,
          url: String(url),
          method: options.method || 'GET',
          headers: options.headers || {},
          timeoutMs: 8_000,
        });
        if (result?.ok === true && Number(result.status) > 0) return asFetchResponse(result);
      } catch {
        /* worker missing — fall through to page fetch */
      }
    }
    if (typeof fetchFn !== 'function') throw new TypeError('fetch is not available');
    return fetchFn(url, options);
  };
}
