import { privateNetworkHost } from './common.mjs';

export const PAGE_CONTEXT_SCRIPT_ID = 'hermes-page-context-bundle';

const PACKAGED_PAGE_SCRIPT_JS = Object.freeze([
  'lib/browser-api-global.js',
  'content-extractor.js',
  'content.js',
  'lib/i18n-content.js',
  'content-inline-helper.js',
]);

/** Packaged extension paths used by dynamic page-context registration and side-panel injection fallback. */
export function packagedPageContextScriptFiles() {
  return [...PACKAGED_PAGE_SCRIPT_JS];
}

const REPOSITORY_PAGE_SCRIPT_JS = Object.freeze([
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
  const candidateDefaultPort = `${parsed.protocol}//${host}`;
  return origins.some((origin) => origin === candidate || origin === candidateDefaultPort);
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

/** Match patterns that skip RFC1918, loopback, link-local, and local names when private skip is active. */
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
    patterns.push(`${scheme}://10.*/*`);
    patterns.push(`${scheme}://192.168.*/*`);
    patterns.push(`${scheme}://169.254.*/*`);
    for (let second = 16; second <= 31; second += 1) {
      patterns.push(`${scheme}://172.${second}.*/*`);
    }
    for (let second = 64; second <= 127; second += 1) {
      patterns.push(`${scheme}://100.${second}.*/*`);
    }
  }
  return patterns;
}

export function originToExcludeMatchPatterns(origin = '') {
  const normalized = normalizeOriginInput(origin);
  if (!normalized) return [];
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return [];
  }
  const host = parsed.hostname.includes(':') && !parsed.hostname.startsWith('[')
    ? `[${parsed.hostname}]`
    : parsed.hostname;
  return [`http://${host}/*`, `https://${host}/*`];
}

export function buildPageScriptExcludeMatchPatterns(settings = {}) {
  const patterns = new Set();
  for (const origin of normalizePageContextExcludedOrigins(settings.pageContextExcludedOrigins)) {
    for (const pattern of originToExcludeMatchPatterns(origin)) patterns.add(pattern);
  }
  if (settings.pageContextOnPrivateNetworks !== true) {
    for (const pattern of buildPrivateNetworkExcludeMatchPatterns()) patterns.add(pattern);
  }
  return [...patterns];
}

export function buildRegisteredPageScriptDefinition(settings = {}, { packaged = true } = {}) {
  return {
    id: PAGE_CONTEXT_SCRIPT_ID,
    matches: ['http://*/*', 'https://*/*', 'file:///*'],
    excludeMatches: buildPageScriptExcludeMatchPatterns(settings),
    js: packaged ? [...PACKAGED_PAGE_SCRIPT_JS] : [...REPOSITORY_PAGE_SCRIPT_JS],
    runAt: 'document_idle',
    persistAcrossSessions: true,
  };
}

export function pageContextSkipMessageKey(reason = '') {
  if (reason === 'excluded-origin') return 'status.page_context_skipped_excluded';
  if (reason === 'private-network') return 'status.page_context_skipped_private';
  return 'status.page_context_skipped';
}
