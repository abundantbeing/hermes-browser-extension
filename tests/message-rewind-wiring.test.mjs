import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const panel = await read('extension/sidepanel.js');
const css = await read('extension/sidepanel.css');

test('panel imports the rewind planner and never invents a truncation ordinal', () => {
  assert.match(panel, /import\s*\{[^}]*truncateSubmitParams[^}]*\}\s*from\s*['"]\.\/lib\/message-rewind\.mjs['"]/);
  for (const name of ['resolveRowIdByDisplayText', 'planEdit', 'planRestore', 'applyRewindLocally', 'rebindSurvivorRowIds', 'bindRowIdsFromHistory']) {
    assert.ok(panel.includes(name), name);
  }
  assert.doesNotMatch(panel, /truncate_before_user_ordinal/);
  assert.doesNotMatch(panel, /truncate_before_message_id/);
});

test('the thread UI is wired with rewind actions, not copy alone', () => {
  const factory = panel.slice(panel.indexOf('function messageThreadUi()'), panel.indexOf('async function copyMessageRecord('));
  assert.match(factory, /canRewind:\s*\(record\)\s*=>\s*canRewindMessage\(record\)/);
  assert.match(factory, /onEdit:\s*\(row, record\)\s*=>\s*beginEditMessage\(row, record\)/);
  assert.match(factory, /onRestore:\s*\(row, record, anchor\)\s*=>\s*confirmRestoreMessage\(row, record, anchor\)/);
});

test('canRewindMessage is gated on the dashboard WS transport and an idle turn', () => {
  const fn = panel.slice(panel.indexOf('function canRewindMessage('), panel.indexOf('function beginEditMessage('));
  assert.match(fn, /record\.role !== 'user'/);
  assert.match(fn, /if \(sending\) return false/);
  assert.doesNotMatch(fn, /usesDashboardWsChatTransport()/, "offered on every idle 1:1 user turn; submitRewind fails closed");
  assert.match(fn, /activeGroupProjection/);
});

test('the inline editor sends on Enter, keeps Shift+Enter as a newline, and cancels on Esc', () => {
  const fn = panel.slice(panel.indexOf('function beginEditMessage('), panel.indexOf('let restorePopoverState'));
  assert.match(fn, /className = 'message-editor'/);
  assert.match(fn, /className = 'message-editor-input'/);
  assert.match(fn, /message-editor-cancel/);
  assert.match(fn, /message-editor-send/);
  assert.match(fn, /event\.key === 'Enter' && !event\.shiftKey && !event\.isComposing/);
  assert.match(fn, /event\.key === 'Escape'/);
  assert.match(fn, /planEdit\(messages, index, text\)/);
});

test('the restore popover cancels on Escape and outside click and traps focus', () => {
  const fn = panel.slice(panel.indexOf('function confirmRestoreMessage('), panel.indexOf('async function submitRewind('));
  assert.match(fn, /message-restore-popover/);
  assert.match(fn, /Rerun from here\? Messages after this will be removed\./);
  assert.match(fn, /message-restore-cancel/);
  assert.match(fn, /message-restore-confirm/);
  assert.match(fn, /event\.key === 'Escape'/);
  assert.match(fn, /document\.addEventListener\('click', state\.onDocumentClick, true\)/);
  assert.match(fn, /event\.key === 'Tab'/);
});

test('submitRewind fails closed to a new message when no row id can be resolved', () => {
  const fn = panel.slice(panel.indexOf('async function submitRewind('), panel.indexOf('function addMessage('));
  assert.match(fn, /resolveRowIdByDisplayText\(history, messageDisplayText\('user', plan\.sourceText\)/);
  assert.match(fn, /displayText: messageDisplayText/);
  assert.match(fn, /could not be matched to the saved conversation/);
  // Snapshot and rollback on any pre-acceptance failure.
  assert.match(fn, /const snapshot = messages\.slice\(\)/);
  assert.match(fn, /if \(!accepted\) \{/);
  assert.match(fn, /Edit failed\. Your conversation was not changed\./);
  assert.match(fn, /reuseUserRecord: true/);
  assert.match(fn, /truncate: \{ rowId \}/);
  assert.match(fn, /rebindSurvivorRowIds\(messages, submitResponse\)/);
});

test('the prompt.submit request spreads the row-id-only truncation params', () => {
  const at = panel.indexOf('const submitParams = () => ({');
  const submit = panel.slice(at, at + 400);
  assert.match(submit, /truncateSubmitParams\(\{ rowId: truncate\?\.rowId \}\)/);
  assert.match(panel, /truncate = null, onSubmitResponse = null \} = \{\}\)/);
});

