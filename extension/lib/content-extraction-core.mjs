export const EXTRACTION_SCHEMA = 'hermes.browser.extraction.v1';
export const EXTRACTION_VERSION = '1.0.0';

const DEFAULT_MAX_TEXT_CHARS = 12_000;
const DEFAULT_MAX_ENVELOPE_CHARS = 24_000;
const DEFAULT_MAX_CONTEXT_CHARS = 32_000;
const MAX_CANDIDATES = 240;
const MAX_VISIBILITY_NODES = 8_000;
const MAX_JSON_LD_SCRIPTS = 12;
const MAX_JSON_LD_SCRIPT_CHARS = 64_000;
const MAX_JSON_LD_TOTAL_CHARS = 128_000;
const MAX_STRUCTURE_SERIALIZED_CHARS = 8_000;
const MIN_CANDIDATE_TEXT_CHARS = 120;
const MAX_METADATA_TEXT_CHARS = 500;
const MAX_STRUCTURE_TEXT_CHARS = 400;
const TRUNCATION_MARKER = ' [truncated]';

const NOISE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'frame',
  'object',
  'embed',
  'canvas',
  'svg',
  'nav',
  'footer',
  'aside',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
  '[hidden]',
  '[inert]',
  '.advertisement',
  '.advert',
  '.ads',
  '.ad',
  '.cookie',
  '.consent',
  '.newsletter',
  '.subscribe',
  '.social-share',
  '.share-buttons',
  '.related-posts',
  '.recommendations',
  '.comments',
].join(',');

const CANDIDATE_SELECTOR = [
  'article',
  'main',
  '[role="main"]',
  '[itemprop="articleBody"]',
  '[itemprop="text"]',
  '.article',
  '.post',
  '.entry-content',
  '.article-content',
  '.post-content',
  '.markdown-body',
  '.documentation',
  '.docs-content',
  'section',
  'div',
].join(',');

const POSITIVE_HINT_RE = /article|body|content|entry|main|markdown|post|prose|story|text/i;
const NEGATIVE_HINT_RE = /ad-|advert|aside|banner|breadcrumb|comment|cookie|footer|header|menu|modal|nav|promo|related|share|sidebar|social|sponsor|subscribe|toolbar|widget/i;
const SENSITIVE_FIELD_RE = /api[-_ ]?key|auth|card|cc-|credit|cvv|cvc|mfa|otp|one[-_ ]?time|passcode|password|payment|pin|secret|security|token/i;
const SENSITIVE_ASSIGNMENT_KEYS = new Set([
  'apikey',
  'accesstoken',
  'authtoken',
  'refreshtoken',
  'sessiontoken',
  'clientsecret',
  'awssecretaccesskey',
  'secretaccesskey',
  'token',
  'secret',
  'password',
  'passwd',
  'privatekey',
]);
// Names are matched on their normalized form (lowercase, letters and digits
// only), so `stripe_secret_key`, `MY_API_TOKEN` and `db-password` all end in a
// credential word. A bare trailing `key` is deliberately not on this list:
// `sort_key` and `cache_key` are ordinary names.
const SENSITIVE_ASSIGNMENT_KEY_SUFFIXES = [
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'secretkey',
  'privatekey',
  'signingkey',
  'encryptionkey',
  'authkey',
  'masterkey',
  // Hermes Agent's own gateway key is API_SERVER_KEY.
  'serverkey',
  'credential',
  'credentials',
];
// key, optional closing quote of a JSON-style key, separator, then either a
// fully quoted value (spaces allowed) or a bare token.
const POTENTIAL_ASSIGNMENT_RE = /\b([A-Za-z][A-Za-z0-9_%+.-]{1,79})(["'`]?)(\s*)([:=])(\s*)(?:(["'`])((?:(?!\6)[^\r\n]){1,500})\6|(["'`]?)([^\s'"`;&,]+))/gi;
// The same shape inside a JSON string that was itself stored as a string
// (`{\"password\":\"hunter2\"}`), which is how JSON turns up in logs and API
// consoles. The value runs to the next escaped quote.
const ESCAPED_JSON_ASSIGNMENT_RE = /\b([A-Za-z][A-Za-z0-9_%+.-]{1,79})(\\+["'])(\s*:\s*)(\\+["'])((?:(?!\\+["'])[^\r\n]){1,500})(\\+["'])/gi;
// Closing brackets after a bare value belong to the surrounding JSON or code.
const BARE_VALUE_TRAILING_BRACKETS_RE = /[}\]]+$/;

