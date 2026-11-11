import { privateNetworkHost } from './common.mjs';

export const PAGE_CONTEXT_SCRIPT_ID = 'hermes-page-context-bundle';
export const PAGE_CONTEXT_GUARD_SCRIPT_ID = 'hermes-page-context-guard';

const PACKAGED_PAGE_SCRIPT_JS = Object.freeze([
  'lib/page-context-bundle-gate.js',
  'lib/browser-api-global.js',
  'content-extractor.js',
  'content.js',
  'lib/i18n-content.js',
  'content-inline-helper.js',
]);

const PACKAGED_PAGE_CONTEXT_GUARD_JS = 'page-context-install-guard.js';
const REPOSITORY_PAGE_CONTEXT_GUARD_JS = 'extension/page-context-install-guard.js';

/** Packaged extension paths used by dynamic page-context registration and side-panel injection fallback. */
export function packagedPageContextScriptFiles() {
  return [...PACKAGED_PAGE_SCRIPT_JS];
}

const REPOSITORY_PAGE_SCRIPT_JS = Object.freeze([
  'extension/lib/page-context-bundle-gate.js',
  'extension/lib/browser-api-global.js',
  'extension/content-extractor.js',
  'extension/content.js',
  'extension/lib/i18n-content.js',
  'extension/content-inline-helper.js',
]);

/** Whether http(s) or file URL resolves to a private/LAN host for page-script policy. */
export function isPrivateNetworkPageUrl(url = '') {
  const text = String(url || '').trim();
  if (!text) return false;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return false;
  }
  if (parsed.protocol === 'file:') return false;
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  return privateNetworkHost(parsed.hostname);
}

function normalizeOriginInput(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${host}${port}`;
  } catch {
    return '';
  }
}

/** Stable list of user-configured origins excluded from page scripts (public or private). */
export function normalizePageContextExcludedOrigins(value) {
  const rows = Array.isArray(value)
    ? value
    : String(value || '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const origin = normalizeOriginInput(row);
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

export function urlMatchesExcludedOrigin(url = '', excludedOrigins = []) {
  const origins = normalizePageContextExcludedOrigins(excludedOrigins);
  if (!origins.length) return false;
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port ? `:${parsed.port}` : '';
  const candidate = `${parsed.protocol}//${host}${port}`;
  return origins.some((origin) => origin === candidate);
}

/**
 * Whether the page-script bundle should run on this URL with these settings.
 * `excluded-origin` wins over the private-network opt-in.
 */
export function pageContextInjectionDecision(url = '', settings = {}) {
  if (urlMatchesExcludedOrigin(url, settings.pageContextExcludedOrigins)) {
    return { inject: false, reason: 'excluded-origin' };
  }
  const allowPrivate = settings.pageContextOnPrivateNetworks === true;
  if (!allowPrivate && isPrivateNetworkPageUrl(url)) {
    return { inject: false, reason: 'private-network' };
  }
  return { inject: true, reason: '' };
}

/**
 * Chrome/Firefox content-script match patterns: host may be * or *.suffix, or a literal host
 * without interior wildcards. Mid-host wildcards are rejected by the browser.
 */
export function isValidMatchPattern(pattern = '') {
  const text = String(pattern || '').trim();
  if (!text) return false;
  if (text === 'file:///*') return true;
  const parts = /^(\*|https?|file|ftp|urn):\/\/([^/]+)(\/.*)$/.exec(text);
  if (!parts) return false;
  const host = parts[2];
  const path = parts[3];
  if (!path.startsWith('/')) return false;
  if (host === '*') return true;
  if (host.startsWith('*.')) {
    const suffix = host.slice(2);
    return Boolean(suffix) && !suffix.includes('*');
  }
  if (host.includes('*')) return false;
  if (host.startsWith('[') && host.endsWith(']')) return !host.slice(1, -1).includes('*');
  return true;
}

