import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptyTurnReasoning,
  formatTurnDuration,
  isReasoningPseudoTool,
  providerWaitText,
  reduceTurnReasoning,
  replyTextAfterCommentary,
  storedTurnSummaries,
  turnReasoningFromRestEvent,
  turnReasoningFromSocketEvent,
} from '../extension/lib/turn-activity.mjs';
import { mergeToolCallActivity } from '../extension/lib/tool-call-group.mjs';

const fold = (updates) => updates.reduce(reduceTurnReasoning, emptyTurnReasoning()).text;

test('the REST "_thinking" progress row is reasoning, not a tool', () => {
  assert.equal(isReasoningPseudoTool('_thinking'), true);
  assert.deepEqual(
    turnReasoningFromRestEvent('tool.progress', { tool_name: '_thinking', delta: 'Checking the docs first.' }),
    { kind: 'available', text: 'Checking the docs first.' },
  );
  assert.equal(turnReasoningFromRestEvent('tool.progress', { tool_name: 'web_search', preview: 'q' }), null);
  assert.deepEqual(
    turnReasoningFromRestEvent('assistant.commentary', { text: 'Let me look.', already_streamed: true }),
    { kind: 'commentary', text: 'Let me look.', alreadyStreamed: true },
  );
});

test('a "_thinking" row never adds to the tool count', () => {
  let calls = [];
  for (let step = 0; step < 12; step += 1) {
    calls = mergeToolCallActivity(calls, { rawName: '_thinking', status: 'progress', preview: `step ${step}` });
  }
  calls = mergeToolCallActivity(calls, { rawName: 'web_search', activityId: 'call_1', status: 'progress' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].rawName, 'web_search');
});

test('socket frames map to reasoning updates; spinner text does not', () => {
  assert.deepEqual(turnReasoningFromSocketEvent('reasoning.delta', { text: 'Hm' }), { kind: 'delta', text: 'Hm' });
  assert.deepEqual(turnReasoningFromSocketEvent('reasoning.available', { text: 'Block' }), { kind: 'available', text: 'Block' });
  assert.deepEqual(
    turnReasoningFromSocketEvent('message.interim', { text: 'Note', already_streamed: false }),
    { kind: 'commentary', text: 'Note', alreadyStreamed: false },
  );
  assert.equal(turnReasoningFromSocketEvent('thinking.delta', { text: '(o_o) pondering' }), null);
});

test('streamed deltas build one paragraph per step and tools split steps', () => {
  const text = fold([
    { kind: 'delta', text: 'The user wants ' },
    { kind: 'delta', text: 'the release date.' },
    { kind: 'boundary' },
    { kind: 'delta', text: 'Found it in the changelog.' },
  ]);
  assert.equal(text, 'The user wants the release date.\n\nFound it in the changelog.');
});

test('a block the deltas already showed is not repeated', () => {
  const streamed = 'The user wants the release date, so I will search the changelog for it.';
  const text = fold([
    { kind: 'delta', text: streamed },
    { kind: 'available', text: streamed.slice(0, 40) },
  ]);
  assert.equal(text, streamed);
});

test('REST blocks and notes each become their own paragraph', () => {
  const text = fold([
    { kind: 'available', text: 'First I need the page title.' },
    { kind: 'commentary', text: 'Opening the page now.' },
    { kind: 'available', text: 'The title is in the header.' },
    { kind: 'available', text: '   ' },
  ]);
  assert.equal(text, 'First I need the page title.\n\nOpening the page now.\n\nThe title is in the header.');
});

test('very long reasoning keeps its newest part', () => {
  const text = fold([{ kind: 'delta', text: 'x'.repeat(25_000) }]);
  assert.equal(text.length, 20_001);
  assert.ok(text.startsWith('…'));
});

test('a streamed note leaves the reply text, and nothing else is touched', () => {
  assert.equal(replyTextAfterCommentary('Let me check the docs.', 'Let me check the docs.'), '');
  assert.equal(replyTextAfterCommentary('Let me check.\n\nThe answer', 'Let me check.'), 'The answer');
  assert.equal(replyTextAfterCommentary('Unrelated text', 'Let me check.'), null);
  assert.equal(replyTextAfterCommentary('Anything', '  '), null);
});

test('only explained provider waits are surfaced', () => {
  assert.equal(providerWaitText('⏳ still waiting on anthropic (32s)'), '⏳ still waiting on anthropic (32s)');
  assert.equal(providerWaitText('↻ rate limited, retrying in 5s'), '↻ rate limited, retrying in 5s');
  assert.equal(providerWaitText('(◕‿◕) pondering...'), '');
  assert.equal(providerWaitText(''), '');
});

test('turn lengths read short and compact', () => {
  const fixed = { DurationFormat: undefined };
  assert.equal(formatTurnDuration(400, fixed), '<1s');
  assert.equal(formatTurnDuration(14_200, fixed), '14s');
  assert.equal(formatTurnDuration(65_000, fixed), '1m 05s');
  assert.equal(formatTurnDuration(3_720_000, fixed), '1h 02m');
  assert.equal(formatTurnDuration(NaN, fixed), '');
  assert.equal(formatTurnDuration(-5, fixed), '');
  assert.equal(formatTurnDuration(3 * 24 * 60 * 60 * 1000, fixed), '');
});

test('the locale duration format is used where the browser has it', () => {
  class FakeDurationFormat {
    constructor(locale, options) { this.locale = locale; this.options = options; }
    format(parts) { return `${this.locale}:${this.options.style}:${JSON.stringify(parts)}`; }
  }
  assert.equal(
    formatTurnDuration(65_000, { locale: 'ja', DurationFormat: FakeDurationFormat }),
    'ja:narrow:{"minutes":1,"seconds":5}',
  );
});

test('stored turns get their length and reasoning on their last reply', () => {
  const user = { role: 'user', content: 'When is the release?', ts: 1_800_000_000 };
  const toolStep = { role: 'assistant', content: '', reasoning: 'Search the changelog.', ts: 1_800_000_004 };
  const note = { role: 'assistant', content: 'Checking.', ts: 1_800_000_005 };
  const reply = { role: 'assistant', content: 'Tomorrow.', reasoning_content: 'It says Friday.', ts: 1_800_000_014 };
  const second = { role: 'user', content: 'Thanks', ts: 1_800_000_100 };
  const secondReply = { role: 'assistant', content: 'Any time.', ts: null };
  const normalizeTs = (value) => (Number.isFinite(value) ? value * 1000 : null);
  const summaries = storedTurnSummaries([user, toolStep, note, reply, second, secondReply], { normalizeTs });
  assert.deepEqual(summaries.get(reply), { durationMs: 14_000, reasoning: 'Search the changelog.\n\nIt says Friday.' });
  assert.equal(summaries.has(note), false);
  assert.deepEqual(summaries.get(secondReply), { durationMs: null, reasoning: '' });
});
