import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

function buildHarness({ sessionId = 'session-A' } = {}) {
  const start = sidepanelSource.indexOf('// /btw answers must outlive the operation toast');
  const end = sidepanelSource.indexOf('\nfunction queueCurrentDraft', start);
  assert.ok(start >= 0 && end > start, 'side-question card source block must exist in sidepanel.js');
  const slice = sidepanelSource.slice(start, end);

  const dom = new JSDOM('<!doctype html><html><body><div id="messages"></div></body></html>');
  const { document } = dom.window;
  const messages = document.getElementById('messages');
  const settings = { sessionId };
  const copied = [];
  const statusCalls = [];

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'document', 'els', 'settings', 'translateUiText', 'renderMessageContentElement',
    'scrollMessageStreamToBottom', 'navigator', 'setTimeout', 'setStatus', 'THINKING_PLACEHOLDER',
    `let sideQuestionCardState = null;\nlet sideQuestionSequence = 0;\n${slice}\nreturn { showSideQuestionCard, settleSideQuestionCard, dismissSideQuestionCard, renderSideQuestionCard, sideQuestionMetaLabel, state: () => sideQuestionCardState };`,
  );
  const api = factory(
    document,
    { messages },
    settings,
    (text) => text,
    (element, content) => { element.textContent = content; },
    () => {},
    { clipboard: { writeText: async (text) => { copied.push(text); } } },
    () => 0,
    (level, title, detail) => { statusCalls.push({ level, title, detail }); },
    'THINKING',
  );
  return { messages, settings, copied, statusCalls, api };
}

test('a /btw side question renders a pending card the moment it is asked', () => {
  const h = buildHarness();
  h.messages.innerHTML = '<article class="message user"></article>';
  const seq = h.api.showSideQuestionCard('what changed in the last turn?');

  const card = h.messages.querySelector('.side-question-card');
  assert.ok(card, 'the pending card must exist');
  assert.equal(typeof seq, 'number');
  assert.equal(h.messages.lastElementChild, card, 'the card sits at the end of the transcript');
  assert.equal(card.querySelector('.side-question-label').textContent, 'By the way');
  assert.equal(card.querySelector('.side-question-question').textContent, 'what changed in the last turn?');
  assert.equal(card.querySelector('.side-question-meta').textContent, 'Asking…');
  assert.match(card.className, /pending/);
  assert.equal(card.querySelector('.side-question-answer').textContent, 'THINKING');
  assert.equal(card.querySelector('.side-question-copy').hidden, true, 'nothing to copy while pending');

  // Idempotent: re-renders never duplicate the card.
  h.api.renderSideQuestionCard();
  assert.equal(h.messages.querySelectorAll('.side-question-card').length, 1);
});

test('settling fills the card with the answer, snapshot timing, and a working Copy', async () => {
  const h = buildHarness();
  const seq = h.api.showSideQuestionCard('question', 'ignored');
  assert.equal(h.api.settleSideQuestionCard(seq, { answer: 'The full side answer.', elapsedMs: 2400 }), true);

  const card = h.messages.querySelector('.side-question-card');
  assert.doesNotMatch(card.className, /pending/);
  assert.doesNotMatch(card.className, /warn/);
  assert.equal(card.querySelector('.side-question-answer').textContent, 'The full side answer.');
  assert.equal(card.querySelector('.side-question-meta').textContent, 'Snapshot · 2.4s');
  assert.equal(card.querySelector('.side-question-copy').hidden, false);
  assert.ok(h.statusCalls.some((call) => call.title === 'Side question answered'));

  const copy = card.querySelector('.side-question-copy');
  copy.dispatchEvent(new h.messages.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.copied, ['The full side answer.']);
});

test('late answers for a replaced side question are ignored', () => {
  const h = buildHarness();
  const first = h.api.showSideQuestionCard('first question');
  const second = h.api.showSideQuestionCard('second question');

  assert.equal(h.api.settleSideQuestionCard(first, { answer: 'stale answer' }), false, 'a replaced card must not accept stale answers');
  assert.equal(h.messages.querySelectorAll('.side-question-card').length, 1, 'only the latest /btw result is kept');
  const card = h.messages.querySelector('.side-question-card');
  assert.equal(card.querySelector('.side-question-question').textContent, 'second question');
  assert.match(card.className, /pending/);

  assert.equal(h.api.settleSideQuestionCard(second, { answer: 'second answer' }), true);
  assert.equal(card.querySelector('.side-question-answer').textContent, 'second answer');
});

