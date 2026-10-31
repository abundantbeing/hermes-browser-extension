// Hermes account sign-in: RFC 8252 native-app sign-in against a gateway's dashboard / Webapp listener, the
// same flow the Hermes Android app uses.
//
//   1. GET  <origin>/auth/native/authorize?provider=&code_challenge=<S256>&code_challenge_method=S256
//           &redirect_uri=http://127.0.0.1:<port>/hermes-browser-callback&state=<state>
//      runs the provider login in a popup window (an OAuth provider, or the gateway's own /login form).
//   2. The browser is sent to the loopback redirect. Nothing listens there and an extension cannot listen on a
//      port, so the redirect is only OBSERVED (webRequest, with the tab URL as a second witness): the code and
//      state are read from the URL and the window is closed. The request itself is never served and never made
//      by this module, so a remote connection still never reaches 127.0.0.1.
//   3. POST <origin>/auth/native/token {code, code_verifier}      -> { access_token, refresh_token, expires_at, ... }
//   4. POST <origin>/auth/native/refresh {refresh_token, provider} -> rotated tokens, or 401 session_expired
//   5. POST <origin>/api/auth/ws-ticket  (Authorization: Bearer <access>) -> a 30 s one-use ticket for /api/ws,
//      offered as the `hermes-gateway-ticket.<ticket>` WebSocket subprotocol beside `hermes-gateway-v1`.
//
// What this works on: a GATED listener (`/api/status` says `auth_required: true` and `auth_flows` has
// `native_pkce`: a remote gateway, or a local one behind sign-in). On an ungated loopback listener the routes
// are mounted but `/api/auth/ws-ticket` answers 401 (it needs a verified session, which only the gate
// attaches) and `/api/ws` takes only the browser session token there, so a native sign-in opens nothing.
// `probeAccountSupport()` reads that from `/api/status` so the panel never offers a sign-in that cannot work.
//
// Tokens: held per gateway origin in storage.local (so they last across browser restarts, like the phone's),
// never put in a URL, never logged. Every object that carries them redacts itself in toString / toJSON /
// util.inspect. A refresh 401 `session_expired`, a sign-out, or a change of the connection clears them.
//
// Every browser API is injected, so the module is pure apart from the fetch and storage it is given.

export const ACCOUNT_STORAGE_KEY = 'hermesAccountSessions';
export const ACCOUNT_CALLBACK_PATH = '/hermes-browser-callback';
export const ACCOUNT_REFRESH_MARGIN_SECONDS = 60;
export const ACCOUNT_SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
export const ACCOUNT_PORT_RANGE = Object.freeze({ min: 49152, max: 65535 });
export const ACCOUNT_WEB_REQUEST_PERMISSION = 'webRequest';
const REQUEST_TIMEOUT_MS = 15_000;
const TICKET_PATTERN = /^[A-Za-z0-9._~-]{1,200}$/;
const MAX_SESSIONS = 16;

export const ACCOUNT_REASONS = Object.freeze({
  NO_ORIGIN: 'no-origin',
  NOT_GATED: 'not-gated',
  NO_NATIVE_FLOW: 'no-native-flow',
  UNREACHABLE: 'unreachable',
  SIGNED_OUT: 'signed-out',
  EXPIRED: 'session-expired',
  UNAVAILABLE: 'unavailable',
  NO_PERMISSION: 'no-permission',
  NO_WINDOW: 'no-window',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  STATE_MISMATCH: 'state-mismatch',
  PROVIDER_DENIED: 'provider-denied',
  EXCHANGE_REJECTED: 'exchange-rejected',
  BAD_RESPONSE: 'bad-response',
  MISSING_CODE: 'missing-code',
  BUSY: 'busy',
});

const REDACTED = '<redacted>';

// ---- Origins ------------------------------------------------------------------------------------------------

export function isLoopbackHostname(hostname = '') {
  const host = String(hostname).toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
}

/**
 * The origin a sign-in may be run against: https anywhere, or http on a loopback address (a local gateway behind
 * sign-in). Tokens never go over plain http to another host. '' for anything else.
 */
export function accountOriginOf(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    if (url.username || url.password) return '';
    if (url.protocol === 'https:') return url.origin;
    if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url.origin;
    return '';
  } catch {
    return '';
  }
}

