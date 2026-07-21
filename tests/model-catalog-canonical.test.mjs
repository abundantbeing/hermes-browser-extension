import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import * as discovery from '../extension/lib/model-discovery.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('canonical Hermes catalog fills authenticated Nous Portal gaps from the live catalog', async () => {
  assert.equal(typeof discovery.discoverCanonicalProviderCatalog, 'function');
  const calls = [];
  const result = await discovery.discoverCanonicalProviderCatalog({
    registryModels: [
      {
        id: 'nous::openai/gpt-5.6-luna',
        rawModelId: 'openai/gpt-5.6-luna',
        label: 'openai/gpt-5.6-luna',
        provider: 'nous',
        providerLabel: 'Nous Portal',
        authenticated: true,
        runtimeSelectable: true,
      },
    ],
    fetchFn: async (url, options = {}) => {
      calls.push({ url: String(url), accept: options.headers?.Accept || '' });
      if (String(url) === 'https://inference-api.nousresearch.com/v1/models') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: 'moonshotai/kimi-k3', name: 'MoonshotAI: Kimi K3', context_length: 1_048_576 },
              { id: 'poolside/laguna-s-2.1', name: 'Poolside: Laguna S 2.1', context_length: 262_144 },
              { id: 'poolside/laguna-xs-2.1', name: 'Poolside: Laguna XS 2.1', context_length: 262_144 },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          providers: {
            nous: {
              models: [
                { id: 'openai/gpt-5.6-luna' },
                { id: 'moonshotai/kimi-k3', description: 'recommended', context_length: 1_048_576 },
              ],
            },
            openrouter: {
              models: [{ id: 'openrouter/should-not-appear' }],
            },
          },
        }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://inference-api.nousresearch.com/v1/models');
  assert.match(calls[1].url, /NousResearch\/hermes-agent\/main\/website\/static\/api\/model-catalog\.json$/);
  assert.ok(calls.every((call) => call.accept === 'application/json'));
  assert.deepEqual(result.models.map((model) => model.id), [
    'nous::openai/gpt-5.6-luna',
    'nous::moonshotai/kimi-k3',
    'nous::poolside/laguna-s-2.1',
    'nous::poolside/laguna-xs-2.1',
  ]);
  const kimi = result.models[1];
  assert.equal(kimi.providerLabel, 'Nous Portal');
  assert.equal(kimi.contextTokens, 1_048_576);
  assert.equal(kimi.runtimeSelectable, true);
  assert.equal(result.models[2].label, 'Poolside: Laguna S 2.1');
  assert.equal(result.models[3].label, 'Poolside: Laguna XS 2.1');
});

test('canonical Hermes catalog keeps the gateway list when the public catalog is unavailable', async () => {
  const registryModels = [{
    id: 'nous::openai/gpt-5.6-luna',
    rawModelId: 'openai/gpt-5.6-luna',
    provider: 'nous',
    providerLabel: 'Nous Portal',
    authenticated: true,
    runtimeSelectable: true,
  }];
  const result = await discovery.discoverCanonicalProviderCatalog({
    registryModels,
    fetchFn: async () => { throw new Error('offline'); },
    timeoutMs: 0,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.models, registryModels);
});

test('Nous Portal display labels receive the live catalog even when the gateway uses a portal alias', async () => {
  const result = await discovery.discoverCanonicalProviderCatalog({
    registryModels: [{
      id: 'portal::openai/gpt-5.6-luna',
      rawModelId: 'openai/gpt-5.6-luna',
      provider: 'portal',
      providerLabel: 'Nous Portal',
      authenticated: true,
      runtimeSelectable: true,
    }],
    fetchFn: async (url) => ({
      ok: true,
      status: 200,
      json: async () => String(url).includes('inference-api.nousresearch.com')
        ? { data: [{ id: 'poolside/laguna-s-2.1', name: 'Poolside: Laguna S 2.1' }] }
        : { providers: { nous: { models: [{ id: 'moonshotai/kimi-k3' }] } } },
    }),
  });
  assert.deepEqual(result.models.map((model) => model.id), [
    'portal::openai/gpt-5.6-luna',
    'portal::poolside/laguna-s-2.1',
    'portal::moonshotai/kimi-k3',
  ]);
});

test('cached provider catalogs are still eligible for live canonical enrichment', () => {
  assert.equal(typeof discovery.shouldEnrichCanonicalProviderCatalog, 'function');
  assert.equal(discovery.shouldEnrichCanonicalProviderCatalog('registry'), true);
  assert.equal(discovery.shouldEnrichCanonicalProviderCatalog('dashboard'), true);
  assert.equal(discovery.shouldEnrichCanonicalProviderCatalog('cache'), true);
  assert.equal(discovery.shouldEnrichCanonicalProviderCatalog('fallback'), false);
});

test('both Browser model surfaces enrich the live registry with the canonical Hermes catalog', () => {
  for (const file of ['extension/sidepanel.js', 'extension/app.js']) {
    const source = read(file);
    assert.match(source, /discoverCanonicalProviderCatalog/);
    assert.match(source, /shouldEnrichCanonicalProviderCatalog/);
    const loadModels = source.match(/async function loadModels\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    assert.match(loadModels, /discoverCanonicalProviderCatalog\(\{/);
  }
});