const SECRET_PATTERNS = [
  { pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  { pattern: /\bBearer\s+[^\s'"`;&]+/gi, replacement: 'Bearer [REDACTED_BEARER]' },
  { pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bxox[abeprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bxapp-\d+-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replacement: '[REDACTED_JWT]' },
  { pattern: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{8,}\b/gi, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/gi, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bhf_[A-Za-z0-9]{30,}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bya29\.[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bgl(?:pat|dt|rt|rtr|cbt|ptt|ft|imt|agent|soat|ffct|wt|oas)-[A-Za-z0-9_.-]{20,}/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bGR1348941[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bdo[opr]_v1_[a-f0-9]{64}\b/g, replacement: '[REDACTED_SECRET]' },
  // The key shapes Hermes Agent's own redactor (agent/redact.py) knows for the providers, tools and chat
  // platforms Hermes is set up with. Each has a fixed prefix and a minimum length well past ordinary words.
  { pattern: /\b(?:gsk_|xai-|r8_|pplx-|fw_|fpk_)[A-Za-z0-9]{20,}/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bsyt_[A-Za-z0-9]{4,}_[A-Za-z0-9]{10,}_[A-Za-z0-9]{6}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\btvly-(?:dev-|prod-)?[A-Za-z0-9]{20,}/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\b(?:fal_|bb_live_)[A-Za-z0-9]{20,}/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bfc-[a-f0-9]{32}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bntn_[A-Za-z0-9]{40,}/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bsecret_[A-Za-z0-9]{43}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\blin_(?:api|oauth)_[A-Za-z0-9]{32,}/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bsk_[a-f0-9]{48}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bpk-lf-[A-Za-z0-9-]{20,}/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bgAAAAA[A-Za-z0-9_=-]{40,}/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bATATT3[A-Za-z0-9_=-]{40,}/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}\b/g, replacement: '[REDACTED_SECRET]' },
  // A Google OAuth refresh token.
  { pattern: /\b1\/\/0[A-Za-z0-9_-]{40,}/g, replacement: '[REDACTED_SECRET]' },
  // A Telegram bot token (`123456789:AA…`), also inside an `api.telegram.org/bot<token>/` path. A URL in
  // page text often carries the colon percent-encoded (`%3A`, or `%253A` when encoded twice), and the
  // `bot` may follow an encoded slash (`%2Fbot…`). The quantifiers are all bounded.
  { pattern: /(?:\b|(?<=%2[Ff]))(bot)?\d{8,12}(?::|%(?:25)?3[Aa])[A-Za-z0-9_-]{30,}/g, replacement: '$1[REDACTED_SECRET]' },
  // A Discord bot token: base64 user id, timestamp and HMAC, dot separated. Any punctuation before it
  // (`/`, `-`, `.`, `_`) still counts as a boundary; only a letter or digit glued to it does not.
  { pattern: /(?<![A-Za-z0-9])[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b/g, replacement: '[REDACTED_SECRET]' },
  // Slack and Discord incoming webhook URLs carry their secret as the last path segment. Slashes may be
  // percent-encoded (`%2F`, `%252F`) when the URL sits inside a query string.
  { pattern: /((?:\/|%(?:25)?2[Ff])services(?:\/|%(?:25)?2[Ff])T[A-Z0-9]{8,}(?:\/|%(?:25)?2[Ff])B[A-Z0-9]{8,}(?:\/|%(?:25)?2[Ff]))[A-Za-z0-9]{20,}/g, replacement: '$1[REDACTED_SECRET]' },
  { pattern: /((?:\/|%(?:25)?2[Ff])api(?:(?:\/|%(?:25)?2[Ff])v\d+)?(?:\/|%(?:25)?2[Ff])webhooks(?:\/|%(?:25)?2[Ff])\d{17,20}(?:\/|%(?:25)?2[Ff]))[A-Za-z0-9_-]{60,}/g, replacement: '$1[REDACTED_SECRET]' },
  { pattern: /\bshp(?:at|ca|pa|ss)_[a-f0-9]{32}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bwhsec_[A-Za-z0-9]{16,}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\b(?:Authorization|Proxy-Authorization)(["'`]?\s*[:=]\s*["'`]?)(?:Basic|Digest|Negotiate|NTLM|Token)\s+[^\s'"`;&,]+/gi, replacement: 'Authorization$1[REDACTED_SECRET]' },
  { pattern: /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"`]+:)[^\s@/'"`]+@/gi, replacement: '$1[REDACTED_SECRET]@' },
];

function boundedInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function normalizeReadableWhitespace(value = '') {
  // SECURITY BOUNDARY: Untrusted Input — page-derived text enters here.
  // Everything below must treat this as attacker-controlled data.
  return String(value || '')
    .replaceAll('\r', '')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function boundedText(value = '', maxChars = MAX_METADATA_TEXT_CHARS) {
  const text = normalizeReadableWhitespace(value);
  return text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text;
}

export function clampExtractedText(value = '', maxChars = DEFAULT_MAX_TEXT_CHARS) {
  const text = normalizeReadableWhitespace(value);
  const limit = boundedInteger(maxChars, DEFAULT_MAX_TEXT_CHARS, 16, 200_000);
  if (text.length <= limit) return { text, truncated: false, originalChars: text.length };
  const bodyLimit = Math.max(1, limit - TRUNCATION_MARKER.length);
  return {
    text: `${text.slice(0, bodyLimit).trimEnd()}${TRUNCATION_MARKER}`,
    truncated: true,
    originalChars: text.length,
  };
}

function decodedTextLayers(value = '', maxLayers = 3) {
  const layers = [String(value || '')];
  for (let index = 0; index < maxLayers; index += 1) {
    const current = layers[layers.length - 1].replace(/\+/g, ' ');
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      decoded = current.replace(/%([0-9a-fA-F]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    }
    if (decoded === layers[layers.length - 1]) break;
    layers.push(decoded);
  }
  return layers;
}

export function isSensitiveAssignmentKey(value = '') {
  return decodedTextLayers(value).some((layer) => {
    const normalized = layer.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    return SENSITIVE_ASSIGNMENT_KEYS.has(normalized)
      || SENSITIVE_ASSIGNMENT_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
  });
}

function redactSensitiveAssignments(value = '') {
  let count = 0;
  const escaped = String(value || '').replace(ESCAPED_JSON_ASSIGNMENT_RE, (match, key, keyQuote, separator, openQuote, _secret, closeQuote) => {
    if (!isSensitiveAssignmentKey(key)) return match;
    count += 1;
    return `${key}${keyQuote}${separator}${openQuote}[REDACTED_SECRET]${closeQuote}`;
  });
  const text = escaped.replace(POTENTIAL_ASSIGNMENT_RE, (match, key, keyQuote, beforeSeparator, separator, afterSeparator, quote, _quoted, _bareQuote, bare) => {
    if (!isSensitiveAssignmentKey(key)) return match;
    count += 1;
    if (quote) {
      // Quoted value: keep the key, separator spacing and quotes so JSON and
      // config-file shapes survive, and drop only the value itself.
      return `${key}${keyQuote}${beforeSeparator}${separator}${afterSeparator}${quote}[REDACTED_SECRET]${quote}`;
    }
    // A bare value must not swallow the `}` or `]` that closes its object.
    const closers = BARE_VALUE_TRAILING_BRACKETS_RE.exec(bare || '')?.[0] || '';
    if (keyQuote) {
      // JSON-style key followed by an unquoted value (number, boolean, bare word).
      return `${key}${keyQuote}${separator} [REDACTED_SECRET]${closers}`;
    }
    const delimiter = separator === ':' ? ': ' : '=';
    return `${key}${delimiter}[REDACTED_SECRET]${closers}`;
  });
  return { text, count };
}

export function redactSensitiveTextWithCount(value = '') {
  const assignments = redactSensitiveAssignments(value);
  let text = assignments.text;
  let count = assignments.count;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    text = text.replace(pattern, (...args) => {
      count += 1;
      return replacement.replace(/\$(\d)/g, (_token, index) => (typeof args[Number(index)] === 'string' ? args[Number(index)] : ''));
    });
  }
  return { text, count };
}

function safeHttpUrl(value = '', baseUrl = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password) return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function documentUrl(document) {
  return String(document?.URL || document?.location?.href || '').trim();
}

function metaContent(document, selectors = []) {
  for (const selector of selectors) {
    const value = document?.querySelector?.(selector)?.getAttribute?.('content');
    if (String(value || '').trim()) return boundedText(value);
  }
  return '';
}

function jsonLdValues(document) {
  const values = [];
  let skipped = 0;
  let consumedChars = 0;
  const nodes = Array.from(document?.querySelectorAll?.('script[type="application/ld+json"]') || []);
  for (const [index, node] of nodes.entries()) {
    if (index >= MAX_JSON_LD_SCRIPTS) {
      skipped += 1;
      continue;
    }
    const raw = String(node.textContent || '').trim();
    if (!raw || raw.length > MAX_JSON_LD_SCRIPT_CHARS || consumedChars + raw.length > MAX_JSON_LD_TOTAL_CHARS) {
      skipped += 1;
      continue;
    }
    consumedChars += raw.length;
    try {
      const parsed = JSON.parse(raw);
      values.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // Invalid or adversarial JSON-LD is ignored.
      skipped += 1;
    }
  }
  return { values, skipped };
}

function schemaTypes(value) {
  const raw = value?.['@type'];
  return (Array.isArray(raw) ? raw : [raw]).map((item) => String(item || '').toLowerCase());
}

function nestedSchemaObjects(value, output = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5 || output.length >= 120) return output;
  if (Array.isArray(value)) {
    for (const item of value) nestedSchemaObjects(item, output, depth + 1);
    return output;
  }
  output.push(value);
  if (value['@graph']) nestedSchemaObjects(value['@graph'], output, depth + 1);
  if (value.mainEntity) nestedSchemaObjects(value.mainEntity, output, depth + 1);
  return output;
}

function articleSchema(document) {
  const preferredTypes = new Set(['article', 'blogposting', 'newsarticle', 'report', 'scholarlyarticle', 'techarticle', 'videoobject']);
  const jsonLd = jsonLdValues(document);
  const objects = jsonLd.values.flatMap((value) => nestedSchemaObjects(value));
  return {
    value: objects.find((value) => schemaTypes(value).some((type) => preferredTypes.has(type))) || {},
    skipped: jsonLd.skipped,
  };
}

function entityName(value) {
  if (Array.isArray(value)) return value.map(entityName).filter(Boolean).join(', ');
  if (value && typeof value === 'object') return boundedText(value.name || value.headline || '');
  return boundedText(value || '');
}

function extractMetadata(document) {
  const baseUrl = documentUrl(document);
  const schema = articleSchema(document);
  const structured = schema.value;
  const canonicalHref = document?.querySelector?.('link[rel="canonical"]')?.getAttribute?.('href') || '';
  const title = entityName(structured.headline || structured.name)
    || metaContent(document, ['meta[property="og:title"]', 'meta[name="twitter:title"]'])
    || boundedText(document?.title || '')
    || boundedText(document?.querySelector?.('h1')?.textContent || '');
  const description = boundedText(structured.description || '')
    || metaContent(document, ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']);
  const author = entityName(structured.author)
    || metaContent(document, ['meta[name="author"]', 'meta[property="article:author"]']);
  const publishedAt = boundedText(structured.datePublished || '')
    || metaContent(document, ['meta[property="article:published_time"]', 'meta[name="date"]', 'meta[name="pubdate"]']);
  const modifiedAt = boundedText(structured.dateModified || '')
    || metaContent(document, ['meta[property="article:modified_time"]']);
  const siteName = entityName(structured.publisher)
    || metaContent(document, ['meta[property="og:site_name"]', 'meta[name="application-name"]']);
  const redacted = {};
  let redactionCount = 0;
  for (const [key, value] of Object.entries({ title, description, author, publishedAt, modifiedAt, siteName })) {
    const next = redactSensitiveTextWithCount(value);
    redacted[key] = boundedText(next.text);
    redactionCount += next.count;
  }
  return {
    ...redacted,
    language: boundedText(document?.documentElement?.getAttribute?.('lang') || '', 40),
    canonicalUrl: safeHttpUrl(canonicalHref || baseUrl, baseUrl),
    redactionCount,
    jsonLdScriptsSkipped: schema.skipped,
  };
}

function inlineStyleHidesNode(node, { ignoreVisibility = false } = {}) {
  const style = String(node?.getAttribute?.('style') || '');
  return /(?:^|;)\s*display\s*:\s*none(?:\s*!important)?\s*(?:;|$)/i.test(style)
    || (!ignoreVisibility && /(?:^|;)\s*visibility\s*:\s*(?:hidden|collapse)(?:\s*!important)?\s*(?:;|$)/i.test(style))
    || /(?:^|;)\s*content-visibility\s*:\s*hidden(?:\s*!important)?\s*(?:;|$)/i.test(style);
  // opacity is judged from the computed style, since a class may make the element display:contents, where opacity
  // does nothing
}

function computedStyleHidesNode(node, document, { ignoreVisibility = false } = {}) {
  const view = document?.defaultView;
  let style = null;
  try {
    style = view?.getComputedStyle?.(node) || null;
  } catch {
    style = null;
  }
  // an element with display:contents draws no box of its own (so neither its opacity nor checkVisibility applies
  // to what it holds): it is judged by display and visibility only. Opacity is judged per element below, not
  // through checkVisibility, which also counts the no-op opacity of a display:contents ancestor; an element whose
  // own opacity is zero is removed with its whole subtree when the walk reaches it.
  const contents = style?.display === 'contents';
  try {
    if (!contents && typeof node?.checkVisibility === 'function'
      && !node.checkVisibility({ checkOpacity: false, checkVisibilityCSS: !ignoreVisibility })) return true;
  } catch {
    // Older engines may reject checkVisibility options; computed style remains available below.
  }
  if (!style) return false;
  return style.display === 'none'
    || (!ignoreVisibility && (style.visibility === 'hidden' || style.visibility === 'collapse'))
    || style.contentVisibility === 'hidden'
    || (!contents && Number.parseFloat(style.opacity) === 0);
}

function liveNodeIsHidden(node, document, options = {}) {
  return node?.hasAttribute?.('hidden')
    || node?.hasAttribute?.('inert')
    || node?.getAttribute?.('aria-hidden') === 'true'
    || inlineStyleHidesNode(node, options)
    || computedStyleHidesNode(node, document, options);
}

// Hidden by visibility alone: its own text is hidden, but a child with visibility:visible still shows, so only the
// element's own text goes and each child is judged on its own.
function hiddenOnlyByVisibility(node, document) {
  try {
    const visibility = document?.defaultView?.getComputedStyle?.(node)?.visibility;
    return (visibility === 'hidden' || visibility === 'collapse') && !liveNodeIsHidden(node, document, { ignoreVisibility: true });
  } catch {
    return false;
  }
}

// Any CSS colour (rgb, hex, hsl, oklch, lab, color(), color-mix() ...) as 0-255 channels and a 0-1 alpha, read by
// painting it into a 1px canvas, so no colour space is misread. Null when the page cannot draw or the value is not a
// colour.
function colourReader(document) {
  const cache = new Map();
  let context = null;
  return (value) => {
    const text = String(value || '').trim();
    if (!text) return null;
    if (cache.has(text)) return cache.get(text);
    let colour = null;
    try {
      if (!context) {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        context = canvas.getContext('2d', { willReadFrequently: true });
      }
      if (context) {
        context.clearRect(0, 0, 1, 1);
        // an unparseable value leaves the previous fill in place, so two different starting fills both survive it
        context.fillStyle = '#010203';
        context.fillStyle = text;
        const first = String(context.fillStyle);
        context.fillStyle = '#040506';
        context.fillStyle = text;
        if (!(first === '#010203' && String(context.fillStyle) === '#040506')) {
          context.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
          colour = { r, g, b, a: a / 255 };
        }
      }
    } catch {
      colour = null;
    }
    cache.set(text, colour);
    return colour;
  };
}

const CSS_COLOUR_RE = /(?:#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\((?:[^()]|\([^()]*\))*\)|\btransparent\b|\bcurrentcolor\b)/gi;
const FAINT_ALPHA = 0.05;
const MIN_READABLE_FONT_PX = 4;

// How opaque the node really is: its own opacity times every ancestor's, cached per element.
function effectiveOpacity(node, view, scan) {
  if (!node || node.nodeType !== 1) return 1;
  if (scan.opacity.has(node)) return scan.opacity.get(node);
  const style = view.getComputedStyle(node);
  const own = style?.display === 'contents' ? 1 : Number.parseFloat(style?.opacity);
  const value = (Number.isFinite(own) ? own : 1) * effectiveOpacity(node.parentElement, view, scan);
  scan.opacity.set(node, value);
  return value;
}

// Whether a shadow list or a stroke draws something visible.
function drawsVisibly(list, readColour, fallback) {
  const value = String(list || 'none');
  if (value === 'none') return false;
  const colours = value.match(CSS_COLOUR_RE) || [];
  if (!colours.length) return (fallback?.a ?? 1) > FAINT_ALPHA;
  return colours.some((token) => (/currentcolor/i.test(token) ? (fallback?.a ?? 1) : (readColour(token)?.a ?? 1)) > FAINT_ALPHA);
}

const ownTextNodes = (node) => Array.from(node?.childNodes || []).filter((child) => child.nodeType === 3 && /\S/.test(child.nodeValue || ''));

// A number as the browser writes it in computed styles (12, -0.5, .5, 1e+06, 1e-06).
const CSS_NUMBER_RE = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;

// The flat [a, b, c, d] part of a computed transform, identity for none, or null for a 3D matrix (the browser writes
// a transform as matrix() whenever it stays flat).
const IDENTITY_2D = [1, 0, 0, 1];
function transformMatrix(value) {
  const text = String(value || 'none');
  if (/^matrix3d\(/.test(text)) return null;
  const numbers = text.replace(/^[^(]*\(/, '').match(CSS_NUMBER_RE)?.map(Number) || [];
  return /^matrix\(/.test(text) && numbers.length >= 6 ? numbers.slice(0, 4) : IDENTITY_2D;
}

// The rotate property as a flat turn: a bare angle or "z <angle>" turns about the screen axis; any other axis is a
// 3D turn (null).
function rotateMatrix(value) {
  const text = String(value || 'none').trim();
  if (text === 'none') return IDENTITY_2D;
  const match = /^(?:z\s+|0\s+0\s+\d*\.?\d+\s+)?(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|turn|grad)$/i.exec(text);
  if (!match) return null;
  const unit = { deg: Math.PI / 180, rad: 1, turn: 2 * Math.PI, grad: Math.PI / 200 }[match[2].toLowerCase()];
  const angle = Number(match[1]) * unit;
  return [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle)];
}

function scaleMatrix(value) {
  const factors = String(value || 'none').split(/\s+/).map(Number).filter(Number.isFinite);
  if (!factors.length) return IDENTITY_2D;
  return [factors[0], 0, 0, factors.length > 1 ? factors[1] : factors[0]];
}

// [a, b, c, d] matrices in CSS order (x' = a·x + c·y, y' = b·x + d·y): first applied on the right.
const multiply2D = ([a1, b1, c1, d1], [a2, b2, c2, d2]) => [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2];

// How everything above the text maps it flat onto the screen: each element's rotate, scale and transform (in that
// CSS order), composed with every ancestor's before measuring, so scales that cancel cancel, times zoom. A chain with
// any 3D (a 3D matrix or turn, or perspective) has no flat matrix (null): how it draws is not judged. An inline
// element and display:contents draw no transformable box, so their transforms do nothing. Cached per element.
function drawnTransform(node, view, scan) {
  if (!node || node.nodeType !== 1) return { matrix: IDENTITY_2D, zoom: 1 };
  if (scan.scale.has(node)) return scan.scale.get(node);
  const parent = drawnTransform(node.parentElement, view, scan);
  const style = view.getComputedStyle(node);
  let own = IDENTITY_2D;
  if (!/^(?:inline|contents)$/.test(String(style?.display || ''))) {
    const parts = [rotateMatrix(style?.rotate), scaleMatrix(style?.scale), transformMatrix(style?.transform)];
    own = parts.includes(null) || String(style?.perspective || 'none') !== 'none' ? null : parts.reduce(multiply2D);
  }
  const zoom = Number.parseFloat(style?.zoom);
  const value = {
    matrix: parent.matrix && own ? multiply2D(parent.matrix, own) : null,
    zoom: parent.zoom * (zoom > 0 ? zoom : 1),
  };
  scan.scale.set(node, value);
  return value;
}

// The size text is drawn at: its font size times zoom and the narrower stretch (smaller singular value) of the flat
// transforms that map it to the screen, so a rotation stretches nothing and a squash in either direction counts.
// Under a 3D transform only the font size and zoom count.
function renderedFontPx(node, style, view, scan) {
  const { matrix, zoom } = drawnTransform(node, view, scan);
  const size = Number.parseFloat(style?.fontSize) * zoom;
  if (!matrix) return size;
  const [a, b, c, d] = matrix;
  const sum = a * a + b * b + c * c + d * d;
  const det = a * d - b * c;
  return size * Math.sqrt(Math.max(0, (sum - Math.sqrt(Math.max(0, sum * sum - 4 * det * det))) / 2));
}

// Text a person cannot read: no size, or no ink. Ink is the text fill (or colour) times the opacity of the element
// and every ancestor; near-zero counts as none. A visible shadow, a visible outline or a background clipped to the
// text draws the glyphs anyway, so the text is kept. Text the colour of whatever is behind it is not judged: what
// paints behind text cannot be read reliably, so that stays a documented limit. Only the element's own text is
// judged; children carry their own styles.
function ownTextIsInvisible(node, document, scan) {
  const view = document?.defaultView;
  if (!ownTextNodes(node).length || typeof view?.getComputedStyle !== 'function') return false;
  try {
    const style = view.getComputedStyle(node);
    if (renderedFontPx(node, style, view, scan) < MIN_READABLE_FONT_PX) return true;
    const ink = scan.readColour(style?.webkitTextFillColor) || scan.readColour(style?.color);
    if (!ink) return false;
    const opacity = effectiveOpacity(node, view, scan);
    const inkAlpha = ink.a * opacity;
    if (inkAlpha > FAINT_ALPHA) return false;
    const shadowed = drawsVisibly(style?.textShadow, scan.readColour, ink) && opacity > FAINT_ALPHA;
    const stroked = Number.parseFloat(style?.webkitTextStrokeWidth) > 0
      && (scan.readColour(style?.webkitTextStrokeColor)?.a ?? 0) * opacity > FAINT_ALPHA;
    const clippedFill = [style?.backgroundClip, style?.webkitBackgroundClip].some((clip) => String(clip || '').includes('text'))
      && opacity > FAINT_ALPHA
      && (String(style?.backgroundImage || 'none') !== 'none' || (scan.readColour(style?.backgroundColor)?.a ?? 0) > FAINT_ALPHA);
    return !shadowed && !stroked && !clippedFill;
  } catch {
    return false;
  }
}

// An ancestor with a transform, filter, perspective, paint containment or a will-change for them becomes the box a
// fixed (or absolute) element is positioned against, so that element moves with it instead of with the window.
// Only a box can anchor: display:contents makes none, and an inline box ignores transforms and containment, so
// only a filter (or a will-change for one) anchors from an inline element.
function anchorsFixedDescendants(style) {
  const set = (value) => String(value || 'none') !== 'none';
  const display = String(style?.display || '');
  if (display === 'contents') return false;
  if (display === 'inline') {
    return set(style?.filter) || set(style?.backdropFilter) || /\b(?:filter|backdrop-filter)\b/.test(String(style?.willChange || ''));
  }
  return set(style?.transform) || set(style?.translate) || set(style?.rotate) || set(style?.scale)
    || set(style?.filter) || set(style?.perspective) || set(style?.backdropFilter)
    || style?.transformStyle === 'preserve-3d'
    || style?.contentVisibility === 'auto'
    || /\b(?:size|inline-size)\b/.test(String(style?.containerType || ''))
    || /\b(?:paint|layout|strict|content)\b/.test(String(style?.contain || ''))
    || /\b(?:transform|translate|rotate|scale|filter|perspective|backdrop-filter|contain)\b/.test(String(style?.willChange || ''));
}

// What an element is laid out against, which is what moves it: its parent for normal flow, the nearest positioned
// (or transformed) ancestor for position:absolute, the nearest transformed ancestor or else the window for
// position:fixed, and the page when nothing is left.
function containingBlockOf(element, view, cache) {
  if (cache?.blocks.has(element)) return cache.blocks.get(element);
  const block = findContainingBlock(element, view);
  cache?.blocks.set(element, block);
  return block;
}

function findContainingBlock(element, view) {
  const position = view.getComputedStyle(element)?.position;
  if (position === 'fixed' || position === 'absolute') {
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = view.getComputedStyle(ancestor);
      const boxed = style?.display !== 'contents';
      if (anchorsFixedDescendants(style) || (position === 'absolute' && boxed && style?.position !== 'static')) return { box: ancestor };
    }
    return position === 'fixed' ? { window: true } : { page: true };
  }
  return element.parentElement ? { box: element.parentElement } : { page: true };
}

// A box a person can scroll (overflow auto, scroll or overlay). It clips what lies outside the range it can scroll
// to, even when it has nothing to scroll. The root's scrolling is the window's, and <body>'s overflow belongs to the
// window too unless <html> clips its own.
function isScrollBox(box, view, cache) {
  if (cache?.scrollBoxes.has(box)) return cache.scrollBoxes.get(box);
  const scrolls = findScrollBox(box, view);
  cache?.scrollBoxes.set(box, scrolls);
  return scrolls;
}

function findScrollBox(box, view) {
  const document = box.ownerDocument;
  if (box === document?.documentElement || box === document?.scrollingElement) return false;
  const style = view.getComputedStyle(box);
  if (!/\b(?:auto|scroll|overlay)\b/.test(`${style?.overflowX} ${style?.overflowY}`)) return false;
  // overflow applies only to boxes that hold content: an inline element, display:contents and table rows ignore it
  if (/^(?:inline|contents|table-(?:row|row-group|header-group|footer-group|column|column-group))$/.test(String(style?.display || ''))) return false;
  if (box === document?.body) {
    const root = view.getComputedStyle(document.documentElement);
    if (root?.overflowX === 'visible' && root?.overflowY === 'visible') return false;
  }
  return true;
}

// Which screen axes scroll backwards (start at the right or the bottom, offsets going negative). The block axis is
// vertical in horizontal writing and horizontal in vertical writing (right to left in vertical-rl and sideways-rl);
// the inline axis runs right to left, or bottom to top, with direction:rtl and in sideways-lr. A row-reverse flex
// box flips its inline axis and a column-reverse one its block axis, so two flips cancel.
function reversedScroll(style) {
  const mode = String(style?.writingMode || 'horizontal-tb');
  const vertical = /^(?:vertical|sideways)/.test(mode);
  const flex = /flex/.test(String(style?.display || ''));
  const inlineBack = (style?.direction === 'rtl') !== (mode === 'sideways-lr') !== (flex && style?.flexDirection === 'row-reverse');
  const blockBack = /-rl$/.test(mode) !== (flex && style?.flexDirection === 'column-reverse');
  return vertical ? { x: blockBack, y: inlineBack } : { x: inlineBack, y: blockBack };
}

// Whether a rectangle lies wholly where scrolling cannot bring it. `x` and `y` are its position measured from the
// box's scroll origin (where it would sit with the box scrolled back to 0); a box shows [0, size] at that point and
// scrolls forwards into [size, scrollSize] or, when reversed, backwards into [size - scrollSize, 0].
const OFF_PAGE_MARGIN_PX = 8;
function beyondScrollRange({ x, y, width, height }, { clientWidth, clientHeight, scrollWidth, scrollHeight }, reversed) {
  const margin = OFF_PAGE_MARGIN_PX;
  const outside = (start, size, client, scrollSize, back) => (back
    ? start > client + margin || start + size < client - Math.max(client, scrollSize) - margin
    : start + size < -margin || start > Math.max(client, scrollSize) + margin);
  return outside(x, width, clientWidth, scrollWidth, reversed.x) || outside(y, height, clientHeight, scrollHeight, reversed.y);
}

// How a scrolling box can move what it holds, on each screen axis: the range of shifts its scroll positions apply
// (a box scrolls forwards over [0, travel], or backwards over [-travel, 0] when reversed; scrolling to s moves the
// content by current - s) and the stretch of screen it shows. Measured once per box.
function scrollReach(box, view, cache) {
  if (cache?.reach.has(box)) return cache.reach.get(box);
  const frame = box.getBoundingClientRect();
  const reversed = reversedScroll(view.getComputedStyle(box));
  // zoom and scaling transforms grow the frame but not the box's own scroll metrics: bring those to screen px
  const scaleX = box.offsetWidth > 0 ? frame.width / box.offsetWidth : 1;
  const scaleY = box.offsetHeight > 0 ? frame.height / box.offsetHeight : 1;
  const axis = (current, client, scrollSize, visibleStart, back, scale) => {
    const travel = Math.max(0, scrollSize - client) * scale;
    const [low, high] = back ? [-travel, 0] : [0, travel];
    return { shift: [current * scale - high, current * scale - low], shows: [visibleStart, visibleStart + client * scale] };
  };
  const reach = {
    x: axis(box.scrollLeft, box.clientWidth, box.scrollWidth, frame.left + box.clientLeft * scaleX, reversed.x, scaleX),
    y: axis(box.scrollTop, box.clientHeight, box.scrollHeight, frame.top + box.clientTop * scaleY, reversed.y, scaleY),
  };
  cache?.reach.set(box, reach);
  return reach;
}

// Every place a rectangle can be brought to on screen while it shows inside the box, as a range of starts on each
// axis: the starts it already had, moved by every scroll the box allows, kept where at least a pixel of it overlaps
// what the box shows. Null when no scroll position shows it. Ranges stay ranges through any number of boxes, so the
// middle of a range is never lost and the work grows with the depth of the page, not exponentially.
function reachInScrollBox(span, box, view, cache) {
  const reach = scrollReach(box, view, cache);
  const axis = ([from, to], size, { shift, shows }) => {
    // a box that shows less than a pixel shows nothing, however it scrolls
    if (shows[1] - shows[0] < 1) return null;
    const low = Math.max(from + shift[0], shows[0] - size + 1);
    const high = Math.min(to + shift[1], shows[1] - 1);
    return low <= high ? [low, high] : null;
  };
  const x = axis(span.x, span.width, reach.x);
  const y = axis(span.y, span.height, reach.y);
  return x && y ? { x, y, width: span.width, height: span.height } : null;
}

// Whether a rectangle, wherever in its ranges it sits, stays wholly where scrolling cannot bring it: past the window
// for text fixed to it, or before the start of the page.
function spanOffPage(span, node, view, holdsText, cache) {
  const margin = OFF_PAGE_MARGIN_PX;
  // text is laid out inside the element that holds it; a box's own frame is laid out by what contains the box
  let box = node;
  let judgeSelf = holdsText;
  for (;;) {
    if (judgeSelf && isScrollBox(box, view, cache)) {
      span = reachInScrollBox(span, box, view, cache);
      if (!span) return true;
    }
    judgeSelf = true;
    const block = containingBlockOf(box, view, cache);
    if (block.window) {
      return span.x[1] + span.width < -margin || span.y[1] + span.height < -margin
        || span.x[0] > view.innerWidth + margin || span.y[0] > view.innerHeight + margin;
    }
    if (block.page) {
      const document = view.document;
      // the page scrolls the way its principal writing mode (from <body>) runs
      const reversed = reversedScroll(view.getComputedStyle(document?.body || document?.documentElement));
      // the page clips nothing past its far end: only before its start is unreachable, so the start nearest it counts
      const before = { clientWidth: view.innerWidth, clientHeight: view.innerHeight, scrollWidth: Number.POSITIVE_INFINITY, scrollHeight: Number.POSITIVE_INFINITY };
      const x = (reversed.x ? span.x[0] : span.x[1]) + (view.scrollX || 0);
      const y = (reversed.y ? span.y[0] : span.y[1]) + (view.scrollY || 0);
      return beyondScrollRange({ x, y, width: span.width, height: span.height }, before, reversed);
    }
    box = block.box;
  }
}

// Where the text itself was laid out, not its box: wholly where no scrolling can bring it (outside the range of the
// scrolling boxes it moves with, counting right-to-left, vertical and bottom-up scrolling, or before the start of the
// page), or, for text fixed to the window, wholly outside the window. Only boxes that actually move the text count:
// an absolute child anchored outside a scrolling box does not scroll with it. Screen-reader-only text overflows its
// 1px box onto the page and is kept: it is real content for people who use a screen reader. Lines are judged by
// halves: when the rectangle around a group of lines is out of reach, so is every line in it; otherwise the group
// is split, down to single lines (the gaps between lines hold no text), and the first reachable line ends the check.
// Lines run in reading order, so only the groups at a window or page edge split and the walks grow with the log of
// the line count. A node that would need more than LINE_CHECK_BUDGET walks is kept, like a partly reachable one.
const LINE_CHECK_BUDGET = 512;
function rectsOffPage(rects, node, view, cache = null) {
  if (!rects.length) return false;
  let budget = LINE_CHECK_BUDGET;
  const groupOff = (from, to) => {
    if (budget <= 0) return false;
    budget -= 1;
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = from; i < to; i += 1) {
      left = Math.min(left, rects[i].left);
      top = Math.min(top, rects[i].top);
      right = Math.max(right, rects[i].right);
      bottom = Math.max(bottom, rects[i].bottom);
    }
    if (spanOffPage({ x: [left, left], y: [top, top], width: right - left, height: bottom - top }, node, view, true, cache)) return true;
    if (to - from === 1) return false;
    const middle = (from + to) >> 1;
    return groupOff(from, middle) && groupOff(middle, to);
  };
  return groupOff(0, rects.length);
}

function rangeRects(document, text, start, end) {
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  return Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
}

// Each live text node and its copy in the clone, paired while the two trees are still identical, so removing
// one hidden child can never shift which copy another text node points at.
function pairTextNodes(liveRoot, clone, document) {
  const pairs = new Map();
  if (typeof document?.createTreeWalker !== 'function') return pairs;
  const live = document.createTreeWalker(liveRoot, 4);
  const copy = document.createTreeWalker(clone, 4);
  for (let a = live.nextNode(), b = copy.nextNode(); a && b; a = live.nextNode(), b = copy.nextNode()) pairs.set(a, b);
  return pairs;
}

// A text node laid out wholly where no scrolling reaches it is removed from the copy. A node that is only partly out
// of reach (a long line pushed half off the page) is kept whole: cutting inside a node cannot be done reliably
// (bidirectional text, wrapped lines, huge lines), so that is a documented limit, and what is kept still reaches
// the model only inside the untrusted block.
function removeOffPageText(liveNode, document, copies, cache) {
  const view = document?.defaultView;
  if (typeof view?.getComputedStyle !== 'function' || typeof document?.createRange !== 'function') return 0;
  let removed = 0;
  for (const child of ownTextNodes(liveNode)) {
    try {
      const rects = rangeRects(document, child, 0, (child.nodeValue || '').length);
      if (rects.length && rectsOffPage(rects, liveNode, view, cache)) {
        copies.get(child)?.remove?.();
        removed += 1;
      }
    } catch {
      // text that cannot be measured is kept
    }
  }
  return removed;
}

function removeOwnText(node) {
  for (const child of Array.from(node?.childNodes || [])) if (child.nodeType === 3) child.remove?.();
}

function cloneVisibleRoot(document, liveRoot) {
  const clone = liveRoot?.cloneNode?.(true) || null;
  if (!clone) return { clone: null, omittedNodes: 0 };
  const copies = pairTextNodes(liveRoot, clone, document);
  const liveNodes = [liveRoot, ...Array.from(liveRoot?.querySelectorAll?.('*') || [])];
  const cloneNodes = [clone, ...Array.from(clone?.querySelectorAll?.('*') || [])];
  const inspected = Math.min(liveNodes.length, cloneNodes.length, MAX_VISIBILITY_NODES);
  let omittedNodes = Math.max(0, cloneNodes.length - inspected);
  for (let index = cloneNodes.length - 1; index >= inspected; index -= 1) cloneNodes[index]?.remove?.();
  const scan = { opacity: new Map(), scale: new Map(), readColour: colourReader(document), layout: { blocks: new Map(), scrollBoxes: new Map(), reach: new Map() } };
  for (let index = inspected - 1; index >= 1; index -= 1) {
    if (hiddenOnlyByVisibility(liveNodes[index], document)) {
      removeOwnText(cloneNodes[index]);
      omittedNodes += 1;
    } else if (liveNodeIsHidden(liveNodes[index], document)) {
      cloneNodes[index]?.remove?.();
      omittedNodes += 1;
    } else if (ownTextIsInvisible(liveNodes[index], document, scan)) {
      removeOwnText(cloneNodes[index]);
      omittedNodes += 1;
    } else {
      omittedNodes += removeOffPageText(liveNodes[index], document, copies, scan.layout);
    }
  }
  // the root's own text (usually <body>'s) is judged the same way; its children were judged above
  if (ownTextIsInvisible(liveRoot, document, scan)) {
    removeOwnText(clone);
    omittedNodes += 1;
  } else {
    omittedNodes += removeOffPageText(liveRoot, document, copies, scan.layout);
  }
  if (liveNodeIsHidden(liveRoot, document)) {
    for (const child of Array.from(clone.childNodes || [])) child.remove?.();
    omittedNodes += 1;
  }
  return { clone, omittedNodes };
}

function removeNoise(root) {
  for (const node of Array.from(root?.querySelectorAll?.(NOISE_SELECTORS) || [])) {
    node.remove?.();
  }
  return root;
}

function textOf(node) {
  return normalizeReadableWhitespace(node?.textContent || '');
}

function classAndId(node) {
  return `${node?.getAttribute?.('class') || ''} ${node?.getAttribute?.('id') || ''}`.trim();
}

function linkTextChars(node) {
  return Array.from(node?.querySelectorAll?.('a') || []).reduce((sum, link) => sum + textOf(link).length, 0);
}

function candidateScore(node) {
  const text = textOf(node);
  const textChars = text.length;
  const paragraphs = Array.from(node?.querySelectorAll?.('p') || []).filter((paragraph) => textOf(paragraph).length >= 40).length;
  const sentences = (text.match(/[.!?](?:\s|$)/g) || []).length;
  const headings = Array.from(node?.querySelectorAll?.('h1,h2,h3') || []).length;
  const forms = Array.from(node?.querySelectorAll?.('form,input,textarea,select') || []).length;
  const links = linkTextChars(node);
  const linkDensity = textChars ? Math.min(1, links / textChars) : 1;
  const tag = String(node?.tagName || '').toLowerCase();
  const hints = classAndId(node);
  let score = (Math.min(textChars, 20_000) / 35) + (paragraphs * 28) + (Math.min(sentences, 80) * 3) + (Math.min(headings, 20) * 7);
  if (tag === 'article') score += 95;
  else if (tag === 'main' || node?.getAttribute?.('role') === 'main') score += 45;
  else if (tag === 'section') score += 12;
  if (POSITIVE_HINT_RE.test(hints)) score += 30;
  if (NEGATIVE_HINT_RE.test(hints)) score -= 80;
  score -= linkDensity * 190;
  score -= Math.min(forms, 20) * 12;
  return {
    node,
    tag: tag || 'unknown',
    hint: boundedText(hints, 120),
    score: Math.round(score * 10) / 10,
    textChars,
    paragraphs,
    linkDensity: Math.round(linkDensity * 1000) / 1000,
  };
}

function bestCandidate(root) {
  const candidates = Array.from(root?.querySelectorAll?.(CANDIDATE_SELECTOR) || [])
    .slice(0, MAX_CANDIDATES)
    .map(candidateScore)
    .filter((candidate) => candidate.textChars >= MIN_CANDIDATE_TEXT_CHARS)
    .sort((left, right) => right.score - left.score || left.textChars - right.textChars);
  const best = candidates[0] || null;
  if (!best || best.score < 45) return { best: null, candidates };
  return { best, candidates };
}

function redactStructureText(value, maxChars = MAX_STRUCTURE_TEXT_CHARS) {
  return boundedText(redactSensitiveTextWithCount(value).text, maxChars);
}

function normalizeLink(node, baseUrl) {
  const text = redactStructureText(node?.textContent || '', 240);
  const url = safeHttpUrl(node?.getAttribute?.('href') || '', baseUrl);
  if (!text && !url) return null;
  return { text, url };
}

function fieldMetadata(field) {
  const rawType = String(field?.getAttribute?.('type') || field?.tagName || 'text').toLowerCase();
  const type = rawType === 'input' ? 'text' : boundedText(redactSensitiveTextWithCount(rawType).text, 40);
  const rawAutocomplete = String(field?.getAttribute?.('autocomplete') || '').toLowerCase();
  const rawName = String(field?.getAttribute?.('name') || '');
  const name = boundedText(rawName, 100);
  const label = boundedText(
    field?.getAttribute?.('aria-label')
      || field?.closest?.('label')?.textContent
      || field?.getAttribute?.('placeholder')
      || name,
    160,
  );
  const classificationText = [type, rawAutocomplete, rawName, label]
    .flatMap((value) => decodedTextLayers(value))
    .join(' ');
  const sensitive = type === 'password'
    || rawAutocomplete === 'one-time-code'
    || rawAutocomplete.startsWith('cc-')
    || SENSITIVE_FIELD_RE.test(classificationText);
  return {
    type,
    name: sensitive ? '' : redactStructureText(name, 100),
    label: sensitive ? 'Sensitive field' : redactStructureText(label, 160),
    autocomplete: sensitive ? '' : redactStructureText(rawAutocomplete, 80),
    sensitive,
  };
}

function extractStructure(root, baseUrl, maxSerializedChars = MAX_STRUCTURE_SERIALIZED_CHARS) {
  const structure = {
    headings: [],
    links: [],
    lists: [],
    tables: [],
    codeBlocks: [],
    blockquotes: [],
    images: [],
    interactives: [],
    forms: [],
  };
  const limit = boundedInteger(maxSerializedChars, MAX_STRUCTURE_SERIALIZED_CHARS, 512, 100_000);
  let serializedChars = 2;
  let truncated = false;
  const add = (category, item) => {
    if (!item) return false;
    const itemChars = JSON.stringify(item).length + 1;
    if (serializedChars + itemChars > limit) {
      truncated = true;
      return false;
    }
    structure[category].push(item);
    serializedChars += itemChars;
    return true;
  };

  for (const node of Array.from(root?.querySelectorAll?.('h1,h2,h3,h4,h5,h6') || []).slice(0, 32)) {
    const text = redactStructureText(node.textContent || '', 240);
    if (text) add('headings', { level: String(node.tagName || '').toLowerCase(), text });
  }
  for (const form of Array.from(root?.querySelectorAll?.('form') || []).slice(0, 16)) {
    add('forms', {
      label: redactStructureText(form.getAttribute?.('aria-label') || form.getAttribute?.('name') || '', 160),
      fields: Array.from(form.querySelectorAll?.('input,textarea,select') || []).slice(0, 30).map(fieldMetadata),
    });
  }
  for (const node of Array.from(root?.querySelectorAll?.('pre,code') || []).filter((item) => !item.closest?.('pre') || String(item.tagName || '').toLowerCase() === 'pre').slice(0, 20)) {
    const item = {
      language: boundedText(node.getAttribute?.('data-language') || node.querySelector?.('code')?.getAttribute?.('class') || '', 80),
      text: redactStructureText(node.textContent || '', 2_000),
    };
    if (item.text) add('codeBlocks', item);
  }
  for (const node of Array.from(root?.querySelectorAll?.('blockquote,[role="note"],.callout,.admonition') || []).slice(0, 20)) {
    const text = redactStructureText(node.textContent || '', 1_000);
    if (text) add('blockquotes', {
      kind: String(node.tagName || '').toLowerCase() === 'blockquote' ? 'blockquote' : 'callout',
      text,
    });
  }
  for (const list of Array.from(root?.querySelectorAll?.('ul,ol') || []).slice(0, 20)) {
    const items = Array.from(list.children || [])
      .filter((item) => String(item.tagName || '').toLowerCase() === 'li')
      .slice(0, 12)
      .map((item) => redactStructureText(item.textContent || '', 180))
      .filter(Boolean);
    if (items.length) add('lists', { ordered: String(list.tagName || '').toLowerCase() === 'ol', items });
  }
  for (const table of Array.from(root?.querySelectorAll?.('table') || []).slice(0, 12)) {
    const rows = Array.from(table.querySelectorAll?.('tr') || []).slice(0, 8).map((row) => Array.from(row.querySelectorAll?.('th,td') || [])
      .slice(0, 6)
      .map((cell) => redactStructureText(cell.textContent || '', 120)));
    if (rows.some((row) => row.length)) add('tables', {
      caption: redactStructureText(table.querySelector?.('caption')?.textContent || '', 180),
      rows,
    });
  }
  for (const node of Array.from(root?.querySelectorAll?.('a[href]') || []).slice(0, 80)) add('links', normalizeLink(node, baseUrl));
  for (const node of Array.from(root?.querySelectorAll?.('img') || []).slice(0, 40)) {
    const item = {
      url: safeHttpUrl(node.getAttribute?.('src') || node.getAttribute?.('data-src') || '', baseUrl),
      alt: redactStructureText(node.getAttribute?.('alt') || '', 240),
      width: boundedInteger(node.getAttribute?.('width'), 0, 0, 20_000),
      height: boundedInteger(node.getAttribute?.('height'), 0, 0, 20_000),
    };
    if (item.url || item.alt) add('images', item);
  }
  for (const node of Array.from(root?.querySelectorAll?.('button,[role="button"],a[href]') || []).slice(0, 60)) {
    const text = redactStructureText(node.textContent || node.getAttribute?.('aria-label') || '', 180);
    if (text) add('interactives', { kind: String(node.tagName || '').toLowerCase() === 'a' ? 'link' : 'button', text });
  }
  return { structure, serializedChars, truncated };
}

function wordCount(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function extractionConfidence(candidate) {
  if (!candidate) return 0.2;
  return Math.min(0.98, Math.max(0.6, 0.56 + (candidate.score / 900)));
}

function serializedChars(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function stabilizeSerializedLimit(target, key = 'serializedChars') {
  for (let index = 0; index < 4; index += 1) {
    const next = serializedChars(target);
    if (target.limits?.[key] === next) return next;
    if (target.limits) target.limits[key] = next;
  }
  return serializedChars(target);
}

function enforceExtractionEnvelopeBudget(result, maxEnvelopeChars) {
  const trimOrder = ['interactives', 'images', 'tables', 'lists', 'blockquotes', 'codeBlocks', 'links', 'forms', 'headings'];
  if (result.debug && serializedChars(result) > maxEnvelopeChars) delete result.debug;
  for (const category of trimOrder) {
    const items = result.structure?.[category];
    while (Array.isArray(items) && items.length && serializedChars(result) > maxEnvelopeChars) {
      items.pop();
      result.limits.structureTruncated = true;
    }
  }
  if (serializedChars(result) > maxEnvelopeChars) {
    const overflow = serializedChars(result) - maxEnvelopeChars;
    const nextLimit = Math.max(16, result.content.text.length - overflow - 128);
    const next = clampExtractedText(result.content.text.replace(TRUNCATION_MARKER, ''), nextLimit);
    result.content.text = next.text;
    result.content.excerpt = boundedText(next.text.replace(TRUNCATION_MARKER, ''), 320);
    result.content.wordCount = wordCount(next.text);
    result.content.truncated = true;
  }
  result.limits.serializedChars = stabilizeSerializedLimit(result);
  if (result.limits.serializedChars > maxEnvelopeChars) {
    result.structure = { headings: [], links: [], lists: [], tables: [], codeBlocks: [], blockquotes: [], images: [], interactives: [], forms: [] };
    result.limits.structureTruncated = true;
    result.limits.serializedChars = stabilizeSerializedLimit(result);
  }
  return result;
}

function extractionBridgeSummary(extraction) {
  return {
    schema: extraction.schema,
    version: extraction.version,
    method: extraction.method,
    confidence: extraction.confidence,
    detailsIncluded: false,
    content: {
      wordCount: extraction.content?.wordCount || 0,
      originalChars: extraction.content?.originalChars || 0,
      truncated: Boolean(extraction.content?.truncated),
    },
    privacy: { ...(extraction.privacy || {}) },
    limits: { ...(extraction.limits || {}) },
  };
}

function enforceContextBudget(context, maxContextChars) {
  for (const key of ['interactive', 'forms', 'headings']) {
    const items = context.meta?.[key];
    while (Array.isArray(items) && items.length && serializedChars(context) > maxContextChars) items.pop();
  }
  if (serializedChars(context) > maxContextChars) {
    const overflow = serializedChars(context) - maxContextChars;
    context.text = clampExtractedText(context.text, Math.max(16, context.text.length - overflow - 128)).text;
    context.meta.extraction.truncated = true;
    context.extraction.content.truncated = true;
  }
  if (serializedChars(context) > maxContextChars) {
    const overflow = serializedChars(context) - maxContextChars;
    context.selectedText = clampExtractedText(context.selectedText, Math.max(16, context.selectedText.length - overflow - 128)).text;
  }
  context.extraction.limits.maxContextChars = maxContextChars;
  context.extraction.limits.serializedContextChars = serializedChars(context);
  return context;
}

export function extractPageContent(document, options = {}) {
  // SECURITY BOUNDARY: Untrusted Input — `document` is a live web page
  // controlled by the site. All extracted strings must be treated as
  // attacker-controlled and escaped/sanitized before any DOM rendering.
  const maxTextChars = boundedInteger(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS, 16, 200_000);
  const defaultEnvelopeChars = Math.max(DEFAULT_MAX_ENVELOPE_CHARS, maxTextChars + 12_000);
  const maxEnvelopeChars = boundedInteger(options.maxEnvelopeChars, defaultEnvelopeChars, 4_000, 220_000);
  const maxStructureChars = Math.min(
    MAX_STRUCTURE_SERIALIZED_CHARS,
    Math.max(512, maxEnvelopeChars - Math.min(maxTextChars, maxEnvelopeChars - 2_000) - 4_000),
  );
  const metadata = extractMetadata(document);
  const baseUrl = metadata.canonicalUrl || safeHttpUrl(documentUrl(document));
  const liveRoot = document?.body || document?.documentElement || null;
  const visibleClone = cloneVisibleRoot(document, liveRoot);
  const clone = visibleClone.clone;
  if (clone) removeNoise(clone);
  const { best, candidates } = bestCandidate(clone);
  const selectedRoot = best?.node || clone;
  const method = best ? 'candidate-reader' : 'raw-body-fallback';
  const rawText = textOf(selectedRoot);
  const redactedText = redactSensitiveTextWithCount(rawText);
  const clamped = clampExtractedText(redactedText.text, maxTextChars);
  const structureResult = extractStructure(selectedRoot, baseUrl, maxStructureChars);
  const structure = structureResult.structure;
  const sensitiveFieldsPresent = structure.forms.some((form) => form.fields.some((field) => field.sensitive));
  const excerpt = boundedText(clamped.text.replace(TRUNCATION_MARKER, ''), 320);
  const result = {
    schema: EXTRACTION_SCHEMA,
    version: EXTRACTION_VERSION,
    capturedAt: new Date().toISOString(),
    sourceUrl: baseUrl,
    method,
    confidence: Math.round(extractionConfidence(best) * 100) / 100,
    content: {
      text: clamped.text,
      excerpt,
      wordCount: wordCount(clamped.text),
      originalChars: clamped.originalChars,
      truncated: clamped.truncated,
    },
    metadata: {
      title: metadata.title,
      description: metadata.description,
      author: metadata.author,
      publishedAt: metadata.publishedAt,
      modifiedAt: metadata.modifiedAt,
      siteName: metadata.siteName,
      language: metadata.language,
      canonicalUrl: metadata.canonicalUrl,
    },
    structure,
    privacy: {
      redactionCount: metadata.redactionCount + redactedText.count,
      formValuesCaptured: false,
      sensitiveFieldsPresent,
    },
    limits: {
      maxTextChars,
      maxCandidates: MAX_CANDIDATES,
      maxEnvelopeChars,
      maxStructureChars,
      structureChars: structureResult.serializedChars,
      structureTruncated: structureResult.truncated,
      jsonLdScriptsSkipped: metadata.jsonLdScriptsSkipped,
      visibilityNodesOmitted: visibleClone.omittedNodes,
      serializedChars: 0,
    },
  };
  if (options.debug) {
    result.debug = {
      candidates: candidates.slice(0, 20).map(({ node: _node, ...candidate }) => candidate),
      selected: best ? { tag: best.tag, hint: best.hint, score: best.score } : null,
    };
  }
  return enforceExtractionEnvelopeBudget(result, maxEnvelopeChars);
}

export function collectPageContext(document, options = {}) {
  const maxTextChars = boundedInteger(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS, 16, 200_000);
  const maxSelectedTextChars = boundedInteger(options.maxSelectedTextChars, Math.min(maxTextChars, 8_000), 16, 20_000);
  const defaultEnvelopeChars = Math.max(DEFAULT_MAX_ENVELOPE_CHARS, maxTextChars + 12_000);
  const maxEnvelopeChars = boundedInteger(options.maxEnvelopeChars, defaultEnvelopeChars, 4_000, 220_000);
  const defaultContextChars = Math.max(DEFAULT_MAX_CONTEXT_CHARS, maxTextChars + maxSelectedTextChars + 12_000);
  const maxContextChars = boundedInteger(options.maxContextChars, defaultContextChars, 8_000, 260_000);
  const extraction = extractPageContent(document, {
    maxTextChars,
    maxEnvelopeChars,
    debug: Boolean(options.debug),
  });
  const metadata = extraction.metadata || {};
  const structure = extraction.structure || {};
  const selected = redactSensitiveTextWithCount(options.selectedText || '');
  const selectedText = clampExtractedText(selected.text, maxSelectedTextChars).text;
  const context = {
    ok: true,
    source: boundedText(options.source || 'shared-extractor', 80),
    title: metadata.title || boundedText(document?.title || ''),
    url: extraction.sourceUrl || safeHttpUrl(options.url || documentUrl(document)),
    selectedText,
    text: extraction.content?.text || '',
    meta: {
      description: metadata.description || '',
      language: metadata.language || '',
      canonical: metadata.canonicalUrl || '',
      headings: structure.headings || [],
      interactive: structure.interactives || [],
      forms: structure.forms || [],
      extraction: {
        schema: extraction.schema,
        version: extraction.version,
        method: extraction.method,
        confidence: extraction.confidence,
        wordCount: extraction.content?.wordCount || 0,
        truncated: Boolean(extraction.content?.truncated),
        redactionCount: (extraction.privacy?.redactionCount || 0) + selected.count,
      },
    },
    extraction: extractionBridgeSummary(extraction),
    capturedAt: extraction.capturedAt || new Date().toISOString(),
  };
  return enforceContextBudget(context, maxContextChars);
}

export const CONTENT_EXTRACTION_API = Object.freeze({
  schema: EXTRACTION_SCHEMA,
  version: EXTRACTION_VERSION,
  extractPageContent,
  collectPageContext,
  redactSensitiveTextWithCount,
  normalizeReadableWhitespace,
  clampExtractedText,
});
