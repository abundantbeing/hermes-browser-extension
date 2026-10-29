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
  ['jsx', 'javascript'],
  ['json', 'json'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['py', 'python'],
  ['python', 'python'],
  ['sh', 'bash'],
  ['shell', 'bash'],
  ['sql', 'sql'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['typescript', 'typescript'],
  ['xml', 'xml'],
  ['yml', 'yaml'],
  ['yaml', 'yaml'],
]);

const MAX_HIGHLIGHT_SOURCE_LENGTH = 50_000;
const SUBLANGUAGE_CLASSES = new Set([
  'language-bash',
  'language-csharp',
  'language-css',
  'language-javascript',
  'language-json',
  'language-markdown',
  'language-python',
  'language-sql',
  'language-typescript',
  'language-xml',
  'language-yaml',
]);
const TIER_CLASSES = new Set([
  'class_',
  'constant_',
  'escape_',
  'function_',
  'inherited__',
  'language_',
]);

function isTrustedTokenClass(name) {
  return name.startsWith('hljs-') || SUBLANGUAGE_CLASSES.has(name) || TIER_CLASSES.has(name);
}

function defaultTokenize(source, language) {
  return hljs.highlight(source, { language, ignoreIllegals: true }).value;
}

function buildTrustedTokenFragment(document, highlightedHtml, source) {
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
    const attributes = [...sourceNode.attributes];
    if (attributes.length !== 1 || attributes[0].name !== 'class') {
      throw new Error('Unexpected syntax-highlighter attribute');
    }
    const classes = [...sourceNode.classList];
    if (
      !classes.length
      || classes.length > 4
      || classes.some((name) => !/^[a-z][a-z0-9_-]{0,63}$/i.test(name))
      || !classes.some((name) => name.startsWith('hljs-') || SUBLANGUAGE_CLASSES.has(name))
      || classes.some((name) => !isTrustedTokenClass(name))
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
  if (fragment.textContent !== source) {
    throw new Error('Syntax-highlighter changed source text');
  }
  return fragment;
}

// A streaming reply re-renders the whole message every frame, so every finished
// code block would be tokenized and re-validated again for each delta. The result
// depends only on the language and the source, so the validated fragment is kept
// and cloned. Only fragments this module built through the allowlist are stored;
// custom tokenizers (tests) bypass the cache.
const FRAGMENT_CACHE_MAX_SOURCE_CHARS = 250_000;
const fragmentCaches = new WeakMap();

function fragmentCacheFor(document) {
  let cache = fragmentCaches.get(document);
  if (!cache) {
    cache = { entries: new Map(), chars: 0 };
    fragmentCaches.set(document, cache);
  }
  return cache;
}

function highlightedFragment(code, source, language, tokenize) {
  const document = code.ownerDocument;
  if (tokenize !== defaultTokenize) return buildTrustedTokenFragment(document, tokenize(source, language), source);
  const cache = fragmentCacheFor(document);
  const key = `${language}\n${source}`;
  const cached = cache.entries.get(key);
  if (cached) {
    // Re-insert so a block that keeps being used outlives the one still growing.
    cache.entries.delete(key);
    cache.entries.set(key, cached);
    return cached.cloneNode(true);
  }
  const fragment = buildTrustedTokenFragment(document, tokenize(source, language), source);
  const cost = source.length;
  if (cost <= FRAGMENT_CACHE_MAX_SOURCE_CHARS / 2) {
    // Least recently used go first; Map iterates in insertion order.
    for (const [oldKey, oldFragment] of cache.entries) {
      if (cache.chars + cost <= FRAGMENT_CACHE_MAX_SOURCE_CHARS) break;
      cache.entries.delete(oldKey);
      cache.chars -= oldFragment.textContent.length;
    }
    cache.entries.set(key, fragment.cloneNode(true));
    cache.chars += cost;
  }
  return fragment;
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
    if (source.length > MAX_HIGHLIGHT_SOURCE_LENGTH) continue;
    try {
      code.replaceChildren(highlightedFragment(code, source, language, tokenize));
      code.classList.add('hljs');
      code.dataset.highlighted = language;
    } catch {
      code.textContent = source;
      code.classList.remove('hljs');
      code.removeAttribute('data-highlighted');
    }
  }
}
