// Tests for extension/lib/session-context-telemetry.mjs.
//
// The fixtures reproduce the REAL payload shapes discovered in the agent
// source (~/.hermes/hermes-agent) and confirmed against the live gateway:
//   - agent/context_breakdown.py :: compute_session_context_breakdown()
//     (the "session.context_breakdown" RPC result the desktop widget uses)
//   - tui_gateway/server.py :: _get_usage() + _start_usage_ticker()
//     (the "session.usage" snapshot: RPC result and pushed event)
//   - tui_gateway/prompt_turn.py :: _complete_turn_payload() ("message.complete")
//   - tui_gateway/server.py :: _session_info() ("session.info", usage nested)
//   - REST api_server GET /api/sessions/{id} (captured live on 127.0.0.1:8642;
//     carries lifetime totals only — no context telemetry, which is the bug
//     this module lets the panel side-step when real telemetry IS available).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_TELEMETRY_EVENT_TYPES,
  CONTEXT_TELEMETRY_SOURCES,
  CONTEXT_TELEMETRY_WS_METHOD,
  contextTelemetryFromRuntime,
  contextTelemetryFromSession,
  formatContextPercent,
  formatTokenCount,
  mergeContextTelemetry,
} from '../extension/lib/session-context-telemetry.mjs';

// ── fixtures ──────────────────────────────────────────────────────────

// Mirror of compute_session_context_breakdown(): numbers from the user's
// live desktop widget (153.8k / 1M / 15% with the category breakdown).
function breakdownResult(overrides = {}) {
  return {
    categories: [
      { color: 'var(--context-usage-system)', id: 'system_prompt', label: 'System prompt', tokens: 12_800 },
      { color: 'var(--context-usage-tools)', id: 'tool_definitions', label: 'Tool definitions', tokens: 12_800 },
      { color: 'var(--context-usage-subagents)', id: 'subagent_definitions', label: 'Subagent definitions', tokens: 1_000 },
      { color: 'var(--context-usage-memory)', id: 'memory', label: 'Memory', tokens: 961 },
      { color: 'var(--context-usage-conversation)', id: 'conversation', label: 'Conversation', tokens: 108_200 },
    ],
    context_max: 1_048_576,
    context_percent: 15,
    context_used: 153_800,
    context_source: 'provider_usage',
    context_estimated: false,
    estimated_total: 135_761,
    model: 'deepseek/deepseek-v4.1-flash',
    ...overrides,
  };
}

// Mirror of tui_gateway _get_usage() for a live agent (session.usage snapshot).
function usageSnapshot(overrides = {}) {
  return {
    model: 'deepseek/deepseek-v4.1-flash',
    input: 2_516_978,
    output: 97_197,
    reasoning: 57_673,
    prompt: 2_516_978,
    completion: 97_197,
    total: 2_614_175,
    calls: 92,
    context_used: 153_800,
    context_max: 1_048_576,
    context_percent: 15,
    context_source: 'provider_usage',
    context_estimated: false,
    compressions: 2,
    ...overrides,
  };
}

const EXPECTED_CATEGORIES = [
  { label: 'System prompt', tokens: 12_800 },
  { label: 'Tool definitions', tokens: 12_800 },
  { label: 'Subagent definitions', tokens: 1_000 },
  { label: 'Memory', tokens: 961 },
  { label: 'Conversation', tokens: 108_200 },
];

// ── extractors: real payload shapes ───────────────────────────────────

test('reads the real session.context_breakdown payload exactly like the desktop widget', () => {
  const telemetry = contextTelemetryFromRuntime(breakdownResult());

  assert.equal(telemetry.reported, true);
  assert.equal(telemetry.usedTokens, 153_800);
  assert.equal(telemetry.limitTokens, 1_048_576);
  assert.equal(telemetry.percent, 15);
  assert.equal(telemetry.source, 'provider-usage');
  assert.equal(telemetry.estimated, false);
  assert.equal(telemetry.compressionCount, null);
  assert.deepEqual(telemetry.breakdown, EXPECTED_CATEGORIES);
});

test('reads the real session.usage snapshot including the compressions count', () => {
  const telemetry = contextTelemetryFromSession(usageSnapshot());

  assert.equal(telemetry.reported, true);
  assert.equal(telemetry.usedTokens, 153_800);
  assert.equal(telemetry.limitTokens, 1_048_576);
  assert.equal(telemetry.percent, 15);
  assert.equal(telemetry.compressionCount, 2);
  assert.equal(telemetry.source, 'provider-usage');
  assert.deepEqual(telemetry.breakdown, []);
});

