import { redactSensitiveText } from './redaction.mjs';
import { hasCredentialBearingUrl } from './redaction.mjs';

export const PAGE_ANNOTATION_SCHEMA_VERSION = 1;
export const PAGE_ANNOTATION_COMMENTS_ENABLED = true;
export const PAGE_ANNOTATION_FEATURE_STORAGE_KEY = 'hermes:pageAnnotationCommentsEnabled';
export const PAGE_ANNOTATION_PROMPT_START = '<<<HERMES_PAGE_COMMENTS';
export const PAGE_ANNOTATION_PROMPT_END = 'HERMES_PAGE_COMMENTS>>>';
export const PAGE_ANNOTATION_NOTE_LIMIT = 4_000;
export const PAGE_ANNOTATION_MAX_PINS = 12;

const MAX_TEXT = 80;
const MAX_SELECTOR = 180;
const MAX_HTML = 600;
const MAX_CSS_VALUE = 80;
const GROUP_THRESHOLD = 4;
const SEP = '>';

export const ANNOTATE_CSS_KEYS = Object.freeze([
  'color',
  'background-color',
  'font-size',
  'font-family',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'display',
  'position',
  'width',
  'height',
  'max-width',
  'padding',
  'margin',
  'border',
  'border-radius',
  'box-shadow',
  'opacity',
  'overflow',
  'z-index',
  'transform',
  'flex-direction',
  'gap',
  'grid-template-columns',
  'justify-content',
  'align-items',
]);

const SEMANTIC_TAGS = new Set(['a', 'button', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'input', 'label', 'select', 'textarea']);

export function pageAnnotationCommentsEnabled({ storedValue, testOverride } = {}) {
  if (testOverride === true) return true;
  if (storedValue === true) return true;
  if (storedValue === false) return false;
  return PAGE_ANNOTATION_COMMENTS_ENABLED;
}

function clip(value, max) {
  const trimmed = String(value || '').replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function clipNote(value) {
  return clip(redactSensitiveText(String(value || '')), PAGE_ANNOTATION_NOTE_LIMIT);
}

export function compactPageAnnotationIdentity(snapshot = {}) {
  const css = {};
  const source = snapshot.css && typeof snapshot.css === 'object' ? snapshot.css : {};
  for (const key of ANNOTATE_CSS_KEYS) {
    const raw = source[key] || source[key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())];
    if (!raw || raw === 'normal' || raw === 'none' || raw === 'auto' || raw === '0px') continue;
    css[key] = clip(raw, MAX_CSS_VALUE);
  }
  return {
    css,
    html: clip(redactSensitiveText(snapshot.html || ''), MAX_HTML),
    selector: clip(snapshot.selector || snapshot.tag || 'div', MAX_SELECTOR),
    tag: String(snapshot.tag || 'div').toLowerCase(),
    text: clip(redactSensitiveText(snapshot.text || ''), MAX_TEXT),
  };
}

function formatIdentityLine(identity) {
  if (!identity?.text) return identity?.selector || identity?.tag || 'element';
  const label = `"${identity.text}"`;
  return SEMANTIC_TAGS.has(identity.tag) ? `${identity.tag} ${label}` : label;
}

function identityBlock(pin) {
  if (!pin?.target && pin?.kind === 'area') {
    const width = Math.round(Number(pin.rect?.width) || 0);
    const height = Math.round(Number(pin.rect?.height) || 0);
    return `area on the page (${width}×${height}px)`;
  }
  return formatIdentityLine(pin.identity || compactPageAnnotationIdentity(pin.target || {}));
}

function cssBlock(identity) {
  const entries = Object.entries(identity?.css || {});
  if (!entries.length) return '';
  return `Styles: ${entries.map(([name, value]) => `${name}: ${value}`).join('; ')}`;
}

export function emptyPageAnnotationStack(page = {}) {
  return {
    schemaVersion: PAGE_ANNOTATION_SCHEMA_VERSION,
    sessionId: String(page.sessionId || ''),
    tabId: Number(page.tabId) || 0,
    safeUrl: String(page.safeUrl || ''),
    documentKey: String(page.documentKey || ''),
    nextNumber: 1,
    pins: [],
  };
}

