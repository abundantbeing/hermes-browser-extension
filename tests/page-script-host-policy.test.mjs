import assert from 'node:assert/strict';
import test from 'node:test';

import { privateNetworkHost } from '../extension/lib/common.mjs';
import {
  buildPageScriptExcludeMatchPatterns,
  buildRegisteredPageScriptDefinition,
  isPrivateNetworkPageUrl,
  normalizePageContextExcludedOrigins,
  pageContextInjectionDecision,
  pageContextSkipMessageKey,
} from '../extension/lib/page-script-host-policy.mjs';

test('privateNetworkHost classifies RFC1918, loopback, and local names with edge cases', () => {
  assert.equal(privateNetworkHost('127.0.0.1'), true);
  assert.equal(privateNetworkHost('192.168.8.1'), true);
  assert.equal(privateNetworkHost('10.0.0.5'), true);
  assert.equal(privateNetworkHost('172.16.0.1'), true);
  assert.equal(privateNetworkHost('172.31.255.1'), true);
  assert.equal(privateNetworkHost('172.15.0.1'), false);
  assert.equal(privateNetworkHost('172.32.0.1'), false);
  assert.equal(privateNetworkHost('192.169.1.1'), false);
  assert.equal(privateNetworkHost('router.local'), true);
  assert.equal(privateNetworkHost('news.ycombinator.com'), false);
  assert.equal(privateNetworkHost('10.example.com'), false);
});

test('isPrivateNetworkPageUrl ignores public sites and file URLs', () => {
  assert.equal(isPrivateNetworkPageUrl('https://192.168.8.1:9443/ui/'), true);
  assert.equal(isPrivateNetworkPageUrl('https://example.com/'), false);
  assert.equal(isPrivateNetworkPageUrl('file:///tmp/a.html'), false);
});

test('pageContextInjectionDecision defaults to skipping private hosts', () => {
  const base = {};
  assert.deepEqual(pageContextInjectionDecision('https://192.168.8.1/ui/', base), {
    inject: false,
    reason: 'private-network',
  });
  assert.deepEqual(pageContextInjectionDecision('https://192.168.8.1/ui/', {
    pageContextOnPrivateNetworks: true,
  }), { inject: true, reason: '' });
});

test('per-origin exclude list applies to public and private sites', () => {
  const settings = {
    pageContextOnPrivateNetworks: true,
    pageContextExcludedOrigins: ['https://news.example.com', 'https://192.168.1.2:9443'],
  };
  assert.deepEqual(pageContextInjectionDecision('https://news.example.com/a', settings), {
    inject: false,
    reason: 'excluded-origin',
  });
  assert.deepEqual(pageContextInjectionDecision('https://192.168.1.2:9443/', settings), {
    inject: false,
    reason: 'excluded-origin',
  });
  assert.deepEqual(pageContextInjectionDecision('https://192.168.1.3/', settings), {
    inject: true,
    reason: '',
  });
});

test('buildPageScriptExcludeMatchPatterns includes private patterns unless opted in', () => {
  const skipped = buildPageScriptExcludeMatchPatterns({});
  assert.ok(skipped.includes('https://192.168.*/*'));
  assert.ok(skipped.includes('https://127.0.0.1/*'));
  const withOrigin = buildPageScriptExcludeMatchPatterns({
    pageContextOnPrivateNetworks: true,
    pageContextExcludedOrigins: ['https://192.168.8.1:9443'],
  });
  assert.ok(withOrigin.includes('https://192.168.8.1/*'));
  assert.ok(!withOrigin.includes('https://192.168.*/*'));
});

test('registered page script definition uses dynamic bundle files', () => {
  const def = buildRegisteredPageScriptDefinition({}, { packaged: true });
  assert.equal(def.id, 'hermes-page-context-bundle');
  assert.deepEqual(def.js.slice(0, 2), ['lib/browser-api-global.js', 'content-extractor.js']);
  assert.equal(def.runAt, 'document_idle');
});

test('normalizePageContextExcludedOrigins deduplicates and normalizes', () => {
  assert.deepEqual(
    normalizePageContextExcludedOrigins(['192.168.8.1', 'https://192.168.8.1/', '']),
    ['https://192.168.8.1'],
  );
});

test('pageContextSkipMessageKey maps reasons to user-visible status keys', () => {
  assert.equal(pageContextSkipMessageKey('private-network'), 'status.page_context_skipped_private');
  assert.equal(pageContextSkipMessageKey('excluded-origin'), 'status.page_context_skipped_excluded');
});
