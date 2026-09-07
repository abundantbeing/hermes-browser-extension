export const PAGE_ANNOTATION_MESSAGES = Object.freeze({
  START: 'HERMES_START_PAGE_ANNOTATION',
  CANCEL: 'HERMES_CANCEL_PAGE_ANNOTATION',
  RESULT: 'HERMES_PAGE_ANNOTATION_RESULT',
  PICKING: 'HERMES_PAGE_ANNOTATION_PICKING',
  CANCELLED: 'HERMES_PAGE_ANNOTATION_CANCELLED',
  SYNC: 'HERMES_PAGE_ANNOTATION_SYNC',
  CAPTURE_BEGIN: 'HERMES_PAGE_ANNOTATION_CAPTURE_BEGIN',
  CAPTURE_END: 'HERMES_PAGE_ANNOTATION_CAPTURE_END',
  PIN_CLICKED: 'HERMES_PAGE_ANNOTATION_PIN_CLICKED',
  ERROR: 'HERMES_PAGE_ANNOTATION_ERROR',
  CARD_SUBMIT: 'HERMES_PAGE_COMMENT_CARD_SUBMIT',
  CARD_CANCEL: 'HERMES_PAGE_COMMENT_CARD_CANCEL',
  ABORT: 'HERMES_ABORT_PAGE_OVERLAYS',
});

export const PAGE_ANNOTATION_MODES = Object.freeze({
  ELEMENT: 'element',
  AREA: 'area',
});

export const PAGE_ANNOTATION_SCHEMA_VERSION = 1;
export const ANNOTATION_AREA_THRESHOLD_PX = 8;
export const ANNOTATION_HTML_BUDGET = 600;
export const ANNOTATION_TEXT_BUDGET = 80;
export const ANNOTATION_SELECTOR_BUDGET = 180;
export const ANNOTATION_CSS_VALUE_BUDGET = 80;

const ANNOTATE_CSS_KEYS = [
  'color', 'background-color', 'font-size', 'font-family', 'font-weight', 'line-height',
  'letter-spacing', 'text-align', 'display', 'position', 'width', 'height', 'max-width',
  'padding', 'margin', 'border', 'border-radius', 'box-shadow', 'opacity', 'overflow',
  'z-index', 'transform', 'flex-direction', 'gap', 'grid-template-columns', 'justify-content',
  'align-items',
];

const CONTROLLER_SENTINEL = '__HERMES_PAGE_ANNOTATION_CONTROLLER__';
const DOCUMENT_KEY_BAG = '__HERMES_PAGE_ANNOTATION_DOC_KEYS__';
const HOST_ATTR = 'data-hermes-page-annotation-host';

