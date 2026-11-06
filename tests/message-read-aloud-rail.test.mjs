import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { buildMessageRail, setReadAloudState } from '../extension/lib/message-actions.mjs';
import { createMessageThreadUi } from '../extension/lib/message-thread-ui.mjs';

const documentFor = () => parseHTML('<!doctype html><html><body></body></html>').document;
const TS = new Date(2026, 8, 30, 14, 42, 8).getTime();

test('a finished assistant reply gets a speaker button after Copy', () => {
  const rail = buildMessageRail({
    document: documentFor(), role: 'assistant', ts: TS, locale: 'en-US',
    canReadAloud: true, onCopy: () => true, onReadAloud: () => {},
  });
  assert.deepEqual(Array.from(rail.children).map((el) => el.className.split(' ').slice(0, 2).join(' ')), [
    'message-time',
    'message-action message-action-copy',
    'message-action message-action-speak',
  ]);
  const speak = rail.querySelector('.message-action-speak');
  assert.equal(speak.getAttribute('aria-label'), 'Read aloud');
  assert.equal(speak.getAttribute('title'), 'Read aloud');
  assert.equal(speak.getAttribute('aria-pressed'), 'false');
  assert.equal(speak.getAttribute('type'), 'button');
  assert.ok(speak.querySelector('svg.message-action-icon'));
});

test('no speaker button on a person\'s message, on a streaming reply, or without a handler', () => {
  const document = documentFor();
  const user = buildMessageRail({ document, role: 'user', ts: TS, canReadAloud: true, onReadAloud: () => {} });
  assert.equal(user.querySelector('.message-action-speak'), null);
  const streaming = buildMessageRail({ document, role: 'assistant', ts: TS, canReadAloud: false, onReadAloud: () => {} });
  assert.equal(streaming.querySelector('.message-action-speak'), null);
  const noHandler = buildMessageRail({ document, role: 'assistant', ts: TS, canReadAloud: true });
  assert.equal(noHandler.querySelector('.message-action-speak'), null);
});

test('pressing the speaker calls back once', () => {
  let calls = 0;
  const rail = buildMessageRail({ document: documentFor(), role: 'assistant', ts: TS, canReadAloud: true, onReadAloud: () => { calls += 1; } });
  rail.querySelector('.message-action-speak').click();
  assert.equal(calls, 1);
});

test('while a reply is read its speaker is a pressed Stop control and its row is marked', () => {
  const document = documentFor();
  const row = document.createElement('div');
  const rail = buildMessageRail({ document, role: 'assistant', ts: TS, canReadAloud: true, onReadAloud: () => {} });
  row.append(rail);
  const speak = rail.querySelector('.message-action-speak');
  const idleIcon = speak.innerHTML;

  setReadAloudState(rail, 'speaking', { translate: (text) => `[${text}]` });
  assert.equal(speak.getAttribute('aria-pressed'), 'true');
  assert.equal(speak.getAttribute('aria-label'), '[Stop reading aloud]');
  assert.equal(speak.getAttribute('aria-busy'), null);
  assert.ok(speak.classList.contains('is-reading'));
  assert.ok(row.classList.contains('is-being-read'));
  assert.notEqual(speak.innerHTML, idleIcon, 'the glyph becomes a stop square');

  setReadAloudState(rail, 'loading');
  assert.equal(speak.getAttribute('aria-pressed'), 'true');
  assert.equal(speak.getAttribute('aria-busy'), 'true');
  assert.ok(speak.classList.contains('is-loading'));

  setReadAloudState(rail, 'idle');
  assert.equal(speak.getAttribute('aria-pressed'), 'false');
  assert.equal(speak.getAttribute('aria-busy'), null);
  assert.equal(speak.getAttribute('aria-label'), 'Read aloud');
  assert.equal(speak.classList.contains('is-reading'), false);
  assert.equal(row.classList.contains('is-being-read'), false);
  assert.equal(speak.innerHTML, idleIcon);
});

function threadFixture(options = {}) {
  const { document, window } = parseHTML('<html><body><section id="messages"></section></body></html>');
  const root = document.querySelector('#messages');
  const controller = createMessageThreadUi({
    root, document, window, ResizeObserver: null, requestFrame: (callback) => callback(),
    locale: () => 'en-US', now: () => TS,
    ...options,
  });
  const add = (record, extra = {}) => {
    const row = document.createElement('div');
    row.className = 'message-row';
    const node = document.createElement('article');
    node.className = `message ${record.role}`;
    row.append(node);
    controller.attach({ row, node, record, ...extra });
    root.append(row);
    return { row, node };
  };
  return { add, controller, document, window };
}

test('the thread asks the panel whether to offer the button, keeps it off while streaming and adds it when the reply ends', () => {
  const asked = [];
  const f = threadFixture({
    canReadAloud: (record) => { asked.push(record); return true; },
    onReadAloud: () => {},
  });
  const reply = { role: 'assistant', ts: TS };
  const a = f.add(reply, { streaming: true });
  assert.equal(a.row.querySelector('.message-action-speak'), null);
  f.controller.setStreaming(a.row, false);
  assert.ok(a.row.querySelector('.message-rail > .message-action-speak'));
  assert.ok(asked.includes(reply));
  const user = f.add({ role: 'user', ts: TS });
  assert.equal(user.row.querySelector('.message-action-speak'), null);
});

