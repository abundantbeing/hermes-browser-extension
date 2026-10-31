// One-use Hermes Web tickets from the paired gateway.
//
// A Hermes gateway that carries the browser-extension pairing patch answers two loopback routes to the
// scoped token this extension already holds (or the API key), so Hermes Web needs no terminal step:
//
//   POST /api/browser-extension/webapp-ticket?profile=         -> { ticket, webapp_url, expires_in_seconds }
//        a one-use Webapp window ticket. `<webapp_url>/webapp/launch#ticket=<ticket>` redeems it into a
//        tab that is signed in; the ticket rides in the fragment, never in a request.
//   POST /api/browser-extension/webapp-socket-ticket?profile= -> { ticket, ws_url, ttl_seconds }
//        a one-use ticket for the Webapp's /api/ws gateway socket, offered as the
//        `hermes-gateway-ticket.<ticket>` subprotocol beside `hermes-gateway-v1`. It gives the panel a
//        session-authority socket without holding the Webapp's long-lived credential.
//
// A route that answers refuses with an `error.code`; a gateway that predates the routes answers a plain
// 404, which is how this module tells the two apart:
//
//   absent          a plain 404: this gateway has no such route (fall back to the held credential, then to
//                   capture, then to the sign-in page)
//   webapp-off      `webapp_off`            the gateway's Webapp is not turned on
//   webapp-not-private  `webapp_not_private`  it is behind sign-in or a public address
//   webapp-unavailable  `webapp_unavailable`  it could not start, or is not built
//   webapp-starting `webapp_starting`       try again in a moment (503)
//
// Nothing here holds a credential: the paired token is read from the caller for each request, goes only
// to the gateway origin as `Authorization`, and is compared in memory to notice a changed connection.
// A negative answer is remembered briefly, so a panel that asks often (the roster, Projects, Settings)
// asks the gateway once and not again until the cache lapses; a user's click always asks again.

export const WEBAPP_TICKET_PATHS = Object.freeze({
  window: '/api/browser-extension/webapp-ticket',
  socket: '/api/browser-extension/webapp-socket-ticket',
});

export const WEBAPP_TICKET_REASONS = Object.freeze({
  NOT_LOCAL: 'not-local',
  NO_TOKEN: 'no-token',
  ABSENT: 'absent',
  OFF: 'webapp-off',
  NOT_PRIVATE: 'webapp-not-private',
  UNAVAILABLE: 'webapp-unavailable',
  STARTING: 'webapp-starting',
  PROFILE: 'profile',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  BUSY: 'busy',
  UNREACHABLE: 'unreachable',
  INVALID: 'invalid',
});

// What each gateway `error.code` means here.
const REASON_BY_CODE = Object.freeze({
  webapp_off: WEBAPP_TICKET_REASONS.OFF,
  webapp_not_private: WEBAPP_TICKET_REASONS.NOT_PRIVATE,
  webapp_unavailable: WEBAPP_TICKET_REASONS.UNAVAILABLE,
  webapp_starting: WEBAPP_TICKET_REASONS.STARTING,
  invalid_profile: WEBAPP_TICKET_REASONS.PROFILE,
  profile_not_found: WEBAPP_TICKET_REASONS.PROFILE,
  webapp_tickets_exhausted: WEBAPP_TICKET_REASONS.BUSY,
  webapp_ticket_loopback_only: WEBAPP_TICKET_REASONS.FORBIDDEN,
});

// Answers worth remembering for a while (ms). A gateway upgraded and restarted while the panel stays
// open starts answering within this, and a click on Hermes Web never waits for it.
const NEGATIVE_CACHE_MS = Object.freeze({
  [WEBAPP_TICKET_REASONS.ABSENT]: 2 * 60_000,
  [WEBAPP_TICKET_REASONS.OFF]: 30_000,
  [WEBAPP_TICKET_REASONS.NOT_PRIVATE]: 30_000,
  [WEBAPP_TICKET_REASONS.UNAVAILABLE]: 30_000,
});

