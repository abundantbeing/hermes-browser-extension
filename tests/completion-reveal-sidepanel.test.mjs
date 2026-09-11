import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as revealHelpers from '../extension/lib/completion-reveal.mjs';

const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
globalThis.__revealHelpers = revealHelpers;

function buildHarness({ previousMessages, reply, commitResult = true, hidden = false, transientRow = false }) {
  const start = sidepanelSource.indexOf('let completionRevealSequence = 0;');
  const end = sidepanelSource.indexOf('\nasync function loadSessionMessages', start);
  assert.ok(start >= 0 && end > start, 'reveal source block must exist in sidepanel.js');
  const slice = sidepanelSource.slice(start, end);

  const dom = new JSDOM('<!doctype html><html><body><div id="messages"></div></body></html>');
  const { document } = dom.window;
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  const container = document.getElementById('messages');

  const commits = [];
  const paints = [];
  const frames = [];
  let fakeNow = 0;
  let committedNodes = [];

  // Execute the real reveal source in an isolated scope with stubbed primitives.
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'document', 'els', 'performance', 'requestAnimationFrame', 'messages',
    'commitFetchedSessionMessages', 'createStreamingMessageUpdater', 'setMessageContent',
    'messageDisplayText', 'sending', `
    const { completionRevealPlan, newestAssistantReply, revealSlice, trailingNewMessages } = globalThis.__revealHelpers;
    ${slice}
    return { commitFetchedSessionMessagesWithReveal, revealCompletionReply };
  `,
  );

  const api = factory(
    document,
    { messages: container },
    { now: () => fakeNow },
    (fn) => { frames.push(fn); return frames.length; },
    previousMessages,
    async () => {
      commits.push(true);
      if (!commitResult) return false;
      container.replaceChildren();
      const node = document.createElement('article');
      node.className = 'message assistant';
      const content = document.createElement('div');
      content.className = 'message-content';
      node.append(content);
      container.append(node);
      committedNodes = [node];
      if (transientRow) {
        const transient = document.createElement('article');
        transient.className = 'message assistant completion-pending-row';
        const transientContent = document.createElement('div');
        transientContent.className = 'message-content';
        transient.append(transientContent);
        container.append(transient);
        committedNodes = [node, transient];
      }
      return true;
    },
    () => ({
      updateText: (text) => paints.push({ kind: 'update', text }),
      flush: (text) => paints.push({ kind: 'flush', text }),
    }),
    (node, text) => { node.querySelector('.message-content').textContent = text; paints.push({ kind: 'paint', text }); },
    (_role, value) => value,
    false,
  );
  return { api, dom, container, paints, frames, commits, advance: (ms) => { fakeNow += ms; return frames.shift(); }, now: () => fakeNow, committedNodes: () => committedNodes };
}

const PREVIOUS = [
  { role: 'user', content: 'task' },
  { role: 'assistant', content: 'dispatched sa-0, sa-1' },
];
const INCOMING = [
  ...PREVIOUS,
  { role: 'user', content: '[ASYNC DELEGATION COMPLETE — deleg_xyz12345]' },
  { role: 'assistant', content: 'Both jobs are done.'.repeat(5) },
];

test('sidepanel reveal: new trailing reply is committed then revealed progressively', async () => {
  const h = buildHarness({ previousMessages: PREVIOUS, reply: INCOMING[3].content });
  await h.api.commitFetchedSessionMessagesWithReveal({ messages: INCOMING }, {});
  assert.equal(h.commits.length, 1, 'commit runs first');
  const nodes = h.container.querySelectorAll('.message.assistant');
  assert.equal(nodes.length, 1);
  // Initial synchronous paint is a strict prefix of the reply, not the full text.
  const initial = nodes[0].querySelector('.message-content').textContent;
  assert.ok(initial.length > 0, 'reveal starts immediately');
  assert.ok(initial.length < INCOMING[3].content.length, 'initial paint is partial');
  assert.ok(INCOMING[3].content.startsWith(initial), 'initial paint is a true prefix');
  // Drive frames to completion.
  let guard = 0;
  while (h.frames.length && guard < 1000) {
    const fn = h.advance(300);
    guard += 1;
    if (fn) fn(h.now());
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const flushed = h.paints.filter((p) => p.kind === 'flush').at(-1);
  assert.equal(flushed.text, INCOMING[3].content, 'reveal ends with the full reply');
  const lengths = h.paints.filter((p) => p.kind === 'update' || p.kind === 'paint').map((p) => p.text.length);
  for (let i = 1; i < lengths.length; i += 1) assert.ok(lengths[i] >= lengths[i - 1], 'text only grows');
});

test('sidepanel reveal: old replies already on screen never re-animate', async () => {
  const h = buildHarness({ previousMessages: INCOMING, reply: '' });
  await h.api.commitFetchedSessionMessagesWithReveal({ messages: INCOMING }, {});
  assert.equal(h.commits.length, 1);
  assert.equal(h.paints.filter((p) => p.kind === 'paint').length, 0, 'no reveal paints');
  assert.equal(h.frames.length, 0, 'no animation scheduled');
});

test('sidepanel reveal: failed commit or hidden tab skips animation', async () => {
  const failed = buildHarness({ previousMessages: PREVIOUS, reply: INCOMING[3].content, commitResult: false });
  await failed.api.commitFetchedSessionMessagesWithReveal({ messages: INCOMING }, {});
  assert.equal(failed.frames.length, 0);
  const hidden = buildHarness({ previousMessages: PREVIOUS, reply: INCOMING[3].content, hidden: true });
  await hidden.api.commitFetchedSessionMessagesWithReveal({ messages: INCOMING }, {});
  assert.equal(hidden.paints.length, 0, 'hidden document renders instantly');
});

test('sidepanel reveal: the completion thinking row never steals the reveal target', async () => {
  // Regression: the settle poll appends a .completion-pending-row (assistant
  // styling) AFTER the committed reply. The reveal must animate the real reply,
  // never the transient row, or the reply pops and the transient "types".
  const h = buildHarness({ previousMessages: PREVIOUS, reply: INCOMING[3].content, transientRow: true });
  await h.api.commitFetchedSessionMessagesWithReveal({ messages: INCOMING }, {});
  const [replyNode, transient] = h.committedNodes();
  const initial = replyNode.querySelector('.message-content').textContent;
  assert.ok(initial.length > 0, 'the reply reveal starts immediately');
  assert.ok(initial.length < INCOMING[3].content.length, 'the reply starts as a partial prefix, not the full text');
  assert.ok(INCOMING[3].content.startsWith(initial), 'the reply prefix is a true prefix');
  assert.equal(transient.querySelector('.message-content').textContent, '', 'the transient row must never be painted by the reveal');
  assert.ok(h.frames.length > 0, 'animation frames are scheduled against the reply node');
});
