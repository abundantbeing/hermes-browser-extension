import assert from 'node:assert/strict';
import test from 'node:test';

import { createHeaderRuleSync } from '../extension/lib/connection-headers.mjs';
import { createPageScriptRegistrar } from '../extension/lib/page-script-registration.mjs';

test('page-script sync surfaces registrar failures through onError', async () => {
  const warnings = [];
  const registrar = createPageScriptRegistrar({
    scriptingApi: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {
        throw new Error('register-failed');
      },
    },
    packaged: true,
  });
  const sync = createHeaderRuleSync({
    read: async () => ({}),
    apply: async (settings) => {
      const result = await registrar.sync(settings);
      if (result?.ok === false) throw new Error(result.reason || 'page-script-registration-failed');
      return result;
    },
    onError: (error) => {
      warnings.push(error?.message || String(error));
      return { ok: false, reason: error?.message || String(error) };
    },
  });
  await sync();
  assert.deepEqual(warnings, ['register-failed']);
});