export function addPageAnnotation(stack, draft) {
  const number = Number(stack?.nextNumber) || 1;
  const pin = {
    schemaVersion: PAGE_ANNOTATION_SCHEMA_VERSION,
    sessionId: stack.sessionId,
    id: draft.id || `annotation-${number}`,
    number,
    status: 'saved',
    kind: draft.kind === 'area' ? 'area' : 'element',
    page: draft.page,
    target: draft.kind === 'area' ? null : draft.target,
    identity: draft.kind === 'area' ? undefined : compactPageAnnotationIdentity(draft.target || draft.identity || {}),
    rect: draft.rect,
    viewport: draft.viewport,
    imageRef: draft.imageRef || '',
    imageDataUrl: draft.imageDataUrl || '',
    note: clipNote(draft.note || ''),
    createdAt: draft.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  return {
    ...stack,
    nextNumber: number + 1,
    pins: [...(stack.pins || []), pin],
  };
}

export function updatePageAnnotationNote(stack, id, note) {
  return {
    ...stack,
    pins: (stack.pins || []).map((pin) => (pin.id === id ? { ...pin, note: clipNote(note), updatedAt: Date.now() } : pin)),
  };
}

export function removePageAnnotation(stack, id) {
  return {
    ...stack,
    pins: (stack.pins || []).filter((pin) => pin.id !== id),
  };
}

export function clearPageAnnotationStack(stack) {
  return { ...emptyPageAnnotationStack(stack), nextNumber: Number(stack?.nextNumber) || 1 };
}

export function normalizePageAnnotationResult(raw, session = {}) {
  if (!raw || typeof raw !== 'object') return null;
  if (Number(raw.version || raw.schemaVersion) !== PAGE_ANNOTATION_SCHEMA_VERSION) return null;
  if (String(raw.sessionId || '') !== String(session.sessionId || '')) return null;
  if (session.documentKey && String(raw.documentKey || '') !== String(session.documentKey || '')) return null;
  const pageUrl = String(raw.pageUrl || raw.safeUrl || '');
  if (!pageUrl || pageUrl !== String(session.safeUrl || '')) return null;
  if (hasCredentialBearingUrl(pageUrl)) return null;
  if (raw.tabId != null && Number.isFinite(Number(session.tabId)) && Number(raw.tabId) !== Number(session.tabId)) return null;
  const kind = raw.kind === 'area' ? 'area' : raw.kind === 'element' ? 'element' : '';
  if (!kind) return null;
  const rect = raw.rect && Number(raw.rect.width) > 0 && Number(raw.rect.height) > 0
    ? {
      x: Math.round(Number(raw.rect.x)),
      y: Math.round(Number(raw.rect.y)),
      width: Math.round(Number(raw.rect.width)),
      height: Math.round(Number(raw.rect.height)),
    }
    : null;
  if (!rect) return null;
  return {
    schemaVersion: PAGE_ANNOTATION_SCHEMA_VERSION,
    sessionId: String(raw.sessionId),
    kind,
    page: {
      tabId: Number(session.tabId),
      safeUrl: pageUrl,
      title: String(raw.pageTitle || ''),
      documentKey: String(raw.documentKey),
      frameId: Number(raw.frameId) || 0,
    },
    target: kind === 'element' ? compactPageAnnotationIdentity(raw.identity || {}) : null,
    rect,
    viewport: raw.viewport && typeof raw.viewport === 'object' ? raw.viewport : null,
  };
}

export function packagePageAnnotation(pin) {
  const identity = pin.identity || (pin.target ? compactPageAnnotationIdentity(pin.target) : undefined);
  const note = String(pin.note || '').trim();
  const target = identityBlock({ ...pin, identity });
  const prompt = [
    `Comment ${pin.number}`,
    `Target: ${target}`,
    identity?.selector && pin.kind !== 'area' ? `Selector: ${identity.selector}` : '',
    identity?.html && pin.kind !== 'area' ? `HTML: ${identity.html}` : '',
    pin.kind !== 'area' ? cssBlock(identity) : '',
    note ? `Note: ${note}` : '',
    pin.imageDataUrl || pin.imageRef ? `Image ${pin.number} marks the target in blue.` : `Image unavailable for this comment.`,
  ].filter(Boolean).join('\n');
  return {
    identity,
    imageDataUrl: pin.imageDataUrl || '',
    imageRef: pin.imageRef || '',
    note,
    number: pin.number,
    prompt,
  };
}

function segments(selector) {
  return String(selector || '').split(SEP).map((part) => part.trim()).filter(Boolean);
}

function ancestorPath(selector) {
  const parts = segments(selector);
  return parts.length > 1 ? parts.slice(0, -1) : parts;
}

function prefixAt(parts, depth) {
  return parts.slice(0, depth).join(SEP);
}

export function annotateSplitDepth(selectors = []) {
  const parts = selectors.map(ancestorPath);
  if (parts.length < 2) return parts[0]?.length ? 1 : 0;
  const shortest = Math.min(...parts.map((list) => list.length));
  for (let depth = 1; depth <= shortest; depth += 1) {
    const seen = new Set(parts.map((list) => prefixAt(list, depth)));
    if (seen.size > 1) return depth;
  }
  return parts.some((list) => list.length > shortest) ? shortest + 1 : shortest;
}

function labelFor(key) {
  const parts = segments(key);
  return parts[parts.length - 1] || '';
}

function bucket(items, depth) {
  const byKey = new Map();
  for (const item of items) {
    const key = prefixAt(ancestorPath(item.identity?.selector || ''), depth);
    const group = byKey.get(key);
    if (group) {
      group.items.push(item);
      continue;
    }
    byKey.set(key, { items: [item], key, label: labelFor(key) });
  }
  return Array.from(byKey.values());
}

function refine(groups, total) {
  const ceiling = Math.max(2, Math.ceil(total / 3));
  let current = groups;
  for (let pass = 0; pass < total; pass += 1) {
    const target = current.find((group) => group.items.length > ceiling);
    if (!target) break;
    const selectors = target.items.map((item) => item.identity?.selector || '');
    const split = bucket(target.items, annotateSplitDepth(selectors));
    if (split.length < 2) break;
    current = current.flatMap((group) => (group === target ? split : [group]));
  }
  return current;
}

export function groupPageAnnotations(items = []) {
  const placed = items.filter((item) => item.identity?.selector);
  const loose = items.filter((item) => !item.identity?.selector);
  const depth = annotateSplitDepth(placed.map((item) => item.identity?.selector || ''));
  const groups = refine(bucket(placed, depth), placed.length);
  if (loose.length) groups.push({ items: [...loose], key: '', label: '' });
  return groups;
}

function batchGuidance(groupCount, total) {
  return [
    `These ${total} comments are pre-grouped by where they sit in the page — each group is a different part of the DOM, so the groups should touch mostly separate files.`,
    `Work them as ${groupCount} pieces of work, not ${total}. Fold comments in the same group into one change.`,
    'If you delegate, delegate whole groups — never split one group across workers, and never form new groups by theme (all the spacing ones, all the copy ones): those cut across the same files and the workers will collide.',
    'Regroup if the code disagrees with this split — it is derived from the page structure, not from your source layout.',
  ].join(' ');
}

export function formatPageAnnotationFlush(pins = [], pageUrl = '') {
  const items = pins.map((pin) => (pin.prompt ? pin : packagePageAnnotation(pin)));
  const where = pageUrl ? ` on ${pageUrl}` : '';
  const count = items.length;
  if (count === 1) {
    return [`I left a comment${where} in the browser tab. Address it and keep the scope narrow.`, '', ...items.map((item) => item.prompt)].join('\n');
  }
  const groups = groupPageAnnotations(items);
  if (count < GROUP_THRESHOLD || groups.length < 2) {
    return [`I left ${count} comments${where} in the browser tab. Address them and keep the scope narrow.`, '', ...items.map((item) => item.prompt)].join('\n');
  }
  const sections = groups.flatMap((group, index) => {
    const what = group.label ? `\`${group.label}\`` : 'Unanchored (dragged areas)';
    return [`Group ${index + 1} — ${what} (${group.items.length} comment${group.items.length === 1 ? '' : 's'})`, ...group.items.map((item) => item.prompt), ''];
  });
  return [
    `I left ${count} comments${where} in the browser tab. Address them and keep the scope narrow.`,
    batchGuidance(groups.length, count),
    '',
    ...sections,
  ].join('\n').trimEnd();
}

export function pageAnnotationBundleFingerprint(pins = []) {
  return pins.map((pin) => `${pin.id}:${pin.number}:${pin.note}:${pin.imageRef || pin.imageDataUrl || ''}`).join('|');
}

export function wrapPageAnnotationPrompt(sessionId, revision, text) {
  return `${PAGE_ANNOTATION_PROMPT_START} session=${sessionId} revision=${revision}>>>\n${text}\n<<<END_${PAGE_ANNOTATION_PROMPT_END}`;
}

function stripPageAnnotationPrompt(text, sessionId) {
  const source = String(text || '');
  const pattern = new RegExp(`${PAGE_ANNOTATION_PROMPT_START} session=${sessionId} revision=\\d+>>>[\\s\\S]*?<<<END_${PAGE_ANNOTATION_PROMPT_END}`, 'g');
  return source.replace(pattern, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function mergePageAnnotationComposerState(current = {}, bundle = {}) {
  const sessionId = String(bundle.sessionId || '');
  const keptAttachments = (current.attachments || []).filter((item) => item?.annotationSessionId !== sessionId && item?.source !== 'page-annotations' || item?.annotationSessionId && item.annotationSessionId !== sessionId);
  const userAttachments = (current.attachments || []).filter((item) => item?.source !== 'page-annotations' || item?.annotationSessionId !== sessionId);
  const nextTextBase = stripPageAnnotationPrompt(current.text || '', sessionId);
  const wrapped = wrapPageAnnotationPrompt(sessionId, bundle.revision, bundle.text || '');
  const text = [nextTextBase, wrapped].filter(Boolean).join('\n\n');
  return {
    text,
    attachments: [...userAttachments, ...(bundle.attachments || [])],
    keptAttachments,
  };
}

export function queuePageAnnotationTurn(bundle = {}) {
  return {
    text: String(bundle.text || ''),
    attachments: [...(bundle.attachments || [])],
    kind: 'queued',
    autoSend: true,
    source: 'page-annotations',
    annotationSessionId: bundle.sessionId,
    annotationRevision: bundle.revision,
  };
}

export function restorePageAnnotationBundleAfterFailure(bundle = {}, error) {
  return {
    retained: true,
    queuedTurn: queuePageAnnotationTurn(bundle),
    error: error?.message || String(error || 'Send failed'),
  };
}

export function formatPageCommentTargetLabel({ tag = '', text = '', selector = '' } = {}) {
  const visible = String(text || '').replace(/\s+/g, ' ').trim();
  if (visible) return visible.length > 42 ? `${visible.slice(0, 41)}…` : visible;
  const last = String(selector || '').split('>').pop()?.trim() || '';
  if (last) return last.length > 48 ? `${last.slice(0, 47)}…` : last;
  return String(tag || 'Element');
}

export function pageCommentVisibleText(content = '') {
  const source = String(content || '');
  if (!source.includes('HERMES_PAGE_COMMENTS')) return source;
  const stripped = source
    .replace(/<<<HERMES_PAGE_COMMENTS[\s\S]*?<<<END_HERMES_PAGE_COMMENTS>>>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (stripped) return stripped;
  const count = (source.match(/^Comment \d+$/gm) || []).length;
  if (count === 1) return '1 page comment';
  if (count > 1) return `${count} page comments`;
  return 'Page comments';
}

export function buildPageAnnotationComposerBundle(stack, { resolveImage } = {}) {
  const pins = stack?.pins || [];
  const attachments = pins.map((pin) => {
    const dataUrl = pin.imageDataUrl || (typeof resolveImage === 'function' ? resolveImage(pin) : '');
    if (!dataUrl) return null;
    return {
      id: `ann-${stack.sessionId}-${pin.number}`,
      kind: 'image',
      label: `Comment_${pin.number}.png`,
      dataUrl,
      source: 'page-annotations',
      annotationSessionId: stack.sessionId,
      annotationRevision: pageAnnotationBundleFingerprint(pins),
    };
  }).filter(Boolean);
  return {
    sessionId: stack.sessionId,
    revision: pageAnnotationBundleFingerprint(pins),
    text: formatPageAnnotationFlush(pins, stack.safeUrl),
    attachments,
  };
}
