// highlight.js is vendored locally for Manifest V3 CSP compliance. Only the
// explicitly imported language modules are registered, keeping the runtime
// surface and extension package bounded.
import hljs from './vendor/highlight-core.mjs';
import './vendor/highlight-bash.mjs';
import './vendor/highlight-csharp.mjs';
import './vendor/highlight-css.mjs';
import './vendor/highlight-javascript.mjs';
import './vendor/highlight-json.mjs';
import './vendor/highlight-markdown.mjs';
import './vendor/highlight-python.mjs';
import './vendor/highlight-sql.mjs';
import './vendor/highlight-typescript.mjs';
import './vendor/highlight-xml.mjs';
import './vendor/highlight-yaml.mjs';

const LANGUAGE_ALIASES = new Map([
  ['bash', 'bash'],
  ['cs', 'csharp'],
  ['csharp', 'csharp'],
  ['css', 'css'],
  ['htm', 'xml'],
  ['html', 'xml'],
  ['javascript', 'javascript'],
  ['js', 'javascript'],
  ['json', 'json'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['py', 'python'],
  ['python', 'python'],
  ['sh', 'bash'],
  ['shell', 'bash'],
  ['sql', 'sql'],
  ['ts', 'typescript'],
  ['typescript', 'typescript'],
  ['xml', 'xml'],
  ['yml', 'yaml'],
  ['yaml', 'yaml'],
]);

function defaultTokenize(source, language) {
  return hljs.highlight(source, { language, ignoreIllegals: true }).value;
}

function appendTrustedTokens(target, highlightedHtml) {
  const document = target.ownerDocument;
  const template = document.createElement('template');
  template.innerHTML = highlightedHtml;

  const appendNode = (sourceNode, parent) => {
    if (sourceNode.nodeType === 3) {
      parent.append(document.createTextNode(sourceNode.nodeValue || ''));
      return;
    }
    if (sourceNode.nodeType !== 1 || sourceNode.nodeName !== 'SPAN') {
      throw new Error('Unexpected syntax-highlighter markup');
    }
    const classes = [...sourceNode.classList];
    if (
      !classes.length
      || classes.length > 4
      || classes.some((name) => !/^[a-z][a-z0-9_-]{0,63}$/i.test(name))
      || !classes.some((name) => name.startsWith('hljs-'))
    ) {
      throw new Error('Unexpected syntax-highlighter class');
    }
    const span = document.createElement('span');
    span.className = classes.join(' ');
    for (const child of sourceNode.childNodes) appendNode(child, span);
    parent.append(span);
  };

  const fragment = document.createDocumentFragment();
  for (const child of template.content.childNodes) appendNode(child, fragment);
  target.replaceChildren(fragment);
}

/**
 * Highlight sanitized Markdown code blocks beneath root.
 *
 * The model-controlled input is read exclusively from textContent. Generated
 * highlighter markup is copied into the live DOM through a strict text/span
 * allowlist, so it cannot widen the DOMPurify trust boundary.
 */
export function highlightCodeBlocks(root, { tokenize = defaultTokenize } = {}) {
  if (!root?.querySelectorAll) return;
  for (const code of root.querySelectorAll('pre > code')) {
    const source = code.textContent || '';
    const requested = String(code.dataset?.lang || '').trim().toLowerCase();
    const language = LANGUAGE_ALIASES.get(requested);
    if (!language) continue;
    try {
      appendTrustedTokens(code, tokenize(source, language));
      code.classList.add('hljs');
      code.dataset.highlighted = language;
    } catch {
      code.textContent = source;
      code.classList.remove('hljs');
      code.removeAttribute('data-highlighted');
    }
  }
}
