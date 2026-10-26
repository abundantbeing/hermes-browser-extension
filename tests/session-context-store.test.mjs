// Tests for extension/lib/session-context-store.mjs. Fixtures follow the real
// gateway shapes: agent/context_breakdown.py::compute_session_context_breakdown
// (session.context_breakdown) and tui_gateway/server.py::_get_usage
// (session.usage RPC result and the pushed { usage } event payload).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_CONTEXT_MAX_SESSIONS,
  emptySessionContextStore,
  markContextBreakdownStale,
  parseContextBreakdown,
  parseContextUsage,
  pruneSessionContextStore,
  recordContextBreakdown,
  recordContextUsage,
  renameSessionContextEntry,
  restoreSessionContextStore,
  sessionContextEntry,
} from '../extension/lib/session-context-store.mjs';

const breakdownA = {
  categories: [
    { color: 'var(--context-usage-system)', id: 'system_prompt', label: 'System prompt', tokens: 16_200 },
    { color: 'var(--context-usage-tools)', id: 'tool_definitions', label: 'Tool definitions', tokens: 19_100 },
    { color: 'var(--context-usage-subagents)', id: 'subagent_definitions', label: 'Subagent definitions', tokens: 1_200 },
    { color: 'var(--context-usage-memory)', id: 'memory', label: 'Memory', tokens: 1_100 },
    { color: 'var(--context-usage-conversation)', id: 'conversation', label: 'Conversation', tokens: 164_000 },
  ],
  context_max: 500_000,
  context_percent: 39,
  context_used: 194_000,
  context_source: 'provider_usage_plus_estimate',
  context_estimated: true,
  estimated_total: 201_600,
  model: 'gpt-5.5',
  context_files: [{ label: 'AGENTS.md', path: '/repo/AGENTS.md', est_tokens: 2_100, status: 'loaded' }],
};

const usageTick = {
  usage: {
    model: 'gpt-5.5', input: 900_000, output: 12_000, reasoning: 0, prompt: 900_000, completion: 12_000,
    total: 912_000, calls: 14, context_used: 196_500, context_max: 500_000, context_percent: 39,
    context_source: 'provider_usage', context_estimated: false, compressions: 0, cache_hit_pct: 92,
  },
};

test('a breakdown keeps category ids, labels and tokens and refuses the zeroed agent-is-None answer', () => {
  const parsed = parseContextBreakdown(breakdownA);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value.categories.map((row) => row.id), ['system_prompt', 'tool_definitions', 'subagent_definitions', 'memory', 'conversation']);
  assert.equal(parsed.value.usedTokens, 194_000);
  assert.equal(parsed.value.limitTokens, 500_000);
  assert.equal(parsed.value.contextFiles[0].tokens, 2_100);
  // The gateway answers this when the session has no live agent to measure.
  const zeroed = { categories: [], context_max: 0, context_percent: 0, context_used: 0, estimated_total: 0, context_estimated: false, context_source: 'provider_usage', model: '' };
  assert.deepEqual(parseContextBreakdown(zeroed), { ok: false, reason: 'zeroed' });
  assert.equal(parseContextBreakdown(null).ok, false);
});

test('a usage snapshot is read from the RPC result and from the event payload alike', () => {
  const fromEvent = parseContextUsage(usageTick);
  const fromRpc = parseContextUsage(usageTick.usage);
  assert.deepEqual(fromEvent, fromRpc);
  assert.equal(fromEvent.value.compressions, 0, 'a real zero compressions survives');
  assert.equal(fromEvent.value.cacheHitPercent, 92);
  assert.deepEqual(parseContextUsage({ usage: { calls: 0, input: 0, output: 0, total: 0 } }), { ok: false, reason: 'no-context-usage' });
});

test('canonical session.stats preserves occupancy, compactions and cache share without using lifetime throughput', () => {
  const parsed = parseContextUsage({ last_prompt_tokens: 147_133, context_tokens: 147_133, context_length: 1_048_576, context_source: 'provider_usage', compression_count: 1, prompt_tokens: 17_192_760, cache_read_tokens: 16_544_008, total_tokens: 17_207_726 });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.usedTokens, 147_133);
  assert.equal(parsed.value.limitTokens, 1_048_576);
  assert.equal(parsed.value.compressions, 1);
  assert.equal(parsed.value.cacheHitPercent, 96);
  assert.equal(parseContextUsage({ prompt_tokens: 1_000_000, input_tokens: 1_000_000, total_tokens: 1_010_000 }).ok, false);
  assert.equal(parseContextUsage({ context_tokens: 0, context_length: 128_000, compression_count: 0 }).value.usedTokens, 0);
});

