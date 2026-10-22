// Display model for the context window card (composer context popover and
// Settings > Sessions & Context). Pure: it turns one session's stored gateway
// readings (lib/session-context-store.mjs) plus the panel's own estimate into
// the header, the segmented bar, the legend and a short list of insights.
//
// Honesty rules, the same as the store's:
//   - Header numbers come from the most recent gateway reading. Only when the
//     gateway has reported nothing for the session does the panel's own
//     estimate fill in, and then the view says so (`reported: false`).
//   - Category sizes are the gateway's own rough estimates; the legend marks
//     them with "~" and an insight says when they disagree with the measured
//     total. Nothing here invents a category the gateway did not send.
//   - Every insight is arithmetic over reported numbers. Thresholds: 80% and
//     95% full (Hermes Mobile's levels) and the auto-compact point when Hermes
//     reports one.
//
// Strings are English templates with {placeholders}. Pass `translate` to run
// each template through the panel's i18n before the values are filled in.

import { formatTokenCount } from './session-context-telemetry.mjs';
import { CONTEXT_CATEGORY_IDS } from './session-context-store.mjs';

export const CONTEXT_WARN_PERCENT = 80;
export const CONTEXT_FULL_PERCENT = 95;
// Insights call out a category once it holds at least this share of the categories.
const DOMINANT_SHARE_PERCENT = 50;
// Category estimates further than this from the measured total get a note.
const ESTIMATE_GAP_RATIO = 0.1;
const CONTEXT_FILE_PROBLEMS = new Set(['truncated', 'flagged', 'blocked', 'unreadable']);
const CONTEXT_FILE_LOADED = new Set(['loaded', 'truncated', 'flagged']);

export const CONTEXT_CATEGORY_LABELS = Object.freeze({
  system_prompt: 'System prompt',
  tool_definitions: 'Tool definitions',
  rules: 'Rules',
  skills: 'Skills',
  mcp: 'MCP',
  subagent_definitions: 'Subagent definitions',
  memory: 'Memory',
  conversation: 'Conversation',
});

const SOURCE_LABELS = Object.freeze({
  provider_usage: 'Measured by the provider',
  provider_usage_plus_estimate: 'Provider measurement plus newer messages',
  local_estimate: 'Hermes estimate, no request has run in this runtime yet',
  reported: 'Reported by Hermes',
  local: 'Panel estimate',
});

function fill(template, vars = {}) {
  return String(template).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name) => (
    Object.hasOwn(vars, name) ? String(vars[name]) : match
  ));
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

