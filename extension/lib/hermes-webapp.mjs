// Hermes Web: the browser-hosted Hermes Webapp that the user's own gateway serves
// (NousResearch/hermes-agent, `webapp.enabled: true`). This module only finds it and opens
// it. It sends no credential to it and never mints a sign-in:
//   * Nothing advertises the Webapp's address to an API client, and no route lets an
//     extension token mint a launch link. The sign-in link only comes from `hermes webapp`
//     on the host (a private same-user control socket), so a fresh tab shows the gateway's
//     own instructions or its sign-in page. The extension therefore opens the address and
//     tells the user what to run.
//   * The address is the user's "Hermes Web address" setting. Empty means automatic: the
//     gateway's default loopback address for a local connection, and nothing for a remote
//     one (a remote Webapp is behind a reverse proxy or tunnel and cannot be guessed).

import { CONNECTION_SCHEMA_VERSION, isLoopbackGatewayUrl, migrateConnectionSettings } from './connection-modes.mjs';

export const WEBAPP_DEFAULT_ADDRESS = 'http://127.0.0.1:9120';
export const WEBAPP_DOCS_URL = 'https://hermes-agent.nousresearch.com/docs/user-guide/desktop#use-the-desktop-workspace-from-a-browser';
export const WEBAPP_SETUP_COMMANDS = Object.freeze([
  'hermes config set webapp.enabled true',
  'hermes gateway restart',
  'hermes webapp',
]);
export const WEBAPP_SIGN_IN_HINT_STORAGE_KEY = 'hermesWebappSignInHintSeen';

const MAX_ADDRESS_LENGTH = 2048;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROBE_TIMEOUT_MS = 3500;

// Why an address was refused. Callers map these to messages.
export const WEBAPP_ADDRESS_REASONS = Object.freeze({
  EMPTY: 'empty',
  INVALID: 'invalid',
});

function encodedDotOrSeparator(segment) {
  return /%(?:2e|2f|5c|00)/i.test(segment);
}

/**
 * Validate a Hermes Web address. Accepts a plain http(s) origin, optionally with a path
 * prefix (a reverse proxy may serve the Webapp under one). Refuses credentials, queries,
 * fragments, backslashes, dot segments and encoded separators.
 *
 * Returns { ok: true, origin, basePath, baseUrl } where baseUrl has no trailing slash,
 * or { ok: false, reason }.
 */