function clip(value, max) {
  const trimmed = String(value || '').replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function escapeCssIdent(value = '') {
  const raw = String(value || '');
  if (!raw) return '';
  if (typeof globalThis.CSS !== 'undefined' && typeof globalThis.CSS.escape === 'function') {
    return globalThis.CSS.escape(raw);
  }
  return raw.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

export function buildCssSelector(element) {
  if (!element || element.nodeType !== 1) return '';
  const parts = [];
  let node = element;
  const document = element.ownerDocument;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    const tag = node.tagName.toLowerCase();
    let part = tag;
    if (node.id) {
      part = `${tag}#${escapeCssIdent(node.id)}`;
      parts.unshift(part);
      break;
    }
    const testId = node.getAttribute?.('data-testid') || node.getAttribute?.('data-test-id');
    if (testId) {
      part = `${tag}[data-testid="${String(testId).replace(/"/g, '\\"')}"]`;
      parts.unshift(part);
      break;
    }
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      if (siblings.length > 1) {
        part = `${tag}:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

export function normalizeAnnotationRect(rect) {
  const x = Math.round(Number(rect?.x));
  const y = Math.round(Number(rect?.y));
  const width = Math.round(Number(rect?.width));
  const height = Math.round(Number(rect?.height));
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

export function normalizeAnnotationViewport(view = {}, document) {
  const defaultView = document?.defaultView;
  return {
    width: Math.round(Number(view.width || defaultView?.innerWidth || document?.documentElement?.clientWidth || 0)),
    height: Math.round(Number(view.height || defaultView?.innerHeight || document?.documentElement?.clientHeight || 0)),
    devicePixelRatio: Number(view.devicePixelRatio || defaultView?.devicePixelRatio || 1) || 1,
    scrollX: Math.round(Number(view.scrollX || defaultView?.scrollX || 0)),
    scrollY: Math.round(Number(view.scrollY || defaultView?.scrollY || 0)),
  };
}

export function areaGestureRect(start, end) {
  const x1 = Number(start?.x);
  const y1 = Number(start?.y);
  const x2 = Number(end?.x);
  const y2 = Number(end?.y);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  if (width < ANNOTATION_AREA_THRESHOLD_PX && height < ANNOTATION_AREA_THRESHOLD_PX) return null;
  return normalizeAnnotationRect({
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.max(width, 1),
    height: Math.max(height, 1),
  });
}

export function captureElementSnapshot(element) {
  if (!element || element.nodeType !== 1) return { ok: false, reason: 'not_an_element' };
  const tag = element.tagName.toLowerCase();
  const type = String(element.getAttribute?.('type') || '').toLowerCase();
  const rect = element.getBoundingClientRect?.();
  const attrs = {};
  for (const name of ['id', 'class', 'name', 'type', 'href', 'src', 'role', 'aria-label', 'aria-labelledby', 'data-testid', 'data-test-id']) {
    const value = element.getAttribute?.(name);
    if (value) attrs[name] = String(value).slice(0, 500);
  }
  const css = {};
  const computed = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  if (computed) {
    for (const key of ANNOTATE_CSS_KEYS) {
      const raw = computed.getPropertyValue?.(key);
      if (raw) css[key] = raw;
    }
  }
  let html = '';
  try {
    html = String(element.outerHTML || '');
  } catch {
    html = '';
  }
  if (type === 'password' || type === 'hidden' || type === 'file' || tag === 'input') {
    html = html.replace(/\svalue="[^"]*"/gi, '');
  }
  return {
    ok: true,
    tag,
    selector: buildCssSelector(element),
    text: clip((element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(), 2000),
    html,
    className: typeof element.className === 'string' ? element.className.trim().slice(0, 300) : '',
    attributes: attrs,
    css,
    boundingBox: rect ? normalizeAnnotationRect(rect) : null,
  };
}

export function compactAnnotationSnapshot(snapshot = {}) {
  const css = {};
  const source = snapshot.css && typeof snapshot.css === 'object' ? snapshot.css : {};
  for (const key of ANNOTATE_CSS_KEYS) {
    const raw = source[key];
    if (!raw || raw === 'normal' || raw === 'none' || raw === 'auto' || raw === '0px') continue;
    css[key] = clip(raw, ANNOTATION_CSS_VALUE_BUDGET);
  }
  return {
    tag: String(snapshot.tag || 'div').toLowerCase(),
    selector: clip(snapshot.selector || snapshot.tag || 'div', ANNOTATION_SELECTOR_BUDGET),
    text: clip(snapshot.text || '', ANNOTATION_TEXT_BUDGET),
    html: clip(snapshot.html || '', ANNOTATION_HTML_BUDGET),
    css,
  };
}

export function createDocumentKey(doc) {
  const bag = globalThis[DOCUMENT_KEY_BAG] || (globalThis[DOCUMENT_KEY_BAG] = new WeakMap());
  if (bag.has(doc)) return bag.get(doc);
  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  bag.set(doc, key);
  return key;
}

function safePageUrl(doc) {
  try {
    const url = new URL(doc.defaultView?.location?.href || doc.URL || '');
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return String(doc.URL || '');
  }
}

function isOverlayEvent(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  return path.some((node) => node?.getAttribute?.(HOST_ATTR) === 'true')
    || event.target?.closest?.(`[${HOST_ATTR}]`);
}

export function createPageAnnotationController({ document, sendMessage } = {}) {
  const previous = globalThis[CONTROLLER_SENTINEL];
  if (previous && previous !== this) {
    try { previous.destroy(); } catch { /* previous controller may already be gone */ }
  }
  const controller = {
    destroyed: false,
    mode: '',
    sessionId: '',
    overlayLive: false,
    pins: [],
    captureHidden: false,
    pointerStart: null,
  };

  function emit(message) {
    try { sendMessage?.(message); } catch { /* side panel may be closed */ }
  }

  function destroy() {
    if (controller.destroyed) return;
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('keydown', onKeydown, true);
    overlayHost?.remove?.();
    overlayHost = null;
    controller.destroyed = true;
    controller.overlayLive = false;
    if (globalThis[CONTROLLER_SENTINEL] === controller) globalThis[CONTROLLER_SENTINEL] = null;
  }

  let overlayHost = null;

  function ensureOverlay() {
    if (overlayHost?.isConnected) return overlayHost;
    overlayHost = document.createElement('div');
    overlayHost.setAttribute(HOST_ATTR, 'true');
    overlayHost.style.cssText = 'position:fixed;inset:0;z-index:2147483645;pointer-events:none;';
    try {
      overlayHost.attachShadow?.({ mode: 'closed' });
    } catch { /* linkedom may not support shadow */ }
    (document.documentElement || document.body)?.appendChild(overlayHost);
    return overlayHost;
  }

  function onClick(event) {
    if (!controller.overlayLive || controller.mode !== PAGE_ANNOTATION_MODES.ELEMENT) return;
    if (isOverlayEvent(event)) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    const target = event.target;
    if (!target || target === document.documentElement || target === document.body) {
      emit({ type: PAGE_ANNOTATION_MESSAGES.ERROR, reason: 'target_too_large', sessionId: controller.sessionId });
      return;
    }
    if (target.ownerDocument !== document) {
      emit({ type: PAGE_ANNOTATION_MESSAGES.ERROR, reason: 'iframe_not_supported', sessionId: controller.sessionId });
      return;
    }
    const snapshot = captureElementSnapshot(target);
    if (!snapshot.ok) return;
    const rect = snapshot.boundingBox || normalizeAnnotationRect(target.getBoundingClientRect?.());
    emit({
      type: PAGE_ANNOTATION_MESSAGES.RESULT,
      version: PAGE_ANNOTATION_SCHEMA_VERSION,
      sessionId: controller.sessionId,
      documentKey: createDocumentKey(document),
      kind: PAGE_ANNOTATION_MODES.ELEMENT,
      pageUrl: safePageUrl(document),
      pageTitle: String(document.title || ''),
      frameId: 0,
      rect,
      viewport: normalizeAnnotationViewport({}, document),
      identity: compactAnnotationSnapshot(snapshot),
    });
  }

  function onPointerDown(event) {
    if (!controller.overlayLive) return;
    if (controller.mode !== PAGE_ANNOTATION_MODES.AREA && controller.mode !== PAGE_ANNOTATION_MODES.ELEMENT) return;
    controller.pointerStart = { x: Number(event.clientX), y: Number(event.clientY) };
  }

  function onPointerMove() {}

  function onPointerUp(event) {
    if (!controller.overlayLive || !controller.pointerStart) return;
    const end = { x: Number(event.clientX), y: Number(event.clientY) };
    const area = areaGestureRect(controller.pointerStart, end);
    controller.pointerStart = null;
    if (!area) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    emit({
      type: PAGE_ANNOTATION_MESSAGES.RESULT,
      version: PAGE_ANNOTATION_SCHEMA_VERSION,
      sessionId: controller.sessionId,
      documentKey: createDocumentKey(document),
      kind: PAGE_ANNOTATION_MODES.AREA,
      pageUrl: safePageUrl(document),
      pageTitle: String(document.title || ''),
      frameId: 0,
      rect: area,
      viewport: normalizeAnnotationViewport({}, document),
    });
  }

  function onKeydown(event) {
    if (!controller.overlayLive) return;
    if (event.key === 'Escape') {
      event.preventDefault?.();
      controller.cancel();
    }
  }

  controller.start = function start({ sessionId, mode } = {}) {
    if (controller.destroyed) return { ok: false, reason: 'destroyed' };
    controller.sessionId = String(sessionId || '');
    controller.mode = mode === PAGE_ANNOTATION_MODES.AREA ? PAGE_ANNOTATION_MODES.AREA : PAGE_ANNOTATION_MODES.ELEMENT;
    controller.overlayLive = true;
    ensureOverlay();
    document.addEventListener('click', onClick, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('keydown', onKeydown, true);
    emit({
      type: PAGE_ANNOTATION_MESSAGES.PICKING,
      version: PAGE_ANNOTATION_SCHEMA_VERSION,
      sessionId: controller.sessionId,
      documentKey: createDocumentKey(document),
      mode: controller.mode,
    });
    return { ok: true };
  };

  controller.cancel = function cancel() {
    controller.overlayLive = false;
    emit({ type: PAGE_ANNOTATION_MESSAGES.CANCELLED, sessionId: controller.sessionId, documentKey: createDocumentKey(document) });
    return { ok: true };
  };

  controller.sync = function sync(pins = []) {
    controller.pins = Array.isArray(pins) ? pins.map((pin) => ({
      id: pin.id,
      number: pin.number,
      kind: pin.kind,
      rect: pin.rect,
      selector: pin.selector || pin.target?.selector || '',
    })) : [];
    renderPins();
    return { ok: true };
  };

  function renderPins() {
    const host = ensureOverlay();
    const root = host.shadowRoot || host;
    while (root.firstChild) root.removeChild(root.firstChild);
    if (controller.captureHidden) return;
    for (const pin of controller.pins) {
      const rect = normalizeAnnotationRect(pin.rect);
      if (!rect) continue;
      const marker = document.createElement('div');
      marker.textContent = String(pin.number);
      marker.style.cssText = [
        'position:fixed',
        `left:${rect.x}px`,
        `top:${rect.y}px`,
        'width:22px',
        'height:22px',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'background:#2F80ED',
        'color:#F4F4F4',
        'font:700 11px/1 sans-serif',
        'pointer-events:none',
        'z-index:2147483646',
      ].join(';');
      const outline = document.createElement('div');
      outline.style.cssText = [
        'position:fixed',
        `left:${rect.x}px`,
        `top:${rect.y}px`,
        `width:${rect.width}px`,
        `height:${rect.height}px`,
        'box-sizing:border-box',
        'border:2px solid #2F80ED',
        'background:rgba(47,128,237,0.14)',
        'pointer-events:none',
      ].join(';');
      root.append(outline, marker);
    }
  }

  controller.beginCapture = function beginCapture() {
    controller.captureHidden = true;
    renderPins();
    return { ok: true };
  };

  controller.endCapture = function endCapture() {
    controller.captureHidden = false;
    renderPins();
    return { ok: true };
  };

  controller.destroy = destroy;
  globalThis[CONTROLLER_SENTINEL] = controller;
  return controller;
}

const COMMENT_CARD_ATTR = 'data-hermes-page-comment-card';

export function hidePageCommentCard(document) {
  document?.querySelector?.(`[${COMMENT_CARD_ATTR}]`)?.remove?.();
}

export function resolvePageCommentCardTheme(settings = {}) {
  const theme = String(settings.appearanceTheme || 'nous').toLowerCase();
  const mode = String(settings.colorMode || 'dark').toLowerCase() === 'light' ? 'light' : 'dark';
  if (theme === 'mono' && mode === 'dark') {
    return { bg: '#171717', field: '#111111', fg: '#f1f1f1', muted: 'rgba(241,241,241,0.62)', border: 'rgba(229,229,229,0.44)', primary: '#e5e5e5', primaryFg: '#111111', font: 'ui-sans-serif, system-ui, sans-serif' };
  }
  if (theme === 'mono' && mode === 'light') {
    return { bg: '#ffffff', field: '#f7f7f7', fg: '#1d1d1d', muted: 'rgba(29,29,29,0.58)', border: 'rgba(32,32,32,0.28)', primary: '#202020', primaryFg: '#ffffff', font: 'ui-sans-serif, system-ui, sans-serif' };
  }
  if (theme === 'cyberpunk' && mode === 'dark') {
    return { bg: '#001b08', field: '#001004', fg: '#36ff7a', muted: 'rgba(54,255,122,0.62)', border: 'rgba(0,255,95,0.46)', primary: '#00ff5f', primaryFg: '#001004', font: 'ui-monospace, SFMono-Regular, Menlo, monospace' };
  }
  if (mode === 'light') {
    return { bg: '#fbfcff', field: '#ffffff', fg: '#0505e8', muted: 'rgba(5,5,232,0.58)', border: 'rgba(5,5,232,0.34)', primary: '#0505e8', primaryFg: '#ffffff', font: 'ui-sans-serif, system-ui, sans-serif' };
  }
  return { bg: '#0a3572', field: '#062a60', fg: '#f4f8ff', muted: 'rgba(244,248,255,0.62)', border: 'rgba(139,183,255,0.42)', primary: '#0d4a9f', primaryFg: '#f4f8ff', font: 'ui-sans-serif, system-ui, sans-serif' };
}

export function mountPageCommentCard(document, {
  label = '',
  detail = '',
  rect = null,
  theme = null,
  onQueue,
  onSend,
  onCancel,
} = {}) {
  hidePageCommentCard(document);
  const colors = theme && typeof theme === 'object' ? { ...resolvePageCommentCardTheme({}), ...theme } : resolvePageCommentCardTheme({});
  const host = document.createElement('div');
  host.setAttribute(COMMENT_CARD_ATTR, 'true');
  const view = document.defaultView;
  const left = Math.max(12, Math.min(Number(rect?.x) || 12, (view?.innerWidth || 360) - 332));
  const top = Math.max(12, Math.min((Number(rect?.y) || 12) + (Number(rect?.height) || 0) + 8, (view?.innerHeight || 640) - 220));
  host.style.cssText = [
    'position:fixed',
    `left:${left}px`,
    `top:${top}px`,
    'z-index:2147483647',
    'width:320px',
    'box-sizing:border-box',
    'padding:10px 12px 12px',
    `background:${colors.bg}`,
    `color:${colors.fg}`,
    `border:1px solid ${colors.border}`,
    `font:13px/1.4 ${colors.font}`,
    'box-shadow:0 16px 40px rgba(0,0,0,0.35)',
  ].join(';');
  const handle = document.createElement('div');
  handle.setAttribute('data-comment-drag', 'true');
  handle.style.cssText = `cursor:grab;margin:0 0 8px;user-select:none;font:700 10px/1.2 ${colors.font};letter-spacing:0.14em;text-transform:uppercase;color:${colors.muted}`;
  handle.textContent = 'Comment';
  const labelEl = document.createElement('p');
  labelEl.setAttribute('data-comment-label', 'true');
  labelEl.textContent = String(label || 'Element');
  if (detail) labelEl.title = String(detail);
  labelEl.style.cssText = `margin:0 0 8px;font-size:11px;color:${colors.muted};word-break:break-word;`;
  const note = document.createElement('textarea');
  note.setAttribute('data-comment-note', 'true');
  note.rows = 4;
  note.placeholder = 'Write a comment about this element';
  note.style.cssText = `width:100%;box-sizing:border-box;min-height:84px;margin:0 0 10px;padding:8px;border:1px solid ${colors.border};background:${colors.field};color:${colors.fg};font:inherit;resize:vertical;`;
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
  const queue = document.createElement('button');
  queue.type = 'button';
  queue.setAttribute('data-comment-queue', 'true');
  queue.textContent = 'Queue';
  queue.style.cssText = `min-height:32px;padding:0 10px;border:1px solid ${colors.border};background:transparent;color:${colors.fg};font:700 11px/1 ${colors.font};text-transform:uppercase;letter-spacing:0.08em;`;
  const send = document.createElement('button');
  send.type = 'button';
  send.setAttribute('data-comment-send', 'true');
  send.textContent = 'Send now';
  send.style.cssText = `min-height:32px;padding:0 10px;border:1px solid ${colors.border};background:${colors.primary};color:${colors.primaryFg};font:700 11px/1 ${colors.font};text-transform:uppercase;letter-spacing:0.08em;`;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.setAttribute('data-comment-cancel', 'true');
  cancel.textContent = 'Cancel';
  cancel.style.cssText = `min-height:32px;padding:0 10px;border:0;background:transparent;color:${colors.muted};font:700 11px/1 ${colors.font};text-transform:uppercase;letter-spacing:0.08em;`;
  const finish = (action) => {
    const value = note.value || '';
    if (action === 'queue') onQueue?.(value);
    else if (action === 'send') onSend?.(value);
    else onCancel?.();
    hidePageCommentCard(document);
  };
  queue.onclick = () => finish('queue');
  send.onclick = () => finish('send');
  cancel.onclick = () => finish('cancel');
  host.onkeydown = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault?.();
    finish('cancel');
  };
  handle.onmousedown = (event) => {
    if (event.button) return;
    event.preventDefault?.();
    const startX = Number(event.clientX) || 0;
    const startY = Number(event.clientY) || 0;
    const originLeft = Number.parseFloat(host.style.left) || 0;
    const originTop = Number.parseFloat(host.style.top) || 0;
    handle.style.cursor = 'grabbing';
    const move = (next) => {
      host.style.left = `${originLeft + ((Number(next.clientX) || 0) - startX)}px`;
      host.style.top = `${originTop + ((Number(next.clientY) || 0) - startY)}px`;
    };
    const stop = () => {
      handle.style.cursor = 'grab';
      view?.removeEventListener?.('mousemove', move, true);
      view?.removeEventListener?.('mouseup', stop, true);
    };
    view?.addEventListener?.('mousemove', move, true);
    view?.addEventListener?.('mouseup', stop, true);
  };
  actions.append(queue, send, cancel);
  host.append(handle, labelEl, note, actions);
  (document.documentElement || document.body)?.appendChild(host);
  note.focus?.();
  return host;
}

export const PAGE_ANNOTATION_CONTENT_API = Object.freeze({
  PAGE_ANNOTATION_MESSAGES,
  PAGE_ANNOTATION_MODES,
  PAGE_ANNOTATION_SCHEMA_VERSION,
  buildCssSelector,
  captureElementSnapshot,
  createDocumentKey,
  normalizeAnnotationRect,
  normalizeAnnotationViewport,
  areaGestureRect,
  compactAnnotationSnapshot,
  createPageAnnotationController,
  mountPageCommentCard,
  hidePageCommentCard,
  resolvePageCommentCardTheme,
});
