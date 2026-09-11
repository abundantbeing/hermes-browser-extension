import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import {
  CODE_COPY_ICON,
  enhanceMarkdownCodeBlocks,
  codeTextFromPre,
} from '../extension/lib/markdown-code-copy.mjs';

const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../extension/app.js', import.meta.url), 'utf8');
const sidepanelCss = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('../extension/app.css', import.meta.url), 'utf8');

function mount(html) {
  const { window } = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  return window;
}

test('enhanceMarkdownCodeBlocks wraps fenced pre blocks with a copy control', async () => {
  const window = mount('<div class="message-content"><pre><code>  const x = 1;\n</code></pre><p>hi <code>inline</code></p></div>');
  const root = window.document.querySelector('.message-content');
  const copied = [];
  const count = enhanceMarkdownCodeBlocks(root, {
    document: window.document,
    copyText: async (text) => { copied.push(text); },
  });
  assert.equal(count, 1);
  const wrap = root.querySelector('.md-code');
  const button = wrap.querySelector('button.md-code-copy');
  assert.equal(button.type, 'button');
  assert.equal(button.title, 'Copy code');
  assert.equal(button.getAttribute('aria-label'), 'Copy code');
  assert.match(button.innerHTML, /viewBox="0 0 24 24"/);
  assert.equal(root.querySelectorAll('.md-code').length, 1);
  assert.equal(root.querySelector('p code').closest('.md-code'), null);
  assert.equal(codeTextFromPre(wrap.querySelector('pre')), '  const x = 1;\n');
  button.click();
  await window.document.defaultView?.Promise?.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(copied, ['  const x = 1;\n']);
  assert.equal(enhanceMarkdownCodeBlocks(root, { document: window.document }), 0);
});

test('enhanceMarkdownCodeBlocks skips empty pre blocks', () => {
  const window = mount('<pre></pre>');
  assert.equal(enhanceMarkdownCodeBlocks(window.document.body, { document: window.document }), 0);
  assert.equal(window.document.querySelector('.md-code'), null);
});

test('sidepanel and full-tab render paths mount the copy control', () => {
  assert.match(sidepanel, /enhanceMarkdownCodeBlocks/);
  assert.match(app, /enhanceMarkdownCodeBlocks/);
  assert.match(sidepanel, /from '\.\/lib\/markdown-code-copy\.mjs'/);
  assert.match(app, /from '\.\/lib\/markdown-code-copy\.mjs'/);
});

test('copy control uses branded icon chrome without fat OS scrollbar overrides', () => {
  assert.match(CODE_COPY_ICON, /stroke="currentColor"/);
  for (const css of [sidepanelCss, appCss]) {
    assert.match(css, /\.md-code-copy/);
    assert.match(css, /\.md-code \{/);
    assert.doesNotMatch(css, /\.md-code[^{]*\{[^}]*scrollbar-color/);
    assert.doesNotMatch(css, /\.md-code-copy[^{]*\{[^}]*border-radius/);
  }
});