export function isLoopbackOrigin(origin = '') {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Where the sign-in may be run for a connection. A local gateway: the loopback listeners named (the dashboard
 * discovery found, the Hermes Web address). Any remote connection: the gateway's own origin and nothing on this
 * machine, whatever else is passed in, so a remote connection can never reach 127.0.0.1 (local-dashboard-scope).
 */
export function accountOriginsFor({ gatewayMode = '', gatewayUrl = '', loopbackOrigins = [] } = {}) {
  if (String(gatewayMode || '').trim().toLowerCase() === 'local-api') {
    const found = [];
    for (const candidate of Array.isArray(loopbackOrigins) ? loopbackOrigins : []) {
      const origin = accountOriginOf(candidate);
      if (origin && isLoopbackOrigin(origin) && !found.includes(origin)) found.push(origin);
    }
    return found;
  }
  const origin = accountOriginOf(gatewayUrl);
  return origin && !isLoopbackOrigin(origin) ? [origin] : [];
}

/** What a stored sign-in is bound to: a different mode or gateway address is a different connection. */
export function accountConnectionKey({ gatewayMode = '', gatewayUrl = '' } = {}) {
  let base = '';
  try {
    base = new URL(String(gatewayUrl || '').trim()).origin;
  } catch {
    base = String(gatewayUrl || '').trim();
  }
  return `${String(gatewayMode || '').trim().toLowerCase()}|${base}`;
}

function joinUrl(base, path) {
  try {
    const url = new URL(String(base || ''));
    url.hash = '';
    url.search = '';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
    return url.toString();
  } catch {
    return '';
  }
}

// ---- PKCE ---------------------------------------------------------------------------------------------------

export function base64UrlEncode(bytes) {
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBytes(count, cryptoImpl) {
  const bytes = new Uint8Array(count);
  cryptoImpl.getRandomValues(bytes);
  return bytes;
}

/** S256: base64url(sha256(ascii(verifier))), no padding (RFC 7636). */
export async function pkceChallengeFor(verifier, cryptoImpl = globalThis.crypto) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(String(verifier)));
  return base64UrlEncode(new Uint8Array(digest));
}

/** A fresh verifier (32 random bytes, 43 characters), its S256 challenge and an opaque state (24 bytes). */
export async function generatePkce(cryptoImpl = globalThis.crypto) {
  const verifier = base64UrlEncode(randomBytes(32, cryptoImpl));
  const challenge = await pkceChallengeFor(verifier, cryptoImpl);
  const state = base64UrlEncode(randomBytes(24, cryptoImpl));
  return { verifier, challenge, state };
}

// ---- The loopback redirect ----------------------------------------------------------------------------------

/** A random port in the dynamic range. Nothing is probed: a probe would be a request to 127.0.0.1. */
export function pickRedirectPort(random = Math.random) {
  const { min, max } = ACCOUNT_PORT_RANGE;
  return min + Math.floor(random() * (max - min + 1));
}

/** The canonical RFC 8252 loopback redirect the gateway accepts: http://127.0.0.1:<port>/hermes-browser-callback. */
export function buildRedirectUri(port) {
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new RangeError('A valid loopback port is required.');
  return `http://127.0.0.1:${number}${ACCOUNT_CALLBACK_PATH}`;
}