export function validateWebappAddress(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, reason: WEBAPP_ADDRESS_REASONS.EMPTY };
  const invalid = { ok: false, reason: WEBAPP_ADDRESS_REASONS.INVALID };
  if (text.length > MAX_ADDRESS_LENGTH) return invalid;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\]/.test(text)) return invalid;
  const scheme = /^(https?):\/\/([^/?#]*)(.*)$/i.exec(text);
  if (!scheme) return invalid;
  const [, , authority, rest] = scheme;
  if (!authority || authority.includes('@')) return invalid;
  if (rest.includes('?') || rest.includes('#')) return invalid;
  const segments = rest.split('/').slice(1);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const last = index === segments.length - 1;
    if (!segment) {
      if (last) continue;
      return invalid;
    }
    if (segment === '.' || segment === '..' || encodedDotOrSeparator(segment)) return invalid;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return invalid;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return invalid;
  if (!url.hostname || url.username || url.password || url.search || url.hash) return invalid;
  const basePath = url.pathname.replace(/\/+$/, '');
  return { ok: true, origin: url.origin, basePath, baseUrl: `${url.origin}${basePath}` };
}

export function isLoopbackWebappHost(hostname = '') {
  const host = String(hostname).toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
}

function profileForUrl(settings) {
  const name = typeof settings?.activeProfile === 'string' ? settings.activeProfile.trim() : '';
  if (!name || name.toLowerCase() === 'default' || !PROFILE_NAME.test(name)) return '';
  return name;
}

// A connection is local when it is the local-gateway mode on a loopback address.
export function isLocalGatewayConnection(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  // An explicit mode counts even on a record that never got a schema version.
  const explicit = ['local', 'cloud', 'remote'].includes(String(source.connectionMode || '').trim().toLowerCase());
  const migrated = migrateConnectionSettings(explicit ? { ...source, connectionSchemaVersion: CONNECTION_SCHEMA_VERSION } : source);
  if (migrated.connectionMode !== 'local') return false;
  const gatewayUrl = String(migrated.gatewayUrl || '').trim();
  return !gatewayUrl || isLoopbackGatewayUrl(gatewayUrl);
}

/**
 * Where Hermes Web is for these settings.
 *   ok: { ok: true, source: 'setting' | 'local-default', origin, basePath, baseUrl, url,
 *         profile, loopback }
 *   not ok: { ok: false, reason: 'invalid-address' | 'needs-address' }
 * `url` is what to open: the base address plus ?profile=<name> when a non-default profile
 * is active. It never carries anything else.
 */
export function resolveWebappTarget(settings = {}) {
  const typed = typeof settings?.hermesWebAddress === 'string' ? settings.hermesWebAddress.trim() : '';
  let address;
  let source;
  if (typed) {
    address = validateWebappAddress(typed);
    if (!address.ok) return { ok: false, reason: 'invalid-address' };
    source = 'setting';
  } else if (isLocalGatewayConnection(settings)) {
    address = validateWebappAddress(WEBAPP_DEFAULT_ADDRESS);
    source = 'local-default';
  } else {
    return { ok: false, reason: 'needs-address' };
  }
  const profile = profileForUrl(settings);
  const url = new URL(`${address.baseUrl}/`);
  if (profile) url.searchParams.set('profile', profile);
  return {
    ok: true,
    source,
    origin: address.origin,
    basePath: address.basePath,
    baseUrl: address.baseUrl,
    url: url.href,
    profile,
    loopback: isLoopbackWebappHost(new URL(address.origin).hostname),
  };
}

// A match pattern for the permission API. Match patterns take no port.
export function webappOriginPattern(target) {
  const { protocol, hostname } = new URL(target.origin);
  return `${protocol}//${hostname}/*`;
}

function tabUrl(tab) {
  try {
    return new URL(String(tab?.url || ''));
  } catch {
    return null;
  }
}

/** The open tab that is showing this Webapp, or null. A tab on the right profile wins. */
export async function findOpenWebappTab(tabsApi, target) {
  if (typeof tabsApi?.query !== 'function') return null;
  let tabs;
  try {
    tabs = await tabsApi.query({});
  } catch {
    return null;
  }
  const candidates = [];
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    const id = Number(tab?.id);
    if (!Number.isInteger(id) || id < 0) continue;
    const url = tabUrl(tab);
    if (!url || url.origin !== target.origin) continue;
    if (target.basePath && url.pathname !== target.basePath && !url.pathname.startsWith(`${target.basePath}/`)) continue;
    const sameProfile = (url.searchParams.get('profile') || '') === target.profile;
    candidates.push({ tab, sameProfile, active: tab.active === true, accessed: Number(tab.lastAccessed) || 0 });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => Number(b.sameProfile) - Number(a.sameProfile)
    || Number(b.active) - Number(a.active)
    || b.accessed - a.accessed);
  return candidates[0].tab;
}

export async function focusWebappTab(tab, { tabsApi, windowsApi } = {}) {
  await tabsApi.update(tab.id, { active: true });
  if (Number.isInteger(tab.windowId) && typeof windowsApi?.update === 'function') {
    try {
      await windowsApi.update(tab.windowId, { focused: true });
    } catch {
      /* the tab is already selected; raising its window is best effort */
    }
  }
}