const REQUEST_TIMEOUT_MS = 5000;
const HANDOFF_TICKET = /^[A-Za-z0-9_-]{43}$/;
// A socket ticket is only ever offered as a WebSocket subprotocol token, so hold it to that alphabet.
const SOCKET_TICKET = /^[A-Za-z0-9._~-]{1,200}$/;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isLoopbackHostname(hostname = '') {
  const host = String(hostname).toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
}

/** A loopback http origin the Webapp may be opened at; '' for anything else (the gateway names it). */
export function webappOriginOf(value = '') {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' || url.username || url.password || !isLoopbackHostname(url.hostname)) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function gatewayBase(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'http:' || url.username || url.password || !isLoopbackHostname(url.hostname)) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function requestSignal(ms) {
  if (typeof AbortSignal?.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function profileQuery(profile = '') {
  const name = typeof profile === 'string' ? profile.trim() : '';
  if (!name || name.toLowerCase() === 'default' || !PROFILE_NAME.test(name)) return '';
  return `?${new URLSearchParams({ profile: name }).toString()}`;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** The address that opens a new, signed-in Hermes Web tab from a window ticket. '' for a bad ticket or origin. */
export function webappTicketLaunchUrl(webappUrl, ticket, { profile = '' } = {}) {
  const origin = webappOriginOf(webappUrl);
  if (!origin || !HANDOFF_TICKET.test(String(ticket || ''))) return '';
  const params = new URLSearchParams();
  params.set('ticket', String(ticket));
  const name = typeof profile === 'string' ? profile.trim() : '';
  if (name && name.toLowerCase() !== 'default' && PROFILE_NAME.test(name)) {
    params.set('query', new URLSearchParams({ profile: name }).toString());
  }
  return `${origin}/webapp/launch#${params.toString()}`;
}

/**
 * @param {object} options
 * @param {() => ({ gatewayUrl?: string, token?: string, local?: boolean } | Promise<...>)} options.getConnection
 *   the gateway this panel talks to: its URL, the paired token or API key, and whether it is the local gateway
 * @param {Function} [options.fetchImpl]
 * @param {() => number} [options.now]
 */
export function createWebappGatewayTickets({
  getConnection,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  now = () => Date.now(),
} = {}) {
  if (typeof getConnection !== 'function') throw new TypeError('getConnection must be a function.');
  let remembered = null; // { key, reason, until }
  let lastKey = '';
  let serving = false;

  async function connection() {
    let raw = null;
    try {
      raw = (await getConnection()) || {};
    } catch {
      raw = {};
    }
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';
    const base = gatewayBase(raw.gatewayUrl);
    return { base, token, local: raw.local !== false, key: `${base}\n${token}` };
  }

  // Ask the gateway once. Never throws.
  async function ask(kind, { profile = '', force = false } = {}) {
    const conn = await connection();
    if (!conn.local || !conn.base) return { ok: false, reason: WEBAPP_TICKET_REASONS.NOT_LOCAL };
    if (!conn.token) return { ok: false, reason: WEBAPP_TICKET_REASONS.NO_TOKEN };
    if (conn.key !== lastKey) {
      lastKey = conn.key;
      remembered = null;
      serving = false;
    }
    if (!force && remembered && remembered.until > now()) return { ok: false, reason: remembered.reason, cached: true };
    if (typeof fetchImpl !== 'function') return { ok: false, reason: WEBAPP_TICKET_REASONS.UNREACHABLE };
    let response;
    try {
      response = await fetchImpl(`${conn.base}${WEBAPP_TICKET_PATHS[kind]}${profileQuery(profile)}`, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${conn.token}` },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: requestSignal(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: WEBAPP_TICKET_REASONS.UNREACHABLE };
    }
    const status = Number(response?.status) || 0;
    if (response?.ok) {
      serving = true;
      remembered = null;
      return { ok: true, status, payload: await readJson(response), base: conn.base };
    }
    const payload = await readJson(response);
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : '';
    let reason;
    if (code && REASON_BY_CODE[code]) reason = REASON_BY_CODE[code];
    else if (status === 401) reason = WEBAPP_TICKET_REASONS.UNAUTHORIZED;
    else if (status === 403) reason = WEBAPP_TICKET_REASONS.FORBIDDEN;
    else if (status === 404 && !code) reason = WEBAPP_TICKET_REASONS.ABSENT;
    else if (status === 429) reason = WEBAPP_TICKET_REASONS.BUSY;
    else if (status === 400) reason = WEBAPP_TICKET_REASONS.PROFILE;
    else reason = WEBAPP_TICKET_REASONS.UNREACHABLE;
    if (reason !== WEBAPP_TICKET_REASONS.UNAUTHORIZED && NEGATIVE_CACHE_MS[reason]) {
      remembered = { key: conn.key, reason, until: now() + NEGATIVE_CACHE_MS[reason] };
    }
    serving = false;
    return { ok: false, reason, status, ...(code ? { code } : {}) };
  }

  /**
   * A one-use window ticket: { ok: true, ticket, webappUrl, origin, expiresInSeconds } or { ok: false, reason }.
   * `force` skips what was remembered (a click on Hermes Web).
   */
  async function windowTicket({ profile = '', force = false } = {}) {
    const result = await ask('window', { profile, force });
    if (!result.ok) return result;
    const ticket = typeof result.payload?.ticket === 'string' ? result.payload.ticket : '';
    const origin = webappOriginOf(result.payload?.webapp_url);
    if (!HANDOFF_TICKET.test(ticket) || !origin) return { ok: false, reason: WEBAPP_TICKET_REASONS.INVALID };
    const expires = Number(result.payload?.expires_in_seconds);
    return { ok: true, ticket, webappUrl: origin, origin, expiresInSeconds: Number.isFinite(expires) && expires > 0 ? expires : 30 };
  }

  /**
   * A one-use ticket for one dial of the Webapp's /api/ws: { ok: true, ticket, wsUrl, baseUrl, origin, ttlSeconds }
   * or { ok: false, reason }. `baseUrl` is the Webapp's origin; the socket is `wsUrl`.
   */
  async function socketTicket({ profile = '', force = false } = {}) {
    const result = await ask('socket', { profile, force });
    if (!result.ok) return result;
    const ticket = typeof result.payload?.ticket === 'string' ? result.payload.ticket : '';
    let wsUrl = '';
    let origin = '';
    try {
      const parsed = new URL(String(result.payload?.ws_url || ''));
      origin = webappOriginOf(`http://${parsed.host}`);
      if (['ws:'].includes(parsed.protocol) && origin && parsed.pathname === '/api/ws' && !parsed.search && !parsed.hash) wsUrl = parsed.href;
    } catch {
      /* wsUrl stays empty */
    }
    if (!SOCKET_TICKET.test(ticket) || !wsUrl) return { ok: false, reason: WEBAPP_TICKET_REASONS.INVALID };
    const ttl = Number(result.payload?.ttl_seconds);
    return { ok: true, ticket, wsUrl, baseUrl: origin, origin, ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 30 };
  }

  /** What this connection last taught: whether the routes exist and whether the gateway's Webapp is serving. */
  function status() {
    const reason = remembered && remembered.until > now() ? remembered.reason : '';
    return {
      routes: reason === WEBAPP_TICKET_REASONS.ABSENT ? 'absent' : (reason || serving ? 'present' : 'unknown'),
      webapp: serving ? 'serving' : (reason && reason !== WEBAPP_TICKET_REASONS.ABSENT ? reason : 'unknown'),
      reason,
    };
  }

  function forget() {
    remembered = null;
    serving = false;
    lastKey = '';
  }

  return { windowTicket, socketTicket, status, forget, launchUrl: webappTicketLaunchUrl };
}
