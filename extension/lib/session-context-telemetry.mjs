// Session context telemetry normalizer for the Hermes Browser side panel.
//
// WHY THIS EXISTS: the desktop app's context widget ("153.8k / 1M Tokens,
// 15% Full", category rows "System prompt / Tool definitions / Subagent
// definitions / Memory / Conversation") renders REAL runtime numbers. The
// side panel currently shows a local next-request estimate because nothing
// parses the runtime's telemetry payloads. This module is the pure parser +
// display-model builder; wiring lives in the caller.
//
// WHERE THE NUMBERS COME FROM (verified against the agent source in
// ~/.hermes/hermes-agent and against the live gateway on 127.0.0.1:8642):
//
//   agent/context_breakdown.py :: compute_session_context_breakdown()
//       -> the "session.context_breakdown" RPC result, field names:
//          categories: [{ id, label, tokens, color }]  (labels: "System
//            prompt", "Tool definitions", "Rules", "Skills", "MCP",
//            "Subagent definitions", "Memory", "Conversation")
//          context_used, context_max, context_percent,
//          context_source ('provider_usage' | 'provider_usage_plus_estimate'
//            | 'local_estimate'), context_estimated, estimated_total, model
//   tui_gateway/server.py :: _get_usage() + _start_usage_ticker()
//       -> the "session.usage" payload (RPC result AND pushed event, 1 Hz
//          mid-turn): input, output, reasoning, prompt, completion, total,
//          calls, context_used, context_max, context_percent,
//          context_source, context_estimated, compressions
//   tui_gateway/prompt_turn.py :: _complete_turn_payload()
//       -> "message.complete" event payload: { text, usage, status, ... }
//   tui_gateway/server.py :: _session_info()
//       -> "session.info" (RPC + end-of-turn event): { ..., "usage": {...} }
//
// TRANSPORT: these ride the dashboard gateway WebSocket (/api/ws, JSON-RPC
// 2.0, ws frames {"jsonrpc":"2.0","method":"event","params":{type,
// session_id, seq, payload}}) — the same transport the desktop app uses
// (desktop: useContextBreakdown -> requestGateway('session.context_breakdown',
// { session_id })). The REST api_server on :8642 publishes NONE of these
// context fields: its /api/sessions payload carries lifetime totals only
// (input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
// reasoning_tokens, message_count, api_call_count, ...). Verified live with
// curl; see tests for the captured shape.
//
// HONESTY RULE: this module never fabricates numbers. A field is reported
// only when the payload actually carries a positive finite value under a
// known wire name (numeric strings are tolerated; zero / negative / NaN are
// treated as "not reported"); otherwise the extractor says
// { reported: false, reason } and the caller falls back to its local
// estimate with source 'local-estimate'.
//
// DISPLAY FORMATTING mirrors the desktop exactly:
//   apps/desktop/src/lib/format.ts   compactNumber()  (153.8k, 1M, 961)
//   apps/desktop/src/i18n/en.ts      `${percent}% Full`,
//                                    `${used} / ${max} Tokens`
// Note: 1_048_576 renders '1M' on desktop (trailing .0 is stripped). The
// extension's legacy `formatTokens()` shows '1.0M tokens' for the same
// number — desktop is the parity target for the widget.

const MAX_SEARCH_DEPTH = 5;
const MAX_SEARCH_NODES = 300;

// Normalized provenance strings returned in `source`. The first three are
// the runtime's own `context_source` values, hyphenated for display; the
// last two are this module's own labels.
export const CONTEXT_TELEMETRY_SOURCES = Object.freeze({
  // context_source === 'provider_usage': provider-measured occupancy.
  PROVIDER_USAGE: 'provider-usage',
  // context_source === 'provider_usage_plus_estimate': measured anchor + estimate of new messages.
  PROVIDER_USAGE_PLUS_ESTIMATE: 'provider-usage-plus-estimate',
  // context_source === 'local_estimate': the runtime's own preflight estimate.
  RUNTIME_LOCAL_ESTIMATE: 'runtime-local-estimate',
  // No context_source in the payload, but real occupancy numbers were found.
  RUNTIME_REPORT: 'runtime-report',
  // Nothing real was reported; the display model fell back to the local estimate.
  LOCAL_ESTIMATE: 'local-estimate',
});

// The dashboard-WS RPC that returns the full category breakdown (desktop's
// useContextBreakdown calls exactly this).
export const CONTEXT_TELEMETRY_WS_METHOD = 'session.context_breakdown';

// Event types that can carry a usage snapshot (`payload.usage` for the last
// two, `payload` itself for session.usage).
export const CONTEXT_TELEMETRY_EVENT_TYPES = Object.freeze([
  'session.usage',
  'message.complete',
  'session.info',
]);

