(() => {
  'use strict';

  const RESTRICTED_SCHEMES = new Set([
    'chrome:', 'chrome-extension:', 'chrome-search:', 'chrome-devtools:',
    'devtools:', 'edge:', 'brave:', 'opera:', 'view-source:',
  ]);
  const SENSITIVE_URL_PATTERNS = [
    /bank/i, /banking/i, /\/bank/i,
    /coinbase|binance|kraken|crypto\.com|wallet/i,
    /1password|bitwarden|lastpass|dashlane|keepersecurity/i,
    /\/password/i, /\/billing/i, /\/checkout/i, /\/payments?/i,
    /\/medical|healthcare|patient|mychart/i, /\/tax|irs\.gov|ssa\.gov/i,
  ];

  function decodedUrlPart(value = '') {
    const normalized = String(value || '').replace(/\+/g, ' ');
    try {
      return decodeURIComponent(normalized);
    } catch {
      return normalized;
    }
  }

  function restrictedUrlHaystack(parsed) {
    const rawParts = [parsed.hostname, parsed.pathname, parsed.search, parsed.hash];
    const decodedParts = rawParts.map(decodedUrlPart);
    return [...rawParts, ...decodedParts].join(' ');
  }

  function hasCredentialBearingUrl(parsed) {
    const auth = String(parsed.username || '') + String(parsed.password || '');
    return Boolean(auth);
  }

  function hermesIsPageContextCaptureUrlBlocked(url = '', options = {}) {
    const allowLocalDocuments = options && options.allowLocalDocuments === true;
    if (!url) return true;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return true;
    }
    if (RESTRICTED_SCHEMES.has(parsed.protocol)) return true;
    if (parsed.protocol === 'file:') return !allowLocalDocuments;
    if (!['http:', 'https:'].includes(parsed.protocol)) return true;
    if (hasCredentialBearingUrl(parsed)) return true;
    const haystack = restrictedUrlHaystack(parsed);
    return SENSITIVE_URL_PATTERNS.some((pattern) => pattern.test(haystack));
  }

  globalThis.hermesIsPageContextCaptureUrlBlocked = hermesIsPageContextCaptureUrlBlocked;
})();