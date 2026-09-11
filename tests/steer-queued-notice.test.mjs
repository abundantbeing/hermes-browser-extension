import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

const THINKING_PLACEHOLDER = 'Hermes is thinking...';

function buildHarness() {
  const start = sidepanelSource.indexOf('// Steer feedback belongs in the transcript');
  const end = sidepanelSource.indexOf('\nfunction queueCurrentDraft', start);
  assert.ok(start >= 0 && end > start, 'steer/completion row source block must exist in sidepanel.js');
  const slice = sidepanelSource.slice(start, end);

  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="messages"></div>
    <template id="messageTemplate"><article class="message"><div class="message-role"></div><div class="message-content"></div></article></template>
  </body></html>`);
  const { document } = dom.window;
  const messages = document.getElementById('messages');
  const template = document.getElementById('messageTemplate');

  const run = (overrides = {}) => {
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      'document', 'els', 'pendingSteerText', 'sending', 'completionSettlePending',
      'translateUiText', 'messageDisplayText', 'renderMessageContentElement',
      'scrollMessageStreamToBottom', 'assistantMessageRoleLabel', 'THINKING_PLACEHOLDER',
      `${slice}\nreturn { renderSteerNotice, renderCompletionPendingRow };`,
    );
    const api = factory(
      document,
      { messages, template },
      overrides.pendingSteerText ?? '',
      overrides.sending ?? false,
      overrides.completionSettlePending ?? false,
      (text) => text,
      (role, content) => content,
      (element, content) => { element.textContent = content; },
      () => {},
      () => 'Hermes',
      THINKING_PLACEHOLDER,
    );
    api.renderSteerNotice();
    api.renderCompletionPendingRow();
    return api;
  };

  return { messages, run };
}

test('queued steer renders as a dashed user row pinned at the end of the transcript', () => {
  const harness = buildHarness();
  harness.messages.innerHTML = '<article class="message assistant"></article><article class="message user"></article>';
  harness.run({ pendingSteerText: 'tighten the second paragraph', sending: true });

  const row = harness.messages.querySelector('.steer-pending-row');
  assert.ok(row, 'a .steer-pending-row must appear while a steer is queued');
  assert.ok(row.classList.contains('user'));
  assert.equal(row.querySelector('.message-role').textContent, 'Steer queued · arrives after the next tool call');
  assert.equal(row.querySelector('.message-content').textContent, 'tighten the second paragraph');
  assert.equal(harness.messages.lastElementChild, row, 'the queued row stays directly under the live turn');

  // Idempotent: repeated renders never duplicate the row.
  harness.run({ pendingSteerText: 'tighten the second paragraph', sending: true });
  assert.equal(harness.messages.querySelectorAll('.steer-pending-row').length, 1);
});

test('queued steer row clears when the turn settles or the steer is rejected', () => {
  const harness = buildHarness();
  harness.run({ pendingSteerText: 'keep going', sending: true });
  assert.ok(harness.messages.querySelector('.steer-pending-row'));

  // Turn settled: sending flips false.
  harness.run({ sending: false });
  assert.equal(harness.messages.querySelector('.steer-pending-row'), null);

  // Steer rejected: pending text is cleared, composer draft restored separately.
  harness.run({ pendingSteerText: 'keep going', sending: true });
  assert.ok(harness.messages.querySelector('.steer-pending-row'));
  harness.run({ pendingSteerText: '', sending: true });
  assert.equal(harness.messages.querySelector('.steer-pending-row'), null);
});

test('queued steer row survives transcript re-renders and follows text edits', () => {
  const harness = buildHarness();
  harness.run({ pendingSteerText: 'first draft of the steer', sending: true });

  // A history commit wipes the container; the sync must rebuild the row.
  harness.messages.innerHTML = '<article class="message assistant"></article>';
  harness.run({ pendingSteerText: 'first draft of the steer', sending: true });
  assert.equal(harness.messages.querySelectorAll('.steer-pending-row').length, 1);

  // The queued text is updated in place when it changes.
  harness.run({ pendingSteerText: 'edited steer text', sending: true });
  const row = harness.messages.querySelector('.steer-pending-row');
  assert.equal(row.querySelector('.message-content').textContent, 'edited steer text');
  assert.equal(harness.messages.querySelectorAll('.steer-pending-row').length, 1);
});

test('completion wait keeps a live thinking row in the transcript until the reply lands', () => {
  const harness = buildHarness();
  harness.run({ completionSettlePending: true });

  const row = harness.messages.querySelector('.completion-pending-row');
  assert.ok(row, 'a .completion-pending-row must hold the transcript while the completion turn generates');
  assert.ok(row.classList.contains('assistant'));
  assert.equal(row.querySelector('.message-role').textContent, 'Hermes');
  assert.equal(row.querySelector('.message-content').textContent, THINKING_PLACEHOLDER);
  assert.equal(harness.messages.lastElementChild, row);

  harness.run({ completionSettlePending: false });
  assert.equal(harness.messages.querySelector('.completion-pending-row'), null);
});

test('steer and completion transients are wired into render loops and the commit path', () => {
  // Composer busy-state sync and message re-render both keep the rows alive.
  assert.match(sidepanelSource, /renderQueueNotice\(\);\r?\n\s*renderSteerNotice\(\);\r?\n\s*renderCompletionPendingRow\(\);/);
  assert.match(sidepanelSource, /renderActiveProfileIndicator\(\);\r?\n\s*renderSteerNotice\(\);\r?\n\s*renderCompletionPendingRow\(\);/);
  // Completion row brackets the settle polling window.
  assert.match(
    sidepanelSource,
    /completionSettlePending = true;\r?\n\s*renderCompletionPendingRow\(\);[\s\S]{0,3200}finally \{\r?\n\s*completionSettlePending = false;\r?\n\s*renderCompletionPendingRow\(\);/,
  );
  // A steered message that reached history clears its queued row.
  assert.match(sidepanelSource, /pendingSteerText && messages\.some\(\(message\) => message\?\.role === 'user' && String\(message\.content \|\| ''\)\.includes\(pendingSteerText\)\)/);

  // The old composer-dock notice is gone; the rows live in the transcript.
  assert.doesNotMatch(html, /id="steerNotice"/);
  assert.doesNotMatch(css, /\.steer-notice \{/);
  assert.match(css, /\.message\.steer-pending-row \{/);
  assert.match(css, /\.message\.steer-pending-row \.message-role \{/);
  assert.match(css, /border-style: dashed;/);
});

test('dashboard steer consumes the session.steer status instead of ignoring it', () => {
  assert.match(sidepanelSource, /const result = await connection\.client\.request\(WS_METHODS\.sessionSteer, \{ session_id: sessionId, text: steerText \}\)/);
  assert.match(sidepanelSource, /result\.status === 'rejected'/);
  assert.doesNotMatch(sidepanelSource, /Steer queued as next turn/);
});
