import test from 'node:test';
import assert from 'node:assert/strict';

import {
  modelCatalogCacheKey,
  normalizeCachedModelCatalog,
  selectModelCatalogFallback,
  modelsFromModelOptionsPayload,
  discoverCanonicalProviderCatalog,
} from '../extension/lib/model-discovery.mjs';

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

test('cached catalog normalization keeps provider-qualified identity and strips malformed rows', () => {
  const models = normalizeCachedModelCatalog([
    {
      id: 'openrouter::nvidia/nemotron-3-ultra-550b-a55b:free',
      rawModelId: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      provider: 'openrouter',
      providerLabel: 'OpenRouter',
      source: 'registry',
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

test('gateway model options always include the synthetic hermes-agent meta-model', () => {
    const models = modelsFromModelOptionsPayload({
      providers: [
        { slug: 'deepseek', name: 'DeepSeek', authenticated: true, is_current: true, models: ['deepseek-v4-pro'] },
        { slug: 'nous', name: 'Nous Portal', authenticated: true, models: ['openai/gpt-5.6-luna'] },
      ],
    });
    // hermes-agent is the gateway's primary model even though /api/model/options
    // never lists it among configured providers (issue #61).
    assert.equal(models[0].id, 'hermes-agent');
    assert.equal(models[0].rawModelId, 'hermes-agent');
    assert.equal(models[0].provider, 'hermes');
    assert.equal(models[0].providerLabel, 'Hermes Agent');
    assert.equal(models[0].runtimeSelectable, true);
    assert.equal(models[0].authenticated, true);
    // The configured providers keep their gateway-format raw ids untouched.
    assert.ok(models.some((model) => model.id === 'deepseek::deepseek-v4-pro' && model.rawModelId === 'deepseek-v4-pro'));
    assert.ok(models.some((model) => model.id === 'nous::openai/gpt-5.6-luna'));
  });

test('gateway model options mark the current provider', () => {
  const models = modelsFromModelOptionsPayload({
    providers: [
      { slug: 'deepseek', name: 'DeepSeek', authenticated: true, is_current: true, models: ['deepseek-v4-pro'] },
      { slug: 'nous', name: 'Nous Portal', authenticated: true, is_current: false, models: ['openai/gpt-5.6-luna'] },
    ],
  });
  assert.equal(models[0].current, true); // hermes-agent is always current
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
