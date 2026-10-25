// Shared message rail: the thread controller and action modules give every
// user message and reply a copy action and a truthful time. The side panel
// wires the clean-clipboard payload through the same shared modules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

const sidepanel = read('extension/sidepanel.js');
const threadUi = read('extension/lib/message-thread-ui.mjs');
const actions = read('extension/lib/message-actions.mjs');

test('shared rails carry copy and time on user messages and replies', () => {
  assert.match(threadUi, /buildMessageRail/);
  // Every user message and reply shows its time; a reply only once it has
  // finished streaming.
  assert.match(threadUi, /showTime:\s*!streaming\b/);
  assert.match(actions, /message-action-copy/);
  assert.match(sidepanel, /buildCleanClipboardPayload/);
});
