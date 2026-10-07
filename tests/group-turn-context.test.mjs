import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBotBrowserContext } from '../extension/lib/bot-browser-bridge.mjs';
import { formatGroupTurnWithBrowserContext } from '../extension/lib/group-turn-context.mjs';

const GROUP_PROMPT = [
  '[Group chat: "Core Team"] You are @alpha, one participant in a group chat with @beta and the user.',
  '',
  'New messages in the room since your last turn (oldest first):',
  '  You: check the current offer',
  '',
  'Rules for this room:',
  '- Reply with ONE conversational message.',
].join('\n');

function enabledContext(overrides = {}) {
  return resolveBotBrowserContext({
    scopeMode: 'follow-active',
    activeTab: { id: 101, url: 'https://github.com/NousResearch/hermes-agent', title: 'NousResearch/hermes-agent' },
    pageContext: { text: 'Hermes Agent is an open-source agent framework.', meta: { description: 'Agent framework' } },
    ...overrides,
  });
}

test('formatGroupTurnWithBrowserContext leaves the base prompt byte-identical when context is disabled', () => {
  assert.equal(formatGroupTurnWithBrowserContext(GROUP_PROMPT, { enabled: false }), GROUP_PROMPT);
  assert.equal(formatGroupTurnWithBrowserContext(GROUP_PROMPT, null), GROUP_PROMPT);
  assert.equal(formatGroupTurnWithBrowserContext(GROUP_PROMPT, undefined), GROUP_PROMPT);
});

test('formatGroupTurnWithBrowserContext emits a full BCP v2 turn envelope so plugin hooks can parse it', () => {
  const context = enabledContext();
  const formatted = formatGroupTurnWithBrowserContext(GROUP_PROMPT, context);

  assert.notEqual(formatted, GROUP_PROMPT, 'enabled context changes the prompt');
  const parsed = JSON.parse(formatted);
  assert.equal(parsed.protocol, 'hermes.browser.turn.v2');
  assert.equal(parsed.source_receipt.version, 2);
  assert.equal(parsed.browser_context.delivery, 'full');
  assert.equal(parsed.browser_context.payload.activeTab.url, 'https://github.com/NousResearch/hermes-agent');
  assert.match(parsed.browser_context.payload.pageContext.text, /open-source agent framework/);
  assert.equal(parsed.human_input.text, GROUP_PROMPT, 'the whole group prompt is the human input, unchanged');
});

test('formatGroupTurnWithBrowserContext never emits a hand-rolled untrusted block', () => {
  const formatted = formatGroupTurnWithBrowserContext(GROUP_PROMPT, enabledContext());
  assert.equal(formatted.includes('[Active Browser Tab Context]'), false);
  assert.equal(formatted.includes('=== '), false);
  assert.doesNotThrow(() => JSON.parse(formatted));
});

test('formatGroupTurnWithBrowserContext redacts secrets and bounds the page text through the BCP budgets', () => {
  const context = enabledContext({
    pageContext: { text: `secret sk-abcdefghijklmnopqrstuvwx ${'y'.repeat(40_000)}` },
    settings: { contextDepth: 'minimal' },
  });
  const parsed = JSON.parse(formatGroupTurnWithBrowserContext(GROUP_PROMPT, context));
  const pageText = parsed.browser_context.payload.pageContext.text;
  assert.equal(pageText.includes('sk-abcdefghijklmnopqrstuvwx'), false);
  assert.match(pageText, /\[REDACTED_SECRET\]/);
});
test('a long group prompt keeps its header, newest messages and rules instead of losing its tail', () => {
  const history = Array.from({ length: 16 }, (_, index) => `  You: message ${index} ${'filler '.repeat(120)}`).join('\n');
  const prompt = [
    '[Group chat: "Core Team"] You are @alpha, one participant in a group chat with @beta and the user.',
    '',
    'New messages in the room since your last turn (oldest first):',
    history,
    '  You: @alpha can you see my screen now?',
    '',
    'Rules for this room:',
    '- IMPORTANT: The user explicitly called @alpha in this turn.',
  ].join('\n');
  assert.ok(prompt.length > 9_000);
  const parsed = JSON.parse(formatGroupTurnWithBrowserContext(prompt, enabledContext()));
  const kept = parsed.human_input.text;
  assert.ok(kept.length <= 6_000);
  assert.match(kept, /^\[Group chat: "Core Team"\] You are @alpha/);
  assert.match(kept, /can you see my screen now\?/);
  assert.match(kept, /The user explicitly called @alpha/);
  assert.equal(parsed.source_receipt.truncation.sources.human_input, undefined, 'the envelope itself cuts nothing');
});

test('a short group prompt is passed through unchanged', () => {
  const parsed = JSON.parse(formatGroupTurnWithBrowserContext(GROUP_PROMPT, enabledContext()));
  assert.equal(parsed.human_input.text, GROUP_PROMPT);
});