function probeSignal(ms) {
  if (typeof AbortSignal?.timeout === 'function') return { signal: AbortSignal.timeout(ms), done() {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * Whether anything answers at the Webapp's address. A plain GET of its root with no
 * credentials, cookies, headers or referrer. The answer must look like a web app
 * (a page, a redirect to sign-in, or a sign-in refusal), not a different service's 404.
 * If the browser will not let the page read the answer, any answer counts.
 */
export async function probeWebapp(target, { fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') return { reachable: false };
  const url = `${target.baseUrl}/`;
  const base = { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'manual', referrerPolicy: 'no-referrer' };
  const first = probeSignal(timeoutMs);
  try {
    const response = await fetchImpl(url, { ...base, mode: 'cors', signal: first.signal });
    const status = Number(response?.status) || 0;
    const reachable = response?.type === 'opaqueredirect'
      || (status >= 200 && status < 400)
      || status === 401
      || status === 403;
    return { reachable, status };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return { reachable: false };
  } finally {
    first.done();
  }
  const second = probeSignal(timeoutMs);
  try {
    await fetchImpl(url, { ...base, mode: 'no-cors', signal: second.signal });
    return { reachable: true, status: 0, opaque: true };
  } catch {
    return { reachable: false };
  } finally {
    second.done();
  }
}

/**
 * The sign-in hint to show after opening a new tab, once per kind and then never again.
 * 'local' on a loopback address (run `hermes webapp` once on this computer), 'account'
 * anywhere else (the Webapp is behind the dashboard sign-in). '' when already shown.
 */
export async function takeWebappSignInHint(storageArea, target) {
  const kind = target?.loopback ? 'local' : 'account';
  if (typeof storageArea?.get !== 'function' || typeof storageArea?.set !== 'function') return kind;
  try {
    const stored = await storageArea.get(WEBAPP_SIGN_IN_HINT_STORAGE_KEY);
    const seen = stored?.[WEBAPP_SIGN_IN_HINT_STORAGE_KEY];
    if (seen && typeof seen === 'object' && seen[kind] === true) return '';
    await storageArea.set({ [WEBAPP_SIGN_IN_HINT_STORAGE_KEY]: { ...(seen && typeof seen === 'object' ? seen : {}), [kind]: true } });
  } catch {
    /* an unreadable store only means the hint can repeat */
  }
  return kind;
}

async function hostAccess(target, permissionsApi, permissionMode) {
  const request = { origins: [webappOriginPattern(target)] };
  if (permissionMode === 'contains') {
    if (typeof permissionsApi?.contains !== 'function') return true;
    try {
      return (await permissionsApi.contains(request)) !== false;
    } catch {
      return true;
    }
  }
  // Called first thing in the click handler, while the user gesture is still live. A
  // browser that already granted the origin (the manifest's host permissions) answers yes
  // without asking anything.
  if (typeof permissionsApi?.request !== 'function') return true;
  try {
    return (await permissionsApi.request(request)) !== false;
  } catch {
    return true;
  }
}

/**
 * The Hermes Web button.
 *   1. work out the address (setting, else the local default),
 *   2. check the browser will let the extension reach it (no new permanent permission:
 *      the origin is covered by the manifest's host permissions),
 *   3. focus a tab that already shows it (that tab is already signed in),
 *   4. otherwise check something answers, with no credentials,
 *   5. then open it in a new tab.
 *
 * Resolves with { status, ... } and never throws for an expected condition:
 *   'focused' | 'opened' (+ hint: 'local' | 'account' | '') | 'unreachable' |
 *   'needs-address' | 'invalid-address' | 'permission-denied' | 'open-failed'
 * permissionMode: 'request' (a click handler) or 'contains' (a background worker).
 */
export async function openHermesWebapp({
  settings = {},
  tabsApi,
  windowsApi,
  permissionsApi,
  fetchImpl,
  storageArea,
  permissionMode = 'request',
} = {}) {
  const target = resolveWebappTarget(settings);
  if (!target.ok) return { status: target.reason };
  if (!(await hostAccess(target, permissionsApi, permissionMode))) {
    return { status: 'permission-denied', address: target.baseUrl };
  }
  const existing = await findOpenWebappTab(tabsApi, target);
  if (existing) {
    try {
      await focusWebappTab(existing, { tabsApi, windowsApi });
      return { status: 'focused', tabId: existing.id, address: target.baseUrl };
    } catch {
      /* the tab closed while focusing it: fall through to a fresh one */
    }
  }
  const probe = await probeWebapp(target, { fetchImpl });
  if (!probe.reachable) return { status: 'unreachable', address: target.baseUrl };
  try {
    const tab = await tabsApi.create({ url: target.url, active: true });
    const hint = await takeWebappSignInHint(storageArea, target);
    return { status: 'opened', tabId: tab?.id, address: target.baseUrl, hint };
  } catch (error) {
    return { status: 'open-failed', address: target.baseUrl, reason: error?.message || String(error) };
  }
}
