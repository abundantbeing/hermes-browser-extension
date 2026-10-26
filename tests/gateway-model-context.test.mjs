import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bareModelId,
  createGatewayModelContext,
  gatewayModelContext,
} from '../extension/lib/gateway-model-context.mjs';
import { normalizeHermesModels } from '../extension/lib/common.mjs';
import { hermesContextForModel } from '../extension/lib/hermes-context-windows.mjs';

test('bareModelId reduces a qualified or vendor-prefixed id to what a gateway reports', () => {
  assert.equal(bareModelId('openai-codex::GPT-6.1-Sol'), 'gpt-6.1-sol');
  assert.equal(bareModelId('openai/gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(bareModelId(''), '');
});

test('a reading is found by model, and a provider-less reading applies to any provider', () => {
  const store = createGatewayModelContext();
  assert.equal(store.record({ model: 'gpt-6.1-sol', tokens: 500_000, source: 'session-usage' }), true);
  assert.equal(store.lookup({ id: 'openai::gpt-6.1-sol', rawModelId: 'gpt-6.1-sol', provider: 'openai' }), 500_000);
  assert.equal(store.lookup({ rawModelId: 'GPT-6.1-Sol' }), 500_000);
  assert.equal(store.lookup({ rawModelId: 'gpt-6.1-terra' }), 0);
});

test('a reading for another provider never leaks onto a row of a different provider', () => {
  const store = createGatewayModelContext();
  store.record({ model: 'gpt-6.1-sol', provider: 'openai-codex', tokens: 272_000 });
  assert.equal(store.lookup({ rawModelId: 'gpt-6.1-sol', provider: 'openai-codex' }), 272_000);
  assert.equal(store.lookup({ rawModelId: 'gpt-6.1-sol', provider: 'openai' }), 0);
  // a row that names no provider takes the newest reading of that model
  assert.equal(store.lookup({ rawModelId: 'gpt-6.1-sol' }), 272_000);
});

test('the provider-specific reading wins over a provider-less one', () => {
  const store = createGatewayModelContext();
  store.record({ model: 'm', tokens: 100_000 });
  store.record({ model: 'm', provider: 'p', tokens: 200_000 });
  assert.equal(store.lookup({ rawModelId: 'm', provider: 'p' }), 200_000);
  assert.equal(store.lookup({ rawModelId: 'm', provider: 'q' }), 100_000);
});

test('garbage is refused: no model, zero or absurd windows, prototype keys', () => {
  const store = createGatewayModelContext();
  for (const reading of [{ tokens: 5 }, { model: 'm', tokens: 0 }, { model: 'm', tokens: -1 }, { model: 'm', tokens: 'x' }, { model: 'm', tokens: 1e12 }, { model: '__proto__', tokens: 5 }]) {
    assert.equal(store.record(reading), false);
  }
  assert.equal(store.list().length, 0);
});

test('revision moves only when an answer changes, so views redraw on change and not on every tick', () => {
  const store = createGatewayModelContext();
  store.record({ model: 'm', tokens: 100 });
  const after = store.revision;
  assert.equal(store.record({ model: 'm', tokens: 100 }), false);
  assert.equal(store.revision, after);
  assert.equal(store.record({ model: 'm', tokens: 200 }), true);
  assert.ok(store.revision > after);
});

test('old entries are dropped and the store is bounded', () => {
  let clock = 1_000_000;
  const store = createGatewayModelContext({ now: () => clock });
  store.record({ model: 'old', tokens: 100 });
  clock += 31 * 24 * 60 * 60 * 1000;
  store.record({ model: 'new', tokens: 200 });
  assert.deepEqual(store.list().map((row) => row.model), ['new']);
  for (let index = 0; index < 260; index += 1) { clock += 1; store.record({ model: `m${index}`, tokens: 100 + index }); }
  assert.equal(store.list().length, 200);
});

test('catalog change detection: first catalog is not a change, a different model set is', () => {
  const store = createGatewayModelContext();
  const a = [{ rawModelId: 'a' }, { rawModelId: 'b' }];
  assert.equal(store.noteCatalog(a), false);
  assert.equal(store.noteCatalog([...a].reverse()), false);
  assert.equal(store.noteCatalog([...a, { rawModelId: 'c' }]), true);
  assert.equal(store.noteCatalog([]), false);
});

test('snapshot and restore round-trip, and restore never overwrites a fresher reading', () => {
  const first = createGatewayModelContext();
  first.record({ model: 'm', provider: 'p', tokens: 300_000, source: 'model-info' });
  first.noteCatalog([{ rawModelId: 'm' }]);
  const second = createGatewayModelContext();
  second.record({ model: 'm', provider: 'p', tokens: 400_000 });
  assert.equal(second.restore(JSON.parse(JSON.stringify(first.snapshot()))), true);
  assert.equal(second.lookup({ rawModelId: 'm', provider: 'p' }), 400_000);
  assert.equal(second.restore({ version: 99, entries: {} }), false);
  assert.equal(second.restore(null), false);
});

test('model rows take the gateway window over the bundled table, and fall back to the table for the rest', () => {
  gatewayModelContext.clear();
  const rows = () => normalizeHermesModels([
    { id: 'gpt-6.1-sol', provider: 'openai' },
    { id: 'gpt-6.1-terra', provider: 'openai' },
  ]);
  // Before the gateway says anything: the last-resort table (Hermes ships 1.05M for Sol).
  assert.equal(rows().find((row) => row.rawModelId === 'gpt-6.1-sol').contextTokens, hermesContextForModel({ id: 'gpt-6.1-sol' }));
  gatewayModelContext.record({ model: 'gpt-6.1-sol', tokens: 500_000, source: 'session-usage' });
  const after = rows();
  assert.equal(after.find((row) => row.rawModelId === 'gpt-6.1-sol').contextTokens, 500_000);
  assert.equal(after.find((row) => row.rawModelId === 'gpt-6.1-terra').contextTokens, 1_050_000);
  // Re-normalizing an already normalized (cached) catalog picks up a window learned later.
  gatewayModelContext.record({ model: 'gpt-6.1-sol', tokens: 450_000 });
  assert.equal(normalizeHermesModels(after).find((row) => row.rawModelId === 'gpt-6.1-sol').contextTokens, 450_000);
  gatewayModelContext.clear();
});

test('a window the catalog itself reports outranks a learned one, and the learned one outranks provider fields', () => {
  gatewayModelContext.clear();
  gatewayModelContext.record({ model: 'm-x', tokens: 300_000 });
  const [catalog] = normalizeHermesModels([{ id: 'm-x', provider: 'p', effective_context_length: 123_000 }]);
  assert.equal(catalog.contextTokens, 123_000);
  const [plain] = normalizeHermesModels([{ id: 'm-x', provider: 'p', context_length: 50_000 }]);
  assert.equal(plain.contextTokens, 300_000);
  gatewayModelContext.clear();
});
