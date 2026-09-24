import {
  HERMES_DEFAULT_CONTEXT_LENGTHS,
  HERMES_DEFAULT_FALLBACK_CONTEXT,
} from './hermes-context-lengths.mjs';

export { HERMES_DEFAULT_FALLBACK_CONTEXT };

// Display names and live ids Hermes's slug table does not spell out, but
// resolves to the same window. Longer keys are listed first by the matcher.
const DISPLAY_CONTEXT_ALIASES = Object.freeze({
  'claude-opus-5.5': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'opus-5.5': 1_000_000,
  'opus-5-5': 1_000_000,
  'opus-5': 1_000_000,
  'sonnet-5': 1_000_000,
  'fable-5': 1_000_000,
  'mythos-5': 1_000_000,
  'opus-4.8': 1_000_000,
  'opus-4-8': 1_000_000,
  'opus-4.7': 1_000_000,
  'opus-4.6': 1_000_000,
  'sonnet-4.6': 1_000_000,
  'sonnet-4-6': 1_000_000,
  'grok-4.7': 500_000,
  'grok-4-7': 500_000,
  'mimo-v2.6-pro': 1_048_576,
  'mimo-v2.6-flash': 1_048_576,
  'mimo-v2-6-pro': 1_048_576,
  'mimo-v2-6-flash': 1_048_576,
  'qwen3.8-max-preview': 1_000_000,
  'qwen3.7-max': 1_000_000,
  'qwen3.7-plus': 1_000_000,
  'qwen3.6-flash': 1_000_000,
});

const CONTEXT_TABLE = Object.freeze({
  ...HERMES_DEFAULT_CONTEXT_LENGTHS,
  ...DISPLAY_CONTEXT_ALIASES,
});

const CONTEXT_KEYS = Object.freeze(
  Object.keys(CONTEXT_TABLE).sort((left, right) => right.length - left.length || left.localeCompare(right)),
);

function normalizeContextSlug(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/\./g, '-');
}

function keyMatches(key, haystack, normalizedHaystack) {
  const normalizedKey = normalizeContextSlug(key);
  return haystack.includes(key) || (normalizedKey && normalizedHaystack.includes(normalizedKey));
}

export function hermesContextForText(value = '') {
  const haystack = String(value || '').trim().toLowerCase();
  if (!haystack) return 0;
  const normalizedHaystack = normalizeContextSlug(haystack);
  for (const key of CONTEXT_KEYS) {
    if (keyMatches(key, haystack, normalizedHaystack)) return CONTEXT_TABLE[key];
  }
  return 0;
}

export function hermesContextForModel(model = {}) {
  const fields = [
    model.id,
    model.rawModelId,
    model.raw_model_id,
    model.model,
    model.name,
    model.label,
    model.root,
  ].filter(Boolean);
  if (!fields.length) return 0;
  let bestLength = -1;
  let bestTokens = 0;
  for (const field of fields) {
    const haystack = String(field).trim().toLowerCase();
    const normalizedHaystack = normalizeContextSlug(haystack);
    for (const key of CONTEXT_KEYS) {
      if (key.length <= bestLength) break;
      if (!keyMatches(key, haystack, normalizedHaystack)) continue;
      bestLength = key.length;
      bestTokens = CONTEXT_TABLE[key];
      break;
    }
  }
  return bestTokens || HERMES_DEFAULT_FALLBACK_CONTEXT;
}
