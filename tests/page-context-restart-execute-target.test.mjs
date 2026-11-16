import assert from 'node:assert/strict';
import test from 'node:test';

import { packagedPageContextScriptFiles } from '../extension/lib/page-script-host-policy.mjs';
import {
  describePageContextBundleRestartInjection,
  pageContextBundleRestartFilesFromManifest,
  runPageContextBundleRestart,
} from '../extension/lib/page-context-bundle-restart.mjs';

test('shipped bundle restart uses documentId target, gate-first files, and document-scoped wait', async () => {
  const calls = [];
  const binding = {
    tabId: 9,
    frameId: 0,
    documentId: 'doc-restart-abc',
    allowFrameFallback: false,
    anchorToken: 'https://example.com\u0000https://example.com/',
  };
  const restartFiles = pageContextBundleRestartFilesFromManifest(packagedPageContextScriptFiles());
  const described = describePageContextBundleRestartInjection(binding, restartFiles);
  assert.deepEqual(described.target, { tabId: 9, documentIds: ['doc-restart-abc'] });
  assert.equal(described.gateFirst, true);
  assert.match(described.files[0], /page-context-bundle-gate/);

  const executeScript = async (request) => {
    calls.push(request);
    if (request.files) return [{ result: undefined, documentId: binding.documentId }];
    if (typeof request.func === 'function') {
      await request.func();
    }
    return [{ result: undefined, documentId: binding.documentId }];
  };

  await runPageContextBundleRestart(executeScript, binding, restartFiles, {
    verifyBinding: async () => true,
    beforeInject: async () => true,
    afterInject: async () => true,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].target, { tabId: 9, documentIds: ['doc-restart-abc'] });
  assert.deepEqual(calls[0].files, described.files);
  assert.deepEqual(calls[1].target, { tabId: 9, documentIds: ['doc-restart-abc'] });
  assert.doesNotMatch(JSON.stringify(calls[0]), /frameIds/);
});