/** Match patterns that skip loopback and local names when private skip is active (valid grammar only). */
export function buildPrivateNetworkExcludeMatchPatterns() {
  const patterns = [];
  const schemes = ['http', 'https'];
  for (const scheme of schemes) {
    patterns.push(`${scheme}://127.0.0.1/*`);
    patterns.push(`${scheme}://localhost/*`);
    patterns.push(`${scheme}://[::1]/*`);
    patterns.push(`${scheme}://0.0.0.0/*`);
    patterns.push(`${scheme}://*.localhost/*`);
    patterns.push(`${scheme}://*.local/*`);
    patterns.push(`${scheme}://*.lan/*`);
    patterns.push(`${scheme}://*.internal/*`);
    patterns.push(`${scheme}://*.home.arpa/*`);
    patterns.push(`${scheme}://*.ts.net/*`);
  }
  return patterns;
}

/**
 * Host-wide exclude patterns. Origins with an explicit port are enforced by the document_start guard
 * (match patterns cannot distinguish ports on the same host).
 */
export function originToExcludeMatchPatterns(origin = '') {
  const normalized = normalizeOriginInput(origin);
  if (!normalized) return [];
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return [];
  }
  if (parsed.port) return [];
  const host = parsed.hostname.includes(':') && !parsed.hostname.startsWith('[')
    ? `[${parsed.hostname}]`
    : parsed.hostname;
  return [`${parsed.protocol}//${host}/*`];
}

/** Whether the active extension serves page-context scripts from dist/ (lib/...) or repo root (extension/...). */
export function extensionPageContextPackaged(getManifest = () => {
  const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;
  return typeof runtime?.getManifest === 'function' ? runtime.getManifest() : {};
}) {
  const files = (getManifest()?.content_scripts || []).flatMap((entry) => entry.js || []);
  if (files.some((file) => String(file).startsWith('extension/'))) return false;
  return true;
}

export function buildPageScriptExcludeMatchPatterns(settings = {}) {
  const patterns = new Set();
  // User-configured origins are enforced in the document_start guard with exact URL matching.
  // Content-script exclude patterns cannot distinguish ports on the same host, so they are
  // intentionally omitted here to keep automatic registration aligned with pageContextInjectionDecision.
  if (settings.pageContextOnPrivateNetworks !== true) {
    for (const pattern of buildPrivateNetworkExcludeMatchPatterns()) patterns.add(pattern);
  }
  return [...patterns];
}

export function assertValidPageScriptPatterns(definitions = []) {
  const invalid = [];
  for (const def of definitions) {
    for (const pattern of [...(def.matches || []), ...(def.excludeMatches || [])]) {
      if (!isValidMatchPattern(pattern)) invalid.push(pattern);
    }
  }
  if (invalid.length) {
    throw new Error(`Invalid content-script match patterns: ${invalid.join(', ')}`);
  }
}

export function buildRegisteredPageScriptDefinitions(settings = {}, { packaged = true } = {}) {
  const excludeMatches = buildPageScriptExcludeMatchPatterns(settings);
  const guardJs = packaged ? PACKAGED_PAGE_CONTEXT_GUARD_JS : REPOSITORY_PAGE_CONTEXT_GUARD_JS;
  const bundleJs = packaged ? [...PACKAGED_PAGE_SCRIPT_JS] : [...REPOSITORY_PAGE_SCRIPT_JS];
  const definitions = [
    {
      id: PAGE_CONTEXT_GUARD_SCRIPT_ID,
      matches: ['http://*/*', 'https://*/*', 'file:///*'],
      excludeMatches,
      js: [guardJs],
      runAt: 'document_start',
      persistAcrossSessions: true,
    },
    {
      id: PAGE_CONTEXT_SCRIPT_ID,
      matches: ['http://*/*', 'https://*/*', 'file:///*'],
      excludeMatches,
      js: bundleJs,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ];
  assertValidPageScriptPatterns(definitions);
  return definitions;
}

/** Bundle-only definition (dynamic registration uses a separate guard script). */
export function buildRegisteredPageScriptDefinition(settings = {}, options = {}) {
  const [guard, bundle] = buildRegisteredPageScriptDefinitions(settings, options);
  void guard;
  return bundle;
}

export function pageContextSkipMessageKey(reason = '') {
  if (reason === 'excluded-origin') return 'status.page_context_skipped_excluded';
  if (reason === 'private-network') return 'status.page_context_skipped_private';
  return 'status.page_context_skipped';
}
