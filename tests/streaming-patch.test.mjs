// Streaming paints a reply by diffing its new HTML against the live DOM block by
// block. A code block is wrapped with its copy button after it is painted, so the
// diff compares against the HTML each block was painted from; otherwise every
// block after the first code block was removed and rebuilt on every frame.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { enhanceMarkdownCodeBlocks } from '../extension/lib/markdown-code-copy.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const patchSource = slice('function patchRenderedMessageContent(', 'function adaptiveUiLabels(');

function harness() {
  const { document, Node } = parseHTML('<html><body><div class="message-content"></div></body></html>');
  const context = vm.createContext({ document, Node, highlightCodeBlocks: () => {} });
  vm.runInContext(patchSource, context);
  const element = document.querySelector('.message-content');
  const paint = (html) => {
    context.patchRenderedMessageContent(element, html);
    enhanceMarkdownCodeBlocks(element, { document, copyText: async () => {} });
  };
  return { element, paint };
}

const code = '<pre><code class="language-js">const answer = 42;</code></pre>';

test('blocks after a wrapped code block survive later frames', () => {
  const { element, paint } = harness();
  paint(`<p>Intro.</p>${code}<p>First paragraph.</p><p>Second</p>`);
  const wrapper = element.querySelector('.md-code');
  const first = [...element.querySelectorAll('p')].find((node) => node.textContent === 'First paragraph.');
  assert.ok(wrapper, 'the code block got its copy button');
  paint(`<p>Intro.</p>${code}<p>First paragraph.</p><p>Second paragraph grows</p>`);
  assert.equal(element.querySelector('.md-code'), wrapper, 'the wrapped code block is kept');
  assert.ok(first.isConnected, 'a finished paragraph after the code block is not rebuilt');
  assert.match(element.textContent, /Second paragraph grows/);
  assert.equal(element.querySelectorAll('.md-code').length, 1);
});

test('a code block whose source changed is still replaced', () => {
  const { element, paint } = harness();
  paint(`${code}<p>After.</p>`);
  const wrapper = element.querySelector('.md-code');
  paint('<pre><code class="language-js">const answer = 43;</code></pre><p>After.</p>');
  assert.notEqual(element.querySelector('.md-code'), wrapper);
  assert.match(element.textContent, /43/);
  assert.doesNotMatch(element.textContent, /42/);
});

test('the growing last block keeps its node and tracks its new source', () => {
  const { element, paint } = harness();
  paint('<p>One</p><p>Tw</p>');
  const tail = element.lastElementChild;
  paint('<p>One</p><p>Two</p>');
  assert.equal(element.lastElementChild, tail);
  paint('<p>One</p><p>Two</p><p>Three</p>');
  assert.equal(element.children[1], tail, 'the finished block now matches its updated source');
  assert.equal(element.textContent, 'OneTwoThree');
});
