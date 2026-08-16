// SECURITY BOUNDARY: Trusted Output — every dynamic HTML string rendered into
// an extension surface passes through DOMPurify before reaching the DOM.
//
// renderMarkdownSafe keeps the extension's battle-tested markdown renderer as
// the parser (its output escapes text and restricts link/image protocols) and
// adds DOMPurify as the industry-standard output sanitizer. For benign input
// the sanitized output is byte-identical to the raw renderer output; hostile
// input (raw HTML, javascript: URLs, attribute breakouts) is neutralized.
//
// Non-DOM contexts (MV3 service worker) cannot run DOMPurify; the module
// fails closed to the renderer's own escaping there rather than throwing.

import createDOMPurify from './vendor/purify.es.mjs';
import { renderMarkdown } from './common.mjs';

let purifyInstance = null;

// DOMPurify 3.2+ removed `target` from its default allowlist. The markdown
// renderer emits target="_blank" + rel="noopener noreferrer" on links;
// without re-adding it, chat links would open inside the panel instead of a
// new tab. ADD_ATTR lets the attribute survive filtering; the
// afterSanitizeAttributes hook then prunes every non-conforming case so no
// other element or frame-busting value (_self/_top/_parent) can survive.
const SANITIZE_OPTIONS = Object.freeze({ ADD_ATTR: ['target'] });

function getPurifier() {
  if (purifyInstance) return purifyInstance;
  if (typeof window !== 'undefined' && window?.document && typeof window.document.createElement === 'function') {
    purifyInstance = createDOMPurify(window);
    purifyInstance.addHook('afterSanitizeAttributes', (node) => {
      if (!node?.hasAttribute?.('target')) return;
      const isBlankAnchor = node.nodeName === 'A'
        && node.getAttribute('target') === '_blank'
        && /\bnoopener\b/i.test(node.getAttribute('rel') || '');
      if (!isBlankAnchor) node.removeAttribute('target');
    });
  }
  return purifyInstance;
}

/**
 * Sanitize an HTML string with DOMPurify defaults.
 * @param {string} html raw HTML to sanitize
 * @returns {string} sanitized HTML (input unchanged when no DOM is available)
 */
export function sanitizeHtml(html = '') {
  const instance = getPurifier();
  const value = String(html ?? '');
  return instance ? instance.sanitize(value, SANITIZE_OPTIONS) : value;
}

/**
 * Render markdown to sanitized HTML.
 * @param {string} value markdown source (untrusted)
 * @returns {string} sanitized HTML
 */
export function renderMarkdownSafe(value = '') {
  const html = renderMarkdown(value);
  const instance = getPurifier();
  return instance ? instance.sanitize(html, SANITIZE_OPTIONS) : html;
}
