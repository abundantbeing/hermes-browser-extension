import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

import {
  assistantSelectionClipboardPayload,
  buildCleanClipboardPayload,
} from '../extension/lib/assistant-clipboard.mjs';

function documentFor(body) {
  return parseHTML(`<!doctype html><html><body>${body}</body></html>`).document;
}

function fragmentFrom(element, document) {
  const fragment = document.createDocumentFragment();
  for (const child of Array.from(element.childNodes)) fragment.appendChild(child.cloneNode(true));
  return fragment;
}

test('clean assistant clipboard payload keeps semantics but strips extension presentation styling', () => {
  const document = documentFor(`
    <div id="content" class="message-content tiny muted" style="font-size:11px;color:#aaa" data-theme="midnight">
      <p class="copy" style="font-size:11px;color:#aaa">Normal <strong class="accent" style="color:red">bold</strong></p>
      <ul class="markdown-list" style="color:#aaa"><li data-row="1">First</li><li>Second</li></ul>
      <p><a href="https://example.com/path" class="link">Good</a> <a href="javascript:alert(1)" style="color:red">Bad</a></p>
      <script>alert('not copied')</script><span class="theme-copy" style="font-size:9px">Tail</span>
    </div>
  `);
  const content = document.querySelector('#content');
  const payload = buildCleanClipboardPayload({
    fragment: fragmentFrom(content, document),
    document,
    baseUrl: 'https://mail.google.com/',
  });

  assert.match(payload.html, /<p>Normal <strong>bold<\/strong><\/p>/);
  assert.match(payload.html, /<ul><li>First<\/li><li>Second<\/li><\/ul>/);
  assert.match(payload.html, /<a href="https:\/\/example\.com\/path">Good<\/a>/);
  assert.match(payload.html, /<a>Bad<\/a>/);
  assert.match(payload.html, /Tail/);
  assert.doesNotMatch(payload.html, /style=|class=|data-|font-size|color:|script|alert/i);
  assert.match(payload.text, /Normal bold/);
  assert.match(payload.text, /• First/);
  assert.match(payload.text, /• Second/);
});

test('assistant selection payload only intercepts a non-collapsed selection inside one assistant response', () => {
  const document = documentFor(`
    <main id="messages">
      <article class="message assistant"><div class="message-content"><p>Answer <strong>text</strong></p></div></article>
      <article class="message user"><div class="message-content"><p>User text</p></div></article>
    </main>
  `);
  const root = document.querySelector('#messages');
  const assistantText = document.querySelector('.assistant p').firstChild;
  const userText = document.querySelector('.user p').firstChild;
  const makeSelection = (node, fragment) => ({
    rangeCount: 1,
    getRangeAt: () => ({
      collapsed: false,
      startContainer: node,
      endContainer: node,
      cloneContents: () => fragment,
    }),
    toString: () => node.textContent,
  });

  const assistantContent = document.querySelector('.assistant .message-content');
  const payload = assistantSelectionClipboardPayload({
    selection: makeSelection(assistantText, fragmentFrom(assistantContent, document)),
    messagesRoot: root,
    document,
    assistantSelector: '.message.assistant',
  });
  assert.match(payload.html, /Answer <strong>text<\/strong>/);

  const userContent = document.querySelector('.user .message-content');
  assert.equal(assistantSelectionClipboardPayload({
    selection: makeSelection(userText, fragmentFrom(userContent, document)),
    messagesRoot: root,
    document,
    assistantSelector: '.message.assistant',
  }), null);
});

test('side panel and full view both install the clean assistant copy handler', () => {
  const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const fullView = readFileSync(new URL('../extension/app.js', import.meta.url), 'utf8');
  for (const source of [sidepanel, fullView]) {
    assert.match(source, /writeAssistantClipboardEvent/);
    assert.match(source, /addEventListener\('copy'/);
  }
  assert.match(sidepanel, /assistantSelector: '\.message\.assistant'/);
  assert.match(fullView, /assistantSelector: '\.web-message\.assistant'/);
});
