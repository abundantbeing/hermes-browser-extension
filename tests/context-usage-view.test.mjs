// Tests for extension/lib/context-usage-view.mjs: the context window card's
// header, bar maths, legend and insights.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildContextUsageView,
  contextBarSegments,
  formatRelativeAge,
  resolveContextOccupancy,
} from '../extension/lib/context-usage-view.mjs';
import { emptySessionContextStore, recordContextBreakdown, recordContextUsage } from '../extension/lib/session-context-store.mjs';

const desktopCard = {
  categories: [
    { id: 'system_prompt', label: 'System prompt', tokens: 16_200 },
    { id: 'tool_definitions', label: 'Tool definitions', tokens: 19_100 },
    { id: 'subagent_definitions', label: 'Subagent definitions', tokens: 1_200 },
    { id: 'memory', label: 'Memory', tokens: 1_100 },
    { id: 'conversation', label: 'Conversation', tokens: 164_000 },
  ],
  context_max: 500_000,
  context_percent: 39,
  context_used: 194_000,
  context_source: 'provider_usage_plus_estimate',
  context_estimated: true,
  estimated_total: 201_600,
};

function entryFrom(...steps) {
  let store = emptySessionContextStore();
  for (const [kind, payload, at] of steps) {
    ({ store } = (kind === 'breakdown' ? recordContextBreakdown : recordContextUsage)(store, 'S', payload, at));
  }
  return store.entries.S;
}

const sum = (rows) => rows.reduce((total, row) => total + row.width, 0);

test('the desktop card reads the same: 194k / 500k Tokens, 39% Full, the five categories', () => {
  const view = buildContextUsageView({
    entry: entryFrom(['breakdown', desktopCard, 1_000], ['usage', { usage: { compressions: 0 } }, 1_000]),
    breakdownSupported: true,
    now: 2_000,
  });
  assert.equal(view.reported, true);
  assert.equal(view.summaryLabel, '~194k / 500k Tokens');
  assert.equal(view.percentLabel, '~39% Full');
  assert.equal(view.compressionsLabel, 'Compressions: 0');
  assert.deepEqual(view.legend.map((row) => [row.label, row.tokensLabel]), [
    ['System prompt', '~16.2k'],
    ['Tool definitions', '~19.1k'],
    ['Subagent definitions', '~1.2k'],
    ['Memory', '~1.1k'],
    ['Conversation', '~164k'],
  ]);
  assert.equal(view.freeLabel, '306k');
  assert.equal(view.level, 'ok');
});

test('window-mode segments split exactly the occupied share in proportion to the estimates', () => {
  const bar = contextBarSegments({ categories: desktopCard.categories, usedTokens: 194_000, limitTokens: 500_000 });
  assert.equal(bar.mode, 'window');
  assert.ok(Math.abs(sum(bar.segments) - 38.8) < 0.01, 'segments add up to used / max');
  assert.ok(Math.abs(sum(bar.segments) + bar.freeWidth - 100) < 0.01, 'segments plus free space fill the bar');
  const conversation = bar.segments.find((row) => row.id === 'conversation');
  assert.ok(Math.abs(conversation.width - (164_000 / 201_600) * 38.8) < 0.01);
});

test('the bar never overflows, and degrades honestly when numbers are missing', () => {
  const over = contextBarSegments({ categories: desktopCard.categories, usedTokens: 600_000, limitTokens: 500_000 });
  assert.ok(Math.abs(sum(over.segments) - 100) < 0.01);
  assert.equal(over.freeWidth, 0);
  const composition = contextBarSegments({ categories: desktopCard.categories, usedTokens: null, limitTokens: null });
  assert.equal(composition.mode, 'composition');
  assert.ok(Math.abs(sum(composition.segments) - 100) < 0.01);
  const unclassified = contextBarSegments({ categories: [], usedTokens: 50_000, limitTokens: 200_000 });
  assert.deepEqual(unclassified.segments.map((row) => [row.id, row.width]), [['in_use', 25]]);
  assert.equal(contextBarSegments({}).mode, 'empty');
  const zeroCategory = contextBarSegments({ categories: [{ id: 'mcp', tokens: 0 }, { id: 'memory', tokens: 10 }], usedTokens: 10, limitTokens: 100 });
  assert.deepEqual(zeroCategory.segments.map((row) => row.id), ['memory'], 'a zero-token category draws nothing');
});

test('header numbers follow the newest reading; the breakdown keeps supplying categories', () => {
  const entry = entryFrom(
    ['breakdown', desktopCard, 1_000],
    ['usage', { usage: { context_used: 250_000, context_max: 500_000, context_percent: 50, context_source: 'provider_usage', context_estimated: false } }, 5_000],
  );
  const occupancy = resolveContextOccupancy(entry);
  assert.equal(occupancy.origin, 'usage');
  const view = buildContextUsageView({ entry, now: 5_000 });
  assert.equal(view.summaryLabel, '250k / 500k Tokens', 'a provider measurement carries no ~');
  assert.equal(view.legend.length, 5);
  assert.ok(Math.abs(sum(view.bar.segments) - 50) < 0.01);
});

test('with no gateway reading the panel estimate fills in and is labelled as such', () => {
  const view = buildContextUsageView({ entry: null, local: { usedTokens: 3_400, limitTokens: 128_000 }, breakdownSupported: false });
  assert.equal(view.reported, false);
  assert.equal(view.sourceLabel, 'Panel estimate');
  assert.equal(view.summaryLabel, '~3.4k / 128k Tokens');
  assert.equal(view.compressionsLabel, '', 'an unreported count is not shown as zero');
  assert.equal(view.breakdownState, 'unsupported');
  assert.ok(view.insights.some((row) => row.text === 'This connection has no Hermes session socket, so the category breakdown cannot be read.'));
});

