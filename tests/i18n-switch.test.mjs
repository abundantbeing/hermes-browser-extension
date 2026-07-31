import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

// ---- Minimal environment shims for i18n.mjs in Node ----
const { document, Node, NodeFilter, MutationObserver } = (() => {
  const parsed = parseHTML('<!doctype html><html><body></body></html>');
  const doc = parsed.document;
  const win = doc.defaultView;
  const NF = win.NodeFilter || {
    SHOW_ELEMENT: 0x1,
    SHOW_TEXT: 0x4,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
  };
  const MO = class {
    constructor() {}
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  };
  return { document: doc, Node: win.Node, NodeFilter: NF, MutationObserver: MO };
})();
globalThis.document = document;
globalThis.Node = Node;
globalThis.NodeFilter = NodeFilter;
globalThis.MutationObserver = MutationObserver;
globalThis.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {} } },
};

const { setLanguage, getLanguage, applyI18n, t } = await import('../extension/lib/i18n.mjs');

function makeFixture() {
  const html = `<!doctype html><html><body>
    <h1 data-i18n="Settings">Settings</h1>
    <button id="connect" data-i18n="Connect to Hermes">Connect to Hermes</button>
    <p data-i18n="Ask Hermes">Ask Hermes</p>
    <p id="plain">No tab detected</p>
    <p id="mixed">Clone this repo, build it, and load the <code>dist/</code> folder unpacked.</p>
    <p class="message-content">Chat message content stays English</p>
  </body></html>`;
  return parseHTML(html).document;
}

test('language switches zh -> en -> zh on data-i18n elements', async () => {
  const doc = makeFixture();
  globalThis.document = doc;
  await setLanguage('zh');
  assert.equal(doc.querySelector('h1').textContent, '设置');
  assert.equal(doc.querySelector('#connect').textContent, '连接到 Hermes');

  // Switch back to English WITHOUT reloading: text must revert
  await setLanguage('en');
  assert.equal(doc.querySelector('h1').textContent, 'Settings');
  assert.equal(doc.querySelector('#connect').textContent, 'Connect to Hermes');

  // And back to Chinese again
  await setLanguage('zh');
  assert.equal(doc.querySelector('h1').textContent, '设置');
  await setLanguage('en');
});

test('plain text nodes restore original English on switch back', async () => {
  const doc = makeFixture();
  globalThis.document = doc;
  await setLanguage('zh');
  assert.equal(doc.querySelector('#plain').textContent, '未检测到标签页');
  await setLanguage('en');
  assert.equal(doc.querySelector('#plain').textContent, 'No tab detected');
});

test('mixed-content elements keep child markup and restore English', async () => {
  const doc = makeFixture();
  globalThis.document = doc;
  await setLanguage('zh');
  const mixed = doc.querySelector('#mixed');
  // code child must survive translation
  assert.ok(mixed.querySelector('code'));
  await setLanguage('en');
  const mixed2 = doc.querySelector('#mixed');
  assert.equal(mixed2.querySelector('code').textContent, 'dist/');
  assert.match(mixed2.textContent, /Clone this repo/);
});

test('user message content is never translated', async () => {
  const doc = makeFixture();
  globalThis.document = doc;
  await setLanguage('zh');
  assert.equal(doc.querySelector('.message-content').textContent, 'Chat message content stays English');
  await setLanguage('en');
});

test('getLanguage reflects the current language', async () => {
  await setLanguage('zh');
  assert.equal(getLanguage(), 'zh');
  await setLanguage('en');
  assert.equal(getLanguage(), 'en');
});
