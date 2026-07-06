/**
 * DOM element pick capture and prompt formatting for Hermes Browser Extension.
 * User-initiated read-only context — not agent browser control.
 */

import { redactSensitiveText } from './redaction.mjs';

export const ELEMENT_PICK_MESSAGES = Object.freeze({
  START: 'HERMES_START_ELEMENT_PICK',
  CANCEL: 'HERMES_CANCEL_ELEMENT_PICK',
  RESULT: 'HERMES_ELEMENT_PICK_RESULT',
  PICKING: 'HERMES_ELEMENT_PICKING',
  CANCELLED: 'HERMES_ELEMENT_PICK_CANCELLED',
});

const OUTER_HTML_LIMIT = 4_000;
const TEXT_LIMIT = 2_000;

export function redactPickedElementText(value = '') {
  return redactSensitiveText(value);
}

export function clampPickerText(value = '', max = TEXT_LIMIT) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`;
}

function escapeCssIdent(value = '') {
  const raw = String(value || '');
  if (!raw) return '';
  if (typeof globalThis.CSS !== 'undefined' && typeof globalThis.CSS.escape === 'function') {
    return globalThis.CSS.escape(raw);
  }
  return raw.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

/**
 * Build a reasonably stable CSS selector path (top document only).
 * @param {Element | null | undefined} element
 * @returns {string}
 */
function buildCssSelector(element) {
  if (!element || element.nodeType !== 1) return '';
  const parts = [];
  let node = element;
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
        const index = siblings.indexOf(node) + 1;
        part = `${tag}:nth-of-type(${index})`;
      }
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

/**
 * @param {Element} element
 * @returns {object}
 */
export function captureElementSnapshot(element) {
  if (!element || element.nodeType !== 1) {
    return { ok: false, reason: 'not_an_element' };
  }
  const tag = element.tagName.toLowerCase();
  const rect = element.getBoundingClientRect?.();
  const attrs = {};
  for (const name of ['id', 'class', 'name', 'type', 'href', 'src', 'role', 'aria-label', 'aria-labelledby', 'data-testid', 'data-test-id']) {
    const value = element.getAttribute?.(name);
    if (value) attrs[name] = value.slice(0, 500);
  }
  const className = typeof element.className === 'string' ? element.className.trim().slice(0, 300) : '';
  const text = clampPickerText((element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim());
  let outerHtml = '';
  try {
    outerHtml = clampPickerText(element.outerHTML || '', OUTER_HTML_LIMIT);
  } catch {
    outerHtml = '';
  }
  return {
    ok: true,
    tag,
    selector: buildCssSelector(element),
    text,
    outerHtml,
    className,
    attributes: attrs,
    boundingBox: rect
      ? {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
      : null,
    capturedAt: new Date().toISOString(),
  };
}

export function normalizePickedElement(value = null) {
  if (!value || typeof value !== 'object' || value.ok === false) return null;
  const selector = String(value.selector || '').trim();
  const tag = String(value.tag || '').trim();
  if (!selector && !tag) return null;
  return {
    ok: true,
    tag,
    selector,
    text: clampPickerText(value.text || ''),
    outerHtml: clampPickerText(value.outerHtml || '', OUTER_HTML_LIMIT),
    className: String(value.className || '').slice(0, 300),
    attributes: value.attributes && typeof value.attributes === 'object' ? value.attributes : {},
    boundingBox: value.boundingBox && typeof value.boundingBox === 'object' ? value.boundingBox : null,
    capturedAt: String(value.capturedAt || ''),
  };
}

export function storedPickedElementRecord({ tabId = null, url = '', pickedElement = null } = {}) {
  const id = Number(tabId);
  const normalized = normalizePickedElement(pickedElement);
  const sourceUrl = String(url || pickedElement?.url || '');
  if (!Number.isFinite(id) || !sourceUrl || !normalized) return null;
  return { tabId: id, url: sourceUrl, pickedElement: normalized };
}

export function pickedElementForTab(record = null, tab = {}, pageContext = {}) {
  if (!record?.pickedElement?.ok) return null;
  const currentUrl = String(tab?.url || pageContext?.url || '');
  if (!record.url || !currentUrl || record.url !== currentUrl) return null;
  return record.pickedElement;
}

export function formatPickedElementBlock(picked = null) {
  const normalized = normalizePickedElement(picked);
  if (!normalized) return '';
  const attrLines = Object.entries(normalized.attributes || {})
    .map(([key, val]) => `  ${key}: ${redactPickedElementText(String(val)).slice(0, 240)}`)
    .join('\n');
  const box = normalized.boundingBox
    ? `Bounding box (viewport px): x=${normalized.boundingBox.x}, y=${normalized.boundingBox.y}, w=${normalized.boundingBox.width}, h=${normalized.boundingBox.height}`
    : '';
  return [
    `Tag: ${normalized.tag || '(unknown)'}`,
    `CSS selector: ${normalized.selector || '(none)'}`,
    normalized.className ? `Class: ${normalized.className}` : '',
    box,
    attrLines ? `Attributes:\n${attrLines}` : '',
    `Visible text: ${redactPickedElementText(normalized.text) || '(empty)'}`,
    normalized.outerHtml ? `Outer HTML:\n${redactPickedElementText(normalized.outerHtml)}` : '',
  ].filter(Boolean).join('\n');
}