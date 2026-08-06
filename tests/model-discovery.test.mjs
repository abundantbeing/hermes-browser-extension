import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  modelCatalogCacheKey,
  normalizeCachedModelCatalog,
  selectModelCatalogFallback,
  modelsFromModelOptionsPayload,
  discoverCanonicalProviderCatalog,
  discoverGatewayVirtualModels,
  gatewayVirtualModelRows,
  mergeVirtualModelRows,
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

test('both Browser surfaces merge only live gateway aliases into provider-aware catalogs', () => {
  for (const relativePath of ['../extension/sidepanel.js', '../extension/app.js']) {
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
