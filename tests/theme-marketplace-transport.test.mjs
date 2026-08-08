import assert from 'node:assert/strict';
import test from 'node:test';
import { createThemeMarketplaceTransport } from '../extension/lib/theme-marketplace-transport.mjs';

const SEARCH = 'HERMES_THEME_MARKETPLACE_SEARCH';
const INSTALL = 'HERMES_THEME_MARKETPLACE_INSTALL';

function fallbackController(result = { ok: true, data: { results: [] } }) {
  const calls = [];
  return {
    calls,
    handles(type) { return type === SEARCH || type === INSTALL; },
    async handleMessage(message) { calls.push(message); return structuredClone(result); },
  };
}

test('transport keeps the background worker as the primary Marketplace owner', async () => {
  const fallback = fallbackController();
  const runtimeCalls = [];
  const transport = createThemeMarketplaceTransport({
    runtime: { async sendMessage(message) { runtimeCalls.push(message); return { ok: true, data: { results: [{ extensionId: 'demo.theme' }] } }; } },
    fallbackController: fallback,
  });
  const message = { type: SEARCH, query: 'demo', limit: 20 };
  const result = await transport.send(message);
  assert.equal(result.data.results[0].extensionId, 'demo.theme');
  assert.deepEqual(runtimeCalls, [message]);
  assert.deepEqual(fallback.calls, []);
});

test('transport falls back to the live page client when a stale worker has no Marketplace handler', async () => {
  const fallback = fallbackController({ ok: true, data: { results: [{ extensionId: 'dracula-theme.theme-dracula' }] } });
  const transport = createThemeMarketplaceTransport({
    runtime: { async sendMessage() { return undefined; } },
    fallbackController: fallback,
  });
  const message = { type: SEARCH, query: 'dracula', limit: 20 };
  const result = await transport.send(message);
  assert.equal(result.ok, true);
  assert.equal(result.data.results[0].extensionId, 'dracula-theme.theme-dracula');
  assert.deepEqual(fallback.calls, [message]);
});

test('transport contains worker restart failures and locks direct installs across surfaces', async () => {
  const fallback = fallbackController({ ok: true, data: { themeId: 'custom:demo' } });
  const lockCalls = [];
  const locks = {
    async request(name, options, operation) {
      lockCalls.push({ name, options });
      return operation();
    },
  };
  const transport = createThemeMarketplaceTransport({
    runtime: { async sendMessage() { throw new Error('Receiving end does not exist'); } },
    fallbackController: fallback,
    locks,
  });
  const message = { type: INSTALL, extensionId: 'demo.theme' };
  const result = await transport.send(message);
  assert.equal(result.data.themeId, 'custom:demo');
  assert.deepEqual(lockCalls, [{ name: 'hermes-theme-marketplace-install', options: { mode: 'exclusive' } }]);
  assert.deepEqual(fallback.calls, [message]);
});

test('transport does not hide a real Marketplace error behind a second request path', async () => {
  const fallback = fallbackController();
  const response = { ok: false, error: { code: 'network-failed', message: 'Marketplace is unavailable' } };
  const transport = createThemeMarketplaceTransport({
    runtime: { async sendMessage() { return response; } },
    fallbackController: fallback,
  });
  assert.deepEqual(await transport.send({ type: SEARCH, query: '', limit: 20 }), response);
  assert.deepEqual(fallback.calls, []);
});