export function buildAuthorizeUrl({ baseUrl, provider = '', challenge, redirectUri, state } = {}) {
  const endpoint = joinUrl(baseUrl, '/auth/native/authorize');
  if (!endpoint || !challenge || !redirectUri || !state) throw new TypeError('An authorize URL needs a base URL, challenge, redirect URI and state.');
  const url = new URL(endpoint);
  url.searchParams.set('provider', String(provider || ''));
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

function constantTimeEquals(a, b) {
  const left = String(a);
  const right = String(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * Judge one URL the browser was about to load against the redirect this sign-in asked for.
 *   { match: false }                          not ours: another page, another port, another path (keep waiting)
 *   { match: true, ok: true, code }           the callback, with the state this sign-in generated
 *   { match: true, ok: false, reason }        the callback, refused: state-mismatch, provider-denied,
 *                                             missing-code or bad-response (a duplicated parameter)
 * The query string is never returned or logged beyond the code.
 */
export function parseCallbackUrl(rawUrl, { redirectUri, expectedState } = {}) {
  let url;
  let target;
  try {
    url = new URL(String(rawUrl || ''));
    target = new URL(String(redirectUri || ''));
  } catch {
    return { match: false };
  }
  if (url.protocol !== target.protocol || url.hostname !== target.hostname || url.port !== target.port
    || url.pathname !== target.pathname || url.username || url.password) {
    return { match: false };
  }
  const seen = { code: [], state: [], error: [] };
  for (const [key, value] of url.searchParams) if (key in seen) seen[key].push(value);
  if (seen.code.length > 1 || seen.state.length > 1 || seen.error.length > 1) {
    return { match: true, ok: false, reason: ACCOUNT_REASONS.BAD_RESPONSE };
  }
  const state = seen.state[0];
  if (typeof state !== 'string' || !expectedState || !constantTimeEquals(state, expectedState)) {
    return { match: true, ok: false, reason: ACCOUNT_REASONS.STATE_MISMATCH };
  }
  if (seen.error.length) return { match: true, ok: false, reason: ACCOUNT_REASONS.PROVIDER_DENIED };
  const code = seen.code[0];
  if (!code) return { match: true, ok: false, reason: ACCOUNT_REASONS.MISSING_CODE };
  return { match: true, ok: true, code };
}

// ---- Optional permission ------------------------------------------------------------------------------------

export async function hasWebRequestPermission(permissionsApi) {
  if (typeof permissionsApi?.contains !== 'function') return false;
  try {
    return (await permissionsApi.contains({ permissions: [ACCOUNT_WEB_REQUEST_PERMISSION] })) === true;
  } catch {
    return false;
  }
}

/**
 * Ask for the one optional permission the capture needs. Call it FIRST in the Sign in click handler: a browser
 * refuses a request that does not come from user input, and any await before it spends the gesture.
 */
export function requestWebRequestPermission(permissionsApi) {
  if (typeof permissionsApi?.request !== 'function') return Promise.resolve(false);
  try {
    return Promise.resolve(permissionsApi.request({ permissions: [ACCOUNT_WEB_REQUEST_PERMISSION] })).then((granted) => granted === true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

// ---- Code capture -------------------------------------------------------------------------------------------

/**
 * Watch for the browser being sent to the loopback redirect. Resolves { ok: true, code } or { ok: false, reason }.
 * `webRequestApi.onBeforeRequest` sees every hop of a redirect chain before it connects (the gateway's own 302 to
 * the loopback URL, or the login page's script navigation); `tabsApi.onUpdated` is a second witness that needs no
 * permission. A URL that is not the redirect (a foreign page, another port) is ignored. A callback whose state is
 * not this sign-in's fails at once and its code is dropped. Every listener is removed before this settles.
 */
export function watchForCallback({
  redirectUri,
  expectedState,
  webRequestApi = null,
  tabsApi = null,
  timeoutMs = ACCOUNT_SIGN_IN_TIMEOUT_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let settle = () => {};
  const done = new Promise((resolve) => { settle = resolve; });
  let finished = false;
  let timer = null;
  const cleanups = [];

  const finish = (result) => {
    if (finished) return;
    finished = true;
    if (timer !== null) clearTimer(timer);
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* a listener that is already gone */ }
    }
    settle(result);
  };

  const consider = (rawUrl) => {
    if (finished || !rawUrl) return;
    const verdict = parseCallbackUrl(rawUrl, { redirectUri, expectedState });
    if (!verdict.match) return;
    finish(verdict.ok ? { ok: true, code: verdict.code } : { ok: false, reason: verdict.reason });
  };

  let target;
  try {
    target = new URL(redirectUri);
  } catch {
    finish({ ok: false, reason: ACCOUNT_REASONS.BAD_RESPONSE });
    return { done, cancel: () => {} };
  }

  if (webRequestApi?.onBeforeRequest?.addListener) {
    const listener = (details) => consider(details?.url);
    // A match pattern names no port: the exact redirect (port, path, state) is judged in consider().
    webRequestApi.onBeforeRequest.addListener(listener, { urls: [`${target.protocol}//${target.hostname}${target.pathname}*`] });
    cleanups.push(() => webRequestApi.onBeforeRequest.removeListener(listener));
  }
  if (tabsApi?.onUpdated?.addListener) {
    const listener = (_tabId, changeInfo, tab) => {
      consider(changeInfo?.url);
      consider(tab?.pendingUrl);
      consider(tab?.url);
    };
    tabsApi.onUpdated.addListener(listener);
    cleanups.push(() => tabsApi.onUpdated.removeListener(listener));
  }
  if (!cleanups.length) {
    finish({ ok: false, reason: ACCOUNT_REASONS.NO_PERMISSION });
  } else {
    timer = setTimer(() => finish({ ok: false, reason: ACCOUNT_REASONS.TIMEOUT }), timeoutMs);
  }
  return { done, cancel: (reason = ACCOUNT_REASONS.CANCELLED) => finish({ ok: false, reason }) };
}

/**
 * Open the provider's sign-in in a popup window (the panel in the parent window stays open), else a tab.
 * Resolves { close(), closed } where `closed` settles when the person closes it themselves.
 */
export async function openSignInWindow(url, { windowsApi = null, tabsApi = null } = {}) {
  if (typeof windowsApi?.create === 'function') {
    const created = await windowsApi.create({ url, type: 'popup', width: 520, height: 760, focused: true });
    const windowId = created?.id;
    let notify = () => {};
    const closed = new Promise((resolve) => { notify = resolve; });
    const onRemoved = (id) => { if (id === windowId) notify(true); };
    windowsApi.onRemoved?.addListener?.(onRemoved);
    return {
      closed,
      async close() {
        windowsApi.onRemoved?.removeListener?.(onRemoved);
        if (windowId === undefined) return;
        try { await windowsApi.remove(windowId); } catch { /* already closed */ }
      },
    };
  }
  if (typeof tabsApi?.create === 'function') {
    const created = await tabsApi.create({ url, active: true });
    const tabId = created?.id;
    let notify = () => {};
    const closed = new Promise((resolve) => { notify = resolve; });
    const onRemoved = (id) => { if (id === tabId) notify(true); };
    tabsApi.onRemoved?.addListener?.(onRemoved);
    return {
      closed,
      async close() {
        tabsApi.onRemoved?.removeListener?.(onRemoved);
        if (tabId === undefined) return;
        try { await tabsApi.remove(tabId); } catch { /* already closed */ }
      },
    };
  }
  throw Object.assign(new Error('This browser cannot open a sign-in window.'), { reason: ACCOUNT_REASONS.NO_WINDOW });
}

// ---- Sessions (redacting) -----------------------------------------------------------------------------------

/** A stored sign-in. Tokens are readable only through accessToken / refreshToken / serialize(). */
export class AccountSession {
  #access;
  #refresh;

  constructor({ origin, connectionKey = '', accessToken, refreshToken, expiresAt = 0, provider = '', userId = '', email = '', displayName = '', savedAt = 0 } = {}) {
    this.origin = String(origin || '');
    this.connectionKey = String(connectionKey || '');
    this.#access = String(accessToken || '');
    this.#refresh = String(refreshToken || '');
    this.expiresAt = Number(expiresAt) || 0;
    this.provider = String(provider || '');
    this.userId = String(userId || '');
    this.email = String(email || '');
    this.displayName = String(displayName || '');
    this.savedAt = Number(savedAt) || 0;
  }

  get accessToken() { return this.#access; }
  get refreshToken() { return this.#refresh; }

  with(patch = {}) {
    return new AccountSession({ ...this.serialize(), ...patch });
  }

  /** The only way the tokens leave: for the storage area. */
  serialize() {
    return {
      origin: this.origin,
      connectionKey: this.connectionKey,
      accessToken: this.#access,
      refreshToken: this.#refresh,
      expiresAt: this.expiresAt,
      provider: this.provider,
      userId: this.userId,
      email: this.email,
      displayName: this.displayName,
      savedAt: this.savedAt,
    };
  }

  /** What the UI and a log may see. */
  summary() {
    return {
      origin: this.origin,
      provider: this.provider,
      userId: this.userId,
      email: this.email,
      displayName: this.displayName,
      expiresAt: this.expiresAt,
    };
  }

  toString() {
    return `AccountSession(origin=${this.origin}, accessToken=${REDACTED}, refreshToken=${REDACTED}, expiresAt=${this.expiresAt}, provider=${this.provider})`;
  }

  toJSON() {
    return { ...this.summary(), accessToken: REDACTED, refreshToken: REDACTED };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return this.toString();
  }
}

function sessionFromStored(value) {
  if (!value || typeof value !== 'object') return null;
  const origin = accountOriginOf(value.origin);
  if (!origin || typeof value.accessToken !== 'string' || typeof value.refreshToken !== 'string' || !value.refreshToken) return null;
  return new AccountSession({ ...value, origin });
}

/**
 * Sign-ins per gateway origin in storage.local. `storageArea` is chrome.storage.local (get/set/remove).
 * Reads are validated; a record that is not a sign-in is dropped.
 */
export function createAccountStore({ storageArea = null, now = () => Date.now(), locks = globalThis.navigator?.locks } = {}) {
  let memory = {};
  let broken = false;
  let tail = Promise.resolve();
  const hasLocks = typeof locks?.request === 'function';
  // The stored map is shared by all origins, so the lock must cover the whole map.
  // Without cross-document locks, use only private memory rather than race shared storage.
  const usable = () => hasLocks && !broken && typeof storageArea?.get === 'function' && typeof storageArea?.set === 'function';
  const exclusive = (fn) => {
    if (hasLocks) return locks.request('hermes-account-sessions', fn);
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };

  async function readAll() {
    if (usable()) {
      try {
        const stored = await storageArea.get(ACCOUNT_STORAGE_KEY);
        const raw = stored?.[ACCOUNT_STORAGE_KEY];
        const out = {};
        if (raw && typeof raw === 'object') {
          for (const value of Object.values(raw)) {
            const session = sessionFromStored(value);
            if (session) out[session.origin] = session;
          }
        }
        return out;
      } catch {
        broken = true;
      }
    }
    return { ...memory };
  }

  async function writeAll(map) {
    const entries = Object.values(map).sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_SESSIONS);
    const plain = Object.fromEntries(entries.map((session) => [session.origin, session.serialize()]));
    if (usable()) {
      try {
        if (entries.length) await storageArea.set({ [ACCOUNT_STORAGE_KEY]: plain });
        else if (typeof storageArea.remove === 'function') await storageArea.remove(ACCOUNT_STORAGE_KEY);
        else await storageArea.set({ [ACCOUNT_STORAGE_KEY]: {} });
        memory = {};
        return;
      } catch {
        broken = true;
      }
    }
    memory = Object.fromEntries(entries.map((session) => [session.origin, session]));
  }

  const unlocked = {
    async get(origin) {
      return (await readAll())[accountOriginOf(origin)] || null;
    },
    async save(session) {
      const map = await readAll();
      const next = session instanceof AccountSession ? session : new AccountSession(session);
      if (!accountOriginOf(next.origin) || !next.refreshToken) return false;
      map[next.origin] = next.with({ savedAt: now() });
      await writeAll(map);
      return true;
    },
    async clear(origin) {
      const map = await readAll();
      const key = accountOriginOf(origin);
      if (!map[key]) return false;
      delete map[key];
      await writeAll(map);
      return true;
    },
    async clearAll() {
      const had = Object.keys(await readAll()).length > 0;
      await writeAll({});
      return had;
    },
    /** Drop every sign-in that is bound to another connection than this one. Returns the origins dropped. */
    async clearUnlessConnection(connectionKey) {
      const map = await readAll();
      const dropped = [];
      for (const [origin, session] of Object.entries(map)) {
        if (session.connectionKey && session.connectionKey !== connectionKey) {
          dropped.push(origin);
          delete map[origin];
        }
      }
      if (dropped.length) await writeAll(map);
      return dropped;
    },
    async list() {
      return Object.values(await readAll());
    },
  };
  return {
    get: unlocked.get,
    list: unlocked.list,
    save: (session) => exclusive(() => unlocked.save(session)),
    clear: (origin) => exclusive(() => unlocked.clear(origin)),
    clearAll: () => exclusive(() => unlocked.clearAll()),
    clearUnlessConnection: (key) => exclusive(() => unlocked.clearUnlessConnection(key)),
    runExclusive: (fn) => exclusive(() => fn(unlocked)),
  };
}

// ---- Client -------------------------------------------------------------------------------------------------

function requestSignal(ms) {
  if (typeof AbortSignal?.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Whether this origin can be signed in to, from its public /api/status:
 *   { available: true, providers }   gated, and it advertises the native flow
 *   { available: false, reason }     not-gated (an ungated loopback listener takes no account sign-in:
 *                                    ws-ticket needs a gate-verified session), no-native-flow (an older
 *                                    gateway), unreachable, no-origin
 */
export async function probeAccountSupport(origin, { fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
  const base = accountOriginOf(origin);
  if (!base) return { available: false, reason: ACCOUNT_REASONS.NO_ORIGIN };
  if (typeof fetchImpl !== 'function') return { available: false, reason: ACCOUNT_REASONS.UNREACHABLE };
  let payload = null;
  try {
    const response = await fetchImpl(joinUrl(origin, '/api/status'), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: requestSignal(5000),
    });
    if (!response?.ok) return { available: false, reason: ACCOUNT_REASONS.UNREACHABLE };
    payload = await readJson(response);
  } catch {
    return { available: false, reason: ACCOUNT_REASONS.UNREACHABLE };
  }
  if (!payload || typeof payload !== 'object') return { available: false, reason: ACCOUNT_REASONS.UNREACHABLE };
  if (payload.auth_required !== true) return { available: false, reason: ACCOUNT_REASONS.NOT_GATED };
  const flows = Array.isArray(payload.auth_flows) ? payload.auth_flows : [];
  if (!flows.includes('native_pkce')) return { available: false, reason: ACCOUNT_REASONS.NO_NATIVE_FLOW };
  return { available: true, providers: Array.isArray(payload.auth_providers) ? payload.auth_providers.map(String) : [] };
}

/**
 * @param {object} options
 * @param {ReturnType<typeof createAccountStore>} options.store
 * @param {Function} [options.fetchImpl]
 * @param {() => number} [options.now]            milliseconds
 * @param {Crypto} [options.cryptoImpl]
 * @param {() => number} [options.random]
 * @param {(url: string) => Promise<{ close(): Promise<void>, closed?: Promise<boolean> }>} [options.openWindow]
 * @param {object} [options.webRequestApi] [options.tabsApi]
 * @param {(event: object) => void} [options.onChange]  a sign-in was saved, replaced or cleared (no tokens)
 */
export function createHermesAccount({
  store,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  now = () => Date.now(),
  cryptoImpl = globalThis.crypto,
  random = Math.random,
  openWindow = null,
  webRequestApi = null,
  tabsApi = null,
  signInTimeoutMs = ACCOUNT_SIGN_IN_TIMEOUT_MS,
  onChange = null,
} = {}) {
  if (!store) throw new TypeError('createHermesAccount needs a store.');
  const refreshing = new Map(); // origin -> Promise (single flight: a refresh rotates the refresh token)
  let signingIn = null;

  const notify = (event) => {
    try { onChange?.(event); } catch { /* a listener must not break the flow */ }
  };

  async function send(origin, path, { method = 'GET', headers = {}, body } = {}) {
    if (typeof fetchImpl !== 'function') return { status: 0 };
    try {
      const response = await fetchImpl(joinUrl(origin, path), {
        method,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: requestSignal(REQUEST_TIMEOUT_MS),
      });
      return { status: Number(response?.status) || 0, ok: response?.ok === true, payload: await readJson(response) };
    } catch {
      return { status: 0 };
    }
  }

  function shaped(origin, connectionKey, payload, previous = null) {
    const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : '';
    const refreshToken = typeof payload?.refresh_token === 'string' ? payload.refresh_token : '';
    if (!accessToken || !refreshToken) return null;
    const expiresAt = Number(payload.expires_at);
    return new AccountSession({
      origin,
      connectionKey: connectionKey || previous?.connectionKey || '',
      accessToken,
      refreshToken,
      expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : Math.floor(now() / 1000) + 300,
      provider: typeof payload.provider === 'string' && payload.provider ? payload.provider : (previous?.provider || ''),
      userId: typeof payload.user_id === 'string' && payload.user_id ? payload.user_id : (previous?.userId || ''),
      email: previous?.email || '',
      displayName: previous?.displayName || '',
    });
  }

  // POST /auth/native/refresh, once per origin at a time. A caller that waited re-reads the store and reuses
  // the session that was just rotated rather than spending the refresh token twice.
  async function refresh(origin, staleAccessToken = null, { force = false } = {}) {
    const base = accountOriginOf(origin);
    if (!base) return { ok: false, reason: ACCOUNT_REASONS.NO_ORIGIN };
    if (refreshing.has(base)) return refreshing.get(base);
    const observed = staleAccessToken === null ? await store.get(base) : null;
    if (refreshing.has(base)) return refreshing.get(base);
    const run = store.runExclusive(async (lockedStore) => {
      const latest = await lockedStore.get(base);
      if (!latest) return { ok: false, reason: ACCOUNT_REASONS.SIGNED_OUT };
      const rotated = staleAccessToken !== null ? latest.accessToken !== staleAccessToken
        : observed && latest.refreshToken !== observed.refreshToken;
      const fresh = latest.expiresAt - Math.floor(now() / 1000) > ACCOUNT_REFRESH_MARGIN_SECONDS;
      if (rotated || (fresh && staleAccessToken !== null && !force)) return { ok: true, session: latest };
      const result = await send(base, '/auth/native/refresh', {
        method: 'POST',
        body: { refresh_token: latest.refreshToken, ...(latest.provider ? { provider: latest.provider } : {}) },
      });
      if (result.ok) {
        const next = shaped(base, latest.connectionKey, result.payload, latest);
        if (!next) return { ok: false, reason: ACCOUNT_REASONS.BAD_RESPONSE };
        await lockedStore.save(next);
        notify({ type: 'refreshed', origin: base });
        return { ok: true, session: (await lockedStore.get(base)) || next };
      }
      if (result.status === 401) {
        await lockedStore.clear(base);
        notify({ type: 'expired', origin: base });
        return { ok: false, reason: ACCOUNT_REASONS.EXPIRED };
      }
      // 503, a network error: the tokens are kept, nothing was decided.
      return { ok: false, reason: ACCOUNT_REASONS.UNAVAILABLE };
    }).finally(() => { refreshing.delete(base); });
    refreshing.set(base, run);
    return run;
  }

  /** A usable access token, refreshed first when it is within a minute of expiring. */
  async function accessToken(origin) {
    const base = accountOriginOf(origin);
    if (!base) return { ok: false, reason: ACCOUNT_REASONS.NO_ORIGIN };
    const session = await store.get(base);
    if (!session) return { ok: false, reason: ACCOUNT_REASONS.SIGNED_OUT };
    if (session.expiresAt - Math.floor(now() / 1000) > ACCOUNT_REFRESH_MARGIN_SECONDS) return { ok: true, token: session.accessToken, session };
    const refreshed = await refresh(base, session.accessToken);
    return refreshed.ok ? { ok: true, token: refreshed.session.accessToken, session: refreshed.session } : refreshed;
  }

  // An authenticated call that retries once, after a single-flight refresh, when the gateway says 401.
  async function authed(origin, path, options = {}) {
    const first = await accessToken(origin);
    if (!first.ok) return first;
    let result = await send(origin, path, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${first.token}` } });
    if (result.status === 401) {
      // The gateway refused a token the clock says is good (rotated elsewhere, revoked): refresh, even if fresh.
      const refreshed = await refresh(origin, first.token, { force: true });
      if (!refreshed.ok) return refreshed;
      result = await send(origin, path, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${refreshed.session.accessToken}` } });
      // Refreshed and still refused is not a verdict on the refresh token: keep the sign-in, report it unavailable.
      if (result.status === 401) return { ok: false, reason: ACCOUNT_REASONS.UNAVAILABLE };
    }
    return { ok: true, result };
  }

  /**
   * A 30 s one-use ticket for /api/ws. { ok: true, ticket, ttlSeconds, principal } or { ok: false, reason }:
   * signed-out / session-expired (sign in again), unavailable (keep the sign-in and try later).
   */
  async function mintWsTicket(origin) {
    const outcome = await authed(origin, '/api/auth/ws-ticket', { method: 'POST' });
    if (!outcome.ok) return outcome;
    const { result } = outcome;
    if (result.status === 503 || result.status === 0) return { ok: false, reason: ACCOUNT_REASONS.UNAVAILABLE };
    const ticket = typeof result.payload?.ticket === 'string' ? result.payload.ticket : '';
    if (!result.ok || !TICKET_PATTERN.test(ticket)) return { ok: false, reason: ACCOUNT_REASONS.BAD_RESPONSE, status: result.status };
    const ttl = Number(result.payload?.ttl_seconds);
    const session = await store.get(origin);
    return {
      ok: true,
      ticket,
      ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 30,
      principal: session ? { user_id: session.userId, provider: session.provider, org_id: '' } : null,
    };
  }

  // GET /api/auth/providers: which interactive providers the gateway offers. One provider is named in the
  // authorize URL; several (or none known) leave it to the gateway, which renders its own chooser.
  async function chooseProvider(origin) {
    const result = await send(origin, '/api/auth/providers');
    const list = Array.isArray(result.payload?.providers) ? result.payload.providers : [];
    const names = list.map((entry) => String(entry?.name || '')).filter(Boolean);
    return names.length === 1 ? names[0] : '';
  }

  async function describeIdentity(origin, session) {
    const outcome = await authed(origin, '/api/auth/me');
    if (!outcome.ok || !outcome.result.ok) return session;
    const me = outcome.result.payload || {};
    return session.with({
      userId: String(me.user_id || session.userId || ''),
      email: String(me.email || ''),
      displayName: String(me.display_name || ''),
      provider: String(me.provider || session.provider || ''),
    });
  }

  /**
   * Run the whole sign-in. The caller has already asked for the webRequest permission from the click. Resolves
   * { ok: true, session: <summary> } or { ok: false, reason }. One sign-in at a time.
   */
  async function signIn({ origin, connectionKey = '' } = {}) {
    const base = accountOriginOf(origin);
    if (!base) return { ok: false, reason: ACCOUNT_REASONS.NO_ORIGIN };
    if (signingIn) return { ok: false, reason: ACCOUNT_REASONS.BUSY };
    if (typeof openWindow !== 'function') return { ok: false, reason: ACCOUNT_REASONS.NO_WINDOW };
    const attempt = (async () => {
      const pkce = await generatePkce(cryptoImpl);
      const redirectUri = buildRedirectUri(pickRedirectPort(random));
      const provider = await chooseProvider(base).catch(() => '');
      const authorizeUrl = buildAuthorizeUrl({ baseUrl: base, provider, challenge: pkce.challenge, redirectUri, state: pkce.state });
      // Watch before the window opens, so a fast redirect cannot be missed.
      const watcher = watchForCallback({ redirectUri, expectedState: pkce.state, webRequestApi, tabsApi, timeoutMs: signInTimeoutMs });
      let opened = null;
      try {
        opened = await openWindow(authorizeUrl);
      } catch (error) {
        watcher.cancel(ACCOUNT_REASONS.NO_WINDOW);
        await watcher.done;
        return { ok: false, reason: error?.reason || ACCOUNT_REASONS.NO_WINDOW };
      }
      opened?.closed?.then?.(() => watcher.cancel(ACCOUNT_REASONS.CANCELLED), () => undefined);
      const captured = await watcher.done;
      try { await opened?.close?.(); } catch { /* the window is already gone */ }
      if (!captured.ok) return { ok: false, reason: captured.reason };
      const exchanged = await send(base, '/auth/native/token', { method: 'POST', body: { code: captured.code, code_verifier: pkce.verifier } });
      if (exchanged.status === 0 || exchanged.status === 503) return { ok: false, reason: ACCOUNT_REASONS.UNAVAILABLE };
      if (!exchanged.ok) return { ok: false, reason: ACCOUNT_REASONS.EXCHANGE_REJECTED, status: exchanged.status };
      const session = shaped(base, connectionKey, exchanged.payload);
      if (!session) return { ok: false, reason: ACCOUNT_REASONS.BAD_RESPONSE };
      await store.save(session);
      const described = await describeIdentity(base, session).catch(() => session);
      await store.runExclusive(async (lockedStore) => {
        const latest = await lockedStore.get(base);
        if (latest && latest.refreshToken === described.refreshToken) await lockedStore.save(described);
      });
      notify({ type: 'signed-in', origin: base });
      return { ok: true, session: described.summary() };
    })();
    signingIn = attempt.finally(() => { signingIn = null; });
    return signingIn;
  }

  /** Local sign-out: forgets the tokens. The gateway is not asked to revoke them (as on the phone). */
  async function signOut(origin) {
    const base = accountOriginOf(origin);
    const cleared = base ? await store.clear(base) : false;
    if (cleared) notify({ type: 'signed-out', origin: base });
    return cleared;
  }

  async function status(origin) {
    const session = await store.get(origin);
    return session ? { signedIn: true, ...session.summary() } : { signedIn: false };
  }

  return { signIn, signOut, status, accessToken, refresh, mintWsTicket, isSigningIn: () => signingIn !== null };
}

// ---- The dial -----------------------------------------------------------------------------------------------

/**
 * Open /api/ws with an account ticket in the Sec-WebSocket-Protocol header only: `hermes-gateway-v1,
 * hermes-gateway-ticket.<ticket>`. If the handshake closes before gateway.ready the first ticket may be spent, so
 * the retry mints a NEW ticket and offers it the same way; a ticket never goes in a URL here.
 *   connect(endpointUrl, protocols)  the gateway client's connect
 *   mint()                           () => { ok, ticket } (hermesAccount.mintWsTicket bound to the origin)
 */
export async function dialWithAccountTicket({ connect, mint, endpoint, protocolsFor }) {
  const first = await mint();
  if (!first.ok) return { ok: false, reason: first.reason, ...(first.status ? { status: first.status } : {}) };
  try {
    await connect(endpoint, protocolsFor(first.ticket));
    return { ok: true, principal: first.principal || null };
  } catch (error) {
    if (!/WebSocket closed before gateway\.ready and open\b/.test(String(error?.message || ''))) throw error;
    const second = await mint();
    if (!second.ok) throw error;
    await connect(endpoint, protocolsFor(second.ticket));
    return { ok: true, principal: second.principal || first.principal || null };
  }
}
