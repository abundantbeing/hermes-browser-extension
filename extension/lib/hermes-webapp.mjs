// Hermes Web: the browser-hosted Hermes Webapp that the user's own gateway serves
// (NousResearch/hermes-agent, `webapp.enabled: true`). This module finds it and opens it.
//   * A gateway that carries the extension-pairing routes mints the sign-in itself: the paired
//     token asks it for a one-use window ticket (lib/webapp-gateway-tickets.mjs), and the button
//     opens `<webapp>/webapp/launch#ticket=...` in a tab that is already signed in. No terminal, and
//     the panel holds no credential for it. The gateway also names the Webapp's own address, so a
//     Webapp on another port is found.
//   * Against a gateway without those routes nothing advertises the Webapp's address to an API client
//     and no extension token can mint a sign-in; the sign-in comes from `hermes webapp` on the host
//     (a one-use launch link that leaves the credential in that tab's sessionStorage). After that
//     the panel can keep this browser's sign-in until the browser closes (lib/webapp-credential.mjs,
//     the "Keep Hermes Web signed in from the panel" setting): the button then opens a new tab that
//     is already signed in, using a one-use window ticket minted with it. The credential itself never
//     goes in a URL. With the setting off, or with nothing held, the button opens the address and
//     tells the user what to run.
//   * The address is the user's "Hermes Web address" setting. Empty means automatic: the
//     gateway's default loopback address for a local connection, and nothing for a remote
//     one (a remote Webapp is behind a reverse proxy or tunnel and cannot be guessed).

