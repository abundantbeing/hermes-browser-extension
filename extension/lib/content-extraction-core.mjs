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
const POTENTIAL_ASSIGNMENT_RE = /\b([A-Za-z][A-Za-z0-9_%+.-]{1,79})["'`]?\s*([:=])\s*["'`]?([^\s'"`;&,]+)/gi;

const SECRET_PATTERNS = [
  { pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  { pattern: /\bBearer\s+[^\s'"`;&]+/gi, replacement: 'Bearer [REDACTED_BEARER]' },
  { pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED_SECRET]' },
  { pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replacement: '[REDACTED_JWT]' },
  { pattern: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{8,}\b/gi, replacement: '[REDACTED_SECRET]' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/gi, replacement: '[REDACTED_SECRET]' },
];

function boundedInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function normalizeReadableWhitespace(value = '') {
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

function isSensitiveAssignmentKey(value = '') {
  return decodedTextLayers(value).some((layer) => {
    const normalized = layer.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    return SENSITIVE_ASSIGNMENT_KEYS.has(normalized);
  });
}

function redactSensitiveAssignments(value = '') {
  let count = 0;
  const text = String(value || '').replace(POTENTIAL_ASSIGNMENT_RE, (match, key, separator) => {
    if (!isSensitiveAssignmentKey(key)) return match;
    count += 1;
    const quotedObjectKey = /^["'`]\s*:/.test(match.slice(key.length));
    const delimiter = separator === ':' && !quotedObjectKey ? ': ' : '=';
    return `${key}${delimiter}[REDACTED_SECRET]`;
  });
  return { text, count };
}

export function redactSensitiveTextWithCount(value = '') {
  const assignments = redactSensitiveAssignments(value);
  let text = assignments.text;
  let count = assignments.count;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      count += 1;
      return replacement;
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

function inlineStyleHidesNode(node) {
  const style = String(node?.getAttribute?.('style') || '');
  return /(?:^|;)\s*display\s*:\s*none(?:\s*!important)?\s*(?:;|$)/i.test(style)
    || /(?:^|;)\s*visibility\s*:\s*(?:hidden|collapse)(?:\s*!important)?\s*(?:;|$)/i.test(style)
    || /(?:^|;)\s*content-visibility\s*:\s*hidden(?:\s*!important)?\s*(?:;|$)/i.test(style)
    || /(?:^|;)\s*opacity\s*:\s*0(?:\.0+)?(?:\s*!important)?\s*(?:;|$)/i.test(style);
}

function computedStyleHidesNode(node, document) {
  try {
    if (typeof node?.checkVisibility === 'function' && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
  } catch {
    // Older engines may reject checkVisibility options; computed style remains available below.
  }
  const getComputedStyle = document?.defaultView?.getComputedStyle;
  if (typeof getComputedStyle !== 'function') return false;
  try {
    const style = getComputedStyle.call(document.defaultView, node);
    return style?.display === 'none'
      || style?.visibility === 'hidden'
      || style?.visibility === 'collapse'
      || style?.contentVisibility === 'hidden'
      || Number.parseFloat(style?.opacity) === 0;
  } catch {
    return false;
  }
}

function liveNodeIsHidden(node, document) {
  return node?.hasAttribute?.('hidden')
    || node?.hasAttribute?.('inert')
    || node?.getAttribute?.('aria-hidden') === 'true'
    || inlineStyleHidesNode(node)
    || computedStyleHidesNode(node, document);
}

function cloneVisibleRoot(document, liveRoot) {
  const clone = liveRoot?.cloneNode?.(true) || null;
  if (!clone) return { clone: null, omittedNodes: 0 };
  const liveNodes = [liveRoot, ...Array.from(liveRoot?.querySelectorAll?.('*') || [])];
  const cloneNodes = [clone, ...Array.from(clone?.querySelectorAll?.('*') || [])];
  const inspected = Math.min(liveNodes.length, cloneNodes.length, MAX_VISIBILITY_NODES);
  let omittedNodes = Math.max(0, cloneNodes.length - inspected);
  for (let index = cloneNodes.length - 1; index >= inspected; index -= 1) cloneNodes[index]?.remove?.();
  for (let index = inspected - 1; index >= 1; index -= 1) {
    if (!liveNodeIsHidden(liveNodes[index], document)) continue;
    cloneNodes[index]?.remove?.();
    omittedNodes += 1;
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
