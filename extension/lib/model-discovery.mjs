// model-discovery.mjs
// Discover real model names from /api/sessions when /v1/models only returns
// the synthetic `hermes-agent` alias. Used as a fallback for multi-provider
// setups where the gateway's OpenAI-compat /v1/models doesn't reflect the
// real model registry.
//
// The actual model used per turn is stored in /api/sessions[*].model, so we
// can reconstruct a useful model picker from session history.

const SESSION_HISTORY_LIMIT = 100;
const LOCAL_DASHBOARD_URL = 'http://127.0.0.1:9119';
export const MODEL_CATALOG_CACHE_STORAGE_KEY = 'hermesBrowserModelCatalogCache';

export function modelCatalogCacheKey({ gatewayMode = 'local-api', gatewayUrl = '', profile = '' } = {}) {
  const mode = String(gatewayMode || 'local-api').trim() || 'local-api';
  const url = String(gatewayUrl || '').trim().replace(/\/$/, '') || (mode === 'local-api' ? 'local-api' : 'unknown');
  const activeProfile = String(profile || '').trim() || 'default';
  return `${mode}|${url}|${activeProfile}`;
}

export function normalizeCachedModelCatalog(payload = []) {
  const rows = Array.isArray(payload) ? payload : [];
  return rows
    .filter((model) => model && typeof model === 'object' && String(model.id || '').trim())
    .map((model) => ({
      ...model,
      source: 'cache',
      runtimeSelectable: model.runtimeSelectable !== false,
    }));
}

export function selectModelCatalogFallback({ registryModels = [], cachedModels = [], sessionModels = [] } = {}) {
  if (Array.isArray(registryModels) && registryModels.length) {
    return { models: registryModels, source: 'registry' };
  }
  if (Array.isArray(cachedModels) && cachedModels.length) {
    return { models: cachedModels, source: 'cache' };
  }
  if (Array.isArray(sessionModels) && sessionModels.length) {
    return { models: sessionModels, source: 'sessions' };
  }
  return { models: [], source: '' };
}

const KNOWN_PROVIDER_PREFIXES = [
  // Order matters: most specific first.
  // Provider names that appear as substrings (e.g. `openai-codex/gpt-5.4`).
  ['openai-codex', 'openai-codex'],
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

const CONTEXT_TOKEN_KEYS = Object.freeze([
  'context_length',
  'contextTokens',
  'context_tokens',
  'contextWindow',
  'context_window',
  'max_context_tokens',
  'maxContextTokens',
  'max_context',
  'context',
]);

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function contextTokensFromObject(source = {}) {
  if (!source || typeof source !== 'object') return 0;
  const direct = firstPositiveNumber(...CONTEXT_TOKEN_KEYS.map((key) => source?.[key]));
  if (direct) return direct;
  return firstPositiveNumber(
    ...CONTEXT_TOKEN_KEYS.map((key) => source?.metadata?.[key]),
    ...CONTEXT_TOKEN_KEYS.map((key) => source?.limits?.[key]),
    source?.limits?.context?.tokens,
    source?.limits?.context?.max,
    source?.context?.tokens,
    source?.context?.max,
  );
}

export function modelsFromModelOptionsPayload(payload = {}) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : [];
  const models = [];
  const seen = new Set();
  for (const provider of providers) {
    const slug = String(provider?.slug || provider?.id || provider?.provider || '').trim();
    const providerLabel = String(provider?.name || provider?.label || slug || 'Hermes').trim();
    const entries = Array.isArray(provider?.models) ? provider.models : [];
    const caps = provider?.capabilities && typeof provider.capabilities === 'object' ? provider.capabilities : {};
    const unavailable = new Set(Array.isArray(provider?.unavailable_models) ? provider.unavailable_models : []);
    for (const entry of entries) {
      const modelId = String(
        typeof entry === 'string'
          ? entry
          : entry?.id || entry?.name || entry?.model || ''
      ).trim();
      if (!modelId) continue;
      const dedupeKey = `${slug || deriveProviderFromModelId(modelId) || providerLabel}::${modelId}`.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const modelCaps = caps[modelId] || {};
      const uiId = slug ? `${slug}::${modelId}` : modelId;
      const entryContext = contextTokensFromObject(entry);
      const capsContext = contextTokensFromObject(modelCaps);
      models.push({
        id: uiId,
        rawModelId: modelId,
        label: typeof entry === 'object' ? (entry.label || entry.name || modelId) : modelId,
        provider: slug || deriveProviderFromModelId(modelId),
        providerLabel,
        description: provider?.warning || provider?.source || '',
        contextTokens: entryContext || capsContext || 0,
        fast: typeof modelCaps.fast === 'boolean' ? modelCaps.fast : undefined,
        reasoning: typeof modelCaps.reasoning === 'boolean' ? modelCaps.reasoning : undefined,
        authenticated: provider?.authenticated !== false,
        available: !unavailable.has(modelId),
        source: 'registry',
        runtimeSelectable: true,
      });
    }
  }
  return models;
}

