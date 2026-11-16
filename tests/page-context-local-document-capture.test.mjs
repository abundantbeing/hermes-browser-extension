import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { isPageContextCaptureUrlBlocked } from '../extension/lib/page-context-capture-guard.mjs';
import {
  pageContextAllowLocalDocumentsForUrl,
  pageContextHostPolicyDecision,
} from '../extension/lib/page-script-host-policy.mjs';

const FILE_URL = 'file:///tmp/hermes-sample-deck.html';

test('approved local file URLs pass host policy and capture guard', () => {
  const settings = { allowLocalDocuments: true, pageContextOnPrivateNetworks: false };
  assert.equal(pageContextAllowLocalDocumentsForUrl(FILE_URL, settings), true);
  assert.deepEqual(pageContextHostPolicyDecision(FILE_URL, settings), { inject: true, reason: '' });
  assert.equal(
    isPageContextCaptureUrlBlocked(FILE_URL, { allowLocalDocuments: true }),
    false,
  );
});

test('unapproved file: URLs stay blocked for host policy and capture', () => {
  const settings = { allowLocalDocuments: false, pageContextOnPrivateNetworks: false };
  assert.equal(pageContextAllowLocalDocumentsForUrl(FILE_URL, settings), false);
  assert.deepEqual(pageContextHostPolicyDecision(FILE_URL, settings), {
    inject: false,
    reason: 'restricted-url',
  });
  assert.equal(isPageContextCaptureUrlBlocked(FILE_URL), true);
});

test('in-page capture guard honors gate allowLocalDocuments for file documents', async () => {
  const guardSource = await readFile(new URL('../extension/lib/page-context-capture-guard.js', import.meta.url), 'utf8');
  const context = { globalThis: {}, URL };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(guardSource, context);
  const blocked = context.globalThis.hermesIsPageContextCaptureUrlBlocked;
  assert.equal(blocked(FILE_URL), true);
  assert.equal(blocked(FILE_URL, { allowLocalDocuments: true }), false);
});