test('failures show as a warn card with the error text and no Copy', () => {
  const h = buildHarness();
  const seq = h.api.showSideQuestionCard('question');
  h.api.settleSideQuestionCard(seq, { error: 'Hermes returned no answer for this side question (401).' });

  const card = h.messages.querySelector('.side-question-card');
  assert.match(card.className, /warn/);
  assert.equal(card.querySelector('.side-question-meta').textContent, 'Failed');
  assert.equal(card.querySelector('.side-question-answer').textContent, 'Hermes returned no answer for this side question (401).');
  assert.equal(card.querySelector('.side-question-copy').hidden, true, 'nothing to copy on a failed side question');
  assert.ok(h.statusCalls.some((call) => call.level === 'warn' && call.title === 'Side question failed'));
});

test('dismissing and session switches clear the card and orphan any pending answer', () => {
  const h = buildHarness({ sessionId: 'session-A' });
  const seq = h.api.showSideQuestionCard('question');
  h.api.dismissSideQuestionCard();
  assert.equal(h.messages.querySelector('.side-question-card'), null);
  assert.equal(h.api.state(), null);
  assert.equal(h.api.settleSideQuestionCard(seq, { answer: 'too late' }), false, 'dismissed cards must not accept late answers');

  const second = h.api.showSideQuestionCard('session-bound question');
  assert.ok(h.messages.querySelector('.side-question-card'));
  h.settings.sessionId = 'session-B';
  h.api.renderSideQuestionCard();
  assert.equal(h.messages.querySelector('.side-question-card'), null, 'the card belongs to the session it was asked in');
  assert.equal(h.api.settleSideQuestionCard(second, { answer: 'wrong session' }), false);
});

test('/btw rides the native side-question flow over the dashboard socket (REST fallback kept)', () => {
  assert.match(sidepanelSource, /const seq = showSideQuestionCard\(userInput\);/);
  assert.match(sidepanelSource, /void runSideQuestion\(userInput, seq\);/);
  assert.doesNotMatch(sidepanelSource, /showOperationToast\(\{ title: 'Side question \(\/btw\)', detail: userInput \}\)/);
  assert.doesNotMatch(sidepanelSource, /throw new Error\('Hermes returned no answer/);

  // Native transport: prompt.btw -> btw.complete with a task-scoped listener and a timeout.
  assert.match(sidepanelSource, /connection\.client\.request\(WS_METHODS\.promptBtw, \{ session_id: sessionId, text: question \}\)/);
  assert.match(sidepanelSource, /connection\.client\.on\('btw\.complete', \(event\) => \{/);
  assert.match(sidepanelSource, /String\(payload\.task_id\) !== taskId/);
  assert.match(sidepanelSource, /\}, 120000\);/);
  assert.match(sidepanelSource, /if \(outcome !== 'unavailable'\) return;/);

  // REST fallback accepts every answer shape the gateway can produce.
  for (const shape of ['choices', 'output_text', 'output']) {
    assert.match(sidepanelSource, new RegExp(shape));
  }

  assert.match(sidepanelSource, /renderCompletionPendingRow\(\);\r?\n\s*renderSideQuestionCard\(\);/);
  assert.match(sidepanelSource, /function renderSideQuestionCard\(\)/);
});

test('/btw card styling spans the transcript with an unbounded close control', () => {
  assert.match(css, /\.side-question-card \{/);
  assert.match(css, /\.side-question-card::before \{/);
  assert.match(css, /\.side-question-card\.warn \{/);
  assert.match(css, /\.side-question-card\.pending \.side-question-answer \{/);
  assert.match(css, /\.side-question-meta \{/);
  assert.match(css, /\.side-question-answer::-webkit-scrollbar \{/);
  assert.match(css, /\.side-question-answer::-webkit-scrollbar-thumb \{/);

  const cardBlock = css.slice(css.indexOf('.side-question-card {'), css.indexOf('.side-question-actions {'));
  assert.match(cardBlock, /width: 100%;/);
  assert.match(cardBlock, /\.side-question-close \{[^}]*border: none;/s, 'the close X must not sit in a square box');
  assert.match(cardBlock, /max-height: 44vh;/);
});