export async function discoverModelsFromRegistry({
  apiFetch,
  readJsonResponse,
  refresh = false,
} = {}) {
  if (typeof apiFetch !== 'function' || typeof readJsonResponse !== 'function') {
    return { ok: false, error: 'no-fetch', models: [] };
  }
  try {
    const suffix = refresh ? '?refresh=true' : '';
    const response = await apiFetch(`/api/model/options${suffix}`, { method: 'GET' });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      return {
        ok: false,
        error: payload?.error?.message || payload?.error || `status-${response.status}`,
        models: [],
      };
    }
    return { ok: true, models: modelsFromModelOptionsPayload(payload), error: '' };
  } catch (error) {
    return { ok: false, error: error?.message || 'error', models: [] };
  }
}

async function fetchWithTimeout(fetchFn, url, options = {}, timeoutMs = 5000) {
  if (typeof fetchFn !== 'function') throw new Error('no-fetch');
  if (typeof AbortController === 'undefined' || !timeoutMs) {
    return fetchFn(url, options);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function dashboardModelDiscoveryBaseUrl({ gatewayMode = 'local-api', gatewayUrl = '', localDashboardUrl = LOCAL_DASHBOARD_URL } = {}) {
  if (gatewayMode === 'local-api') return localDashboardUrl;
  if (gatewayMode === 'remote-dashboard') return String(gatewayUrl || '').trim();
  return '';
}

export function extractDashboardSessionToken(html = '') {
  const match = String(html || '').match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/);
  return match?.[1] || '';
}

export function dashboardModelOptionsUrl(baseUrl = '', refresh = false, profile = '') {
  try {
    const url = new URL(String(baseUrl || '').trim());
    url.hash = '';
    url.search = '';
    if (refresh) url.searchParams.set('refresh', 'true');
    const profileName = String(profile || '').trim();
    if (profileName) url.searchParams.set('profile', profileName);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/model/options`;
    return url.toString();
  } catch {
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', 'true');
    const profileName = String(profile || '').trim();
    if (profileName) params.set('profile', profileName);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return `${String(baseUrl || '').replace(/\/+$/, '')}/api/model/options${suffix}`;
  }
}

export async function discoverModelsFromDashboard({
  baseUrl = LOCAL_DASHBOARD_URL,
  fetchFn = globalThis.fetch?.bind(globalThis),
  refresh = false,
  profile = '',
  rootTimeoutMs = 2500,
  optionsTimeoutMs = refresh ? 18000 : 6000,
} = {}) {
  const dashboardUrl = String(baseUrl || '').trim();
  if (!dashboardUrl) return { ok: false, error: 'no-dashboard-url', models: [] };
  try {
    const rootResponse = await fetchWithTimeout(fetchFn, dashboardUrl, {
      method: 'GET',
      headers: { Accept: 'text/html' },
      credentials: 'include',
    }, rootTimeoutMs);
    if (!rootResponse.ok) return { ok: false, error: `dashboard-root-${rootResponse.status}`, models: [] };
    const html = await rootResponse.text();
    const token = extractDashboardSessionToken(html);
    if (!token) return { ok: false, error: 'no-dashboard-session-token', models: [] };
    const optionsResponse = await fetchWithTimeout(fetchFn, dashboardModelOptionsUrl(dashboardUrl, refresh, profile), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Hermes-Session-Token': token,
      },
      credentials: 'include',
    }, optionsTimeoutMs);
    const text = await optionsResponse.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text.slice(0, 500) };
    }
    if (!optionsResponse.ok) {
      return {
        ok: false,
        error: payload?.detail || payload?.error?.message || payload?.error || `dashboard-options-${optionsResponse.status}`,
        models: [],
      };
    }
    return { ok: true, models: modelsFromModelOptionsPayload(payload), error: '', source: 'dashboard' };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'dashboard-timeout' : (error?.message || 'error'), models: [] };
  }
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
      if (!modelId || modelId === 'hermes-agent') continue;
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
        description: `Observed in ${bucket.sessionCount} session${bucket.sessionCount === 1 ? '' : 's'} · ${(bucket.inputTokens + bucket.outputTokens).toLocaleString()} tokens`,
        contextTokens: 0,
        source: 'sessions',
        runtimeSelectable: false,
        lastSeen: bucket.lastSeen,
        sessionCount: bucket.sessionCount,
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
    return { ok: true, models, error: '' };
  } catch (error) {
    return { ok: false, error: error?.message || 'error', models: [] };
  }
}

export function shouldTrySessionModelFallback({ registryModels = [], registrySource = '', defaultModelId = 'hermes-agent' } = {}) {
  if (registrySource === 'cache') return false;
  const advertisedModels = registryModels.filter((model) => model?.source !== 'selected');
  const includesDefaultAlias = advertisedModels.some((model) => model?.id === defaultModelId)
    || registryModels.some((model) => model?.id === defaultModelId);
  if (registrySource === 'v1') {
    // API-server /v1/models may expose only the active OpenAI-compatible row,
    // or that row plus the default hermes-agent alias. Both are sparse and
    // should keep searching session history rather than freezing the picker at
    // one provider.
    return advertisedModels.length <= 2;
  }
  const nonDefaultAdvertised = advertisedModels.filter((model) => model?.id !== defaultModelId);
  return includesDefaultAlias && nonDefaultAdvertised.length <= 1;
}

export function modelCatalogRefreshDecision({ previousSelectedModel = '', discoveredModels = [], refresh = false } = {}) {
  const models = Array.isArray(discoveredModels) ? discoveredModels : [];
  const fallbackIds = new Set(['hermes-agent', 'nous']);
  const onlyFallback = models.length > 0 && models.every((model) => {
    const id = String(model?.id || model?.name || model?.label || '').trim().toLowerCase();
    return fallbackIds.has(id);
  });
  if (refresh && previousSelectedModel && onlyFallback) {
    return {
      keepPreviousSelection: true,
      selectedModel: previousSelectedModel,
      warning: 'fallback-only',
    };
  }
  return {
    keepPreviousSelection: false,
    selectedModel: models[0]?.id || previousSelectedModel,
    warning: '',
  };
}

function modelDedupeKey(model = {}) {
  const rawId = String(model?.rawModelId || model?.id || '').trim().toLowerCase();
  if (!rawId) return '';
  const provider = String(model?.provider || model?.providerLabel || model?.source || '').trim().toLowerCase();
  return `${provider || 'models'}::${rawId}`;
}

export function mergeModelsByRawId(arrays = []) {
  const seen = new Set();
  const merged = [];
  for (const models of arrays) {
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      const key = modelDedupeKey(model);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(model);
    }
  }
  return merged;
}

export function mergeModelsWithRegistry({ registryModels = [], sessionModels = [] } = {}) {
  const out = [];
  const seen = new Set();
  // Registry first (these are the gateway-blessed models)
  for (const model of registryModels) {
    const key = modelDedupeKey(model);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...model, source: model.source || 'registry' });
  }
  // Then session-discovered models, marking them as such
  for (const model of sessionModels) {
    const key = modelDedupeKey(model);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...model, source: 'sessions' });
  }
  return out;
}

export const MODEL_DISCOVERY_DEFAULTS = Object.freeze({
  limit: SESSION_HISTORY_LIMIT,
});

export function externalModelsUrlForSource(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return '';
  if (!parsed.hostname || parsed.username || parsed.password) return '';
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname
    .replace(/\/+$/, '')
    .replace(/\/v1\/models$/i, '')
    .replace(/\/models$/i, '')
    .replace(/\/v1$/i, '');
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/v1/models`;
  return parsed.toString();
}

export function normalizeExternalModelSourceList(sourceUrls = []) {
  const seen = new Set();
  const normalized = [];
  for (const value of Array.isArray(sourceUrls) ? sourceUrls : []) {
    const url = externalModelsUrlForSource(value);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    normalized.push(url);
  }
  return normalized;
}

function externalProviderLabel(modelsUrl = '') {
  try {
    const parsed = new URL(modelsUrl);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return 'custom';
  }
}

export async function discoverModelsFromExternalSources({
  sourceUrls = [],
  fetchFn = globalThis.fetch?.bind(globalThis),
  timeoutMs = 5000,
} = {}) {
  const urls = normalizeExternalModelSourceList(sourceUrls);
  if (!urls.length) return { ok: true, models: [], results: [] };
  if (typeof fetchFn !== 'function') return { ok: false, error: 'no-fetch', models: [], results: [] };

  const results = [];
  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(fetchFn, url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      }, timeoutMs);
      if (!response.ok) {
        results.push({ url, ok: false, error: `status-${response.status}`, models: [] });
        continue;
      }
      const payload = await response.json();
      const rows = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
          ? payload.data
          : Array.isArray(payload?.models)
            ? payload.models
            : [];
      const providerLabel = externalProviderLabel(url);
      const provider = `custom:${providerLabel}`;
      const models = rows
        .map((entry) => {
          const rawModelId = String(typeof entry === 'string' ? entry : entry?.id || entry?.model || entry?.name || '').trim();
          if (!rawModelId) return null;
          return {
            id: `${provider}::${rawModelId}`,
            rawModelId,
            label: typeof entry === 'object' ? (entry.label || entry.name || rawModelId) : rawModelId,
            provider,
            providerLabel,
            description: `Discovered from ${url}`,
            contextTokens: contextTokensFromObject(entry),
            source: 'external',
            runtimeSelectable: false,
          };
        })
        .filter(Boolean);
      results.push({ url, ok: true, models });
    } catch (error) {
      results.push({
        url,
        ok: false,
        error: error?.name === 'AbortError' ? 'timeout' : (error?.message || 'error'),
        models: [],
      });
    }
  }
  return { ok: results.some((result) => result.ok), models: mergeModelsByRawId(results.map((result) => result.models)), results };
}
