import test from 'node:test';
import assert from 'node:assert/strict';

import {
  modelCatalogCacheKey,
  normalizeCachedModelCatalog,
  selectModelCatalogFallback,
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
