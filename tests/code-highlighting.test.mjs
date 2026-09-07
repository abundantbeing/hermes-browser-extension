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

test('maps JSX and TSX fences to registered grammars', () => {
  const jsx = renderedCode('```jsx\nconst view = <Panel enabled />;\n```');
  const tsx = renderedCode('```tsx\nconst view: JSX.Element = <Panel enabled />;\n```');

  highlightCodeBlocks(jsx.root);
  highlightCodeBlocks(tsx.root);

  assert.equal(jsx.code.dataset.highlighted, 'javascript');
  assert.equal(tsx.code.dataset.highlighted, 'typescript');
  assert.ok(jsx.code.querySelector('[class^="hljs-"]'));
  assert.ok(tsx.code.querySelector('[class^="hljs-"]'));
});

test('keeps highlighting when registered grammars emit sublanguage wrappers', () => {
  const rendered = renderedCode('```js\nconst view = html`<div>hello</div>`;\n```');

  highlightCodeBlocks(rendered.root);

  assert.equal(rendered.code.dataset.highlighted, 'javascript');
  assert.ok(rendered.code.querySelector('.language-xml'));
  assert.equal(rendered.code.textContent, 'const view = html`<div>hello</div>`;');
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

test('rejects unexpected tokenizer tags, attributes, and classes', () => {
  const source = 'print("safe")';
  const hostileMarkup = [
    '<img src="x" />',
    '<span class="hljs-keyword" onclick="alert(1)">print</span>',
    '<span class="hljs-a one two three four">print</span>',
    '<span class="hljs-keyword message">print</span>("safe")',
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

test('falls back when reconstructed tokens do not preserve the source', () => {
  const source = 'print("safe")';
  const rendered = renderedCode(`\`\`\`python\n${source}\n\`\`\``);

  highlightCodeBlocks(rendered.root, {
    tokenize: () => '<span class="hljs-keyword">return</span>',
  });

  assert.equal(rendered.code.textContent, source);
  assert.equal(rendered.code.dataset.highlighted, undefined);
  assert.equal(rendered.code.querySelector('[class^="hljs-"]'), null);
});

test('leaves oversized blocks plain while preserving their exact source', () => {
  const source = `const payload = "${'x'.repeat(100_000)}";`;
  const rendered = renderedCode(`\`\`\`js\n${source}\n\`\`\``);

  highlightCodeBlocks(rendered.root, {
    tokenize() {
      return '<span class="hljs-keyword">const</span>';
    },
  });

  assert.equal(rendered.code.dataset.highlighted, undefined);
  assert.equal(rendered.code.querySelector('[class^="hljs-"]'), null);
  assert.equal(rendered.code.textContent, source);
});