// Wire field names accepted per concept (checked in order; first positive
// finite value wins). Extra camelCase / HBE-normalized aliases are included
// because session rows and runtime snapshots travel through several shapes.
const USED_KEYS = Object.freeze([
  'context_used', 'contextUsed', 'context_used_tokens', 'contextUsedTokens',
  'last_prompt_tokens', 'lastPromptTokens', 'liveContextTokens',
]);
const LIMIT_KEYS = Object.freeze([
  'context_max', 'contextMax', 'context_length', 'contextLength',
  'contextLimitTokens', 'modelContextTokens', 'context_tokens', 'contextTokens',
]);
const PERCENT_KEYS = Object.freeze([
  'context_percent', 'contextPercent', 'usage_percent', 'usagePercent',
]);
const COMPRESSION_KEYS = Object.freeze([
  'compressions', 'compression_count', 'compressionCount',
]);
const BREAKDOWN_KEYS = Object.freeze(['categories', 'breakdown']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toPositiveNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Non-negative integer: used for compressions, where a real 0 must survive
// (a session with zero compactions has compressions: 0 on the wire).
function toCount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function toBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function pickNumber(source, keys, parser) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const parsed = parser(source[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

// Runtime categories carry { id, label, tokens, color }; this module keeps
// the display pair the spec requires ({ label, tokens }) and drops the rest.
function normalizeBreakdown(entries) {
  if (!Array.isArray(entries)) return [];
  const rows = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    const tokens = toPositiveNumber(entry.tokens);
    const label = String(entry.label || entry.id || entry.name || '').trim();
    if (!label || tokens === null) continue;
    rows.push({ label, tokens });
  }
  return rows;
}

function normalizeSource(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  const normalized = value.toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'provider_usage') return CONTEXT_TELEMETRY_SOURCES.PROVIDER_USAGE;
  if (normalized === 'provider_usage_plus_estimate') return CONTEXT_TELEMETRY_SOURCES.PROVIDER_USAGE_PLUS_ESTIMATE;
  if (normalized === 'local_estimate') return CONTEXT_TELEMETRY_SOURCES.RUNTIME_LOCAL_ESTIMATE;
  // 'local-estimate' (hyphenated) is already the caller-side fallback label.
  return value;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

// Breadth-first, bounded walk over plain objects only (arrays such as
// message lists are skipped, so a whole transcript never gets scanned).
// Field-wise first hit in visit order wins; every value kept is a real
// number the payload carried.
function scanTelemetry(root) {
  const found = {
    usedTokens: null,
    limitTokens: null,
    percent: null,
    compressionCount: null,
    breakdown: [],
    source: '',
    estimated: null,
  };
  const queue = [{ value: root, depth: 0 }];
  const seen = new Set();
  let visited = 0;

  while (queue.length > 0 && visited < MAX_SEARCH_NODES) {
    const { value, depth } = queue.shift();
    if (!isPlainObject(value) || seen.has(value)) continue;
    seen.add(value);
    visited += 1;

    if (found.usedTokens === null) found.usedTokens = pickNumber(value, USED_KEYS, toPositiveNumber);
    if (found.limitTokens === null) found.limitTokens = pickNumber(value, LIMIT_KEYS, toPositiveNumber);
    if (found.percent === null) found.percent = pickNumber(value, PERCENT_KEYS, toPositiveNumber);
    if (
      found.compressionCount === null
      && value.compressionCountKnown !== false
      && value.compression_count_known !== false
    ) {
      // HBE session rows stamp `compressionCountKnown: false` when the count
      // was defaulted rather than reported — never surface that default.
      found.compressionCount = pickNumber(value, COMPRESSION_KEYS, toCount);
    }
    if (found.breakdown.length === 0) {
      for (const key of BREAKDOWN_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const rows = normalizeBreakdown(value[key]);
        if (rows.length > 0) {
          found.breakdown = rows;
          break;
        }
      }
    }
    if (!found.source) found.source = normalizeSource(value.context_source ?? value.contextSource);
    if (found.estimated === null) found.estimated = toBoolean(value.context_estimated ?? value.contextEstimated);

    if (depth >= MAX_SEARCH_DEPTH) continue;
    for (const child of Object.values(value)) {
      if (isPlainObject(child) && !seen.has(child)) queue.push({ value: child, depth: depth + 1 });
    }
  }
  return found;
}

function telemetryFromPayload(payload) {
  if (!isPlainObject(payload)) {
    return { reported: false, reason: 'invalid-input' };
  }
  const found = scanTelemetry(payload);
  const hasRealNumbers = found.usedTokens !== null
    || found.limitTokens !== null
    || found.percent !== null
    || found.breakdown.length > 0;
  if (!hasRealNumbers) {
    const reason = Object.prototype.hasOwnProperty.call(payload, 'error') ? 'rpc-error' : 'no-context-telemetry';
    return { reported: false, reason };
  }

  const source = found.source || CONTEXT_TELEMETRY_SOURCES.RUNTIME_REPORT;
  let percent = found.percent !== null ? clampPercent(found.percent) : null;
  if (percent === null && found.usedTokens !== null && found.limitTokens !== null) {
    // Arithmetic over two real numbers, matching the runtime's own formula
    // (round(used / max * 100)) — not a fabricated value.
    percent = clampPercent((found.usedTokens / found.limitTokens) * 100);
  }
  let estimated = found.estimated;
  if (estimated === null) {
    if (source === CONTEXT_TELEMETRY_SOURCES.PROVIDER_USAGE) estimated = false;
    else if (
      source === CONTEXT_TELEMETRY_SOURCES.PROVIDER_USAGE_PLUS_ESTIMATE
      || source === CONTEXT_TELEMETRY_SOURCES.RUNTIME_LOCAL_ESTIMATE
    ) estimated = true;
  }

  return {
    reported: true,
    usedTokens: found.usedTokens,
    limitTokens: found.limitTokens,
    percent,
    compressionCount: found.compressionCount,
    breakdown: found.breakdown,
    source,
    // true = show the '~' the desktop uses for estimated figures; null is
    // "provenance unknown" and callers should treat it conservatively.
    estimated,
  };
}

/**
 * Normalize a Hermes session-shaped payload into display telemetry.
 *
 * Accepts a session object (REST session row, HBE-normalized session,
 * session.info result, a whole JSON-RPC response — anything that may nest
 * `usage` / `runtime`). Forgiving about nesting; never invents numbers.
 *
 * @returns {{reported: true, usedTokens: (number|null), limitTokens: (number|null),
 *   percent: (number|null), compressionCount: (number|null),
 *   breakdown: Array<{label: string, tokens: number}>, source: string,
 *   estimated: (boolean|null)}}
 *   or `{reported: false, reason: 'invalid-input'|'rpc-error'|'no-context-telemetry'}`.
 */
export function contextTelemetryFromSession(session) {
  return telemetryFromPayload(session);
}

/**
 * Normalize a Hermes runtime payload into display telemetry — the same
 * shapes the dashboard WS delivers: the `session.context_breakdown` result,
 * the `session.usage` snapshot (RPC result, `{usage}` event payload,
 * `message.complete` payload), or the `session.info` payload.
 *
 * @returns same shape as {@link contextTelemetryFromSession}.
 */
export function contextTelemetryFromRuntime(payload) {
  return telemetryFromPayload(payload);
}

/**
 * Desktop-style compact token string — an exact port of
 * apps/desktop/src/lib/format.ts::compactNumber().
 *
 * RULE (thresholds sit just under the unit boundary so rounding can never
 * produce "1000k" or "1000"):
 *   - not finite / <= 0        -> "0"
 *   - >= 999_950               -> (n/1e6).toFixed(1), trailing ".0" stripped, + "M"
 *   - >= 999.5                 -> (n/1e3).toFixed(1), trailing ".0" stripped, + "k"
 *   - otherwise                -> Math.round(n)
 *
 * Examples: 153_800 -> "153.8k"; 1_048_576 -> "1M"; 961 -> "961";
 *           1_500_000 -> "1.5M"; 999_950 -> "1M"; 1_000 -> "1k".
 */
export function formatTokenCount(value) {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num) || num <= 0) {
    return '0';
  }
  const scaled = (v, suffix) => `${v.toFixed(1).replace(/\.0$/, '')}${suffix}`;
  if (num >= 999_950) {
    return scaled(num / 1_000_000, 'M');
  }
  if (num >= 999.5) {
    return scaled(num / 1_000, 'k');
  }
  return `${Math.round(num)}`;
}

