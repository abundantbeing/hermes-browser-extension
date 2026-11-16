import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { privateNetworkHost } from '../extension/lib/common.mjs';
import { pageContextInjectionDecision } from '../extension/lib/page-script-host-policy.mjs';

const LINK_LOCAL = [
  ['fe80::1', true],
  ['fe90::1', true],
  ['febf::1', true],
  ['fec0::1', false],
];

test('privateNetworkHost covers fe80::/10 with fec0::/10 as the public boundary', () => {
  for (const [host, expected] of LINK_LOCAL) {
    assert.equal(privateNetworkHost(host), expected, host);
  }
});

test('generated install guard embeds the same fe80::/10 classifier', async () => {
  const guard = await readFile(new URL('../extension/page-context-install-guard.js', import.meta.url), 'utf8');
  const embedded = guard.match(/const privateNetworkHost = ([\s\S]+?)\n\n {2}const likelyPrivate/)?.[1];
  assert.ok(embedded, 'embedded classifier');
  for (const [host, expected] of LINK_LOCAL) {
    assert.equal(guard.includes(`value >= 0xfe80 && value <= 0xfebf`), true);
    assert.equal(privateNetworkHost(host), expected, `common.mjs ${host}`);
  }
});

test('pageContextInjectionDecision applies fe80::/10 link-local policy with fec0::/10 boundary', () => {
  for (const host of ['fe80::1', 'fe90::1', 'febf::1']) {
    assert.deepEqual(pageContextInjectionDecision(`http://[${host}]/`, {}), {
      inject: false,
      reason: 'private-network',
    }, host);
  }
  assert.equal(pageContextInjectionDecision('http://[fec0::1]/', {}).inject, true);
});