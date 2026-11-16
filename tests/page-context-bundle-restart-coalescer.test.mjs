import assert from 'node:assert/strict';
import test from 'node:test';

import { createPageContextBundleRestartCoalescer } from '../extension/lib/page-context-bundle-restart.mjs';

test('coalesced bundle restart swallows restart refusal without rejecting waiters', async () => {
  const { awaitPageContextBundleRestart, reinstallPageContextBundleEntries } = createPageContextBundleRestartCoalescer({
    probeRestartNeeded: async () => true,
    runBundleRestart: async () => {
      throw new Error('inject refused');
    },
  });
  const binding = { tabId: 9, frameId: 0, allowFrameFallback: true };
  await assert.doesNotReject(() => reinstallPageContextBundleEntries(9, binding));
  await assert.doesNotReject(() => awaitPageContextBundleRestart(9, binding));
});