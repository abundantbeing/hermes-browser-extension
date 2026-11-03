// A reply painted again after its picture loaded keeps the picture. The side panel's own
// patchRenderedMessageContent and replaceHydratedMediaNode run in a DOM.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function slice(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `sidepanel.js no longer has ${start} … ${end}`);
  return source.slice(from, to);
}

const code = [
  slice('function patchRenderedMessageContent(', 'function renderedBlockSource('),
  slice('function renderedBlockSource(', '\n}\n') + '\n}\n',
  slice('function replaceHydratedMediaNode(', '\n}\n') + '\n}\n',
].join('\n');

const placeholder = '<figure class="session-media" data-session-media="image" data-media-path="/m/d.png" role="status"><span class="session-media-label">Image</span><span class="session-media-name">d.png</span></figure>';
const reply = `<p>Option D is ready.</p>${placeholder}`;

function panel() {
  const { document } = parseHTML('<html><body><div class="message-content"></div></body></html>');
  const context = vm.createContext({ document, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, highlightCodeBlocks: () => {} });
  vm.runInContext(`${code}\nglobalThis.api = { patchRenderedMessageContent, replaceHydratedMediaNode };`, context);
  return { document, element: document.querySelector('.message-content'), api: context.api };
}

function loadedPicture(document) {
  const figure = document.createElement('figure');
  figure.className = 'generated-image';
  const image = document.createElement('img');
  image.src = 'data:image/png;base64,AAAA';
  figure.append(image);
  return figure;
}

test('a picture that loaded survives the next paint of the same reply', () => {
  const { document, element, api } = panel();
  api.patchRenderedMessageContent(element, reply);
  api.replaceHydratedMediaNode(element.querySelector('[data-session-media]'), loadedPicture(document));
  api.patchRenderedMessageContent(element, reply);
  assert.equal(element.querySelectorAll('img').length, 1, 'the picture is still there');
  assert.equal(element.querySelector('figure').className, 'generated-image');
  assert.equal(element.querySelector('.session-media-label'), null, 'no placeholder markup poured into it');
});

test('a reply that changes after its picture loaded is painted afresh', () => {
  const { document, element, api } = panel();
  api.patchRenderedMessageContent(element, reply);
  api.replaceHydratedMediaNode(element.querySelector('[data-session-media]'), loadedPicture(document));
  api.patchRenderedMessageContent(element, `<p>Option D is ready, and E.</p>${placeholder}`);
  assert.ok(element.querySelector('[data-session-media][data-media-path]'), 'a new placeholder for the next hydration');
});

test('every media hydration swaps nodes through replaceHydratedMediaNode', () => {
  const hydration = slice('async function hydrateSessionMediaInElement(', '// ── Returned-file cards');
  assert.equal((hydration.match(/replaceHydratedMediaNode\(node, /g) || []).length, 3);
  assert.doesNotMatch(hydration, /\bnode\.replaceWith\(/, 'a bare replaceWith loses the painted source');
});
