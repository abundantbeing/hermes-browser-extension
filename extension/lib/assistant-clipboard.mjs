const ALLOWED_TAGS = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'I', 'LI', 'OL', 'P', 'PRE', 'S', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U', 'UL',
]);
const BLOCKED_TAGS = new Set([
  'BUTTON', 'CANVAS', 'IFRAME', 'INPUT', 'MATH', 'OBJECT', 'OPTION', 'SCRIPT', 'SELECT', 'STYLE', 'SVG', 'TEXTAREA',
]);
const BLOCK_TAGS = new Set([
  'BLOCKQUOTE', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'OL', 'P', 'PRE', 'TABLE', 'TBODY', 'THEAD', 'TR', 'UL',
]);

function elementForNode(node) {
  if (!node) return null;
  return node.nodeType === 1 ? node : node.parentElement;
}

function safeClipboardHref(value = '', baseUrl = '') {
  const href = String(value || '').trim();
  if (!href) return '';
  try {
    const parsed = new URL(href, baseUrl || undefined);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

function unwrapElement(element) {
  const parent = element?.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  element.remove();
}

function sanitizeElement(element, baseUrl) {
  const tag = String(element?.tagName || '').toUpperCase();
  if (BLOCKED_TAGS.has(tag)) {
    element.remove();
    return;
  }
  if (!ALLOWED_TAGS.has(tag)) {
    unwrapElement(element);
    return;
  }

  const href = tag === 'A' ? safeClipboardHref(element.getAttribute('href'), baseUrl) : '';
  const start = tag === 'OL' ? Number.parseInt(element.getAttribute('start'), 10) : 0;
  const value = tag === 'LI' ? Number.parseInt(element.getAttribute('value'), 10) : 0;
  for (const attribute of Array.from(element.attributes || [])) element.removeAttribute(attribute.name);
  if (href) element.setAttribute('href', href);
  if (tag === 'OL' && Number.isFinite(start) && start > 1) element.setAttribute('start', String(start));
  if (tag === 'LI' && Number.isFinite(value)) element.setAttribute('value', String(value));
}

function sanitizeFragment(fragment, document, baseUrl = '') {
  const container = document.createElement('div');
  container.appendChild(fragment);
  const elements = Array.from(container.querySelectorAll('*')).reverse();
  for (const element of elements) sanitizeElement(element, baseUrl);
  return container;
}

function semanticPlainText(root) {
  let text = '';
  const append = (value) => { text += String(value || ''); };
  const newline = () => {
    if (text && !text.endsWith('\n')) text += '\n';
  };

  const visit = (node) => {
    if (!node) return;
    if (node.nodeType === 3) {
      append(node.nodeValue || '');
      return;
    }
    if (node.nodeType !== 1) {
      for (const child of Array.from(node.childNodes || [])) visit(child);
      return;
    }

    const tag = String(node.tagName || '').toUpperCase();
    if (tag === 'BR') {
      append('\n');
      return;
    }
    if (tag === 'HR') {
      newline();
      append('---');
      newline();
      return;
    }
    if (tag === 'LI') {
      newline();
      const parentTag = String(node.parentElement?.tagName || '').toUpperCase();
      if (parentTag === 'OL') {
        const siblings = Array.from(node.parentElement.children || []).filter((child) => String(child.tagName || '').toUpperCase() === 'LI');
        const start = Number.parseInt(node.parentElement.getAttribute('start'), 10) || 1;
        const explicit = Number.parseInt(node.getAttribute('value'), 10);
        append(`${Number.isFinite(explicit) ? explicit : start + Math.max(0, siblings.indexOf(node))}. `);
      } else {
        append('• ');
      }
      for (const child of Array.from(node.childNodes || [])) visit(child);
      newline();
      return;
    }
    if (tag === 'TD' || tag === 'TH') {
      for (const child of Array.from(node.childNodes || [])) visit(child);
      append('\t');
      return;
    }

    const block = BLOCK_TAGS.has(tag);
    if (block) newline();
    for (const child of Array.from(node.childNodes || [])) visit(child);
    if (block) newline();
  };

  for (const child of Array.from(root?.childNodes || [])) visit(child);
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildCleanClipboardPayload({ fragment, document = globalThis.document, baseUrl = '' } = {}) {
  if (!fragment || !document?.createElement) return null;
  const container = sanitizeFragment(fragment, document, baseUrl || document.baseURI || '');
  const html = String(container.innerHTML || '').trim();
  const text = semanticPlainText(container);
  if (!html && !text) return null;
  return { html, text };
}

export function assistantSelectionClipboardPayload({
  selection,
  messagesRoot,
  document = globalThis.document,
  assistantSelector = '.assistant',
  baseUrl = '',
} = {}) {
  if (!selection || selection.rangeCount !== 1 || !messagesRoot) return null;
  const range = selection.getRangeAt(0);
  if (!range || range.collapsed) return null;
  const startAssistant = elementForNode(range.startContainer)?.closest?.(assistantSelector);
  const endAssistant = elementForNode(range.endContainer)?.closest?.(assistantSelector);
  if (!startAssistant || startAssistant !== endAssistant || !messagesRoot.contains(startAssistant)) return null;
  return buildCleanClipboardPayload({
    fragment: range.cloneContents(),
    document,
    baseUrl: baseUrl || document?.baseURI || '',
  });
}

export function writeAssistantClipboardEvent(event, options = {}) {
  const payload = assistantSelectionClipboardPayload(options);
  if (!payload || !event?.clipboardData?.setData) return false;
  event.preventDefault();
  event.clipboardData.setData('text/plain', payload.text);
  event.clipboardData.setData('text/html', payload.html);
  return true;
}
