// The Hermes Web sign-in, held for the panel.
//
// The gateway's Webapp signs a browser in with one credential (the dashboard session token,
// 43 characters of [A-Za-z0-9_-]). `hermes webapp` hands it to a tab through a one-use launch
// link, and that tab keeps it in sessionStorage under
//   hermes.webapp.session.v1:<JSON [origin, basePath]>
// Nothing else on the page or the API advertises it, and no extension token can mint it. So a
// panel that wants Hermes Web, Projects and the bot roster to work after that tab is closed has
// to keep the credential itself, for as long as the browser runs:
//   * capture  read it from an open, signed-in Webapp tab (chrome.scripting, one storage key),
//   * hold     chrome.storage.session only (memory, gone when the browser closes, and its default
//              trusted-contexts access level is left alone so no content script can read it); where
//              storage.session is missing (older Firefox) it lives in memory for this context only,
//   * validate one authenticated GET; a 401 or 403 (`hermes webapp --sign-out` rotates the
//              credential) drops it,
//   * use      as the X-Hermes-Session-Token header, and from it mint one-use tickets:
//                POST /api/webapp/window-ticket  -> a ticket for a new signed-in tab,
//                POST /api/webapp/socket-ticket  -> a ticket for one /api/ws dial.
//
// Where the credential may appear, and where it may not:
//   * It is sent only as a request header to the Webapp origin it was captured from.
//   * It is never put in a URL. The launch URL carries a ticket, in its fragment (the browser
//     never sends a fragment to the server, and the launch page scrubs it from the address bar
//     before it does anything else). The socket carries a ticket too, in the
//     hermes-gateway-ticket subprotocol or ?ticket=. Upstream does accept ?token=<credential> on
//     /api/ws, and this module never uses it.
//   * It is never logged, shown, or returned from anything but `held()` and `tokenFor()`.
//   * Capture works on loopback Webapp origins only: only the private Webapp keeps this credential
//     in a tab, and it grants host files and a shell.

export const WEBAPP_CREDENTIAL_STORAGE_KEY = 'hermesWebappCredential';
export const WEBAPP_SESSION_HEADER = 'X-Hermes-Session-Token';
export const WEBAPP_SESSION_KEY_PREFIX = 'hermes.webapp.session.v1:';
export const WEBAPP_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// Upstream's one-use ticket is token_urlsafe(32): the same alphabet and length as the credential.
const HANDOFF_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// A socket ticket is only ever offered as a WebSocket subprotocol token, so hold it to that alphabet.
const SOCKET_TICKET_PATTERN = /^[A-Za-z0-9._~-]{1,200}$/;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Pages that exist only to redeem a ticket: their sessionStorage is not the Webapp's.
const HANDOFF_PATHS = Object.freeze(['/webapp/launch', '/webapp/window']);
const MAX_CAPTURE_TABS = 6;
const REQUEST_TIMEOUT_MS = 5000;

export const WEBAPP_CREDENTIAL_REASONS = Object.freeze({
  DISABLED: 'disabled',
  UNSUPPORTED_ORIGIN: 'unsupported-origin',
  SCRIPTING_UNAVAILABLE: 'scripting-unavailable',
  NO_TAB: 'no-tab',
  NOT_SIGNED_IN: 'not-signed-in',
  NONE: 'none',
  REJECTED: 'rejected',
  UNSUPPORTED: 'unsupported',
  UNREACHABLE: 'unreachable',
});

export function isWebappCredential(value) {
  return typeof value === 'string' && WEBAPP_CREDENTIAL_PATTERN.test(value);
}

/** The "Keep Hermes Web signed in from the panel" setting. On unless it was turned off. */
export function keepSignedInEnabled(settings) {
  return settings?.webappKeepSignedIn !== false;
}

/** The sessionStorage key a Webapp tab keeps its credential under. */
export function webappSessionStorageKey(origin = '', basePath = '') {
  return `${WEBAPP_SESSION_KEY_PREFIX}${JSON.stringify([String(origin || ''), String(basePath || '')])}`;
}

function parsedUrl(value) {
  try {
    return new URL(String(value || ''));
  } catch {
    return null;
  }
}

export function originOfUrl(value) {
  const url = parsedUrl(value);
  return url && ['http:', 'https:'].includes(url.protocol) ? url.origin : '';
}

function isLoopbackHostname(hostname = '') {
  const host = String(hostname).toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
}

/** Whether the credential may be captured from, held for, and sent to this origin. */
export function isCredentialOrigin(origin = '') {
  const url = parsedUrl(origin);
  return Boolean(url) && url.protocol === 'http:' && !url.username && !url.password && isLoopbackHostname(url.hostname);
}

