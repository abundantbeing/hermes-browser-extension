import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = window;

const { renderMarkdownSafe } = await import('../extension/lib/sanitizer.mjs');
const { highlightCodeBlocks } = await import('../extension/lib/code-highlighting.mjs');

function renderedCode(markdown) {
  const root = window.document.createElement('div');
  root.innerHTML = renderMarkdownSafe(markdown);
  return { root, code: root.querySelector('pre > code') };
}

test('highlights a Python fence with tokenizer spans', () => {
  const { root, code } = renderedCode('```python\ndef greet(name):\n    return f"Hi {name}"\n```');

  highlightCodeBlocks(root);

  assert.match(code.innerHTML, /class="hljs-keyword"[^>]*>def<\/span>/);
  assert.match(code.innerHTML, /class="hljs-keyword"[^>]*>return<\/span>/);
});

test('resolves supported aliases and leaves unknown or untagged fences plain', () => {
  const aliased = renderedCode('```py\nprint(True)\n```');
  const unknown = renderedCode('```made-up-lang\nalpha < beta\n```');
  const untagged = renderedCode('```\nalpha < beta\n```');

  highlightCodeBlocks(aliased.root);
  highlightCodeBlocks(unknown.root);
  highlightCodeBlocks(untagged.root);

  assert.match(aliased.code.innerHTML, /class="hljs-built_in"[^>]*>print<\/span>/);
  assert.equal(unknown.code.querySelector('[class^="hljs-"]'), null);
  assert.equal(unknown.code.textContent, 'alpha < beta');
  assert.equal(untagged.code.querySelector('[class^="hljs-"]'), null);
  assert.equal(untagged.code.textContent, 'alpha < beta');
});

test('preserves exact source text and falls back to plain text if tokenization fails', () => {
  const source = 'const payload = "<script>& text";\nconsole.log(payload);';
  const highlighted = renderedCode(`\`\`\`js\n${source}\n\`\`\``);
  const failed = renderedCode(`\`\`\`js\n${source}\n\`\`\``);

  highlightCodeBlocks(highlighted.root);
  highlightCodeBlocks(failed.root, {
    tokenize() {
      throw new Error('synthetic tokenizer failure');
    },
  });

  assert.equal(highlighted.code.textContent, source);
  assert.equal(failed.code.textContent, source);
  assert.equal(failed.code.querySelector('[class^="hljs-"]'), null);
});
