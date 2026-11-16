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
      const src = request.func.toString();
      if (src.includes('location.href') && src.includes('token')) {
        return [{
          result: {
            href: 'https://example.com/',
            origin: 'https://example.com',
            token: binding.anchorToken,
          },
          documentId: binding.documentId,
        }];
      }
      await request.func();
    }
    return [{ result: undefined, documentId: binding.documentId }];
  };

  await runPageContextBundleRestart(executeScript, binding, restartFiles, {
    verifyBinding: async () => true,
    beforeInject: async () => true,
    afterInject: async () => true,
  });

  assert.equal(calls.length, 3, 'anchor probe, file inject, post-inject wait');
  assert.equal(typeof calls[0].func, 'function');
  assert.equal(calls[0].files, undefined);
  assert.deepEqual(calls[1].target, { tabId: 9, documentIds: ['doc-restart-abc'] });
  assert.deepEqual(calls[1].files, described.files);
  assert.deepEqual(calls[2].target, { tabId: 9, documentIds: ['doc-restart-abc'] });
  assert.doesNotMatch(JSON.stringify(calls[1]), /frameIds/);
});

test('frame fallback shipped restart targets frameIds and injects gate-first file list', async () => {
  const binding = {
    tabId: 3,
    frameId: 0,
    documentId: null,
    allowFrameFallback: true,
  };
  const restartFiles = pageContextBundleRestartFilesFromManifest(packagedPageContextScriptFiles());
  const described = describePageContextBundleRestartInjection(binding, restartFiles);
  assert.deepEqual(described.target, { tabId: 3, frameIds: [0] });
  assert.equal(described.gateFirst, true);
  assert.match(described.files[0], /page-context-bundle-gate/);
});