function normalizedBasePath(basePath = '') {
  const text = String(basePath || '').replace(/\/+$/, '');
  return text && !text.startsWith('/') ? `/${text}` : text;
}

/** Whether this URL is one of the Webapp's ticket-redeeming pages, which hold no credential of their own. */
export function isHandoffUrl(url, basePath = '') {
  const parsed = parsedUrl(url);
  if (!parsed) return false;
  const prefix = normalizedBasePath(basePath);
  const path = parsed.pathname.replace(/\/+$/, '');
  return HANDOFF_PATHS.some((handoff) => path === `${prefix}${handoff}`);
}

function isOnWebapp(url, target) {
  const parsed = parsedUrl(url);
  if (!parsed || parsed.origin !== target.origin) return false;
  const prefix = normalizedBasePath(target.basePath);
  return !prefix || parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`);
}

/**
 * The address that opens a new, signed-in Webapp tab: the launch page with a one-use window ticket
 * in the fragment. The fragment is never sent to the server and the page removes it from the address
 * bar; it holds the ticket and the query to enter the Webapp with, never the credential.
 * '' when the ticket is not the shape the launch page accepts.
 */
export function webappLaunchUrl(target, ticket, { profile = '' } = {}) {
  if (!target?.origin || !HANDOFF_TICKET_PATTERN.test(String(ticket || ''))) return '';
  const params = new URLSearchParams();
  params.set('ticket', String(ticket));
  const name = typeof profile === 'string' ? profile.trim() : '';
  if (name && name.toLowerCase() !== 'default' && PROFILE_NAME.test(name)) {
    params.set('query', new URLSearchParams({ profile: name }).toString());
  }
  return `${target.origin}${normalizedBasePath(target.basePath)}/webapp/launch#${params.toString()}`;
}

// Runs in the Webapp tab. chrome.scripting serializes it, so it must stay self-contained.
// Reads one sessionStorage key and nothing else.
export function readSessionCredentialInPage(key) {
  try {
    const value = globalThis.sessionStorage.getItem(String(key));
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function tokenFromHtml(html = '') {
  const match = String(html || '').match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/);
  return match?.[1] || '';
}

/**
 * The dashboard token to send to a dashboard at *baseUrl*: the one its page injects (a legacy
 * dashboard), else the held Webapp credential when it belongs to the same origin. The Webapp
 * injects nothing, so this is where its credential takes the place of `__HERMES_SESSION_TOKEN__`.
 */
export function dashboardTokenFor(baseUrl, html = '', held = null) {
  const injected = tokenFromHtml(html);
  if (injected) return injected;
  const origin = originOfUrl(baseUrl);
  if (origin && held && held.origin === origin && isWebappCredential(held.token)) return held.token;
  return '';
}

function normalizeRecord(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.origin !== 'string' || !isCredentialOrigin(entry.origin) || !isWebappCredential(entry.token)) return null;
  return {
    origin: entry.origin,
    basePath: normalizedBasePath(entry.basePath),
    token: entry.token,
    capturedAt: Number(entry.capturedAt) || 0,
  };
}

