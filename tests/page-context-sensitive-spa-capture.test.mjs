import assert from 'node:assert/strict';
import test from 'node:test';

import { isPageContextCaptureUrlBlocked } from '../extension/lib/page-context-capture-guard.mjs';
import { readPageScriptDocumentAnchor } from '../extension/lib/page-context-bundle-restart.mjs';

test('same documentId with SPA navigation to billing fails URL binding and restricted capture checks', async () => {
  const binding = {
    tabId: 4,
    frameId: 0,
    documentId: 'doc-spa-1',
    allowFrameFallback: false,
    anchorToken: 'https://shop.example.com\u0000https://shop.example.com/catalog',
  };
  const executeScript = async () => [{
    result: {
      href: 'https://shop.example.com/billing',
      origin: 'https://shop.example.com',
      token: 'https://shop.example.com\u0000https://shop.example.com/billing',
    },
  }];
  const anchor = await readPageScriptDocumentAnchor(executeScript, binding);
  assert.notEqual(anchor.token, binding.anchorToken);
  assert.equal(isPageContextCaptureUrlBlocked(anchor.href), true);
});