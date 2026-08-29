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

test('maps JSX and TSX fences to the registered JavaScript and TypeScript grammars', () => {
  const jsx = renderedCode('```jsx\nconst view = <Panel enabled />;\n```');
  const tsx = renderedCode('```tsx\nconst view: JSX.Element = <Panel enabled />;\n```');

  highlightCodeBlocks(jsx.root);
  highlightCodeBlocks(tsx.root);

  assert.equal(jsx.code.dataset.highlighted, 'javascript');
  assert.equal(tsx.code.dataset.highlighted, 'typescript');
  assert.ok(jsx.code.querySelector('[class^="hljs-"]'));
  assert.ok(tsx.code.querySelector('[class^="hljs-"]'));
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

test('rejects unexpected tokenizer tags, attributes, and excessive classes', () => {
  const source = 'print("safe")';
  const hostileMarkup = [
    '<img src="x" />',
    '<span class="hljs-keyword" onclick="alert(1)">print</span>',
    '<span class="hljs-a one two three four">print</span>',
    '<span class="hljs-keyword"><b>nested</b></span>',
  ];

  for (const markup of hostileMarkup) {
    const rendered = renderedCode(`\`\`\`python\n${source}\n\`\`\``);
    highlightCodeBlocks(rendered.root, { tokenize: () => markup });
    assert.equal(rendered.code.textContent, source);
    assert.equal(rendered.code.dataset.highlighted, undefined);
    assert.equal(rendered.code.querySelector('[class^="hljs-"]'), null);
  }
});

test('accepts a valid sublanguage wrapper alongside hljs classes', () => {
  const source = 'print("safe")';
  const markup = '<span class="hljs-keyword language-python">print</span>(<span class="hljs-string">"safe"</span>)';
  const rendered = renderedCode(`\`\`\`python\n${source}\n\`\`\``);
  highlightCodeBlocks(rendered.root, { tokenize: () => markup });
  assert.equal(rendered.code.textContent, source);
  assert.equal(rendered.code.dataset.highlighted, 'python');
  assert.ok(rendered.code.querySelector('.hljs-keyword.language-python'));
});