test('usage ticks never erase the category breakdown', () => {
  let { store } = recordContextBreakdown(emptySessionContextStore(), 'stored-A', breakdownA, 1_000);
  ({ store } = recordContextUsage(store, 'stored-A', usageTick, 2_000));
  const entry = sessionContextEntry(store, 'stored-A');
  assert.equal(entry.breakdown.categories.length, 5);
  assert.equal(entry.usage.usedTokens, 196_500);
  assert.equal(entry.usage.occupancyAt, 2_000);
});

test('each session keeps its own context: switching A to B and back shows A as it was left', () => {
  let { store } = recordContextBreakdown(emptySessionContextStore(), 'stored-A', breakdownA, 1_000);
  ({ store } = recordContextUsage(store, 'stored-B', { usage: { context_used: 12_000, context_max: 272_000, context_percent: 4, compressions: 3 } }, 2_000));
  assert.equal(sessionContextEntry(store, 'stored-B').usage.usedTokens, 12_000);
  assert.equal(sessionContextEntry(store, 'stored-B').breakdown, null, 'B never inherits A\'s categories');
  assert.equal(sessionContextEntry(store, 'stored-A').breakdown.usedTokens, 194_000, 'A is untouched by B');
  assert.equal(sessionContextEntry(store, 'stored-C'), null);
});

test('a usage snapshot without a field keeps the previous value, and a new compression marks the breakdown stale', () => {
  let { store } = recordContextBreakdown(emptySessionContextStore(), 'A', breakdownA, 1_000);
  ({ store } = recordContextUsage(store, 'A', usageTick, 2_000));
  ({ store } = recordContextUsage(store, 'A', { usage: { context_used: 60_000, context_max: 500_000 } }, 3_000));
  assert.equal(sessionContextEntry(store, 'A').usage.compressions, 0, 'an omitted count is not reset');
  assert.equal(sessionContextEntry(store, 'A').breakdownStale, false);
  ({ store } = recordContextUsage(store, 'A', { usage: { context_used: 40_000, context_max: 500_000, compressions: 1 } }, 4_000));
  assert.equal(sessionContextEntry(store, 'A').breakdownStale, true);
  ({ store } = recordContextBreakdown(store, 'A', { ...breakdownA, context_used: 41_000 }, 5_000));
  assert.equal(sessionContextEntry(store, 'A').breakdownStale, false, 'a fresh breakdown clears the flag');
  assert.equal(markContextBreakdownStale(store, 'A', 6_000).entries.A.breakdownStale, true);
});

test('the store survives a reload, drops malformed rows and keeps the most recent sessions', () => {
  let { store } = recordContextBreakdown(emptySessionContextStore(), 'A', breakdownA, 1_000);
  ({ store } = recordContextUsage(store, 'A', usageTick, 2_000));
  const restored = restoreSessionContextStore(JSON.parse(JSON.stringify(store)));
  assert.deepEqual(restored, store);
  const dirty = { version: 1, entries: { '': {}, junk: 'x', empty: { breakdown: { limitTokens: 0 } }, A: store.entries.A } };
  assert.deepEqual(Object.keys(restoreSessionContextStore(dirty).entries), ['A']);
  assert.deepEqual(restoreSessionContextStore({ version: 99, entries: store.entries }).entries, {});

  let many = emptySessionContextStore();
  for (let index = 0; index < SESSION_CONTEXT_MAX_SESSIONS + 5; index += 1) {
    ({ store: many } = recordContextUsage(many, `s${index}`, { usage: { context_used: 10, context_max: 100 } }, index + 1));
  }
  const pruned = pruneSessionContextStore(many);
  assert.equal(Object.keys(pruned.entries).length, SESSION_CONTEXT_MAX_SESSIONS);
  assert.ok(!pruned.entries.s0 && pruned.entries[`s${SESSION_CONTEXT_MAX_SESSIONS + 4}`], 'the oldest go first');
});

test('a compaction that rotates the session id carries its entry over', () => {
  const { store } = recordContextUsage(emptySessionContextStore(), 'old', usageTick, 1_000);
  const renamed = renameSessionContextEntry(store, 'old', 'new');
  assert.equal(sessionContextEntry(renamed, 'old'), null);
  assert.equal(sessionContextEntry(renamed, 'new').usage.usedTokens, 196_500);
});