test('finds telemetry nested in the pushed session.usage event envelope', () => {
  const frame = {
    jsonrpc: '2.0',
    method: 'event',
    params: {
      type: 'session.usage',
      session_id: 'a1b2c3',
      seq: 412,
      payload: { usage: usageSnapshot() },
    },
  };

  const telemetry = contextTelemetryFromRuntime(frame);

  assert.equal(telemetry.reported, true);
  assert.equal(telemetry.usedTokens, 153_800);
  assert.equal(telemetry.compressionCount, 2);
});

test('finds telemetry inside a message.complete payload (usage rides the payload)', () => {
  const payload = { text: 'Done.', usage: usageSnapshot(), status: 'ok' };

  const telemetry = contextTelemetryFromRuntime(payload);

  assert.equal(telemetry.reported, true);
  assert.equal(telemetry.usedTokens, 153_800);
  assert.equal(telemetry.percent, 15);
});

test('finds telemetry inside a session.info payload', () => {
  const payload = {
    model: 'deepseek/deepseek-v4.1-flash',
    provider: 'nous',
    cwd: 'D:\\Hermes',
    branch: 'main',
    running: false,
    desktop_contract: 6,
    usage: usageSnapshot(),
    profile_name: 'default',
  };

  const telemetry = contextTelemetryFromRuntime(payload);

  assert.equal(telemetry.reported, true);
  assert.equal(telemetry.usedTokens, 153_800);
  assert.equal(telemetry.compressionCount, 2);
});

test('is forgiving about deep nesting but keeps every value real', () => {
  const payload = { result: { session: { runtime: { usage: usageSnapshot() } } } };

  const telemetry = contextTelemetryFromRuntime(payload);

  assert.equal(telemetry.reported, true);
  assert.equal(telemetry.usedTokens, 153_800);
  assert.equal(telemetry.compressionCount, 2);
});

test('carries the runtime context_source through as normalized provenance labels', () => {
  const plusEstimate = contextTelemetryFromRuntime(
    breakdownResult({ context_source: 'provider_usage_plus_estimate', context_estimated: true }),
  );
  assert.equal(plusEstimate.source, 'provider-usage-plus-estimate');
  assert.equal(plusEstimate.estimated, true);

  const runtimeEstimate = contextTelemetryFromRuntime(
    breakdownResult({ context_source: 'local_estimate', context_estimated: true }),
  );
  assert.equal(runtimeEstimate.source, 'runtime-local-estimate');
  assert.equal(runtimeEstimate.estimated, true);
});

test('prefers the reported percent over one derived from used/limit', () => {
  const telemetry = contextTelemetryFromRuntime(
    usageSnapshot({ context_percent: 14 }),
  );
  assert.equal(telemetry.percent, 14);

  const withoutPercent = usageSnapshot({ context_percent: undefined });
  assert.equal(contextTelemetryFromRuntime(withoutPercent).percent, 15);
});

test('accepts HBE-normalized runtime snapshot names (lastPromptTokens / contextLength)', () => {
  const telemetry = contextTelemetryFromSession({
    id: 'session-1',
    lastPromptTokens: 153_800,
    contextLength: 1_048_576,
    usagePercent: 15,
  });

  assert.equal(telemetry.reported, true);
  assert.equal(telemetry.usedTokens, 153_800);
  assert.equal(telemetry.limitTokens, 1_048_576);
  assert.equal(telemetry.percent, 15);
  assert.equal(telemetry.source, 'runtime-report');
});

test('never surfaces a defaulted compression count (compressionCountKnown: false)', () => {
  const unknown = contextTelemetryFromSession({
    lastPromptTokens: 153_800,
    contextLength: 1_048_576,
    compressionCount: 0,
    compressionCountKnown: false,
  });
  assert.equal(unknown.reported, true);
  assert.equal(unknown.compressionCount, null);

  const known = contextTelemetryFromSession({
    lastPromptTokens: 153_800,
    contextLength: 1_048_576,
    compressionCount: 0,
    compressionCountKnown: true,
  });
  assert.equal(known.compressionCount, 0);
});

// ── extractors: absence (reported: false) ─────────────────────────────

test('reports absence for a real REST session row — lifetime totals are not context telemetry', () => {
  // Captured live: GET http://127.0.0.1:8642/api/sessions/20260911_211956_10457b
  // (the REST api_server carries no context_used/context_max/breakdown).
  const sessionRow = {
    id: '20260911_211956_10457b',
    source: 'desktop',
    model: 'deepseek/deepseek-v4.1-flash',
    title: 'Plan in-app browser page comments',
    message_count: 280,
    tool_call_count: 150,
    input_tokens: 2_516_978,
    output_tokens: 97_197,
    cache_read_tokens: 15_668_608,
    cache_write_tokens: 0,
    reasoning_tokens: 57_673,
    api_call_count: 92,
    parent_session_id: '20260911_185548_ffd863',
    pinned: false,
    archived: false,
    hidden: false,
    has_system_prompt: true,
    has_model_config: true,
  };

  assert.deepEqual(contextTelemetryFromSession(sessionRow), {
    reported: false,
    reason: 'no-context-telemetry',
  });
});