import { CONNECTION_SCHEMA_VERSION, isLoopbackGatewayUrl, migrateConnectionSettings } from './connection-modes.mjs';
import { WEBAPP_TICKET_REASONS } from './webapp-gateway-tickets.mjs';

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
export async function takeWebappSignInHint(storageArea, target, { account = false } = {}) {
  const kind = target?.loopback && !account ? 'local' : 'account';
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

async function captureFromTab(credentials, target, tab) {
  try {
    return (await credentials.capture(target, tab ? { tab } : {})) || { ok: false };
  } catch {
    return { ok: false };
  }
}

// Opens a ticketed launch URL as the visible tab. With an `opener` (lib/hermes-web-opening.mjs) the background worker
// runs the hand-off: the branded "Opening Hermes Web" page the first time in a run of the gateway, the launch tab in
// front straight away after that (`quiet`). Without one, or if the opener cannot, the launch URL opens directly, as
// before; the content script on the gateway's hand-off page (hermes-web-launch.js) covers it either way.
// Resolves the tab that carries the launch URL.
async function openLaunchTab({ url, origin, basePath = '', tabsApi, opener }) {
  if (opener && typeof opener.open === 'function') {
    try {
      const opened = await opener.open({ url, origin, basePath });
      if (opened?.ok) return { id: opened.tabId, ...(opened.mode === 'quiet' ? { quiet: true } : {}) };
    } catch {
      /* fall through to the direct open */
    }
  }
  return tabsApi.create({ url, active: true });
}

// A new tab already signed in: a one-use window ticket, minted with the held credential, rides
// in the launch URL's fragment. Resolves the open-tab result, or null when it cannot (nothing
// held, the ticket was refused, nothing answered) so the caller can fall through.
async function openSignedInTab({ credentials, target, tabsApi, opener }) {
  if (!(await credentials.held())) return null;
  const minted = await credentials.mintWindowTicket(target);
  if (!minted?.ok) return null;
  const url = credentials.launchUrl(target, minted.ticket, { profile: target.profile });
  if (!url) return null;
  try {
    const tab = await openLaunchTab({ url, origin: target.origin, basePath: target.basePath, tabsApi, opener });
    return { status: 'opened', tabId: tab?.id, address: target.baseUrl, hint: 'signed-in', signedIn: true, ...(tab?.quiet ? { quiet: true } : {}) };
  } catch (error) {
    return { status: 'open-failed', address: target.baseUrl, reason: error?.message || String(error) };
  }
}

// A new tab already signed in by the paired gateway: it mints a one-use window ticket (no credential is
// held here) and names the Webapp's own address. Resolves { opened } (the open-tab result, or null when the
// gateway cannot sign a tab in) and the `reason` it gave. A click asks again whatever was remembered.
async function openTabViaGateway({ tickets, target, tabsApi, opener }) {
  let minted;
  try {
    minted = await tickets.windowTicket({ profile: target.profile, force: true });
  } catch {
    minted = { ok: false, reason: WEBAPP_TICKET_REASONS.UNREACHABLE };
  }
  if (!minted?.ok) return { opened: null, reason: minted?.reason || WEBAPP_TICKET_REASONS.UNREACHABLE };
  // The address the user typed names a Webapp of their own choosing; only the local default follows the gateway.
  if (target.source === 'setting' && minted.origin !== target.origin) return { opened: null, reason: 'other-webapp' };
  const url = tickets.launchUrl(minted.webappUrl, minted.ticket, { profile: target.profile });
  if (!url) return { opened: null, reason: WEBAPP_TICKET_REASONS.INVALID };
  try {
    const tab = await openLaunchTab({ url, origin: minted.origin, tabsApi, opener });
    return { opened: { status: 'opened', tabId: tab?.id, address: minted.origin, hint: 'signed-in', signedIn: true, via: 'gateway', ...(tab?.quiet ? { quiet: true } : {}) } };
  } catch (error) {
    return { opened: { status: 'open-failed', address: minted.origin, reason: error?.message || String(error) } };
  }
}

// Whether the gateway answered about its Webapp at all (a gateway with the routes), from the reason it gave.
const GATEWAY_ANSWERED = new Set([
  WEBAPP_TICKET_REASONS.OFF,
  WEBAPP_TICKET_REASONS.NOT_PRIVATE,
  WEBAPP_TICKET_REASONS.UNAVAILABLE,
  WEBAPP_TICKET_REASONS.STARTING,
  WEBAPP_TICKET_REASONS.BUSY,
  WEBAPP_TICKET_REASONS.PROFILE,
]);

/**
 * The Hermes Web button.
 *   1. work out the address (setting, else the local default),
 *   2. check the browser will let the extension reach it (no new permanent permission:
 *      the origin is covered by the manifest's host permissions),
 *   3. focus a tab that already shows it and is signed in (and keep its sign-in, when the panel may),
 *   4. otherwise ask the paired gateway for a one-use window ticket and open a new tab that is already
 *      signed in (`tickets`, lib/webapp-gateway-tickets.mjs; no credential is held for it),
 *   5. otherwise, with a held sign-in, open a new tab that is already signed in,
 *   6. otherwise keep the sign-in of any open signed-in tab and do the same,
 *   7. otherwise check something answers, with no credentials, and open the address.
 *
 * `opener` (optional, lib/hermes-web-opening.mjs) shows the branded "Opening Hermes Web" page while a ticketed launch
 * tab loads in the background. It is used only where a ticketed launch URL opens (steps 4 to 6); focusing an open tab and
 * the plain address open as they were.
 *
 * `credentials` is the store from lib/webapp-credential.mjs; without it, or with the setting off,
 * steps 5 and 6 do not apply. Without `tickets`, or for a Webapp that is not on this computer, neither
 * does step 4.
 *
 * Resolves with { status, ... } and never throws for an expected condition:
 *   'focused' | 'opened' (+ hint: 'signed-in' | 'local' | 'local-kept' | 'account' | '', and `quiet: true` when the
 *   run was signed in already, so no opening page showed) | 'unreachable' |
 *   'needs-address' | 'invalid-address' | 'permission-denied' | 'open-failed'
 * 'unreachable' carries `routes: 'present'` when the gateway answered about its Webapp (so no terminal step
 * is left to suggest) and `webapp`, the reason it gave (webapp-off, webapp-unavailable, ...).
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
  credentials = null,
  tickets = null,
  opener = null,
} = {}) {
  const target = resolveWebappTarget(settings);
  if (!target.ok) return { status: target.reason };
  if (!(await hostAccess(target, permissionsApi, permissionMode))) {
    return { status: 'permission-denied', address: target.baseUrl };
  }
  // Only the private loopback Webapp keeps a sign-in the panel can use; a remote Webapp is behind the account sign-in.
  const keepSignedIn = credentials && target.loopback ? (await credentials.enabled()) !== false : false;
  const viaGateway = Boolean(tickets) && target.loopback;
  let capturedFromTab = false;
  const existing = await findOpenWebappTab(tabsApi, target);
  if (existing) {
    let focusIt = true;
    if (keepSignedIn) {
      const captured = await captureFromTab(credentials, target, existing);
      capturedFromTab = captured.ok === true;
      // A tab that is not signed in cannot be fixed from here. When the gateway can sign a new tab in, or a
      // sign-in is held, a new signed-in tab is better than raising that one.
      if (!captured.ok && ['not-signed-in', 'rejected'].includes(captured.reason) && (viaGateway || await credentials.held())) focusIt = false;
    }
    if (focusIt) {
      try {
        await focusWebappTab(existing, { tabsApi, windowsApi });
        return { status: 'focused', tabId: existing.id, address: target.baseUrl };
      } catch {
        /* the tab closed while focusing it: fall through to a fresh one */
      }
    }
  }
  let gatewayReason = '';
  if (viaGateway) {
    const attempt = await openTabViaGateway({ tickets, target, tabsApi, opener });
    if (attempt.opened) return attempt.opened;
    gatewayReason = attempt.reason;
  }
  if (keepSignedIn) {
    let opened = await openSignedInTab({ credentials, target, tabsApi, opener });
    if (!opened && !capturedFromTab && (await captureFromTab(credentials, target, null)).ok) {
      opened = await openSignedInTab({ credentials, target, tabsApi, opener });
    }
    if (opened) return opened;
  }
  const probe = await probeWebapp(target, { fetchImpl });
  const answered = GATEWAY_ANSWERED.has(gatewayReason);
  if (!probe.reachable) {
    return { status: 'unreachable', address: target.baseUrl, ...(answered ? { routes: 'present' } : {}), ...(gatewayReason ? { webapp: gatewayReason } : {}) };
  }
  try {
    const tab = await tabsApi.create({ url: target.url, active: true });
    // A Webapp behind sign-in has an account sign-in, not `hermes webapp`.
    let hint = await takeWebappSignInHint(storageArea, target, { account: gatewayReason === WEBAPP_TICKET_REASONS.NOT_PRIVATE });
    // On this computer the first sign-in is still `hermes webapp`; once it is done the panel keeps it.
    if (hint === 'local' && keepSignedIn && target.loopback) hint = 'local-kept';
    return { status: 'opened', tabId: tab?.id, address: target.baseUrl, hint };
  } catch (error) {
    return { status: 'open-failed', address: target.baseUrl, reason: error?.message || String(error) };
  }
}