// Three decimals keeps the bar's segments summing to the occupied share.
function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/** "just now", "4 min ago", "3 h ago", "2 d ago"; '' for an unknown time. */
export function formatRelativeAge(at, now = Date.now()) {
  const time = finite(at);
  if (!time || time <= 0) return '';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function readingTime(reading, key = 'at') {
  return finite(reading?.[key]) || finite(reading?.at) || 0;
}

function hasOccupancy(reading) {
  return Boolean(reading) && (finite(reading.usedTokens) !== null || finite(reading.limitTokens) !== null);
}

/**
 * Pick the header numbers: the most recent gateway reading that carries
 * occupancy, the other reading's window size when it lacks one, and the
 * panel's estimate only when the gateway reported nothing.
 */
export function resolveContextOccupancy(entry = null, local = {}) {
  const usage = hasOccupancy(entry?.usage) ? entry.usage : null;
  const breakdown = hasOccupancy(entry?.breakdown) ? entry.breakdown : null;
  const usageAt = readingTime(usage, 'occupancyAt');
  const breakdownAt = readingTime(breakdown);
  const chosen = usage && (!breakdown || usageAt >= breakdownAt) ? usage : breakdown;
  const other = chosen === usage ? breakdown : usage;
  const localUsed = finite(local?.usedTokens);
  const localLimit = finite(local?.limitTokens) && local.limitTokens > 0 ? local.limitTokens : null;

  if (!chosen) {
    return {
      reported: false,
      origin: 'local',
      usedTokens: localUsed !== null && localUsed >= 0 ? Math.round(localUsed) : null,
      limitTokens: localLimit,
      source: '',
      estimated: true,
      at: 0,
    };
  }
  const usedTokens = finite(chosen.usedTokens) ?? finite(other?.usedTokens);
  const limitTokens = finite(chosen.limitTokens) || finite(other?.limitTokens) || localLimit;
  const source = chosen.source || other?.source || '';
  const estimated = typeof chosen.estimated === 'boolean' ? chosen.estimated : source !== 'provider_usage';
  return {
    reported: true,
    origin: chosen === usage ? 'usage' : 'breakdown',
    usedTokens,
    limitTokens,
    reportedPercent: finite(chosen.limitTokens) === limitTokens ? finite(chosen.percent) : null,
    source,
    estimated,
    at: chosen === usage ? usageAt : breakdownAt,
  };
}

function categoryLabel(category) {
  return CONTEXT_CATEGORY_LABELS[category.id] || category.label || category.id;
}

function categoryKey(id) {
  return CONTEXT_CATEGORY_IDS.includes(id) ? id : 'other';
}

/**
 * Bar segments as percentages of the bar's width.
 *
 * Window mode (the window size is known): the bar is the whole context window.
 * The categories split the occupied share in proportion to their estimates,
 * so they always add up to exactly the measured fill, and the rest is free
 * space. Composition mode (no window size): the categories fill the bar.
 * With no categories, one "in use" segment shows the measured fill alone.
 */
export function contextBarSegments({ categories = [], usedTokens = null, limitTokens = null } = {}) {
  const rows = (Array.isArray(categories) ? categories : []).filter((row) => finite(row?.tokens) !== null && row.tokens > 0);
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  const used = finite(usedTokens);
  const limit = finite(limitTokens) && limitTokens > 0 ? limitTokens : null;
  const windowMode = limit !== null && used !== null;
  const occupied = windowMode ? Math.min(1, Math.max(0, used / limit)) * 100 : 100;

  if (!rows.length) {
    if (!windowMode) return { mode: 'empty', segments: [], freeWidth: 100, occupiedWidth: 0 };
    return {
      mode: 'window',
      segments: occupied > 0 ? [{ id: 'in_use', key: 'in_use', tokens: used, width: round3(occupied) }] : [],
      freeWidth: round3(100 - occupied),
      occupiedWidth: round3(occupied),
    };
  }
  const segments = rows.map((row) => ({
    id: row.id,
    key: categoryKey(row.id),
    tokens: row.tokens,
    width: round3((row.tokens / total) * occupied),
  }));
  return {
    mode: windowMode ? 'window' : 'composition',
    segments,
    freeWidth: windowMode ? round3(100 - occupied) : 0,
    occupiedWidth: round3(occupied),
  };
}

function contextLevel(percent, overLimit, autoCompactPercent) {
  if (percent === null) return 'unknown';
  if (overLimit || percent >= CONTEXT_FULL_PERCENT) return 'full';
  if (percent >= CONTEXT_WARN_PERCENT || (autoCompactPercent && percent >= autoCompactPercent - 5)) return 'warn';
  return 'ok';
}

/**
 * Build the card's display model.
 *
 * @param {object} options
 * @param {object|null} options.entry       lib/session-context-store.mjs entry for the viewed session
 * @param {{usedTokens?: number, limitTokens?: number}} options.local  the panel's own estimate
 * @param {{percent?: number, tokens?: number}|null} options.autoCompact  reported auto-compact point
 * @param {boolean} options.breakdownSupported  the connection can answer session.context_breakdown
 * @param {boolean} options.loading       a context request is in flight
 * @param {number}  options.now
 * @param {(template: string) => string} [options.translate]
 */
export function buildContextUsageView({
  entry = null,
  local = {},
  autoCompact = null,
  breakdownSupported = false,
  loading = false,
  now = Date.now(),
  translate = (template) => template,
} = {}) {
  const say = (template, vars) => fill(translate(template), vars);
  const occupancy = resolveContextOccupancy(entry, local);
  const { usedTokens, limitTokens, estimated } = occupancy;
  const tilde = estimated ? '~' : '';
  const overLimit = usedTokens !== null && limitTokens !== null && usedTokens > limitTokens;
  let percent = null;
  if (usedTokens !== null && limitTokens !== null) {
    percent = occupancy.reportedPercent ?? clampPercent((usedTokens / limitTokens) * 100);
  }
  const freeTokens = usedTokens !== null && limitTokens !== null ? Math.max(0, limitTokens - usedTokens) : null;

  const breakdown = entry?.breakdown || null;
  const categories = Array.isArray(breakdown?.categories) ? breakdown.categories : [];
  const categoryTotal = categories.reduce((sum, row) => sum + (finite(row.tokens) || 0), 0);
  let breakdownState = 'missing';
  if (categories.length) breakdownState = entry?.breakdownStale ? 'stale' : 'reported';
  else if (loading) breakdownState = 'loading';
  else if (!breakdownSupported) breakdownState = 'unsupported';

  const bar = contextBarSegments({ categories, usedTokens, limitTokens });
  const legend = categories.map((row) => ({
    id: row.id,
    key: categoryKey(row.id),
    label: say(categoryLabel(row)),
    tokens: row.tokens,
    tokensLabel: `~${formatTokenCount(row.tokens)}`,
    sharePercent: categoryTotal > 0 ? clampPercent((row.tokens / categoryTotal) * 100) : 0,
  }));
  const segmentLabels = new Map(legend.map((row) => [row.id, row.label]));
  const segments = bar.segments.map((segment) => ({
    ...segment,
    label: segment.id === 'in_use' ? say('In use') : segmentLabels.get(segment.id) || segment.id,
  }));

  const autoPercent = finite(autoCompact?.percent) && autoCompact.percent > 0 ? clampPercent(autoCompact.percent) : null;
  const autoTokens = finite(autoCompact?.tokens) && autoCompact.tokens > 0 ? Math.round(autoCompact.tokens) : null;
  const level = contextLevel(percent, overLimit, autoPercent);
  const compressions = finite(entry?.usage?.compressions);

  const insights = [];
  const note = (id, tone, template, vars) => insights.push({ id, tone, text: say(template, vars) });
  if (overLimit) {
    note('over-limit', 'danger', 'Over the context window by {tokens}.', { tokens: formatTokenCount(usedTokens - limitTokens) });
  } else if (percent !== null && percent >= CONTEXT_FULL_PERCENT) {
    note('full', 'danger', 'Above {percent}% full.', { percent: CONTEXT_FULL_PERCENT });
  } else if (percent !== null && percent >= CONTEXT_WARN_PERCENT) {
    note('high', 'warn', 'Above {percent}% full.', { percent: CONTEXT_WARN_PERCENT });
  }
  if (usedTokens !== null && autoTokens !== null) {
    if (usedTokens >= autoTokens) {
      note('auto-compact', 'warn', 'Auto-compact is due on the next Hermes turn.');
    } else {
      note('auto-compact', 'info', 'Auto-compacts at {percent}, {tokens} to go.', {
        percent: autoPercent !== null ? `${autoPercent}%` : formatTokenCount(autoTokens),
        tokens: formatTokenCount(autoTokens - usedTokens),
      });
    }
  }
  const dominant = [...legend].sort((left, right) => right.tokens - left.tokens)[0];
  if (dominant && dominant.sharePercent >= DOMINANT_SHARE_PERCENT && legend.length > 1) {
    note('dominant', 'info', '{label} is {share}% of what is loaded.', { label: dominant.label, share: dominant.sharePercent });
  }
  if (
    categoryTotal > 0 && occupancy.reported && usedTokens
    && occupancy.source !== 'local_estimate'
    && Math.abs(categoryTotal - usedTokens) / usedTokens > ESTIMATE_GAP_RATIO
  ) {
    note('estimate-gap', 'info', 'Category sizes are rough estimates: {estimate} in all against {used} in use.', {
      estimate: `~${formatTokenCount(categoryTotal)}`,
      used: `${tilde}${formatTokenCount(usedTokens)}`,
    });
  }
  if (breakdownState === 'stale') {
    note('stale', 'info', 'The breakdown predates the last compaction.');
  }
  const cacheHit = finite(entry?.usage?.cacheHitPercent);
  if (cacheHit !== null) note('cache', 'info', 'Prompt cache hit {percent}%.', { percent: cacheHit });
  const files = Array.isArray(breakdown?.contextFiles) ? breakdown.contextFiles : [];
  const loadedFiles = files.filter((file) => CONTEXT_FILE_LOADED.has(file.status));
  for (const file of files.filter((row) => CONTEXT_FILE_PROBLEMS.has(row.status)).slice(0, 2)) {
    note(`file-${file.label}`, 'warn', '{file} is {status}.', { file: file.label, status: say(file.status) });
  }
  if (loadedFiles.length) {
    const fileTokens = loadedFiles.reduce((sum, file) => sum + (file.tokens || 0), 0);
    note('files', 'info', loadedFiles.length === 1 ? '1 context file loaded, {tokens}.' : '{count} context files loaded, {tokens}.', {
      count: loadedFiles.length,
      tokens: `~${formatTokenCount(fileTokens)}`,
    });
  }
  if (breakdownState === 'missing') {
    note('no-breakdown', 'info', 'Hermes has not reported a category breakdown for this session yet.');
  } else if (breakdownState === 'unsupported') {
    note('no-breakdown', 'info', 'This connection does not report a category breakdown.');
  }

  let sourceKey = 'local';
  if (occupancy.reported) sourceKey = SOURCE_LABELS[occupancy.source] ? occupancy.source : 'reported';
  const age = formatRelativeAge(occupancy.at, now);

  return {
    reported: occupancy.reported,
    origin: occupancy.origin,
    source: occupancy.source,
    estimated,
    usedTokens,
    limitTokens,
    freeTokens,
    percent,
    overLimit,
    level,
    compressions,
    usedLabel: usedTokens === null ? '' : `${tilde}${formatTokenCount(usedTokens)}`,
    limitLabel: limitTokens === null ? '' : formatTokenCount(limitTokens),
    summaryLabel: usedTokens !== null && limitTokens !== null
      ? say('{used} / {limit} Tokens', { used: `${tilde}${formatTokenCount(usedTokens)}`, limit: formatTokenCount(limitTokens) })
      : usedTokens !== null ? say('{used} Tokens', { used: `${tilde}${formatTokenCount(usedTokens)}` }) : '',
    percentLabel: percent === null ? '' : say('{percent}% Full', { percent: `${tilde}${percent}` }),
    compressionsLabel: compressions === null ? '' : say('Compressions: {count}', { count: compressions }),
    freeLabel: freeTokens === null ? '' : formatTokenCount(freeTokens),
    autoCompactMarker: bar.mode === 'window' && autoPercent !== null ? autoPercent : null,
    bar: { mode: bar.mode, segments, freeWidth: bar.freeWidth, occupiedWidth: bar.occupiedWidth },
    legend,
    breakdownState,
    insights,
    sourceLabel: say(SOURCE_LABELS[sourceKey]),
    updatedAt: occupancy.at,
    updatedLabel: age ? say(age) : '',
  };
}