test('a reply that is being read keeps its marked state when its rail is rebuilt, and refreshReadAloud updates states alone', () => {
  const reading = new Set();
  const f = threadFixture({
    canReadAloud: () => true,
    onReadAloud: () => {},
    readAloudStateFor: (record) => (reading.has(record) ? 'speaking' : 'idle'),
  });
  const first = { role: 'assistant', ts: TS };
  const second = { role: 'assistant', ts: TS };
  const a = f.add(first);
  const b = f.add(second);
  reading.add(first);
  const railBefore = a.row.querySelector('.message-rail');
  f.controller.refreshReadAloud();
  assert.equal(a.row.querySelector('.message-rail'), railBefore, 'the rail is not rebuilt');
  assert.equal(a.row.querySelector('.message-action-speak').getAttribute('aria-pressed'), 'true');
  assert.ok(a.row.classList.contains('is-being-read'));
  assert.equal(b.row.classList.contains('is-being-read'), false);

  f.controller.refreshActions();
  assert.ok(a.row.classList.contains('is-being-read'), 'a rebuilt rail still marks the reply');
  assert.equal(a.row.querySelector('.message-action-speak').getAttribute('aria-pressed'), 'true');

  reading.clear();
  f.controller.refreshReadAloud();
  assert.equal(a.row.classList.contains('is-being-read'), false);
});

test('when voice becomes available after the probe, stale assistant rails gain a speaker button', () => {
  let offerVoice = false;
  const f = threadFixture({ canReadAloud: () => offerVoice, onReadAloud: () => {} });
  const reply = { role: 'assistant', ts: TS };
  const a = f.add(reply);
  assert.equal(a.row.querySelector('.message-action-speak'), null);
  offerVoice = true;
  f.controller.refreshAfterReadAloudProbe();
  assert.ok(a.row.querySelector('.message-rail > .message-action-speak'));
  assert.equal(f.controller.readAloudRailsNeedRebuild(), false);
});

test('when read-aloud turns off after the probe, stale speaker buttons are removed (idle rows only)', () => {
  let offerVoice = true;
  const f = threadFixture({ canReadAloud: () => offerVoice, onReadAloud: () => {} });
  const reply = { role: 'assistant', ts: TS };
  const a = f.add(reply);
  assert.ok(a.row.querySelector('.message-rail > .message-action-speak'));
  offerVoice = false;
  f.controller.refreshAfterReadAloudProbe();
  assert.equal(a.row.querySelector('.message-action-speak'), null);
  assert.equal(f.controller.readAloudRailsNeedRebuild(), false);
});

test('when read-aloud turns off while a reply is speaking, the Stop control stays until playback ends', () => {
  const reading = new Set();
  let offerVoice = true;
  const f = threadFixture({
    canReadAloud: () => offerVoice,
    onReadAloud: () => {},
    readAloudStateFor: (record) => (reading.has(record) ? 'speaking' : 'idle'),
  });
  const record = { role: 'assistant', ts: TS };
  const a = f.add(record);
  reading.add(record);
  assert.ok(a.row.querySelector('.message-action-speak'));
  offerVoice = false;
  assert.equal(f.controller.readAloudRailsNeedRebuild(), false);
  f.controller.refreshAfterReadAloudProbe();
  assert.ok(a.row.querySelector('.message-action-speak'));
  assert.equal(a.row.querySelector('.message-action-speak').getAttribute('aria-pressed'), 'true');
});

test('when voice availability is unchanged, probe refresh updates speak state without rebuilding the rail', () => {
  const reading = new Set();
  const f = threadFixture({
    canReadAloud: () => true,
    onReadAloud: () => {},
    readAloudStateFor: (record) => (reading.has(record) ? 'speaking' : 'idle'),
  });
  const record = { role: 'assistant', ts: TS };
  const a = f.add(record);
  reading.add(record);
  const railBefore = a.row.querySelector('.message-rail');
  f.controller.refreshAfterReadAloudProbe();
  assert.equal(a.row.querySelector('.message-rail'), railBefore);
  assert.equal(a.row.querySelector('.message-action-speak').getAttribute('aria-pressed'), 'true');
});

test('rebuilding rails keeps keyboard focus on the Stop control', () => {
  const reading = new Set();
  const f = threadFixture({
    canReadAloud: () => true,
    onReadAloud: () => {},
    readAloudStateFor: (record) => (reading.has(record) ? 'speaking' : 'idle'),
  });
  let active = null;
  Object.defineProperty(f.document, 'activeElement', {
    configurable: true,
    get: () => active,
  });
  const stubFocus = function stubFocus() { active = this; };
  const buttonProto = f.document.defaultView?.HTMLButtonElement?.prototype;
  const previousFocus = buttonProto?.focus;
  if (buttonProto) buttonProto.focus = stubFocus;
  try {
    const record = { role: 'assistant', ts: TS };
    const a = f.add(record);
    reading.add(record);
    const stop = a.row.querySelector('.message-action-speak');
    active = stop;
    f.controller.refreshActions();
    const stopAfter = a.row.querySelector('.message-action-speak');
    assert.equal(active, stopAfter);
    assert.equal(stopAfter.getAttribute('aria-pressed'), 'true');
  } finally {
    if (buttonProto && previousFocus) buttonProto.focus = previousFocus;
  }
});
