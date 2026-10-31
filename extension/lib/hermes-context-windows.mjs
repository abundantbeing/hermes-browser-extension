import {
  HERMES_DEFAULT_CONTEXT_LENGTHS,
  HERMES_DEFAULT_FALLBACK_CONTEXT,
} from './hermes-context-lengths.mjs';

export { HERMES_DEFAULT_FALLBACK_CONTEXT };

// Display names and live ids Hermes's slug table does not spell out, but
// resolves to the same window. Versioned keys outrank family catch-alls.
export const DISPLAY_CONTEXT_ALIASES = Object.freeze({
  'claude-opus-5.5': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'claude-sonnet-5.5': 1_000_000,
  'claude-sonnet-5-5': 1_000_000,
  'claude-haiku-5.5': 1_000_000,
  'claude-haiku-5-5': 1_000_000,
  'opus-5.5': 1_000_000,
  'opus-5-5': 1_000_000,
  'sonnet-5.5': 1_000_000,
  'sonnet-5-5': 1_000_000,
  'haiku-5.5': 1_000_000,
  'haiku-5-5': 1_000_000,
  'opus-5': 1_000_000,
  'sonnet-5': 1_000_000,
  'space-bunny-alpha': 1_000_000,
  'fable-5': 1_000_000,
  'mythos-5': 1_000_000,
  'opus-4.8': 1_000_000,
  'opus-4-8': 1_000_000,
  'opus-4.7': 1_000_000,
  'opus-4.6': 1_000_000,
  'sonnet-4.6': 1_000_000,
  'sonnet-4-6': 1_000_000,
  // Not in Hermes Agent's table yet; its sibling gpt-5.6-terra / gpt-6.1-sol rows are 1.05M. A guess of last resort:
  // a window the gateway reports for this model replaces it.
  'gpt-6.1-terra': 1_050_000,
  'grok-4.7': 500_000,
  'grok-4-7': 500_000,
  // StepFun. Hermes Agent's DEFAULT_CONTEXT_LENGTHS has no `step` key at all,
  // so every stepfun id — including the 1M step-5-preview — resolved to the
  // 256k fallback. Nous Portal reports 1M for step-5 and 262k for step-3.7.
  'step-5-preview': 1_000_000,
  'step-5': 1_000_000,
  'step-4': 1_000_000,
  'step-3.7-flash': 262_144,
  'step-3.5-flash': 262_144,
  'step-3': 262_144,
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

function normalizeContextSlug(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/\./g, '-');
}

// A versioned id must beat a family catch-all even when the catch-all string
// is longer. "claude-haiku" (12) is longer than "haiku-5.5" (8), so a pure
// longest-key scan labels every new Haiku 200k until someone hand-adds it.
function keySpecificity(key = '') {
  const normalized = normalizeContextSlug(key);
  const versioned = /(?:^|-)(?:\d+)(?:-\d+)+$/.test(normalized) || /\d+\.\d+/.test(key);
  return (versioned ? 1_000 : 0) + key.length;
}

const CONTEXT_KEYS = Object.freeze(
  Object.keys(CONTEXT_TABLE).sort((left, right) => keySpecificity(right) - keySpecificity(left) || left.localeCompare(right)),
);

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
      if (keySpecificity(key) <= bestLength) break;
      if (!keyMatches(key, haystack, normalizedHaystack)) continue;
      bestLength = keySpecificity(key);
      bestTokens = CONTEXT_TABLE[key];
      break;
    }
  }
  return bestTokens || HERMES_DEFAULT_FALLBACK_CONTEXT;
}
