import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import {
  COMPLETION_REVEAL_MAX_MS,
  COMPLETION_REVEAL_MIN_MS,
  completionRevealPlan,
  newestAssistantReply,
  revealSlice,
  trailingNewMessages,
} from '../extension/lib/completion-reveal.mjs';

test('trailingNewMessages returns only rows appended after the rendered tail', () => {
  const previous = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'dispatched sa-0, sa-1' },
  ];
  const incoming = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'dispatched sa-0, sa-1' },
    { role: 'user', content: '[ASYNC DELEGATION COMPLETE — deleg_abc]' },
    { role: 'assistant', content: 'Both jobs are done.' },
  ];
  assert.deepEqual(trailingNewMessages(previous, incoming), [
    { role: 'user', content: '[ASYNC DELEGATION COMPLETE — deleg_abc]' },
    { role: 'assistant', content: 'Both jobs are done.' },
  ]);
});

test('trailingNewMessages anchors to the LAST matching row for duplicate content', () => {
  const previous = [
    { role: 'user', content: 'echo' },
    { role: 'assistant', content: 'echo' },
  ];
  const incoming = [
    { role: 'user', content: 'echo' },
    { role: 'assistant', content: 'echo' },
    { role: 'assistant', content: 'echo' },
    { role: 'assistant', content: 'new reply' },
  ];
  assert.deepEqual(trailingNewMessages(previous, incoming), [{ role: 'assistant', content: 'new reply' }]);
});

test('trailingNewMessages fails safe without an anchor', () => {
  assert.deepEqual(trailingNewMessages([], [{ role: 'assistant', content: 'x' }]), []);
  assert.deepEqual(trailingNewMessages([{ role: 'user', content: 'gone' }], [{ role: 'assistant', content: 'x' }]), []);
  assert.deepEqual(trailingNewMessages([{ role: 'user', content: 'a' }], []), []);
});

test('newestAssistantReply skips tool rows and empty content', () => {
  assert.equal(newestAssistantReply([
    { role: 'assistant', content: '' },
    { role: 'assistant', content: 'interim', tool_calls: [{ name: 'read_file' }] },
    { role: 'assistant', content: 'Final answer.' },
  ]), 'Final answer.');
  assert.equal(newestAssistantReply([{ role: 'assistant', content: '   ' }]), '');
  assert.equal(newestAssistantReply([]), '');
});

test('completionRevealPlan clamps duration and counts code points', () => {
  const small = completionRevealPlan('ok');
  assert.equal(small.durationMs, COMPLETION_REVEAL_MIN_MS);
  assert.equal(small.initialCount, 1);
  const big = completionRevealPlan('x'.repeat(10_000));
  assert.equal(big.durationMs, COMPLETION_REVEAL_MAX_MS);
  assert.equal(completionRevealPlan('').total, 0);
  assert.equal(completionRevealPlan('').durationMs, 0);
  assert.equal(completionRevealPlan('🙂🙂🙂🙂').total, 4);
});

test('side panel message template satisfies the reveal selectors', () => {
  const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html);
  const template = dom.window.document.querySelector('#messageTemplate');
  assert.ok(template, 'message template must exist');
  const node = template.content.firstElementChild.cloneNode(true);
  node.classList.add('assistant');
  assert.ok(node.matches('.message.assistant'), 'reveal anchors on .message.assistant nodes');
  assert.ok(node.querySelector('.message-content'), 'reveal requires a .message-content slot');
  dom.window.close();
});

test('revealSlice never splits surrogate pairs and clamps', () => {
  const text = 'a🙂b';
  assert.equal(revealSlice(text, 0), '');
  assert.equal(revealSlice(text, 2), 'a🙂');
  assert.equal(revealSlice(text, 99), 'a🙂b');
  assert.equal(revealSlice(text, -3), '');
  assert.equal(revealSlice(text, 1.9), 'a');
});