test('reports absence for an agent-less session.usage snapshot', () => {
  // tui_gateway session.usage with no live agent: {calls: 0, input: 0, ...}.
  const usage = { calls: 0, input: 0, output: 0, total: 0 };

  assert.deepEqual(contextTelemetryFromRuntime(usage), {
    reported: false,
    reason: 'no-context-telemetry',
  });
});

test('reports absence for the all-zero agent-less context_breakdown response', () => {
  // methods_session.py session.context_breakdown with session["agent"] === None.
  const payload = {
    categories: [],
    context_max: 0,
    context_percent: 0,
    context_used: 0,
    estimated_total: 0,
    context_estimated: false,
    context_source: 'provider_usage',
    model: '',
  };

  assert.deepEqual(contextTelemetryFromRuntime(payload), {
    reported: false,
    reason: 'no-context-telemetry',
  });
});

test('zero and negative values are never treated as reported numbers', () => {
  assert.equal(contextTelemetryFromRuntime({ context_used: 0, context_max: 0 }).reported, false);
  assert.equal(contextTelemetryFromRuntime({ context_used: -5, context_max: -1 }).reported, false);
});

test('recognizes a JSON-RPC error envelope as rpc-error, not missing data', () => {
  const errorFrame = {
    jsonrpc: '2.0',
    id: 7,
    error: { code: 5000, message: 'Could not compute context breakdown: boom' },
  };

  assert.deepEqual(contextTelemetryFromRuntime(errorFrame), {
    reported: false,
    reason: 'rpc-error',
  });
});

test('non-object input is invalid-input', () => {
  for (const bad of [null, undefined, '153.8k', 42, [breakdownResult()]]) {
    assert.deepEqual(contextTelemetryFromRuntime(bad), {
      reported: false,
      reason: 'invalid-input',
    });
  }
});

// ── formatTokenCount ──────────────────────────────────────────────────

test('formatTokenCount matches the desktop compactNumber contract', () => {
  // The numbers from the live widget: "153.8k / 1M Tokens".
  assert.equal(formatTokenCount(153_800), '153.8k');
  assert.equal(formatTokenCount(1_048_576), '1M');
  assert.equal(formatTokenCount(961), '961');

  // Documented desktop examples (apps/desktop/src/lib/format.ts).
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1_000), '1k');
  assert.equal(formatTokenCount(1_230), '1.2k');
  assert.equal(formatTokenCount(10_000), '10k');
  assert.equal(formatTokenCount(1_500_000), '1.5M');

  // Boundary promotion so rounding never emits "1000" / "1000k".
  assert.equal(formatTokenCount(999.5), '1k');
  assert.equal(formatTokenCount(999_949), '999.9k');
  assert.equal(formatTokenCount(999_950), '1M');

  // Category rows from the widget.
  assert.equal(formatTokenCount(12_800), '12.8k');
  assert.equal(formatTokenCount(1_000), '1k');
  assert.equal(formatTokenCount(108_200), '108.2k');

  // Degenerate input collapses to '0', never a guessed figure.
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(-5), '0');
  assert.equal(formatTokenCount(Number.NaN), '0');
  assert.equal(formatTokenCount(null), '0');
  assert.equal(formatTokenCount(undefined), '0');
});

// ── formatContextPercent ──────────────────────────────────────────────

test('formatContextPercent renders integer percents in the desktop style', () => {
  assert.equal(formatContextPercent(153_800, 1_048_576), '15%');
  assert.equal(formatContextPercent(128_200, 272_000), '47%');
  assert.equal(formatContextPercent(1_048_576, 1_048_576), '100%');
  assert.equal(formatContextPercent(2_000_000, 1_048_576), '100%');
  assert.equal(formatContextPercent(0, 1_048_576), '0%');
  assert.equal(formatContextPercent('128200', '272000'), '47%');
});

test('formatContextPercent refuses to guess when inputs are unusable', () => {
  assert.equal(formatContextPercent(undefined, 1_048_576), '');
  assert.equal(formatContextPercent(153_800, undefined), '');
  assert.equal(formatContextPercent(153_800, 0), '');
  assert.equal(formatContextPercent('abc', 1_048_576), '');
  assert.equal(formatContextPercent(Number.NaN, Number.NaN), '');
});

// ── mergeContextTelemetry ─────────────────────────────────────────────