test('askHermes reuses the standing user record on a rewind and never adds a second bubble', () => {
  assert.match(panel, /if \(turnOptions\.reuseUserRecord\)/);
  assert.match(panel, /truncate: turnOptions\.truncate \|\| null/);
  // The submit response still reaches the caller's hook; the panel also reads the run's execution
  // generation from it first (tests/stop-generation-fence.test.mjs).
  assert.match(panel, /onSubmitResponse: \(response\) => \{[\s\S]{0,500}turnOptions\.onSubmitResponse\?\.\(response\);/);
});

test('post-turn history refresh binds durable row ids by display text', () => {
  const commit = panel.slice(panel.indexOf('async function commitFetchedSessionMessages('), panel.indexOf('let completionRevealSequence'));
  assert.match(commit, /bindRowIdsFromHistory\(messages, incoming, \{ displayText: messageDisplayText \}\)/);
});

test('CSS hides rewind actions while a turn runs and styles the restore popover', () => {
  assert.match(css, /body\.turn-running \.message-action-edit/);
  assert.match(css, /body\.turn-running \.message-action-restore/);
  assert.match(css, /\.message-restore-popover/);
  assert.match(css, /\.message-editor-input/);
});
test('restore replays the display text, not the stored protocol envelope', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(src, /if \(mode === 'restore'\) plan\.text = messageDisplayText\('user', plan\.sourceText\);/);
});

import { messageDisplayText as displayText, isSteerMessage, steerMessageText } from '../extension/lib/common.mjs';

const TURN = (text, ctx = { delivery: 'reference', context_hash: 'abc' }) => JSON.stringify({
  protocol: 'hermes.browser.turn.v2',
  human_input: { source: 'composer', text },
  browser_context: ctx,
  attachment_context: { items: [] },
  source_receipt: { protocol: 'hermes.browser.turn.v2', version: 2 },
});
const MARKER = (text) => `[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]\n${text}\n[/OUT-OF-BAND USER MESSAGE]`;

test('display text unwraps an envelope that an earlier replay wrapped again', () => {
  const once = TURN('fire, works');
  const twice = TURN(once);
  const thrice = TURN(twice);
  assert.equal(displayText('user', once), 'fire, works');
  assert.equal(displayText('user', twice), 'fire, works');
  assert.equal(displayText('user', thrice), 'fire, works');
  assert.equal(displayText('user', 'a pasted {"protocol":1} snippet'), 'a pasted {"protocol":1} snippet');
  assert.equal(displayText('assistant', twice), twice);
});

test('steer marker is unwrapped to the typed words and recognised as a steer', () => {
  const row = { role: 'user', content: MARKER('stop digging, just letting you know') };
  assert.equal(steerMessageText(row.content), 'stop digging, just letting you know');
  assert.equal(displayText('user', row.content), 'stop digging, just letting you know');
  assert.equal(isSteerMessage(row), true);
  assert.equal(isSteerMessage({ role: 'user', content: 'hi', display_kind: 'steer' }), true);
  assert.equal(isSteerMessage({ role: 'user', content: 'hello there' }), false);
  assert.equal(isSteerMessage({ role: 'assistant', content: MARKER('x') }), false);
  assert.equal(steerMessageText('text [OUT-OF-BAND USER MESSAGE] inline mention'), null);
});

test('restore of a wrapped row replays only the typed message', () => {
  const stored = TURN(TURN('ok it works'));
  assert.equal(displayText('user', stored), 'ok it works');
});
