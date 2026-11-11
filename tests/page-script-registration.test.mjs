import assert from 'node:assert/strict';
import test from 'node:test';

import { createPageScriptRegistrar } from '../extension/lib/page-script-registration.mjs';
import {
  PAGE_CONTEXT_GUARD_SCRIPT_ID,
  PAGE_CONTEXT_SCRIPT_ID,
  buildRegisteredPageScriptDefinitions,
} from '../extension/lib/page-script-host-policy.mjs';

test('createPageScriptRegistrar registers guard and bundle with valid patterns', async () => {
  const calls = [];
  const registered = new Set();
  const scriptingApi = {
    async getRegisteredContentScripts({ ids }) {
      calls.push(['get', ids]);
      return [...registered].map((id) => ({ id }));
    },
    async registerContentScripts(entries) {
      for (const entry of entries) {
        registered.add(entry.id);
        calls.push(['register', entry.id, entry.excludeMatches.length, entry.js.length]);
      }
    },
    async updateContentScripts(entries) {
      for (const entry of entries) {
        calls.push(['update', entry.id, entry.excludeMatches.length]);
      }
    },
  };
  const registrar = createPageScriptRegistrar({ scriptingApi, packaged: true });
  const defs = buildRegisteredPageScriptDefinitions({ pageContextOnPrivateNetworks: false });
  for (const def of defs) {
    for (const pattern of [...def.matches, ...def.excludeMatches]) {
      assert.match(pattern, /^[a-z*]+:\/\//);
    }
  }
  const first = await registrar.sync({ pageContextOnPrivateNetworks: false });
  assert.equal(first.ok, true);
  const second = await registrar.sync({
    pageContextOnPrivateNetworks: true,
    pageContextExcludedOrigins: ['https://192.168.8.1'],
  });
  assert.equal(second.ok, true);
  assert.ok(calls.some(([, id]) => id === PAGE_CONTEXT_GUARD_SCRIPT_ID));
  assert.ok(calls.some(([, id]) => id === PAGE_CONTEXT_SCRIPT_ID));
  assert.ok(calls.some(([type]) => type === 'register'));
  assert.ok(calls.some(([type]) => type === 'update'));
});

test('registrar reports unavailable when scripting API is missing', async () => {
  const registrar = createPageScriptRegistrar({});
  const result = await registrar.sync({});
  assert.deepEqual(result, { ok: false, reason: 'scripting-unavailable' });
});