function requestSignal(ms) {
  if (typeof AbortSignal?.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function endpoint(target, path) {
  return `${String(target.baseUrl || `${target.origin}${normalizedBasePath(target.basePath)}`).replace(/\/+$/, '')}${path}`;
}

/**
 * The store. Every browser API is injected so it can be tested and so each context (panel,
 * service worker) wires its own.
 *
 * @param {object} options
 * @param {object} [options.storageSession]  chrome.storage.session, or null/absent for memory only
 * @param {object} [options.scriptingApi]    chrome.scripting
 * @param {object} [options.tabsApi]         chrome.tabs
 * @param {Function} [options.fetchImpl]
 * @param {() => boolean|Promise<boolean>} [options.isEnabled]  the "keep signed in" setting
 * @param {() => number} [options.now]
 * @param {(info: { origin: string }) => void} [options.onDrop]  called after a rejected credential was dropped
 */
export function createWebappCredentialStore({
  storageSession = null,
  scriptingApi = null,
  tabsApi = null,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  isEnabled = () => true,
  now = () => Date.now(),
  onDrop = null,
} = {}) {
  let memory = null;
  let storageBroken = false;

  async function enabled() {
    try {
      return (await isEnabled()) !== false;
    } catch {
      return true;
    }
  }

  function storageUsable() {
    return !storageBroken && typeof storageSession?.get === 'function' && typeof storageSession?.set === 'function';
  }

  async function readRecord() {
    if (storageUsable()) {
      try {
        const stored = await storageSession.get(WEBAPP_CREDENTIAL_STORAGE_KEY);
        const record = normalizeRecord(stored?.[WEBAPP_CREDENTIAL_STORAGE_KEY]);
        if (record) return record;
      } catch {
        storageBroken = true;
      }
    }
    return memory;
  }

  /** The held credential, or null: none held, the setting is off, or it is not for a loopback Webapp. */
  async function held() {
    if (!(await enabled())) return null;
    return readRecord();
  }

  async function hold({ origin, basePath = '', token, capturedAt = now() } = {}) {
    const record = normalizeRecord({ origin, basePath, token, capturedAt });
    if (!record) return false;
    if (storageUsable()) {
      try {
        await storageSession.set({ [WEBAPP_CREDENTIAL_STORAGE_KEY]: record });
        memory = null;
        return true;
      } catch {
        storageBroken = true;
      }
    }
    memory = record;
    return true;
  }

  async function clear() {
    memory = null;
    if (typeof storageSession?.remove === 'function' && !storageBroken) {
      try {
        await storageSession.remove(WEBAPP_CREDENTIAL_STORAGE_KEY);
        return;
      } catch {
        storageBroken = true;
      }
    }
    if (typeof storageSession?.set === 'function') {
      try {
        await storageSession.set({ [WEBAPP_CREDENTIAL_STORAGE_KEY]: null });
      } catch {
        /* nothing else to clear */
      }
    }
  }

  async function drop(origin = '') {
    await clear();
    try {
      onDrop?.({ origin });
    } catch {
      /* a listener must not stop the drop */
    }
  }

  async function authorized(target) {
    if (!(await enabled())) return { ok: false, reason: WEBAPP_CREDENTIAL_REASONS.DISABLED };
    const record = await readRecord();
    if (!record || !target?.origin || record.origin !== target.origin) return { ok: false, reason: WEBAPP_CREDENTIAL_REASONS.NONE };
    return { ok: true, token: record.token };
  }

  // One authenticated request to the Webapp the credential belongs to. Never throws.
  async function send(target, path, { method = 'GET' } = {}) {
    const gate = await authorized(target);
    if (!gate.ok) return { ok: false, reason: gate.reason };
    if (typeof fetchImpl !== 'function') return { ok: false, reason: WEBAPP_CREDENTIAL_REASONS.UNREACHABLE };
    let response;
    try {
      response = await fetchImpl(endpoint(target, path), {
        method,
        headers: { Accept: 'application/json', [WEBAPP_SESSION_HEADER]: gate.token },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: requestSignal(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: WEBAPP_CREDENTIAL_REASONS.UNREACHABLE };
    }
    const status = Number(response?.status) || 0;
    if (status === 401 || status === 403) {
      await drop(target.origin);
      return { ok: false, reason: WEBAPP_CREDENTIAL_REASONS.REJECTED, status };
    }
    if (status === 400 || status === 404 || status === 405) {
      return { ok: false, reason: WEBAPP_CREDENTIAL_REASONS.UNSUPPORTED, status };
    }
    if (!response?.ok) return { ok: false, reason: WEBAPP_CREDENTIAL_REASONS.UNREACHABLE, status };
    return { ok: true, status, response };
  }

  /** One cheap authenticated GET. A 401 or 403 drops the credential. */
  async function validate(target) {
    const result = await send(target, '/api/profiles');
    return result.ok ? { ok: true } : { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) };
  }

  /** A one-use ticket that opens a new tab already signed in (see webappLaunchUrl). */
  async function mintWindowTicket(target) {
    const result = await send(target, '/api/webapp/window-ticket', { method: 'POST' });
    if (!result.ok) return { ok: false, reason: result.reason };
    const payload = await result.response.json().catch(() => null);
    const ticket = typeof payload?.ticket === 'string' ? payload.ticket : '';
    if (!HANDOFF_TICKET_PATTERN.test(ticket)) return { ok: false, reason: WEBAPP_CREDENTIAL_REASONS.UNSUPPORTED };
    return { ok: true, ticket };
  }

  /** A one-use ticket for one dial of /api/ws on this Webapp (`profile` pins the socket's profile). */
  async function mintSocketTicket(target, { socket = 'gateway', profile = '' } = {}) {
    const query = new URLSearchParams({ socket: String(socket) });
    const name = typeof profile === 'string' ? profile.trim() : '';
    if (name && PROFILE_NAME.test(name)) query.set('profile', name);
    const result = await send(target, `/api/webapp/socket-ticket?${query.toString()}`, { method: 'POST' });
    if (!result.ok) return { ok: false, reason: result.reason };
    const payload = await result.response.json().catch(() => null);
    const ticket = typeof payload?.ticket === 'string' ? payload.ticket : '';
    if (!SOCKET_TICKET_PATTERN.test(ticket)) return { ok: false, reason: WEBAPP_CREDENTIAL_REASONS.UNSUPPORTED };
    const ttl = Number(payload?.ttl_seconds);
    return { ok: true, ticket, ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 30 };
  }

  async function candidateTabs(target) {
    if (typeof tabsApi?.query !== 'function') return [];
    let tabs;
    try {
      tabs = await tabsApi.query({});
    } catch {
      return [];
    }
    return (Array.isArray(tabs) ? tabs : [])
      .filter((tab) => Number.isInteger(Number(tab?.id)) && Number(tab.id) >= 0
        && !tab.discarded
        && isOnWebapp(tab.url, target)
        && !isHandoffUrl(tab.url, target.basePath))
      .sort((a, b) => Number(b.active === true) - Number(a.active === true)
        || (Number(b.lastAccessed) || 0) - (Number(a.lastAccessed) || 0))
      .slice(0, MAX_CAPTURE_TABS);
  }

  /**
   * Read the credential from an open, signed-in Webapp tab, hold it and validate it.
   * `target` is { origin, basePath?, baseUrl? }; `tab` limits the read to one tab.
   * Resolves { ok: true, tabId, validated } or { ok: false, reason }.
   */
  async function capture(target, { tab = null } = {}) {
    if (!(await enabled())) return { ok: false, reason: WEBAPP_CREDENTIAL_REASONS.DISABLED };
    if (!target?.origin || !isCredentialOrigin(target.origin)) return { ok: false, reason: WEBAPP_CREDENTIAL_REASONS.UNSUPPORTED_ORIGIN };
    if (typeof scriptingApi?.executeScript !== 'function') return { ok: false, reason: WEBAPP_CREDENTIAL_REASONS.SCRIPTING_UNAVAILABLE };
    const shaped = { origin: target.origin, basePath: normalizedBasePath(target.basePath), baseUrl: target.baseUrl };
    const candidates = tab
      ? [tab].filter((entry) => Number.isInteger(Number(entry?.id)) && isOnWebapp(entry.url, shaped) && !isHandoffUrl(entry.url, shaped.basePath))
      : await candidateTabs(shaped);
    if (!candidates.length) return { ok: false, reason: WEBAPP_CREDENTIAL_REASONS.NO_TAB };
    const key = webappSessionStorageKey(shaped.origin, shaped.basePath);
    for (const candidate of candidates) {
      let value = null;
      try {
        const [injection] = await scriptingApi.executeScript({
          target: { tabId: Number(candidate.id) },
          func: readSessionCredentialInPage,
          args: [key],
        });
        value = injection?.result;
      } catch {
        continue;
      }
      if (!isWebappCredential(value)) continue;
      // The read ran in whatever the tab showed by then: make sure it is still this Webapp.
      if (typeof tabsApi?.get === 'function') {
        try {
          const current = await tabsApi.get(Number(candidate.id));
          if (!current || !isOnWebapp(current.url, shaped)) continue;
        } catch {
          continue;
        }
      }
      // The same credential already held was checked when it was first captured, and is checked
      // again the first time it is used; a reload of the tab need not ask the Webapp again.
      const already = await readRecord();
      if (already && already.origin === shaped.origin && already.token === value) {
        return { ok: true, tabId: Number(candidate.id), validated: false, unchanged: true };
      }
      await hold({ origin: shaped.origin, basePath: shaped.basePath, token: value, capturedAt: now() });
      const checked = await validate(shaped);
      if (checked.reason === WEBAPP_CREDENTIAL_REASONS.REJECTED) continue;
      return { ok: true, tabId: Number(candidate.id), validated: checked.ok === true };
    }
    return { ok: false, reason: WEBAPP_CREDENTIAL_REASONS.NOT_SIGNED_IN };
  }

  /** See dashboardTokenFor(): the page's own token, else the held credential for the same origin. */
  async function tokenFor(baseUrl, html = '') {
    const injected = tokenFromHtml(html);
    if (injected) return injected;
    return dashboardTokenFor(baseUrl, '', await held());
  }

  return {
    enabled,
    held,
    hold,
    clear,
    capture,
    validate,
    mintWindowTicket,
    mintSocketTicket,
    tokenFor,
    launchUrl: webappLaunchUrl,
  };
}