test('levels and insights: 80% and 95% marks, the auto-compact point, the dominant category, estimate drift', () => {
  const at = (used) => buildContextUsageView({
    entry: entryFrom(['breakdown', { ...desktopCard, context_used: used, context_percent: Math.round(used / 5_000) }, 1_000]),
    autoCompact: { percent: 85, tokens: 425_000 },
    breakdownSupported: true,
    now: 1_000,
  });
  const ok = at(194_000);
  assert.equal(ok.level, 'ok');
  assert.ok(ok.insights.some((row) => row.id === 'auto-compact' && row.text === 'Auto-compacts at 85%, 231k to go.'));
  assert.ok(ok.insights.some((row) => row.id === 'dominant' && row.text === 'Conversation is 81% of what is loaded.'));
  assert.equal(ok.autoCompactMarker, 85);
  assert.equal(at(400_000).level, 'warn');
  assert.equal(at(400_000).insights[0].text, 'Above 80% full.');
  const due = at(430_000);
  assert.ok(due.insights.some((row) => row.id === 'auto-compact' && row.tone === 'warn'));
  assert.equal(at(480_000).level, 'full');
  assert.equal(at(480_000).insights[0].text, 'Above 95% full.');

  const drift = at(100_000);
  assert.ok(drift.insights.some((row) => row.id === 'estimate-gap'), 'categories at ~201.6k against 100k in use');
  assert.ok(!ok.insights.some((row) => row.id === 'estimate-gap'), '201.6k against 194k is within 10%');
});

test('context files and cache hits surface only when Hermes reports them', () => {
  const entry = entryFrom(
    ['breakdown', { ...desktopCard, context_files: [
      { label: 'AGENTS.md', status: 'loaded', est_tokens: 2_000 },
      { label: 'CLAUDE.md', status: 'truncated', est_tokens: 8_000 },
      { label: 'SOUL.md', status: 'shadowed', est_tokens: 0 },
    ] }, 1_000],
    ['usage', { usage: { cache_hit_pct: 88 } }, 1_000],
  );
  const texts = buildContextUsageView({ entry, now: 1_000 }).insights.map((row) => row.text);
  assert.ok(texts.includes('CLAUDE.md is truncated.'));
  assert.ok(texts.includes('2 context files loaded, ~10k.'));
  assert.ok(texts.includes('Prompt cache hit 88%.'));
  const bare = buildContextUsageView({ entry: entryFrom(['breakdown', desktopCard, 1_000]), now: 1_000 }).insights.map((row) => row.id);
  assert.ok(!bare.includes('cache') && !bare.includes('files'));
});

test('templates run through the translator before values are filled in', () => {
  const view = buildContextUsageView({
    entry: entryFrom(['breakdown', desktopCard, 1_000]),
    translate: (template) => template.replace('Tokens', 'jetons'),
    now: 1_000,
  });
  assert.equal(view.summaryLabel, '~194k / 500k jetons');
});

test('relative ages', () => {
  assert.equal(formatRelativeAge(0, 10_000), '');
  assert.equal(formatRelativeAge(9_000, 10_000), 'just now');
  assert.equal(formatRelativeAge(0.1, 4 * 60_000), '4 min ago');
  assert.equal(formatRelativeAge(1, 3 * 3_600_000), '3 h ago');
  assert.equal(formatRelativeAge(1, 49 * 3_600_000), '2 d ago');
});

test('a REST turn\'s own runtime count is labelled as that, not as a panel estimate', () => {
  const runtime = buildContextUsageView({ local: { usedTokens: 42_000, limitTokens: 200_000, source: 'runtime', estimated: false } });
  assert.equal(runtime.reported, false);
  assert.equal(runtime.sourceLabel, 'Reported by the last Hermes turn');
  assert.equal(runtime.summaryLabel, '42k / 200k Tokens');
  const saved = buildContextUsageView({ local: { usedTokens: 42_000, limitTokens: 200_000, source: 'session' } });
  assert.equal(saved.sourceLabel, 'Saved with the session');
  assert.equal(saved.summaryLabel, '42k / 200k Tokens', 'a saved last_prompt_tokens is a provider count too');
  assert.equal(buildContextUsageView({ local: { usedTokens: 1, source: 'bogus' } }).sourceLabel, 'Panel estimate');
});

test('the "not reported" notes say what is true of the channel: no socket, sign-in would open one, socket open but session not held', () => {
  const note = (options) => buildContextUsageView({ local: { usedTokens: 10, limitTokens: 100 }, ...options }).insights.find((row) => row.id === 'no-breakdown')?.text;
  assert.match(note({ channel: 'none' }), /no Hermes session socket/);
  assert.match(note({ channel: 'sign-in' }), /Sign in with your Hermes account/);
  assert.equal(buildContextUsageView({ local: {}, channel: 'sign-in' }).breakdownState, 'unsupported');
  // A socket exists: the breakdown is only missing, never "unsupported".
  assert.equal(buildContextUsageView({ local: {}, channel: 'open' }).breakdownState, 'missing');
  assert.equal(note({ channel: 'open' }), 'Hermes has not reported a category breakdown for this session yet.');
  assert.match(note({ channel: 'open', failure: 'not-held' }), /does not hold this session/);
  // A request in flight is loading whatever the channel says.
  assert.equal(buildContextUsageView({ local: {}, channel: 'open', loading: true }).breakdownState, 'loading');
  // Callers that only pass breakdownSupported keep working.
  assert.equal(buildContextUsageView({ local: {}, breakdownSupported: true }).breakdownState, 'missing');
});