/**
 * Integer percent string in the desktop's "15%" style.
 *
 * RULE: both inputs must be finite numbers (numeric strings tolerated);
 * `limit` must be > 0. Percent = round(used / limit * 100), clamped to
 * 0..100. Any other input returns '' (caller renders its own placeholder),
 * never a guessed number.
 *
 * Examples: (153_800, 1_048_576) -> "15%"; (128_200, 272_000) -> "47%".
 */
export function formatContextPercent(used, limit) {
  const usedValue = toFiniteNumber(used);
  const limitValue = toFiniteNumber(limit);
  if (usedValue === null || limitValue === null || limitValue <= 0) return '';
  return `${clampPercent((usedValue / limitValue) * 100)}%`;
}

function toFiniteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Accepted local-estimate aliases, in priority order. `liveContextTokens` /
// `contextLimitTokens` are the extension's own accounting names
// (lib/common.mjs contextAccountingSnapshot).
function normalizeLocalEstimate(localEstimate) {
  const local = isPlainObject(localEstimate) ? localEstimate : {};
  const usedTokens = pickNumber(
    local,
    ['usedTokens', 'liveContextTokens', 'estimatedTokens', 'nextPromptTokens', 'used'],
    toPositiveNumber,
  );
  const limitTokens = pickNumber(
    local,
    ['limitTokens', 'contextLimitTokens', 'contextLimit', 'modelContextTokens', 'limit'],
    toPositiveNumber,
  );
  const percent = pickNumber(local, ['percent', 'percentUsed'], toPositiveNumber);
  const compressionCount = pickNumber(local, ['compressionCount', 'compressions'], toCount);
  let breakdown = normalizeBreakdown(local.breakdown);
  if (breakdown.length === 0) breakdown = normalizeBreakdown(local.categories);
  return { usedTokens, limitTokens, percent, compressionCount, breakdown };
}

