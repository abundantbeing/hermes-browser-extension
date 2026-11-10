import assert from 'node:assert/strict';
import test from 'node:test';

import { createPageScriptRegistrar } from '../extension/lib/page-script-registration.mjs';
import { PAGE_CONTEXT_SCRIPT_ID } from '../extension/lib/page-script-host-policy.mjs';

test('createPageScriptRegistrar registers then updates content scripts', async () => {
  const calls = [];
  let registered = false;
  const scriptingApi = {
    async getRegisteredContentScripts({ ids }) {
      calls.push(['get', ids]);
      return registered ? [{ id: PAGE_CONTEXT_SCRIPT_ID }] : [];
    },
    async registerContentScripts(entries) {
      registered = true;
      calls.push(['register', entries[0].excludeMatches.length, entries[0].js.length]);
    },
    async updateContentScripts(entries) {
      calls.push(['update', entries[0].excludeMatches.length]);
    },
  };
  const registrar = createPageScriptRegistrar({ scriptingApi, packaged: true });
  const first = await registrar.sync({ pageContextOnPrivateNetworks: false });
  assert.equal(first.ok, true);
  const second = await registrar.sync({
    pageContextOnPrivateNetworks: true,
    pageContextExcludedOrigins: ['https://192.168.8.1'],
  });
  assert.equal(second.ok, true);
  assert.ok(calls.some(([type]) => type === 'register'));
  assert.ok(calls.some(([type]) => type === 'update'));
});

test('registrar reports unavailable when scripting API is missing', async () => {
  const registrar = createPageScriptRegistrar({});
  const result = await registrar.sync({});
  assert.deepEqual(result, { ok: false, reason: 'scripting-unavailable' });
});
