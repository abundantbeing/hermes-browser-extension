import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ReadableStream } from 'node:stream/web';
import { setImmediate } from 'node:timers';
import vm from 'node:vm';

import {
  modelCatalogCacheKey,
  normalizeCachedModelCatalog,
  selectModelCatalogFallback,
  modelsFromModelOptionsPayload,
  discoverModelsFromRegistry,
  discoverCanonicalProviderCatalog,
  NOUS_LIVE_MODEL_CATALOG_URL,
  HERMES_CANONICAL_MODEL_CATALOG_URL,
  shouldEnrichCanonicalProviderCatalog,
  shouldTrySessionModelFallback,
  modelCatalogRefreshDecision,
  discoverGatewayVirtualModels,
  gatewayVirtualModelRows,
  mergeVirtualModelRows,
  mergeModelsByRawId,
  mergeModelsWithRegistry,
  MODEL_CATALOG_CACHE_STORAGE_KEY,
  MODEL_CATALOG_SHARED_CACHE_PROFILE,
  globalModelCatalogCacheKey,
  catalogProvidersTouchedByDiscovery,
  filterModelsForAuthoritativeProviderInventory,
  mergeSharedModelCatalog,
  reconcileScopedAndSharedCachedCatalog,
  providerSlugsFromModelOptionsPayload,
  shouldPersistAuthoritativeModelCatalog,
  shouldPreferCachedCatalogOverSparseLiveDiscovery,
  unionCachedModelCatalogs,
  profileDefaultModelFromOptions,
  resolveDiscoveredProviderSlugs,
  resolveProfileSessionModel,
  normalizeExternalModelSourceList,
  discoverModelsFromExternalSources,
  raceModelDiscovery,
} from '../extension/lib/model-discovery.mjs';
import {
  DEFAULT_SETTINGS,
  normalizeHermesModels,
} from '../extension/lib/common.mjs';

function raceDiscoveryTimerSpies() {
  const clearedIds = [];
  let scheduledId;
  const timers = {
    setTimeout(callback, delayMs) {
      scheduledId = setTimeout(callback, delayMs);
      return scheduledId;
    },
    clearTimeout(timeoutId) {
      clearedIds.push(timeoutId);
      clearTimeout(timeoutId);
    },
  };
  return { timers, clearedIds, scheduledId: () => scheduledId };
}

test('raceModelDiscovery clears its timeout when discovery resolves first', async () => {
  const { timers, clearedIds, scheduledId } = raceDiscoveryTimerSpies();
  const outcome = await raceModelDiscovery(
    Promise.resolve({ ok: true, models: [{ id: 'demo::m1' }] }),
    20_000,
    timers,
  );
  assert.equal(outcome.ok, true);
  assert.equal(clearedIds.length, 1, 'race timeout must be cleared after discovery resolves');
  assert.equal(clearedIds[0], scheduledId());
});

test('raceModelDiscovery clears its timeout when discovery rejects', async () => {
  const { timers, clearedIds, scheduledId } = raceDiscoveryTimerSpies();
  await assert.rejects(
    () => raceModelDiscovery(Promise.reject(new Error('discovery failed')), 20_000, timers),
    /discovery failed/,
  );
  assert.equal(clearedIds.length, 1, 'race timeout must be cleared after discovery rejects');
  assert.equal(clearedIds[0], scheduledId());
});

