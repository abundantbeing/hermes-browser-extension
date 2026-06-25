// model-discovery.mjs
// Discover real model names from /api/sessions when /v1/models only returns
// the synthetic `hermes-agent` alias. Used as a fallback for multi-provider
// setups where the gateway's OpenAI-compat /v1/models doesn't reflect the
// real model registry.
//
// The actual model used per turn is stored in /api/sessions[*].model, so we
// can reconstruct a useful model picker from session history.

const SESSION_HISTORY_LIMIT = 100;

const KNOWN_PROVIDER_PREFIXES = [
  // Order matters: most specific first.
  // Provider names that appear as substrings (e.g. `openai-codex/gpt-5.4`).
  ['openai-codex', 'openai'],
  ['openai', 'openai'],
  ['minimax', 'minimax'],
  ['kimi', 'moonshot'],
  ['moonshot', 'moonshot'],
  ['qwen', 'alibaba'],
  ['glm', 'zhipu'],
  ['deepseek', 'deepseek'],
  ['grok', 'xai'],
  ['gemini', 'google'],
  ['claude', 'anthropic'],
];

// Brand prefixes that don't contain the provider name as a substring.
const KNOWN_PROVIDER_BRANDS = [
  ['gpt-', 'openai'],
  ['gpt5', 'openai'],
  ['gpt4', 'openai'],
  ['o1', 'openai'],
  ['o3', 'openai'],
  ['o4', 'openai'],
];

export function deriveProviderFromModelId(modelId = '') {
  const lower = String(modelId || '').toLowerCase();
  if (!lower) return '';
  for (const [prefix, provider] of KNOWN_PROVIDER_PREFIXES) {
    if (lower.startsWith(prefix) || lower.includes(`/${prefix}`) || lower.includes(`-${prefix}`)) {
      return provider;
    }
  }
  for (const [brand, provider] of KNOWN_PROVIDER_BRANDS) {
    if (lower.startsWith(brand) || lower.includes(`-${brand}`) || lower.includes(`/${brand}`)) {
      return provider;
    }
  }
  return '';
}

export async function discoverModelsFromSessions({
  apiFetch,
  readJsonResponse,
  limit = SESSION_HISTORY_LIMIT,
} = {}) {
  if (typeof apiFetch !== 'function' || typeof readJsonResponse !== 'function') {
    return { ok: false, error: 'no-fetch', models: [] };
  }
  try {
    const response = await apiFetch(`/api/sessions?limit=${encodeURIComponent(limit)}`, { method: 'GET' });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      return {
        ok: false,
        error: payload?.error?.message || `status-${response.status}`,
        models: [],
      };
    }
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const buckets = new Map();
    for (const row of rows) {
      const modelId = String(row?.model || '').trim();
      if (!modelId) continue;
      const lastSeen = Number(row?.last_active || row?.started_at || 0);
      const bucket = buckets.get(modelId) || {
        id: modelId,
        label: modelId,
        provider: deriveProviderFromModelId(modelId),
        contextTokens: 0,
        lastSeen: 0,
        sessionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      bucket.sessionCount += 1;
      bucket.lastSeen = Math.max(bucket.lastSeen, lastSeen);
      bucket.inputTokens += Number(row?.input_tokens || 0);
      bucket.outputTokens += Number(row?.output_tokens || 0);
      buckets.set(modelId, bucket);
    }
    const models = Array.from(buckets.values())
      .map((bucket) => ({
        id: bucket.id,
        label: bucket.label,
        provider: bucket.provider,
        providerLabel: bucket.provider,
        description: `${bucket.sessionCount} session${bucket.sessionCount === 1 ? '' : 's'} · ${(bucket.inputTokens + bucket.outputTokens).toLocaleString()} tokens`,
        contextTokens: 0,
        source: 'sessions',
        lastSeen: bucket.lastSeen,
        sessionCount: bucket.sessionCount,
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
    return { ok: true, models, error: '' };
  } catch (error) {
    return { ok: false, error: error?.message || 'error', models: [] };
  }
}

export function mergeModelsWithRegistry({ registryModels = [], sessionModels = [] } = {}) {
  const out = [];
  const seen = new Set();
  // Registry first (these are the gateway-blessed models)
  for (const model of registryModels) {
    if (!model || !model.id || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push({ ...model, source: model.source || 'registry' });
  }
  // Then session-discovered models, marking them as such
  for (const model of sessionModels) {
    if (!model || !model.id || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push({ ...model, source: 'sessions' });
  }
  return out;
}

export const MODEL_DISCOVERY_DEFAULTS = Object.freeze({
  limit: SESSION_HISTORY_LIMIT,
});