/**
 * Build the display model the side panel renders.
 *
 * Preference order: real runtime telemetry first; any field the runtime did
 * not report falls back to the caller's local estimate, and when nothing was
 * reported the whole model comes from the local estimate with
 * `source: 'local-estimate'` so the UI can label it honestly.
 *
 * @param {{reported: boolean, [key: string]: any}|null|undefined} reported
 *   Output of {@link contextTelemetryFromRuntime} / {@link contextTelemetryFromSession}.
 * @param {{usedTokens?: number, limitTokens?: number, percent?: number,
 *   compressionCount?: number, breakdown?: Array<{label: string, tokens: number}>,
 *   liveContextTokens?: number, contextLimitTokens?: number,
 *   estimatedTokens?: number, nextPromptTokens?: number}|null|undefined} localEstimate
 *
 * @returns {{
 *   reported: boolean,               // true when runtime numbers were used
 *   source: string,                  // CONTEXT_TELEMETRY_SOURCES value
 *   reason: string,                  // why telemetry was absent ('' when reported)
 *   estimated: boolean,              // show the desktop '~' marker
 *   usedTokens: (number|null),
 *   limitTokens: (number|null),
 *   percent: (number|null),
 *   usedLabel: string,               // formatTokenCount(usedTokens), '' when unknown
 *   limitLabel: string,              // formatTokenCount(limitTokens), '' when unknown
 *   percentLabel: string,            // e.g. '15%', '' when unknown
 *   percentFullLabel: string,        // e.g. '15% Full' (desktop i18n), '' when unknown
 *   tokenSummaryLabel: string,       // e.g. '153.8k / 1M Tokens', '' unless both known
 *   compressionCount: (number|null),
 *   breakdown: Array<{label: string, tokens: number}>
 * }}
 */
export function mergeContextTelemetry(reported, localEstimate) {
  const telemetry = isPlainObject(reported) && reported.reported === true ? reported : null;
  const local = normalizeLocalEstimate(localEstimate);

  const usedTokens = telemetry?.usedTokens ?? local.usedTokens ?? null;
  const limitTokens = telemetry?.limitTokens ?? local.limitTokens ?? null;
  let percent = telemetry?.percent ?? local.percent ?? null;
  if (percent === null && usedTokens !== null && limitTokens !== null && limitTokens > 0) {
    percent = clampPercent((usedTokens / limitTokens) * 100);
  }
  const compressionCount = telemetry?.compressionCount ?? local.compressionCount ?? null;
  const breakdown = telemetry && Array.isArray(telemetry.breakdown) && telemetry.breakdown.length > 0
    ? telemetry.breakdown
    : local.breakdown;

  return {
    reported: Boolean(telemetry),
    source: telemetry
      ? String(telemetry.source || CONTEXT_TELEMETRY_SOURCES.RUNTIME_REPORT)
      : CONTEXT_TELEMETRY_SOURCES.LOCAL_ESTIMATE,
    reason: telemetry ? '' : String((isPlainObject(reported) && reported.reason) || 'no-context-telemetry'),
    estimated: telemetry ? telemetry.estimated !== false : true,
    usedTokens,
    limitTokens,
    percent,
    usedLabel: usedTokens === null ? '' : formatTokenCount(usedTokens),
    limitLabel: limitTokens === null ? '' : formatTokenCount(limitTokens),
    percentLabel: percent === null ? '' : `${percent}%`,
    percentFullLabel: percent === null ? '' : `${percent}% Full`,
    tokenSummaryLabel: usedTokens !== null && limitTokens !== null
      ? `${formatTokenCount(usedTokens)} / ${formatTokenCount(limitTokens)} Tokens`
      : '',
    compressionCount,
    breakdown,
  };
}
