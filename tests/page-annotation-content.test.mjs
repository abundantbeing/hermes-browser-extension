import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

import {
  PAGE_ANNOTATION_CONTENT_API,
  PAGE_ANNOTATION_MESSAGES,
  PAGE_ANNOTATION_MODES,
  PAGE_ANNOTATION_SCHEMA_VERSION,
  areaGestureRect,
  buildCssSelector,
  captureElementSnapshot,
  compactAnnotationSnapshot,
  createDocumentKey,
  createPageAnnotationController,
  normalizeAnnotationRect,
  normalizeAnnotationViewport,
} from '../extension/lib/page-annotation-content.mjs';

test('content protocol names and schema version are exact', () => {
  assert.deepEqual(PAGE_ANNOTATION_MESSAGES, {
    START: 'HERMES_START_PAGE_ANNOTATION',
    CANCEL: 'HERMES_CANCEL_PAGE_ANNOTATION',
    RESULT: 'HERMES_PAGE_ANNOTATION_RESULT',
    PICKING: 'HERMES_PAGE_ANNOTATION_PICKING',
    CANCELLED: 'HERMES_PAGE_ANNOTATION_CANCELLED',
    SYNC: 'HERMES_PAGE_ANNOTATION_SYNC',
    CAPTURE_BEGIN: 'HERMES_PAGE_ANNOTATION_CAPTURE_BEGIN',
    CAPTURE_END: 'HERMES_PAGE_ANNOTATION_CAPTURE_END',
    PIN_CLICKED: 'HERMES_PAGE_ANNOTATION_PIN_CLICKED',
    ERROR: 'HERMES_PAGE_ANNOTATION_ERROR',
    CARD_SUBMIT: 'HERMES_PAGE_COMMENT_CARD_SUBMIT',
    CARD_CANCEL: 'HERMES_PAGE_COMMENT_CARD_CANCEL',
    ABORT: 'HERMES_ABORT_PAGE_OVERLAYS',
  });
  assert.deepEqual(PAGE_ANNOTATION_MODES, { ELEMENT: 'element', AREA: 'area' });
  assert.equal(PAGE_ANNOTATION_SCHEMA_VERSION, 1);
  assert.equal(PAGE_ANNOTATION_CONTENT_API.PAGE_ANNOTATION_SCHEMA_VERSION, 1);
});

test('buildCssSelector escapes ids and quoted test ids', () => {
  const { document } = parseHTML('<!doctype html><html><body><main></main></body></html>');
  const button = document.createElement('button');
  button.id = 'save.changes';
  document.querySelector('main').append(button);
  assert.match(buildCssSelector(button), /button#save\\\.changes|button#save\\.changes/);

  const input = document.createElement('input');
  input.setAttribute('data-testid', 'hero"cta');
  document.querySelector('main').append(input);
  assert.match(buildCssSelector(input), /data-testid="hero\\"cta"|data-testid="hero\\\\"cta"/);
});

test('normalizeAnnotationRect keeps finite positive CSS viewport coordinates', () => {
  assert.deepEqual(normalizeAnnotationRect({ x: 10.4, y: 2.2, width: 12.8, height: 9.1 }), {
    x: 10,
    y: 2,
    width: 13,
    height: 9,
  });
  assert.equal(normalizeAnnotationRect({ x: 1, y: 1, width: 0, height: 8 }), null);
});

test('areaGestureRect requires an 8px movement threshold', () => {
  assert.equal(areaGestureRect({ x: 10, y: 10 }, { x: 14, y: 12 }), null);
  assert.deepEqual(areaGestureRect({ x: 10, y: 10 }, { x: 30, y: 40 }), {
    x: 10,
    y: 10,
    width: 20,
    height: 30,
  });
});

test('captureElementSnapshot omits value and password contents', () => {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const password = document.createElement('input');
  password.setAttribute('type', 'password');
  password.setAttribute('value', 'hunter2');
  password.setAttribute('name', 'secret');
  document.body.append(password);
  const snapshot = captureElementSnapshot(password);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.attributes.value, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /hunter2/);
});

test('compactAnnotationSnapshot clips text, html, and css', () => {
  const compact = compactAnnotationSnapshot({
    ok: true,
    tag: 'div',
    selector: 'div',
    text: 'x'.repeat(120),
    html: '<div>' + 'y'.repeat(700) + '</div>',
    css: { color: 'red', display: 'none' },
  });
  assert.equal(compact.text.length, 80);
  assert.equal(compact.html.length, 600);
  assert.equal(compact.css.display, undefined);
});

