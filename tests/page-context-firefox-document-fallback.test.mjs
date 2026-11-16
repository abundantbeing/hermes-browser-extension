import assert from 'node:assert/strict';
import test from 'node:test';

import { pageContextInjectionDecision } from '../extension/lib/page-script-host-policy.mjs';
import {
  pageContextBindingUsesFrameFallback,
  pageContextScriptInjectionTarget,
  probePageContextFrameDocumentId,
} from '../extension/lib/page-context-document-target.mjs';
import { readPageScriptDocumentAnchor } from '../extension/lib/page-context-bundle-restart.mjs';

test('missing documentId on a frame enables frame fallback (Firefox)', async () => {
  const executeScript = async () => [{ result: 'https://example.com/app', documentId: undefined }];
  const documentId = await probePageContextFrameDocumentId(executeScript, 2, 0);
  assert.equal(documentId, null);
  assert.equal(pageContextBindingUsesFrameFallback(documentId), true);
  const binding = {
    tabId: 2,
    frameId: 0,
    documentId,
    allowFrameFallback: pageContextBindingUsesFrameFallback(documentId),
  };
  assert.deepEqual(pageContextScriptInjectionTarget(binding), { tabId: 2, frameIds: [0] });
  const injectionDecision = (url) => pageContextInjectionDecision(url, { pageContextOnPrivateNetworks: false });
  const anchor = await readPageScriptDocumentAnchor(async (request) => {
    if (request.target?.frameIds) {
      return [{ result: { href: 'https://example.com/app', origin: 'https://example.com', token: 'https://example.com\u0000https://example.com/app' } }];
    }
    return [{ result: null }];
  }, binding);
  assert.equal(injectionDecision(anchor.href).inject, true);
});