test('fetchWithTimeout keeps healthy real Response objects readable', async () => {
  const result = await discoverModelsFromExternalSources({
    sourceUrls: ['https://example.test/catalog.json'],
    fetchFn: async () => new Response(JSON.stringify({ data: [{ id: 'm1', name: 'Model One' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
    timeoutMs: 5000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0]?.ok, true);
  assert.equal(result.results[0]?.models?.length, 1);
  assert.equal(result.results[0]?.models?.[0]?.rawModelId, 'm1');
});

test('canonical catalog keeps static fallback when live Nous body read times out', async () => {
  const registryModels = [{
    id: 'nous::openai/gpt-5.6-luna',
    rawModelId: 'openai/gpt-5.6-luna',
    provider: 'nous',
    providerLabel: 'Nous Portal',
    authenticated: true,
    runtimeSelectable: true,
  }];
  const stalledLiveBody = new ReadableStream({
    pull() {},
  });
  const result = await discoverCanonicalProviderCatalog({
    registryModels,
    timeoutMs: 80,
    fetchFn: async (url) => {
      if (String(url) === NOUS_LIVE_MODEL_CATALOG_URL) {
        return new Response(stalledLiveBody, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (String(url) === HERMES_CANONICAL_MODEL_CATALOG_URL) {
        return new Response(JSON.stringify({
          providers: {
            nous: { models: [{ id: 'moonshotai/kimi-k3' }] },
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected-url:${url}`);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'canonical');
  assert.ok(result.models.some((model) => model.rawModelId === 'moonshotai/kimi-k3'));
});

test('discoverModelsFromExternalSources times out when the response body stalls after headers', async () => {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    json: () => new Promise(() => {}),
    text: () => new Promise(() => {}),
  });
  const started = Date.now();
  const result = await discoverModelsFromExternalSources({
    sourceUrls: ['https://openrouter.ai/api/v1/models'],
    fetchFn,
    timeoutMs: 80,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, 'stalled body reads must not hang catalog discovery');
  assert.equal(result.ok, false);
  assert.ok(result.results.some((entry) => entry.error === 'timeout'));
});

test('the shared catalog cache key is profile-independent and distinct from every profile key', () => {
  const shared = globalModelCatalogCacheKey({ gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642' });
  assert.equal(shared, 'local-api|http://127.0.0.1:8642|__shared__');
  for (const profile of ['default', 'namine', 'riku', '']) {
    const scoped = modelCatalogCacheKey({ gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', profile });
    assert.notEqual(scoped, shared);
  }
  assert.equal(MODEL_CATALOG_SHARED_CACHE_PROFILE, '__shared__');
});

test('unionCachedModelCatalogs merges every profile cache into one deduped catalog', () => {
  const cache = {
    'local-api|gw|default': {
      savedAt: 100,
      models: [
        { id: 'nous::z-ai/glm-5.3-flash', rawModelId: 'z-ai/glm-5.3-flash', provider: 'nous', contextTokens: 200000 },
        { id: 'nous::qwen-max', rawModelId: 'qwen-max', provider: 'nous' },
      ],
    },
    'local-api|gw|namine': {
      savedAt: 200,
      models: [
        // Fresher metadata for the shared row must win.
        { id: 'nous::qwen-max', rawModelId: 'qwen-max', provider: 'nous', contextTokens: 32768 },
        { id: 'nous::minimax/minimax-m3', rawModelId: 'minimax/minimax-m3', provider: 'nous' },
      ],
    },
  };
  const union = unionCachedModelCatalogs(cache);
  assert.equal(union.length, 2, 'an older profile slot must not resurrect retired provider models');
  const qwen = union.find((model) => model.rawModelId === 'qwen-max');
  assert.equal(qwen.contextTokens, 32768, 'freshest entry wins on conflicts');
  assert.ok(union.some((model) => model.rawModelId === 'minimax/minimax-m3'));
  assert.ok(!union.some((model) => model.rawModelId === 'z-ai/glm-5.3-flash'));
  // Empty/garbage entries degrade to an empty union, never a throw.
  assert.deepEqual(unionCachedModelCatalogs(null), []);
  assert.deepEqual(unionCachedModelCatalogs({ a: { savedAt: 1, models: [] }, b: {} }), []);
});

test('model catalog fallback prefers cached canonical providers over session history', () => {
  const cached = [
    {
      id: 'openrouter::nvidia/nemotron-3-ultra-550b-a55b:free',
      rawModelId: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      provider: 'openrouter',
      providerLabel: 'OpenRouter',
      source: 'registry',
      runtimeSelectable: true,
    },
  ];
  const sessions = [
    {
      id: 'gpt-5.5',
      rawModelId: 'gpt-5.5',
      provider: 'openai-codex',
      source: 'sessions',
      runtimeSelectable: false,
    },
  ];

  assert.deepEqual(selectModelCatalogFallback({ cachedModels: cached, sessionModels: sessions }), {
    models: cached,
    source: 'cache',
  });
});

test('model catalog fallback only uses session history when no canonical cache exists', () => {
  const sessions = [{ id: 'gpt-5.5', source: 'sessions' }];
  assert.deepEqual(selectModelCatalogFallback({ sessionModels: sessions }), {
    models: sessions,
    source: 'sessions',
  });
});

test('cached catalog does not trigger session-history expansion', async () => {
  const { shouldTrySessionModelFallback } = await import('../extension/lib/model-discovery.mjs');
  assert.equal(shouldTrySessionModelFallback({
    registrySource: 'cache',
    registryModels: [{ id: 'openrouter::model', source: 'cache' }],
  }), false);
});

test('normalizeCachedModelCatalog drops selected placeholders before persisting shared cache', () => {
  const selectedOnly = normalizeHermesModels(
    { data: [{ id: 'custom::only-live', rawModelId: 'only-live', provider: 'custom' }] },
    'qwen-token-plan::qwen3.8-max',
  );
  const models = normalizeCachedModelCatalog(selectedOnly);
  assert.ok(
    models.some((model) => model.id === 'custom::only-live'),
    'verified provider rows must still be cached',
  );
  assert.ok(
    !models.some((model) => model.id === 'qwen-token-plan::qwen3.8-max'),
    'provider-less selected placeholders must not be written to the catalog cache',
  );
});

test('unionCachedModelCatalogs keeps verified provider rows when a provider-less placeholder shares the cache key', () => {
  const verified = {
    id: 'qwen-token-plan::qwen3.8-max',
    rawModelId: 'qwen3.8-max',
    provider: 'qwen-token-plan',
    source: 'cache',
    runtimeSelectable: true,
  };
  const placeholder = {
    id: 'qwen-token-plan::qwen3.8-max',
    label: 'qwen-token-plan::qwen3.8-max',
    owner: 'selected',
    source: 'cache',
    runtimeSelectable: false,
  };
  const union = unionCachedModelCatalogs({
    older: { savedAt: 100, models: [verified] },
    newer: { savedAt: 200, models: [placeholder] },
  });
  assert.equal(union.length, 1);
  assert.equal(union[0].provider, 'qwen-token-plan');
  assert.equal(union[0].runtimeSelectable, true);
});

test('cached catalog normalization keeps provider identity, strips malformed rows, and drops stale gateway aliases', () => {
  const models = normalizeCachedModelCatalog([
    {
      id: 'openrouter::nvidia/nemotron-3-ultra-550b-a55b:free',
      rawModelId: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      provider: 'openrouter',
      providerLabel: 'OpenRouter',
      source: 'registry',
      runtimeSelectable: true,
    },
    {
      id: 'custom-hermes-alias',
      rawModelId: 'custom-hermes-alias',
      provider: '',
      gatewayAlias: true,
      gatewayDefault: true,
      source: 'gateway',
      runtimeSelectable: true,
    },
    null,
    { label: 'missing id' },
  ]);

  assert.equal(models.length, 1);
  assert.equal(models[0].provider, 'openrouter');
  assert.equal(models[0].rawModelId, 'nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.equal(models[0].source, 'cache');
});

test('model catalog cache keys isolate gateway and profile', () => {
  assert.notEqual(
    modelCatalogCacheKey({ gatewayMode: 'local-api', gatewayUrl: '', profile: 'default' }),
    modelCatalogCacheKey({ gatewayMode: 'remote-dashboard', gatewayUrl: 'https://example.test', profile: 'default' }),
  );
  assert.notEqual(
    modelCatalogCacheKey({ gatewayMode: 'remote-dashboard', gatewayUrl: 'https://example.test', profile: 'default' }),
    modelCatalogCacheKey({ gatewayMode: 'remote-dashboard', gatewayUrl: 'https://example.test', profile: 'work' }),
  );
});

test('gateway model options never fabricate a Hermes provider row', () => {
  const models = modelsFromModelOptionsPayload({
    providers: [
      { slug: 'deepseek', name: 'DeepSeek', authenticated: true, is_current: true, models: ['deepseek-v4-pro'] },
      { slug: 'nous', name: 'Nous Portal', authenticated: true, models: ['openai/gpt-5.6-luna'] },
    ],
  });

  assert.deepEqual(models.map((model) => model.id), [
    'deepseek::deepseek-v4-pro',
    'nous::openai/gpt-5.6-luna',
  ]);
  assert.ok(!models.some((model) => model.provider === 'hermes'));
  assert.equal(models[0].current, true);
});

test('gateway virtual model rows come only from the live OpenAI models endpoint', () => {
  const models = gatewayVirtualModelRows({
    data: [
      {
        id: 'browser-primary',
        object: 'model',
        owned_by: 'hermes-agent',
        root: 'browser-primary',
        parent: null,
      },
      {
        id: 'fast-route',
        object: 'model',
        owned_by: 'configured',
        root: 'fast-route',
        parent: 'browser-primary',
      },
      { id: '', object: 'model', owned_by: 'hermes-agent' },
      { id: 'alias --global', object: 'model', owned_by: 'configured', parent: 'browser-primary' },
      { id: 'foreign-model', object: 'model', owned_by: 'openai', parent: null },
      null,
    ],
  });

  assert.deepEqual(models.map((model) => model.id), ['browser-primary', 'fast-route']);
  assert.deepEqual(models.map((model) => model.provider), ['', '']);
  assert.equal(models[0].gatewayDefault, true);
  assert.equal(models[1].gatewayDefault, false);
  assert.equal(models[0].gatewayAlias, true);
  assert.equal(models[0].source, 'gateway');
  assert.equal(models[0].runtimeSelectable, true);
  assert.equal(models[0].current, true);
});

test('gateway virtual model discovery fails closed when /v1/models is unavailable', async () => {
  const calls = [];
  const ok = await discoverGatewayVirtualModels({
    apiFetch: async (endpoint, options) => {
      calls.push([endpoint, options?.method]);
      return { ok: true, status: 200 };
    },
    readJsonResponse: async () => ({
      data: [{ id: 'custom-hermes-alias', object: 'model', owned_by: 'hermes-agent', parent: null }],
    }),
  });
  assert.deepEqual(calls, [['/v1/models', 'GET']]);
  assert.equal(ok.ok, true);
  assert.equal(ok.models[0].id, 'custom-hermes-alias');
  assert.equal(ok.models[0].provider, '');

  const unavailable = await discoverGatewayVirtualModels({
    apiFetch: async () => ({ ok: false, status: 404 }),
    readJsonResponse: async () => ({ error: { message: 'not found' } }),
  });
  assert.deepEqual(unavailable, {
    ok: false,
    models: [],
    error: 'not found',
    source: 'gateway',
  });
});

test('gateway virtual model merge keeps the live default, avoids duplicate routes, and preserves provider truth', () => {
  const merged = mergeVirtualModelRows({
    registryModels: [
      { id: 'deepseek::deepseek-v4-pro', rawModelId: 'deepseek-v4-pro', provider: 'deepseek', source: 'registry' },
      { id: 'nous::openai/gpt-5.6-luna', rawModelId: 'openai/gpt-5.6-luna', provider: 'nous', source: 'registry' },
    ],
    virtualModels: gatewayVirtualModelRows({
      data: [
        { id: 'browser-primary', object: 'model', owned_by: 'hermes', parent: null },
        { id: 'deepseek-v4-pro', object: 'model', owned_by: 'hermes', parent: 'browser-primary' },
        { id: 'fast-route', object: 'model', owned_by: 'hermes', parent: 'browser-primary' },
      ],
    }),
  });

  assert.deepEqual(merged.map((model) => model.id), [
    'browser-primary',
    'fast-route',
    'deepseek::deepseek-v4-pro',
    'nous::openai/gpt-5.6-luna',
  ]);
  assert.equal(merged.find((model) => model.rawModelId === 'deepseek-v4-pro')?.provider, 'deepseek');
});

test('the side panel merges only live gateway aliases into provider-aware catalogs', () => {
  for (const relativePath of ['../extension/sidepanel.js']) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, /discoverGatewayVirtualModels\(\{/);
    assert.match(source, /mergeVirtualModelRows\(\{/);
    assert.match(source, /gatewayDefault:/);
  }
  const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(sidepanelSource, /if\s*\(!isRemoteWsMode\(\)\s*&&\s*registrySource !== 'gateway'\)/);
  const discoverySource = readFileSync(new URL('../extension/lib/model-discovery.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(discoverySource, /provider:\s*['"]hermes['"]/);
});

test('gateway model options mark the current provider without claiming a virtual default', () => {
  const models = modelsFromModelOptionsPayload({
    providers: [
      { slug: 'deepseek', name: 'DeepSeek', authenticated: true, is_current: true, models: ['deepseek-v4-pro'] },
      { slug: 'nous', name: 'Nous Portal', authenticated: true, is_current: false, models: ['openai/gpt-5.6-luna'] },
    ],
  });
  const deepseek = models.find((model) => model.provider === 'deepseek');
  const nous = models.find((model) => model.provider === 'nous');
  assert.equal(deepseek.current, true);
  assert.equal(nous.current, false);
});

test('canonical catalog does not overlay authenticated direct providers', async () => {
  const result = await discoverCanonicalProviderCatalog({
    registryModels: [
      {
        id: 'nous::openai/gpt-5.6-luna',
        rawModelId: 'openai/gpt-5.6-luna',
        provider: 'nous',
        providerLabel: 'Nous Portal',
        authenticated: true,
        runtimeSelectable: true,
      },
      {
        id: 'deepseek::deepseek-v4-pro',
        rawModelId: 'deepseek-v4-pro',
        provider: 'deepseek',
        providerLabel: 'DeepSeek',
        authenticated: true,
        current: true,
        runtimeSelectable: true,
      },
    ],
    fetchFn: async (url) => ({
      ok: true,
      status: 200,
      json: async () => String(url).includes('inference-api.nousresearch.com')
        ? { data: [{ id: 'poolside/laguna-s-2.1', name: 'Poolside: Laguna S 2.1' }] }
        : {
            providers: {
              nous: { models: [{ id: 'moonshotai/kimi-k3' }] },
              deepseek: { models: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-chat-fake' }] },
            },
          },
    }),
  });
  const ids = result.models.map((model) => model.id);
  // Nous Portal still receives canonical enrichment…
  assert.ok(ids.includes('nous::poolside/laguna-s-2.1'));
  assert.ok(ids.includes('nous::moonshotai/kimi-k3'));
  // …but DeepSeek keeps exactly its gateway-advertised row: the catalog must
  // never invent extra rows for authenticated direct providers (issue #61).
  assert.ok(ids.includes('deepseek::deepseek-v4-pro'));
  assert.ok(!ids.includes('deepseek::deepseek-chat-fake'));
  assert.equal(result.models.filter((model) => model.provider === 'deepseek').length, 1);
});

test('resolveProfileSessionModel prefers the live /api/model/options default over a stale roster row', () => {
  assert.deepEqual(profileDefaultModelFromOptions({ model: 'deepseek-v4', provider: 'nous' }), {
    model: 'deepseek-v4',
    provider: 'nous',
  });
  assert.equal(profileDefaultModelFromOptions({ model: '', provider: 'nous' }), null);
  assert.deepEqual(
    resolveProfileSessionModel({
      rosterModel: 'z-ai/glm-5.3-flash',
      rosterProvider: 'nous',
      optionsPayload: { model: 'grok-4.6', provider: 'xai' },
    }),
    { model: 'grok-4.6', provider: 'xai' },
  );
  assert.deepEqual(
    resolveProfileSessionModel({
      rosterModel: 'z-ai/glm-5.3-flash',
      rosterProvider: 'nous',
      optionsPayload: { model: '', provider: '' },
    }),
    { model: 'z-ai/glm-5.3-flash', provider: 'nous' },
  );
  assert.equal(resolveProfileSessionModel({ rosterModel: '', optionsPayload: {} }), null);
});

test('unionCachedModelCatalogs drops stale profile provider rows even when the live catalog omits that provider', () => {
  const cache = {
    'local-api|gw|secondary': {
      savedAt: 100,
      models: [
        { id: 'custom::legacy-a', rawModelId: 'legacy-a', provider: 'custom' },
        { id: 'custom::legacy-b', rawModelId: 'legacy-b', provider: 'custom' },
      ],
    },
    'local-api|gw|default': {
      savedAt: 200,
      models: [
        { id: 'custom::live-only', rawModelId: 'live-only', provider: 'custom' },
      ],
    },
    'local-api|gw|__shared__': {
      savedAt: 200,
      models: [
        { id: 'custom::live-only', rawModelId: 'live-only', provider: 'custom' },
      ],
    },
  };
  const union = unionCachedModelCatalogs(cache, {
    gatewayPrefix: 'local-api|gw|',
  });
  assert.deepEqual(union.map((model) => model.id), ['custom::live-only']);
});

test('mergeSharedModelCatalog clears providers explicitly returned with an empty model list', () => {
  const sharedModels = [
    { id: 'retired::gone-model', rawModelId: 'gone-model', provider: 'retired' },
    { id: 'other::still-here', rawModelId: 'still-here', provider: 'other' },
  ];
  const freshModels = [
    { id: 'custom::live-only', rawModelId: 'live-only', provider: 'custom' },
  ];
  const merged = mergeSharedModelCatalog({
    sharedModels,
    freshModels,
    freshProviders: new Set(['custom', 'retired']),
  });
  assert.deepEqual(merged.map((model) => model.id), [
    'other::still-here',
    'custom::live-only',
  ]);
});

test('shouldPreferCachedCatalogOverSparseLiveDiscovery keeps an authoritative one-model registry reply', () => {
  const cached = [{ id: 'nous::old-a', rawModelId: 'old-a', provider: 'nous' }, { id: 'nous::old-b', rawModelId: 'old-b', provider: 'nous' }];
  const singleLive = [{ id: 'custom::only-one', rawModelId: 'only-one', provider: 'custom', source: 'registry' }];
  assert.equal(shouldPreferCachedCatalogOverSparseLiveDiscovery({
    registryModels: singleLive,
    registrySource: 'registry',
    cachedCatalogModels: cached,
  }), false);
  assert.equal(shouldPreferCachedCatalogOverSparseLiveDiscovery({
    registryModels: [{ id: 'hermes-agent', gatewayAlias: true }],
    registrySource: 'gateway',
    cachedCatalogModels: cached,
  }), true);
});

test('discoverModelsFromRegistry clears empty providers in shared union via replacedProviders', async () => {
  const payload = {
    providers: [
      { slug: 'retired', name: 'Retired', models: [] },
      { slug: 'custom', name: 'Custom', models: ['live-only'] },
    ],
  };
  const apiFetch = async (endpoint) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(endpoint === '/api/model/options?refresh=true' || endpoint === '/api/model/options' ? payload : {}),
  });
  const readJsonResponse = async (response) => JSON.parse(await response.text());
  const discovered = await discoverModelsFromRegistry({ apiFetch, readJsonResponse, refresh: true });
  assert.equal(discovered.ok, true);
  assert.deepEqual([...discovered.providerSlugs].sort(), ['custom', 'retired']);
  const sharedModels = [
    { id: 'retired::gone-model', rawModelId: 'gone-model', provider: 'retired' },
    { id: 'omitted::still-here', rawModelId: 'still-here', provider: 'omitted' },
  ];
  const merged = mergeSharedModelCatalog({
    sharedModels,
    freshModels: discovered.models,
    freshProviders: discovered.providerSlugs,
  });
  const replacedProviders = [...catalogProvidersTouchedByDiscovery({
    models: discovered.models,
    providerSlugs: discovered.providerSlugs,
  })];
  const cache = {
    'local-api|http://127.0.0.1:8642|secondary': {
      savedAt: 100,
      models: [{ id: 'retired::stale-slot', rawModelId: 'stale-slot', provider: 'retired' }],
    },
    'local-api|http://127.0.0.1:8642|__shared__': {
      savedAt: 200,
      models: merged,
      replacedProviders,
    },
  };
  const union = unionCachedModelCatalogs(cache, {
    gatewayPrefix: 'local-api|http://127.0.0.1:8642|',
    excludeProviders: discovered.providerSlugs,
  });
  assert.deepEqual(union.map((model) => model.id), ['omitted::still-here']);
  const pickerModels = mergeModelsByRawId([discovered.models, union]);
  assert.deepEqual(pickerModels.map((model) => model.id).sort(), [
    'custom::live-only',
    'omitted::still-here',
  ]);
});

test('unionCachedModelCatalogs honors replacedProviders on an otherwise empty provider snapshot', () => {
  const cache = {
    'local-api|gw|secondary': {
      savedAt: 100,
      models: [{ id: 'retired::stale', rawModelId: 'stale', provider: 'retired' }],
    },
    'local-api|gw|__shared__': {
      savedAt: 200,
      models: [{ id: 'custom::live', rawModelId: 'live', provider: 'custom' }],
      replacedProviders: ['retired', 'custom'],
    },
  };
  const union = unionCachedModelCatalogs(cache, { gatewayPrefix: 'local-api|gw|' });
  assert.deepEqual(union.map((model) => model.id), ['custom::live']);
});

test('filterModelsForAuthoritativeProviderInventory drops resurrected rows for explicitly empty providers', () => {
  const slugs = new Set(['retired', 'custom']);
  const models = [
    { id: 'retired::gone', provider: 'retired' },
    { id: 'custom::live-only', provider: 'custom' },
    { id: 'omitted::kept', provider: 'omitted' },
  ];
  const filtered = filterModelsForAuthoritativeProviderInventory(models, slugs, [
    { id: 'custom::live-only', provider: 'custom' },
  ]);
  assert.deepEqual(filtered.map((model) => model.id), [
    'custom::live-only',
    'omitted::kept',
  ]);
});

test('shouldPersistAuthoritativeModelCatalog matches registry and dashboard discovery sources only', () => {
  assert.equal(shouldPersistAuthoritativeModelCatalog('registry'), true);
  assert.equal(shouldPersistAuthoritativeModelCatalog('dashboard'), true);
  assert.equal(shouldPersistAuthoritativeModelCatalog('registry+external'), true);
  assert.equal(shouldPersistAuthoritativeModelCatalog('cache'), false);
  assert.equal(shouldPersistAuthoritativeModelCatalog('gateway'), false);
});

test('resolveDiscoveredProviderSlugs prefers the raw options payload over model rows', () => {
  const slugs = resolveDiscoveredProviderSlugs({
    optionsPayload: {
      providers: [
        { slug: 'retired', models: [] },
        { slug: 'custom', models: ['live-only'] },
      ],
    },
    providerSlugs: new Set(['custom']),
    models: [{ id: 'custom::live-only', provider: 'custom' }],
  });
  assert.deepEqual([...slugs].sort(), ['custom', 'retired']);
});

test('providerSlugsFromModelOptionsPayload keeps empty provider slots authoritative', () => {
  const slugs = providerSlugsFromModelOptionsPayload({
    providers: [
      { slug: 'custom', models: [{ id: 'only-one' }] },
      { slug: 'retired', models: [] },
    ],
  });
  assert.deepEqual([...slugs].sort(), ['custom', 'retired']);
});

test('reconcileScopedAndSharedCachedCatalog honors per-provider freshness from shared replacedProviders', () => {
  const liveIds = ['gemini-4-hydrogen', 'gpt-oss-120b'];
  const staleIds = ['legacy-flash', 'retired-preview'];
  const scopedEntry = {
    savedAt: 300,
    models: [...liveIds, ...staleIds].map((id) => ({
      id: `custom::${id}`,
      rawModelId: id,
      provider: 'custom',
      source: 'cache',
    })),
  };
  const sharedEntry = {
    savedAt: 200,
    replacedProviders: ['custom'],
    models: liveIds.map((id) => ({
      id: `custom::${id}`,
      rawModelId: id,
      provider: 'custom',
      source: 'cache',
    })),
  };
  const reconciled = reconcileScopedAndSharedCachedCatalog(scopedEntry, sharedEntry);
  assert.deepEqual(
    reconciled.map((m) => m.rawModelId).sort(),
    [...liveIds].sort(),
    'newer shared provider snapshot must override an older scoped slot without resurrecting removed models',
  );
});

test('mergeSharedModelCatalog prunes removed models from live providers while preserving absent providers', () => {
  const sharedModels = [
    { id: 'custom::legacy-flash', rawModelId: 'legacy-flash', provider: 'custom' },
    { id: 'custom::removed-preview', rawModelId: 'removed-preview', provider: 'custom' },
    { id: 'custom::gemini-4-hydrogen', rawModelId: 'gemini-4-hydrogen', provider: 'custom' },
    { id: 'qwen-token-plan::qwen3.8-max', rawModelId: 'qwen3.8-max', provider: 'qwen-token-plan' },
  ];
  const freshModels = [
    { id: 'custom::gemini-4-hydrogen', rawModelId: 'gemini-4-hydrogen', provider: 'custom' },
    { id: 'custom::gpt-oss-120b', rawModelId: 'gpt-oss-120b', provider: 'custom' },
  ];
  const merged = mergeSharedModelCatalog({ sharedModels, freshModels });
  assert.deepEqual(merged.map((m) => m.id), [
    'qwen-token-plan::qwen3.8-max',
    'custom::gemini-4-hydrogen',
    'custom::gpt-oss-120b',
  ]);
});

test('unionCachedModelCatalogs scopes to gatewayPrefix, excludes live providers, and keeps same-named models across providers', () => {
  const cache = {
    'local-api|http://127.0.0.1:8642|secondary': {
      savedAt: 100,
      models: [
        { id: 'custom::legacy-flash', rawModelId: 'legacy-flash', provider: 'custom' },
        { id: 'custom::gemini-4-hydrogen', provider: 'custom', contextTokens: 256_000 },
        { id: 'nous::deepseek-v4', rawModelId: 'deepseek-v4', provider: 'nous' },
      ],
    },
    'local-api|http://127.0.0.1:8642|default': {
      savedAt: 200,
      models: [
        { id: 'custom::gemini-4-hydrogen', rawModelId: 'gemini-4-hydrogen', provider: 'custom', contextTokens: 1_048_576 },
        { id: 'gemini::gemini-4-hydrogen', rawModelId: 'gemini-4-hydrogen', provider: 'gemini' },
      ],
    },
    'remote-dashboard|https://other.test|default': {
      savedAt: 300,
      models: [
        { id: 'other::secret-model', rawModelId: 'secret-model', provider: 'other' },
      ],
    },
  };
  const filtered = unionCachedModelCatalogs(cache, {
    gatewayPrefix: 'local-api|http://127.0.0.1:8642|',
    excludeProviders: ['custom'],
  });
  assert.deepEqual(filtered.map((m) => m.id), [
    'nous::deepseek-v4',
    'gemini::gemini-4-hydrogen',
  ]);
  const unfilteredLocal = unionCachedModelCatalogs(cache, {
    gatewayPrefix: 'local-api|http://127.0.0.1:8642|',
  });
  assert.equal(unfilteredLocal.filter((m) => m.provider === 'custom' && String(m.id).includes('gemini-4-hydrogen')).length, 1);
  assert.equal(unfilteredLocal.find((m) => m.id === 'custom::gemini-4-hydrogen')?.contextTokens, 1_048_576);
  assert.ok(unfilteredLocal.some((m) => m.id === 'gemini::gemini-4-hydrogen'));
});

test('sidepanel loadModels prunes stale provider models across cache slots, preserves other providers, and keeps context windows', async () => {
  const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const between = (start, end) => {
    const from = sidepanelSource.indexOf(start);
    assert.ok(from >= 0, `sidepanel.js defines ${start}`);
    const to = sidepanelSource.indexOf(end, from);
    assert.ok(to > from, `sidepanel.js has ${end} after ${start}`);
    return sidepanelSource.slice(from, to);
  };

  const liveFourIds = [
    'gemini-4-hydrogen',
    'claude-opus-5-5-high',
    'claude-sonnet-5-5-high',
    'gpt-oss-120b',
  ];
  const staleRetiredIds = [
    'legacy-pro-1',
    'legacy-flash-2',
    'retired-preview-3',
    'retired-alpha-4',
  ];
  const staleProviderRows = [...liveFourIds, ...staleRetiredIds].map((id) => ({
    id: `custom::${id}`,
    rawModelId: id,
    label: id,
    provider: 'custom',
    providerLabel: 'Custom Endpoint',
    source: 'cache',
    runtimeSelectable: true,
  }));
  const qwenRow = {
    id: 'qwen-token-plan::qwen3.8-max',
    rawModelId: 'qwen3.8-max',
    label: 'qwen3.8-max',
    provider: 'qwen-token-plan',
    providerLabel: 'Qwen Token Plan',
    source: 'cache',
    runtimeSelectable: true,
  };
  const storageState = {
    [MODEL_CATALOG_CACHE_STORAGE_KEY]: {
      'local-api|http://127.0.0.1:8642|__shared__': {
        savedAt: 100,
        models: [...staleProviderRows, qwenRow],
      },
      'local-api|http://127.0.0.1:8642|default': {
        savedAt: 100,
        models: [...staleProviderRows],
      },
      'local-api|http://127.0.0.1:8642|secondary': {
        savedAt: 200,
        models: staleRetiredIds.map((id) => ({
          id: `custom::${id}`,
          rawModelId: id,
          label: id,
          provider: 'custom',
          providerLabel: 'Custom Endpoint',
          source: 'cache',
          runtimeSelectable: true,
        })),
      },
    },
  };

  let registryHealthy = true;
  const liveOptionsPayload = {
    providers: [
      {
        slug: 'custom',
        name: 'Custom Endpoint',
        authenticated: true,
        source: 'user-config',
        models: liveFourIds,
        capabilities: Object.fromEntries(liveFourIds.map((id) => [id, { fast: false, reasoning: true }])),
      },
    ],
  };

  const context = vm.createContext({
    DEFAULT_SETTINGS,
    MODEL_CATALOG_CACHE_STORAGE_KEY,
    MODEL_CATALOG_SHARED_CACHE_PROFILE,
    settings: { ...DEFAULT_SETTINGS, gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', activeProfile: 'default', model: 'custom::gemini-4-hydrogen' },
    availableModels: [],
    modelsRefreshing: false,
    modelCatalogRefreshDeferred: false,
    browserApi: {
      storage: {
        local: {
          get: async (keys) => Object.fromEntries(keys.map((k) => [k, storageState[k]])),
          set: async (patch) => { Object.assign(storageState, patch); },
        },
      },
    },
    apiFetch: async (endpoint) => {
      if (!registryHealthy) return { ok: false, status: 503, text: async () => '{}' };
      if (String(endpoint).startsWith('/api/model/options')) {
        return { ok: true, status: 200, text: async () => JSON.stringify(liveOptionsPayload) };
      }
      if (endpoint === '/v1/models') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ object: 'list', data: [{ id: 'hermes-agent', object: 'model', owned_by: 'hermes', parent: null }] }) };
      }
      return { ok: false, status: 404, text: async () => '{}' };
    },
    readJsonResponse: async (res) => JSON.parse(await res.text()),
    discoverModelsFromRegistry,
    raceModelDiscovery,
    discoverModelsFromExternalSources,
    discoverModelsFromDashboard: async () => ({ ok: false, models: [] }),
    discoverGatewayVirtualModels,
    discoverCanonicalProviderCatalog,
    shouldEnrichCanonicalProviderCatalog,
    shouldTrySessionModelFallback,
    modelCatalogRefreshDecision,
    normalizeCachedModelCatalog,
    normalizeExternalModelSourceList,
    normalizeHermesModels,
    selectModelCatalogFallback,
    mergeVirtualModelRows,
    mergeSharedModelCatalog,
    reconcileScopedAndSharedCachedCatalog,
    mergeModelsByRawId,
    mergeModelsWithRegistry,
    catalogProvidersTouchedByDiscovery,
    filterModelsForAuthoritativeProviderInventory,
    resolveDiscoveredProviderSlugs,
    providerSlugsFromModelOptionsPayload,
    shouldPersistAuthoritativeModelCatalog,
    shouldPreferCachedCatalogOverSparseLiveDiscovery,
    unionCachedModelCatalogs,
    modelCatalogCacheKey,
    globalModelCatalogCacheKey,
    isRemoteWsMode: () => false,
    usesDashboardWsChatTransport: () => false,
    localDashboardUrl: () => '',
    dashboardModelDiscoveryBaseUrl: () => '',
    dashboardTokenFor: async () => '',
    refreshHermesContextRegistry: async () => ({ ok: true }),
    noteModelCatalogForGatewayContext() {},
    reconcileInlineAssistModelBinding: async () => {},
    renderModelOptions() {},
    renderModelRefreshState() {},
    renderContextWindow() {},
    applySelectedModel() {},
    setStatus() {},
    translateUiText: (text) => text,
    t: (key) => key,
    classifyGatewayError: () => ({ kind: 'unknown', title: 'err', detail: 'err' }),
    markGatewayDegraded() {},
    sanitizeGatewayDiagnosticText: (msg) => msg,
    setTimeout,
    setImmediate,
  });

  vm.runInContext([
    'let modelCatalogLoadSerial = 0;\nlet modelCatalogSerializedLoads = Promise.resolve();',
    between('async function readCachedModelCatalog()', '// Union of every profile\'s cached catalog'),
    between('async function readCachedModelCatalogUnion(', 'let modelCatalogSyncPromise = null;'),
    between('async function loadModels(', 'async function refreshModelsFromMenu()'),
  ].join('\n'), context);

  // Confirm the timeout allows slower /api/model/options?refresh=true responses (>2.5s)
  assert.match(sidepanelSource, /const registryTimeoutMs = refresh \? 20_000 : 5_000;/);
  assert.match(sidepanelSource, /raceModelDiscovery\(/);
  assert.match(sidepanelSource, /raceModelDiscovery\(\s*\n\s*discoverModelsFromRegistry/);
  assert.match(sidepanelSource, /raceModelDiscovery\(\s*\n\s*discoverModelsFromDashboard/);

  const liveOutcome = await context.loadModels({ quiet: true, refresh: true });
  assert.equal(liveOutcome.ok, true);
  assert.equal(liveOutcome.source, 'registry');

  const customLive = context.availableModels.filter((m) => m.provider === 'custom');
  assert.equal(customLive.length, 4, 'live loadModels must keep only the 4 current models');
  assert.deepEqual(customLive.map((m) => m.rawModelId).sort(), [...liveFourIds].sort());
  assert.deepEqual(
    Object.fromEntries(customLive.map((m) => [m.rawModelId, m.contextTokens])),
    {
      'gemini-4-hydrogen': 1_048_576,
      'claude-opus-5-5-high': 1_000_000,
      'claude-sonnet-5-5-high': 1_000_000,
      'gpt-oss-120b': 131_072,
    },
  );
  assert.ok(context.availableModels.some((m) => m.id === 'qwen-token-plan::qwen3.8-max'), 'unrelated provider from shared cache survives');

  const updatedCache = storageState[MODEL_CATALOG_CACHE_STORAGE_KEY];
  assert.equal(
    updatedCache['local-api|http://127.0.0.1:8642|__shared__'].models.filter((m) => m.provider === 'custom').length,
    4,
    'shared cache slot must drop deleted provider models',
  );
  assert.equal(
    updatedCache['local-api|http://127.0.0.1:8642|default'].models.filter((m) => m.provider === 'custom').length,
    4,
    'active profile cache slot must keep only the 4 live provider models',
  );

  // Even when the gateway later fails and loadModels falls back to cache,
  // secondary's retired entries must never leak back into default.
  registryHealthy = false;
  const fallbackOutcome = await context.loadModels({ quiet: true, refresh: false });
  assert.equal(fallbackOutcome.ok, true);
  assert.equal(fallbackOutcome.source, 'cache');
  const customCached = context.availableModels.filter((m) => m.provider === 'custom');
  assert.equal(customCached.length, 4, 'cache fallback must not resurrect stale models from other profiles');

  // Switch to secondary (which still holds an older cache entry from t=200)
  // while discovery is offline: the newer __shared__ snapshot from default
  // must win over secondary's older slot so removed models stay gone.
  context.settings.activeProfile = 'secondary';
  const secondaryFallback = await context.loadModels({ quiet: true, refresh: false });
  assert.equal(secondaryFallback.ok, true);
  assert.equal(secondaryFallback.source, 'cache');
  const secondaryCustom = context.availableModels.filter((m) => m.provider === 'custom');
  assert.deepEqual(
    secondaryCustom.map((m) => m.rawModelId).sort(),
    [...liveFourIds].sort(),
    'switching to a profile with an older cache must use the newer shared snapshot instead of resurrecting retired models',
  );
});

test('loadModels stale replies do not overwrite cache after profile switch', async () => {
  const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const between = (start, end) => {
    const from = sidepanelSource.indexOf(start);
    assert.ok(from >= 0, `sidepanel.js defines ${start}`);
    const to = sidepanelSource.indexOf(end, from);
    assert.ok(to > from, `sidepanel.js has ${end} after ${start}`);
    return sidepanelSource.slice(from, to);
  };

  let releaseRegistry;
  const registryGate = new Promise((resolve) => { releaseRegistry = resolve; });

  const storageState = {
    [MODEL_CATALOG_CACHE_STORAGE_KEY]: {
      'local-api|http://127.0.0.1:8642|default': { savedAt: 1, models: [] },
      'local-api|http://127.0.0.1:8642|secondary': { savedAt: 1, models: [] },
      'local-api|http://127.0.0.1:8642|__shared__': { savedAt: 1, models: [] },
    },
  };

  const context = vm.createContext({
    DEFAULT_SETTINGS,
    MODEL_CATALOG_CACHE_STORAGE_KEY,
    MODEL_CATALOG_SHARED_CACHE_PROFILE,
    settings: { ...DEFAULT_SETTINGS, gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', activeProfile: 'default', model: 'custom::gemini-4-hydrogen' },
    availableModels: [],
    modelsRefreshing: false,
    modelCatalogRefreshDeferred: false,
    browserApi: {
      storage: {
        local: {
          get: async (keys) => Object.fromEntries(keys.map((k) => [k, storageState[k]])),
          set: async (patch) => { Object.assign(storageState, patch); },
        },
      },
    },
    apiFetch: async (endpoint) => {
      if (String(endpoint).startsWith('/api/model/options')) {
        await registryGate;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            providers: [{ slug: 'custom', name: 'Custom', models: ['profile-default-model'] }],
          }),
        };
      }
      return { ok: false, status: 404, text: async () => '{}' };
    },
    readJsonResponse: async (res) => JSON.parse(await res.text()),
    discoverModelsFromRegistry,
    raceModelDiscovery,
    discoverModelsFromExternalSources,
    discoverModelsFromDashboard: async () => ({ ok: false, models: [] }),
    discoverGatewayVirtualModels,
    discoverCanonicalProviderCatalog: async ({ registryModels }) => ({ models: registryModels }),
    shouldEnrichCanonicalProviderCatalog,
    shouldTrySessionModelFallback,
    modelCatalogRefreshDecision,
    normalizeCachedModelCatalog,
    normalizeExternalModelSourceList,
    normalizeHermesModels,
    selectModelCatalogFallback,
    mergeVirtualModelRows,
    mergeSharedModelCatalog,
    reconcileScopedAndSharedCachedCatalog,
    mergeModelsByRawId,
    mergeModelsWithRegistry,
    catalogProvidersTouchedByDiscovery,
    filterModelsForAuthoritativeProviderInventory,
    resolveDiscoveredProviderSlugs,
    providerSlugsFromModelOptionsPayload,
    shouldPersistAuthoritativeModelCatalog,
    shouldPreferCachedCatalogOverSparseLiveDiscovery,
    unionCachedModelCatalogs,
    modelCatalogCacheKey,
    globalModelCatalogCacheKey,
    isRemoteWsMode: () => false,
    usesDashboardWsChatTransport: () => false,
    localDashboardUrl: () => '',
    dashboardModelDiscoveryBaseUrl: () => '',
    dashboardTokenFor: async () => '',
    refreshHermesContextRegistry: async () => ({ ok: true }),
    noteModelCatalogForGatewayContext() {},
    reconcileInlineAssistModelBinding: async () => {},
    renderModelOptions() {},
    renderModelRefreshState() {},
    renderContextWindow() {},
    applySelectedModel() {},
    setStatus() {},
    translateUiText: (text) => text,
    t: (key) => key,
    classifyGatewayError: () => ({ kind: 'unknown', title: 'err', detail: 'err' }),
    markGatewayDegraded() {},
    sanitizeGatewayDiagnosticText: (msg) => msg,
    setTimeout,
    setImmediate,
  });

  vm.runInContext([
    'let modelCatalogLoadSerial = 0;\nlet modelCatalogSerializedLoads = Promise.resolve();',
    between('async function readCachedModelCatalog()', 'let modelCatalogSyncPromise = null;'),
    between('async function loadModels(', 'async function refreshModelsFromMenu()'),
  ].join('\n'), context);

  const pending = context.loadModels({ quiet: true, refresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  context.settings.activeProfile = 'secondary';
  releaseRegistry();
  const staleOutcome = await pending;
  assert.equal(staleOutcome.stale, true);
  const updatedCache = storageState[MODEL_CATALOG_CACHE_STORAGE_KEY];
  assert.ok(!updatedCache['local-api|http://127.0.0.1:8642|secondary']?.models?.some(
    (model) => model.rawModelId === 'profile-default-model',
  ), 'stale default refresh must not write into the secondary profile slot');
});

test('loadModels removes emptied provider models from availableModels after authoritative refresh', async () => {
  const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const between = (start, end) => {
    const from = sidepanelSource.indexOf(start);
    assert.ok(from >= 0, `sidepanel.js defines ${start}`);
    const to = sidepanelSource.indexOf(end, from);
    assert.ok(to > from, `sidepanel.js has ${end} after ${start}`);
    return sidepanelSource.slice(from, to);
  };

  const storageState = {
    [MODEL_CATALOG_CACHE_STORAGE_KEY]: {
      'local-api|http://127.0.0.1:8642|__shared__': {
        savedAt: 1,
        models: [
          { id: 'retired::gone', rawModelId: 'gone', provider: 'retired', source: 'cache', runtimeSelectable: true },
          { id: 'omitted::kept', rawModelId: 'kept', provider: 'omitted', source: 'cache', runtimeSelectable: true },
        ],
      },
      'local-api|http://127.0.0.1:8642|default': { savedAt: 1, models: [] },
    },
  };

  const context = vm.createContext({
    DEFAULT_SETTINGS,
    MODEL_CATALOG_CACHE_STORAGE_KEY,
    MODEL_CATALOG_SHARED_CACHE_PROFILE,
    settings: { ...DEFAULT_SETTINGS, gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', activeProfile: 'default', model: 'custom::live-only' },
    availableModels: [],
    modelsRefreshing: false,
    modelCatalogRefreshDeferred: false,
    browserApi: {
      storage: {
        local: {
          get: async (keys) => Object.fromEntries(keys.map((k) => [k, storageState[k]])),
          set: async (patch) => { Object.assign(storageState, patch); },
        },
      },
    },
    apiFetch: async (endpoint) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(
        String(endpoint).startsWith('/api/model/options')
          ? {
            providers: [
              { slug: 'retired', name: 'Retired', models: [] },
              { slug: 'custom', name: 'Custom', models: ['live-only'] },
            ],
          }
          : {},
      ),
    }),
    readJsonResponse: async (res) => JSON.parse(await res.text()),
    discoverModelsFromRegistry,
    raceModelDiscovery,
    discoverModelsFromExternalSources,
    discoverModelsFromDashboard: async () => ({ ok: false, models: [] }),
    discoverGatewayVirtualModels,
    discoverCanonicalProviderCatalog: async ({ registryModels }) => ({ models: registryModels }),
    shouldEnrichCanonicalProviderCatalog,
    shouldTrySessionModelFallback,
    modelCatalogRefreshDecision,
    normalizeCachedModelCatalog,
    normalizeExternalModelSourceList,
    normalizeHermesModels,
    selectModelCatalogFallback,
    mergeVirtualModelRows,
    mergeSharedModelCatalog,
    reconcileScopedAndSharedCachedCatalog,
    mergeModelsByRawId,
    mergeModelsWithRegistry,
    catalogProvidersTouchedByDiscovery,
    filterModelsForAuthoritativeProviderInventory,
    resolveDiscoveredProviderSlugs,
    providerSlugsFromModelOptionsPayload,
    shouldPersistAuthoritativeModelCatalog,
    shouldPreferCachedCatalogOverSparseLiveDiscovery,
    unionCachedModelCatalogs,
    modelCatalogCacheKey,
    globalModelCatalogCacheKey,
    isRemoteWsMode: () => false,
    usesDashboardWsChatTransport: () => false,
    localDashboardUrl: () => '',
    dashboardModelDiscoveryBaseUrl: () => '',
    dashboardTokenFor: async () => '',
    refreshHermesContextRegistry: async () => ({ ok: true }),
    noteModelCatalogForGatewayContext() {},
    reconcileInlineAssistModelBinding: async () => {},
    renderModelOptions() {},
    renderModelRefreshState() {},
    renderContextWindow() {},
    applySelectedModel() {},
    setStatus() {},
    translateUiText: (text) => text,
    t: (key) => key,
    classifyGatewayError: () => ({ kind: 'unknown', title: 'err', detail: 'err' }),
    markGatewayDegraded() {},
    sanitizeGatewayDiagnosticText: (msg) => msg,
    setTimeout,
    setImmediate,
  });

  vm.runInContext([
    'let modelCatalogLoadSerial = 0;\nlet modelCatalogSerializedLoads = Promise.resolve();',
    between('async function readCachedModelCatalog()', 'let modelCatalogSyncPromise = null;'),
    between('async function loadModels(', 'async function refreshModelsFromMenu()'),
  ].join('\n'), context);

  const outcome = await context.loadModels({ quiet: true, refresh: true });
  assert.equal(outcome.ok, true);
  assert.ok(context.availableModels.some((model) => model.id === 'custom::live-only'));
  assert.ok(context.availableModels.some((model) => model.id === 'omitted::kept'));
  assert.ok(!context.availableModels.some((model) => model.provider === 'retired'));
  const cache = storageState[MODEL_CATALOG_CACHE_STORAGE_KEY];
  assert.ok(cache['local-api|http://127.0.0.1:8642|__shared__'].replacedProviders.includes('retired'));
  assert.ok(!cache['local-api|http://127.0.0.1:8642|__shared__'].models.some((model) => model.provider === 'retired'));
});

test('loadModels reruns a deferred profile refresh after an in-flight refresh finishes', async () => {
  const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const between = (start, end) => {
    const from = sidepanelSource.indexOf(start);
    assert.ok(from >= 0, `sidepanel.js defines ${start}`);
    const to = sidepanelSource.indexOf(end, from);
    assert.ok(to > from, `sidepanel.js has ${end} after ${start}`);
    return sidepanelSource.slice(from, to);
  };

  let releaseRegistry;
  const registryGate = new Promise((resolve) => { releaseRegistry = resolve; });
  let refreshCallCount = 0;

  const context = vm.createContext({
    DEFAULT_SETTINGS,
    MODEL_CATALOG_CACHE_STORAGE_KEY,
    MODEL_CATALOG_SHARED_CACHE_PROFILE,
    settings: { ...DEFAULT_SETTINGS, gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', activeProfile: 'default', model: 'custom::gemini-4-hydrogen' },
    availableModels: [],
    modelsRefreshing: false,
    modelCatalogRefreshDeferred: false,
    browserApi: {
      storage: {
        local: {
          get: async () => ({ [MODEL_CATALOG_CACHE_STORAGE_KEY]: {} }),
          set: async () => {},
        },
      },
    },
    apiFetch: async (endpoint) => {
      if (String(endpoint).startsWith('/api/model/options')) {
        refreshCallCount += 1;
        await registryGate;
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          providers: [{ slug: 'custom', name: 'Custom', models: [`call-${refreshCallCount}`] }],
        }),
      };
    },
    readJsonResponse: async (res) => JSON.parse(await res.text()),
    discoverModelsFromRegistry,
    raceModelDiscovery,
    discoverModelsFromExternalSources,
    discoverModelsFromDashboard: async () => ({ ok: false, models: [] }),
    discoverGatewayVirtualModels,
    discoverCanonicalProviderCatalog: async ({ registryModels }) => ({ models: registryModels }),
    shouldEnrichCanonicalProviderCatalog,
    shouldTrySessionModelFallback,
    modelCatalogRefreshDecision,
    normalizeCachedModelCatalog,
    normalizeExternalModelSourceList,
    normalizeHermesModels,
    selectModelCatalogFallback,
    mergeVirtualModelRows,
    mergeSharedModelCatalog,
    reconcileScopedAndSharedCachedCatalog,
    mergeModelsByRawId,
    mergeModelsWithRegistry,
    catalogProvidersTouchedByDiscovery,
    filterModelsForAuthoritativeProviderInventory,
    resolveDiscoveredProviderSlugs,
    providerSlugsFromModelOptionsPayload,
    shouldPersistAuthoritativeModelCatalog,
    shouldPreferCachedCatalogOverSparseLiveDiscovery,
    unionCachedModelCatalogs,
    modelCatalogCacheKey,
    globalModelCatalogCacheKey,
    isRemoteWsMode: () => false,
    usesDashboardWsChatTransport: () => false,
    localDashboardUrl: () => '',
    dashboardModelDiscoveryBaseUrl: () => '',
    dashboardTokenFor: async () => '',
    refreshHermesContextRegistry: async () => ({ ok: true }),
    noteModelCatalogForGatewayContext() {},
    reconcileInlineAssistModelBinding: async () => {},
    renderModelOptions() {},
    renderModelRefreshState() {},
    renderContextWindow() {},
    applySelectedModel() {},
    setStatus() {},
    translateUiText: (text) => text,
    t: (key) => key,
    classifyGatewayError: () => ({ kind: 'unknown', title: 'err', detail: 'err' }),
    markGatewayDegraded() {},
    sanitizeGatewayDiagnosticText: (msg) => msg,
    setTimeout,
    setImmediate,
  });

  vm.runInContext([
    'let modelCatalogLoadSerial = 0;\nlet modelCatalogSerializedLoads = Promise.resolve();',
    between('async function readCachedModelCatalog()', 'let modelCatalogSyncPromise = null;'),
    between('async function loadModels(', 'async function refreshModelsFromMenu()'),
  ].join('\n'), context);

  const first = context.loadModels({ quiet: true, refresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  const second = context.loadModels({ quiet: true, refresh: true });
  assert.equal((await second).skipped, true);
  releaseRegistry();
  assert.equal((await first).ok, true);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (context.availableModels.some((model) => model.rawModelId === 'call-2')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(context.availableModels.some((model) => model.rawModelId === 'call-2'), 'deferred refresh must run for the superseded profile');
});

test('loadModels cache fallback uses newer shared provider rows when scoped cache is older', async () => {
  const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const between = (start, end) => {
    const from = sidepanelSource.indexOf(start);
    assert.ok(from >= 0, `sidepanel.js defines ${start}`);
    const to = sidepanelSource.indexOf(end, from);
    assert.ok(to > from, `sidepanel.js has ${end} after ${start}`);
    return sidepanelSource.slice(from, to);
  };

  const liveIds = ['gemini-4-hydrogen', 'gpt-oss-120b'];
  const staleIds = ['legacy-flash', 'retired-preview'];
  const storageState = {
    [MODEL_CATALOG_CACHE_STORAGE_KEY]: {
      'local-api|http://127.0.0.1:8642|default': {
        savedAt: 300,
        models: [...liveIds, ...staleIds].map((id) => ({
          id: `custom::${id}`,
          rawModelId: id,
          provider: 'custom',
          source: 'cache',
          runtimeSelectable: true,
        })),
      },
      'local-api|http://127.0.0.1:8642|__shared__': {
        savedAt: 200,
        replacedProviders: ['custom'],
        models: liveIds.map((id) => ({
          id: `custom::${id}`,
          rawModelId: id,
          provider: 'custom',
          source: 'cache',
          runtimeSelectable: true,
        })),
      },
    },
  };

  const context = vm.createContext({
    DEFAULT_SETTINGS,
    MODEL_CATALOG_CACHE_STORAGE_KEY,
    MODEL_CATALOG_SHARED_CACHE_PROFILE,
    settings: { ...DEFAULT_SETTINGS, gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', activeProfile: 'default', model: 'custom::gemini-4-hydrogen' },
    availableModels: [],
    modelsRefreshing: false,
    modelCatalogRefreshDeferred: false,
    browserApi: {
      storage: {
        local: {
          get: async (keys) => Object.fromEntries(keys.map((k) => [k, storageState[k]])),
          set: async (patch) => { Object.assign(storageState, patch); },
        },
      },
    },
    apiFetch: async () => ({ ok: false, status: 503, text: async () => '{}' }),
    readJsonResponse: async (res) => JSON.parse(await res.text()),
    discoverModelsFromRegistry,
    raceModelDiscovery,
    discoverModelsFromExternalSources,
    discoverModelsFromDashboard: async () => ({ ok: false, models: [] }),
    discoverGatewayVirtualModels,
    discoverCanonicalProviderCatalog: async ({ registryModels }) => ({ models: registryModels }),
    shouldEnrichCanonicalProviderCatalog,
    shouldTrySessionModelFallback,
    modelCatalogRefreshDecision,
    normalizeCachedModelCatalog,
    normalizeExternalModelSourceList,
    normalizeHermesModels,
    selectModelCatalogFallback,
    mergeVirtualModelRows,
    mergeSharedModelCatalog,
    reconcileScopedAndSharedCachedCatalog,
    mergeModelsByRawId,
    mergeModelsWithRegistry,
    catalogProvidersTouchedByDiscovery,
    filterModelsForAuthoritativeProviderInventory,
    resolveDiscoveredProviderSlugs,
    providerSlugsFromModelOptionsPayload,
    shouldPersistAuthoritativeModelCatalog,
    shouldPreferCachedCatalogOverSparseLiveDiscovery,
    unionCachedModelCatalogs,
    modelCatalogCacheKey,
    globalModelCatalogCacheKey,
    isRemoteWsMode: () => false,
    usesDashboardWsChatTransport: () => false,
    localDashboardUrl: () => '',
    dashboardModelDiscoveryBaseUrl: () => '',
    dashboardTokenFor: async () => '',
    refreshHermesContextRegistry: async () => ({ ok: true }),
    noteModelCatalogForGatewayContext() {},
    reconcileInlineAssistModelBinding: async () => {},
    renderModelOptions() {},
    renderModelRefreshState() {},
    renderContextWindow() {},
    applySelectedModel() {},
    setStatus() {},
    translateUiText: (text) => text,
    t: (key) => key,
    classifyGatewayError: () => ({ kind: 'unknown', title: 'err', detail: 'err' }),
    markGatewayDegraded() {},
    sanitizeGatewayDiagnosticText: (msg) => msg,
    setTimeout,
    setImmediate,
  });

  vm.runInContext([
    'let modelCatalogLoadSerial = 0;\nlet modelCatalogSerializedLoads = Promise.resolve();',
    between('async function readCachedModelCatalog()', '// Union of every profile\'s cached catalog'),
    between('async function readCachedModelCatalogUnion(', 'let modelCatalogSyncPromise = null;'),
    between('async function loadModels(', 'async function refreshModelsFromMenu()'),
  ].join('\n'), context);

  const outcome = await context.loadModels({ quiet: true, refresh: false });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.source, 'cache');
  const customModels = context.availableModels.filter((m) => m.provider === 'custom');
  assert.deepEqual(
    customModels.map((m) => m.rawModelId).sort(),
    [...liveIds].sort(),
    'cache-only load must not treat stale scoped rows as authoritative over a fresher shared provider snapshot',
  );
});

test('loadModels queues quiet loads behind an in-flight manual refresh', async () => {
  const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const between = (start, end) => {
    const from = sidepanelSource.indexOf(start);
    assert.ok(from >= 0, `sidepanel.js defines ${start}`);
    const to = sidepanelSource.indexOf(end, from);
    assert.ok(to > from, `sidepanel.js has ${end} after ${start}`);
    return sidepanelSource.slice(from, to);
  };

  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  let registryCalls = 0;
  let refreshFinished = false;

  const storageState = {
    [MODEL_CATALOG_CACHE_STORAGE_KEY]: {
      'local-api|http://127.0.0.1:8642|default': { savedAt: 1, models: [] },
      'local-api|http://127.0.0.1:8642|__shared__': { savedAt: 1, models: [] },
    },
  };

  const context = vm.createContext({
    DEFAULT_SETTINGS,
    MODEL_CATALOG_CACHE_STORAGE_KEY,
    MODEL_CATALOG_SHARED_CACHE_PROFILE,
    settings: { ...DEFAULT_SETTINGS, gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', activeProfile: 'default', model: 'custom::after-refresh' },
    availableModels: [],
    modelsRefreshing: false,
    modelCatalogRefreshDeferred: false,
    browserApi: {
      storage: {
        local: {
          get: async (keys) => Object.fromEntries(keys.map((k) => [k, storageState[k]])),
          set: async (patch) => { Object.assign(storageState, patch); },
        },
      },
    },
    apiFetch: async (endpoint) => {
      if (!String(endpoint).startsWith('/api/model/options')) {
        return { ok: false, status: 404, text: async () => '{}' };
      }
      registryCalls += 1;
      if (registryCalls === 1) {
        await refreshGate;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            providers: [{ slug: 'custom', models: ['after-refresh'] }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          providers: [{ slug: 'custom', models: ['after-refresh'] }],
        }),
      };
    },
    readJsonResponse: async (res) => JSON.parse(await res.text()),
    discoverModelsFromRegistry,
    raceModelDiscovery,
    discoverModelsFromExternalSources,
    discoverModelsFromDashboard: async () => ({ ok: false, models: [] }),
    discoverGatewayVirtualModels,
    discoverCanonicalProviderCatalog: async ({ registryModels }) => ({ models: registryModels }),
    shouldEnrichCanonicalProviderCatalog,
    shouldTrySessionModelFallback,
    modelCatalogRefreshDecision,
    normalizeCachedModelCatalog,
    normalizeExternalModelSourceList,
    normalizeHermesModels,
    selectModelCatalogFallback,
    mergeVirtualModelRows,
    mergeSharedModelCatalog,
    reconcileScopedAndSharedCachedCatalog,
    mergeModelsByRawId,
    mergeModelsWithRegistry,
    catalogProvidersTouchedByDiscovery,
    filterModelsForAuthoritativeProviderInventory,
    resolveDiscoveredProviderSlugs,
    providerSlugsFromModelOptionsPayload,
    shouldPersistAuthoritativeModelCatalog,
    shouldPreferCachedCatalogOverSparseLiveDiscovery,
    unionCachedModelCatalogs,
    modelCatalogCacheKey,
    globalModelCatalogCacheKey,
    isRemoteWsMode: () => false,
    usesDashboardWsChatTransport: () => false,
    localDashboardUrl: () => '',
    dashboardModelDiscoveryBaseUrl: () => '',
    dashboardTokenFor: async () => '',
    refreshHermesContextRegistry: async () => ({ ok: true }),
    noteModelCatalogForGatewayContext() {},
    reconcileInlineAssistModelBinding: async () => {},
    renderModelOptions() {},
    renderModelRefreshState() {},
    renderContextWindow() {},
    applySelectedModel() {},
    setStatus() {},
    translateUiText: (text) => text,
    t: (key) => key,
    classifyGatewayError: () => ({ kind: 'unknown', title: 'err', detail: 'err' }),
    markGatewayDegraded() {},
    sanitizeGatewayDiagnosticText: (msg) => msg,
    setTimeout,
    setImmediate,
  });

  vm.runInContext([
    'let modelCatalogLoadSerial = 0;\nlet modelCatalogSerializedLoads = Promise.resolve();',
    between('async function readCachedModelCatalog()', 'let modelCatalogSyncPromise = null;'),
    between('async function loadModels(', 'async function refreshModelsFromMenu()'),
  ].join('\n'), context);

  const refreshPending = context.loadModels({ quiet: true, refresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  let quietFinishedBeforeRefresh = false;
  const quietPending = context.loadModels({ quiet: true, refresh: false }).then((outcome) => {
    quietFinishedBeforeRefresh = !refreshFinished;
    return outcome;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registryCalls, 1, 'quiet loads must wait behind an in-flight refresh');
  releaseRefresh();
  const refreshOutcome = await refreshPending;
  assert.equal(refreshOutcome.ok, true);
  refreshFinished = true;
  const quietOutcome = await quietPending;
  assert.equal(quietFinishedBeforeRefresh, false);
  assert.equal(quietOutcome.ok, true);
  const cachedDefault = storageState[MODEL_CATALOG_CACHE_STORAGE_KEY]['local-api|http://127.0.0.1:8642|default'];
  assert.ok(cachedDefault?.models?.some((model) => model.rawModelId === 'after-refresh'));
  assert.ok(!cachedDefault?.models?.some((model) => model.rawModelId === 'stale-quiet'), 'queued quiet loads must not overwrite a completed refresh cache write');
});

test('loadModels persists gateway catalog without custom external discovery rows', async () => {
  const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const between = (start, end) => {
    const from = sidepanelSource.indexOf(start);
    assert.ok(from >= 0, `sidepanel.js defines ${start}`);
    const to = sidepanelSource.indexOf(end, from);
    assert.ok(to > from, `sidepanel.js has ${end} after ${start}`);
    return sidepanelSource.slice(from, to);
  };

  const storageState = {
    [MODEL_CATALOG_CACHE_STORAGE_KEY]: {
      'local-api|http://127.0.0.1:8642|default': { savedAt: 1, models: [] },
      'local-api|http://127.0.0.1:8642|__shared__': { savedAt: 1, models: [] },
    },
  };

  const context = vm.createContext({
    DEFAULT_SETTINGS,
    MODEL_CATALOG_CACHE_STORAGE_KEY,
    MODEL_CATALOG_SHARED_CACHE_PROFILE,
    settings: {
      ...DEFAULT_SETTINGS,
      gatewayMode: 'local-api',
      gatewayUrl: 'http://127.0.0.1:8642',
      activeProfile: 'default',
      model: 'custom::gateway-only',
      customModelSources: ['https://models.example/openapi.json'],
    },
    availableModels: [],
    modelsRefreshing: false,
    modelCatalogRefreshDeferred: false,
    browserApi: {
      storage: {
        local: {
          get: async (keys) => Object.fromEntries(keys.map((k) => [k, storageState[k]])),
          set: async (patch) => { Object.assign(storageState, patch); },
        },
      },
    },
    apiFetch: async (endpoint) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(
        String(endpoint).startsWith('/api/model/options')
          ? { providers: [{ slug: 'custom', models: ['gateway-only'] }] }
          : {},
      ),
    }),
    readJsonResponse: async (res) => JSON.parse(await res.text()),
    discoverModelsFromRegistry,
    raceModelDiscovery,
    discoverModelsFromExternalSources: async () => ({
      ok: true,
      models: [{
        id: 'custom:evil::ghost-model',
        rawModelId: 'ghost-model',
        provider: 'custom:evil',
        source: 'external',
        runtimeSelectable: true,
      }],
      results: [{ ok: true }],
    }),
    discoverModelsFromDashboard: async () => ({ ok: false, models: [] }),
    discoverGatewayVirtualModels,
    discoverCanonicalProviderCatalog: async ({ registryModels }) => ({ models: registryModels }),
    shouldEnrichCanonicalProviderCatalog,
    shouldTrySessionModelFallback,
    modelCatalogRefreshDecision,
    normalizeCachedModelCatalog,
    normalizeExternalModelSourceList,
    normalizeHermesModels,
    selectModelCatalogFallback,
    mergeVirtualModelRows,
    mergeSharedModelCatalog,
    reconcileScopedAndSharedCachedCatalog,
    mergeModelsByRawId,
    mergeModelsWithRegistry,
    catalogProvidersTouchedByDiscovery,
    filterModelsForAuthoritativeProviderInventory,
    resolveDiscoveredProviderSlugs,
    providerSlugsFromModelOptionsPayload,
    shouldPersistAuthoritativeModelCatalog,
    shouldPreferCachedCatalogOverSparseLiveDiscovery,
    unionCachedModelCatalogs,
    modelCatalogCacheKey,
    globalModelCatalogCacheKey,
    isRemoteWsMode: () => false,
    usesDashboardWsChatTransport: () => false,
    localDashboardUrl: () => '',
    dashboardModelDiscoveryBaseUrl: () => '',
    dashboardTokenFor: async () => '',
    refreshHermesContextRegistry: async () => ({ ok: true }),
    noteModelCatalogForGatewayContext() {},
    reconcileInlineAssistModelBinding: async () => {},
    renderModelOptions() {},
    renderModelRefreshState() {},
    renderContextWindow() {},
    applySelectedModel() {},
    setStatus() {},
    translateUiText: (text) => text,
    t: (key) => key,
    classifyGatewayError: () => ({ kind: 'unknown', title: 'err', detail: 'err' }),
    markGatewayDegraded() {},
    sanitizeGatewayDiagnosticText: (msg) => msg,
    setTimeout,
    setImmediate,
  });

  vm.runInContext([
    'let modelCatalogLoadSerial = 0;\nlet modelCatalogSerializedLoads = Promise.resolve();',
    between('async function readCachedModelCatalog()', 'let modelCatalogSyncPromise = null;'),
    between('async function loadModels(', 'async function refreshModelsFromMenu()'),
  ].join('\n'), context);

  const outcome = await context.loadModels({ quiet: true, refresh: true });
  assert.equal(outcome.ok, true);
  assert.ok(context.availableModels.some((model) => model.rawModelId === 'ghost-model'), 'external discovery stays in the live picker');
  const cached = storageState[MODEL_CATALOG_CACHE_STORAGE_KEY];
  const profileModels = cached['local-api|http://127.0.0.1:8642|default']?.models || [];
  const sharedModels = cached['local-api|http://127.0.0.1:8642|__shared__']?.models || [];
  assert.ok(profileModels.some((model) => model.rawModelId === 'gateway-only'));
  assert.ok(!profileModels.some((model) => model.rawModelId === 'ghost-model'));
  assert.ok(!sharedModels.some((model) => model.rawModelId === 'ghost-model'));
});