test('createDocumentKey is stable across duplicate controller init', () => {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const first = createDocumentKey(document);
  const second = createDocumentKey(document);
  assert.equal(first, second);
  assert.ok(first);
});

test('controller start emits picking and a click emits one element result', () => {
  const { document, Event } = parseHTML('<!doctype html><html><body><main><button id="save">Save</button></main></body></html>');
  const sent = [];
  const controller = createPageAnnotationController({
    document,
    sendMessage: (message) => sent.push(message),
  });
  const started = controller.start({ sessionId: 's1', mode: PAGE_ANNOTATION_MODES.ELEMENT });
  assert.equal(started.ok, true);
  assert.equal(sent[0].type, PAGE_ANNOTATION_MESSAGES.PICKING);
  const button = document.getElementById('save');
  button.dispatchEvent(new Event('click', { bubbles: true }));
  const result = sent.find((message) => message.type === PAGE_ANNOTATION_MESSAGES.RESULT);
  assert.ok(result);
  assert.equal(result.kind, 'element');
  assert.equal(result.sessionId, 's1');
  assert.ok(result.identity?.selector);
  controller.destroy();
});

test('duplicate controllers tear down the previous listeners', () => {
  const { document } = parseHTML('<!doctype html><html><body><button id="save">Save</button></body></html>');
  const first = createPageAnnotationController({ document, sendMessage: () => {} });
  first.start({ sessionId: 'one', mode: 'element' });
  const second = createPageAnnotationController({ document, sendMessage: () => {} });
  assert.equal(first.destroyed, true);
  second.destroy();
});

test('content script routes the page-annotation protocol', () => {
  const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
  assert.match(source, /HermesPageAnnotation/);
  assert.match(source, /startAnnotationMode/);
  assert.match(source, /annotationMessages\.START/);
  assert.match(source, /annotationMessages\.SYNC/);
});

test('page comment card queues, sends, and cancels without leaving a host', () => {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const events = [];
  const host = PAGE_ANNOTATION_CONTENT_API.mountPageCommentCard(document, {
    label: 'button#save',
    rect: { x: 40, y: 40, width: 80, height: 24 },
    onQueue: (note) => events.push(['queue', note]),
    onSend: (note) => events.push(['send', note]),
    onCancel: () => events.push(['cancel']),
  });
  assert.ok(host);
  assert.equal(host.getAttribute('data-hermes-page-comment-card'), 'true');
  assert.ok(host.querySelector('[data-comment-drag]'));
  const note = host.querySelector('[data-comment-note]');
  note.value = 'tighten this CTA';
  host.querySelector('[data-comment-queue]').onclick();
  assert.deepEqual(events, [['queue', 'tighten this CTA']]);
  assert.equal(document.querySelector('[data-hermes-page-comment-card]'), null);

  const again = PAGE_ANNOTATION_CONTENT_API.mountPageCommentCard(document, {
    label: 'h1',
    onSend: (value) => events.push(['send', value]),
    onCancel: () => events.push(['cancel']),
  });
  again.querySelector('[data-comment-note]').value = 'send this';
  again.querySelector('[data-comment-send]').onclick();
  assert.equal(events.at(-1)[0], 'send');
  PAGE_ANNOTATION_CONTENT_API.mountPageCommentCard(document, { onCancel: () => events.push(['cancel']) });
  document.querySelector('[data-comment-cancel]').onclick();
  assert.equal(events.at(-1)[0], 'cancel');
  assert.equal(document.querySelector('[data-hermes-page-comment-card]'), null);
});

test('page comment card follows the active appearance theme', () => {
  const theme = PAGE_ANNOTATION_CONTENT_API.resolvePageCommentCardTheme({
    appearanceTheme: 'mono',
    colorMode: 'dark',
  });
  assert.equal(theme.bg, '#171717');
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const host = PAGE_ANNOTATION_CONTENT_API.mountPageCommentCard(document, { theme, label: 'Save' });
  assert.match(host.getAttribute('style') || '', /#171717/i);
  assert.equal(host.querySelector('[data-comment-label]')?.textContent, 'Save');
});