test('merge prefers reported telemetry and labels it with desktop strings', () => {
  const reported = contextTelemetryFromRuntime(breakdownResult());
  const localEstimate = { usedTokens: 28_557, limitTokens: 1_048_576 };

  const display = mergeContextTelemetry(reported, localEstimate);

  assert.equal(display.reported, true);
  assert.equal(display.source, 'provider-usage');
  assert.equal(display.reason, '');
  assert.equal(display.estimated, false);
  assert.equal(display.usedTokens, 153_800);
  assert.equal(display.limitTokens, 1_048_576);
  assert.equal(display.percent, 15);
  assert.equal(display.usedLabel, '153.8k');
  assert.equal(display.limitLabel, '1M');
  assert.equal(display.percentLabel, '15%');
  assert.equal(display.percentFullLabel, '15% Full');
  assert.equal(display.tokenSummaryLabel, '153.8k / 1M Tokens');
  assert.deepEqual(display.breakdown, EXPECTED_CATEGORIES);
  assert.equal(display.compressionCount, null);
});

test('merge falls back to the local estimate with source local-estimate', () => {
  const reported = { reported: false, reason: 'no-context-telemetry' };
  const localEstimate = {
    // The panel's local inputs: next-request estimate + model context limit.
    nextPromptTokens: 28_557,
    contextLimitTokens: 1_048_576,
  };

  const display = mergeContextTelemetry(reported, localEstimate);

  assert.equal(display.reported, false);
  assert.equal(display.source, 'local-estimate');
  assert.equal(display.reason, 'no-context-telemetry');
  assert.equal(display.estimated, true);
  assert.equal(display.usedTokens, 28_557);
  assert.equal(display.limitTokens, 1_048_576);
  assert.equal(display.percent, 3);
  assert.equal(display.usedLabel, '28.6k');
  assert.equal(display.limitLabel, '1M');
  assert.equal(display.percentFullLabel, '3% Full');
  assert.equal(display.tokenSummaryLabel, '28.6k / 1M Tokens');
  assert.deepEqual(display.breakdown, []);
});

test('merge accepts the extension accounting names (liveContextTokens / contextLimitTokens)', () => {
  const display = mergeContextTelemetry(null, {
    liveContextTokens: 153_800,
    contextLimitTokens: 1_048_576,
  });

  assert.equal(display.source, 'local-estimate');
  assert.equal(display.usedTokens, 153_800);
  assert.equal(display.limitTokens, 1_048_576);
  assert.equal(display.percentLabel, '15%');
});

test('merge fills only the fields the runtime omitted from the local estimate', () => {
  // session.usage snapshots carry no category breakdown; the local estimate
  // may still provide one, and the limit may come from the model metadata.
  const reported = contextTelemetryFromRuntime(usageSnapshot({ context_max: undefined }));
  const display = mergeContextTelemetry(reported, {
    limitTokens: 1_048_576,
    breakdown: [{ label: 'Conversation', tokens: 108_200 }],
  });

  assert.equal(display.reported, true);
  assert.equal(display.source, 'provider-usage');
  assert.equal(display.usedTokens, 153_800);
  assert.equal(display.limitTokens, 1_048_576);
  assert.deepEqual(display.breakdown, [{ label: 'Conversation', tokens: 108_200 }]);
  // compressions came from the runtime snapshot, not the local estimate.
  assert.equal(display.compressionCount, 2);
});

test('merge derives the percent label when only used and limit are known', () => {
  const display = mergeContextTelemetry(
    { reported: true, usedTokens: 100, limitTokens: 1_000, percent: null, breakdown: [], compressionCount: null, source: 'runtime-report', estimated: null },
    null,
  );

  assert.equal(display.percent, 10);
  assert.equal(display.percentLabel, '10%');
  // estimated was unknown => conservative marking for the '~' modifier.
  assert.equal(display.estimated, true);
});

test('merge with nothing at all returns an empty honest model', () => {
  const display = mergeContextTelemetry(undefined, undefined);

  assert.equal(display.reported, false);
  assert.equal(display.source, 'local-estimate');
  assert.equal(display.reason, 'no-context-telemetry');
  assert.equal(display.usedTokens, null);
  assert.equal(display.limitTokens, null);
  assert.equal(display.percent, null);
  assert.equal(display.usedLabel, '');
  assert.equal(display.limitLabel, '');
  assert.equal(display.percentLabel, '');
  assert.equal(display.tokenSummaryLabel, '');
  assert.deepEqual(display.breakdown, []);
});

// ── constants (the discovered wire contract) ──────────────────────────

test('exports the discovered gateway method + event names', () => {
  assert.equal(CONTEXT_TELEMETRY_WS_METHOD, 'session.context_breakdown');
  assert.deepEqual(
    [...CONTEXT_TELEMETRY_EVENT_TYPES],
    ['session.usage', 'message.complete', 'session.info'],
  );
  assert.equal(CONTEXT_TELEMETRY_SOURCES.LOCAL_ESTIMATE, 'local-estimate');
});
