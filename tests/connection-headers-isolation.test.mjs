import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROBE_PARAM,
  createHeaderRuleSync,
  extensionInitiatorHost,
  probeHeaderRule,
  withProbeHeaderIsolation,
} from '../extension/lib/connection-headers.mjs';

const active = { gatewayUrl: 'https://hermes.example.com', headers: [{ name: 'X-Proxy-Token', value: 'active-secret' }, { name: 'X-Tenant', value: 'acme' }] };
const MARKER = 'abc123def456';

test('the initiator is the host of the extension pages, in Chrome and in Firefox', () => {
  assert.equal(extensionInitiatorHost((path) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop${path}`), 'abcdefghijklmnopabcdefghijklmnop');
  assert.equal(extensionInitiatorHost((path) => `moz-extension://6f1e3c2a-9d9d-4b0c-8a77-0a1b2c3d4e5f${path}`), '6f1e3c2a-9d9d-4b0c-8a77-0a1b2c3d4e5f');
  assert.equal(extensionInitiatorHost(() => 'not a url'), '');
  assert.equal(extensionInitiatorHost(() => { throw new Error('no runtime'); }), '');
});

test('overlapping header syncs install in order: a stale read can never put a removed header back', async () => {
  let stored = [{ name: 'X-Proxy-Token', value: 'old' }];
  const installed = [];
  const reads = [];
  const sync = createHeaderRuleSync({
    read: () => new Promise((resolve) => {
      const snapshot = stored;
      reads.push(() => resolve({ headers: snapshot }));
    }),
    apply: async (settings) => { installed.push(settings.headers); },
  });
  const first = sync();
  await new Promise((resolve) => setTimeout(resolve, 0));
  stored = [];
  const second = sync();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reads.length, 1, 'the second sync waits for the first');
  reads.shift()();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 0));
  reads.shift()();
  await second;
  assert.deepEqual(installed, [[{ name: 'X-Proxy-Token', value: 'old' }], []], 'the last write is the last installed');
});

test('a failing sync reports and does not stop the ones queued after it', async () => {
  const errors = [];
  let calls = 0;
  const sync = createHeaderRuleSync({
    read: async () => ({}),
    apply: async () => { calls += 1; if (calls === 1) throw new Error('rule refused'); },
    onError: (error) => errors.push(error.message),
  });
  await sync();
  await sync();
  assert.deepEqual(errors, ['rule refused']);
  assert.equal(calls, 2);
});

test('a test at the active address sets the draft headers and removes the active ones it does not have', () => {
  const rule = probeHeaderRule({
    gatewayUrl: 'https://hermes.example.com',
    headers: [{ name: 'x-proxy-token', value: 'draft-secret' }],
    active,
    extensionHost: 'abc',
    marker: MARKER,
  });
  assert.equal(rule.priority, 3);
  assert.deepEqual(rule.action.requestHeaders, [
    { header: 'x-proxy-token', operation: 'set', value: 'draft-secret' },
    { header: 'X-Tenant', operation: 'remove' },
  ]);
  assert.deepEqual(rule.condition.initiatorDomains, ['abc']);
  assert.deepEqual(rule.condition.resourceTypes, ['xmlhttprequest']);
  const matches = (address) => new RegExp(rule.condition.regexFilter).test(address);
  assert.ok(matches(`https://hermes.example.com/health?${PROBE_PARAM}=${MARKER}`));
  assert.ok(matches(`https://hermes.example.com/api/sessions?limit=1&${PROBE_PARAM}=${MARKER}`));
  assert.ok(!matches('https://hermes.example.com/health'), 'the active connection\'s own requests do not carry the marker');
  assert.ok(!matches(`https://hermes.example.com/health?${PROBE_PARAM}=other00000000`), 'another test\'s requests are not this one');
  assert.ok(!matches(`https://other.example.com/health?${PROBE_PARAM}=${MARKER}`));
  assert.ok(!matches(`https://hermes.example.com:8443/health?${PROBE_PARAM}=${MARKER}`));
});

test('a test with no headers still strips the active ones, and needs no rule when it does not meet the active address', () => {
  const bare = probeHeaderRule({ gatewayUrl: 'https://hermes.example.com', headers: [], active, extensionHost: 'abc', marker: MARKER });
  assert.deepEqual(bare.action.requestHeaders, [
    { header: 'X-Proxy-Token', operation: 'remove' },
    { header: 'X-Tenant', operation: 'remove' },
  ]);
  assert.equal(probeHeaderRule({ gatewayUrl: 'https://another.example.com', headers: [], active, extensionHost: 'abc', marker: MARKER }), null);
  assert.equal(probeHeaderRule({ gatewayUrl: 'https://hermes.example.com', headers: [], active: { gatewayUrl: 'https://hermes.example.com', headers: [] }, extensionHost: 'abc', marker: MARKER }), null);
  assert.equal(probeHeaderRule({ gatewayUrl: 'https://hermes.example.com', headers: [], active, extensionHost: '', marker: MARKER }), null);
  assert.equal(probeHeaderRule({ gatewayUrl: 'https://hermes.example.com', headers: [], active, extensionHost: 'abc', marker: 'a.b' }), null, 'a marker is never read as a pattern');
});

test('the isolation rule exists only while the test runs, and each test has its own', async () => {
  const calls = [];
  const dnr = { updateSessionRules: async (change) => calls.push(change) };
  const seen = [];
  const run = (marker) => withProbeHeaderIsolation(
    { gatewayUrl: 'https://hermes.example.com', headers: [], active, extensionHost: 'abc' },
    async (given) => { seen.push(given); return 'tested'; },
    dnr,
  );
  assert.equal(await run(), 'tested');
  assert.equal(await run(), 'tested');
  assert.match(seen[0], /^[a-z0-9]{16}$/);
  assert.notEqual(seen[0], seen[1]);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].addRules.length, 1);
  assert.deepEqual(calls[1], { removeRuleIds: [calls[0].addRules[0].id] }, 'removed as soon as the test ends');
  assert.notEqual(calls[0].addRules[0].id, calls[2].addRules[0].id, 'overlapping tests never remove each other\'s rule');
});

test('two panels never pick the same rule id, and a taken id is replaced instead of overwritten', async () => {
  const first = await import('../extension/lib/connection-headers.mjs?panel=one');
  const second = await import('../extension/lib/connection-headers.mjs?panel=two');
  const ids = new Set([...Array.from({ length: 200 }, () => first.newProbeRuleId()), ...Array.from({ length: 200 }, () => second.newProbeRuleId())]);
  assert.equal(ids.size, 400, 'a counter that restarts in each document would repeat');
  assert.ok([...ids].every((id) => id >= 1_000_000 && id !== 7746));

  const calls = [];
  let refused = 0;
  const dnr = {
    updateSessionRules: async (change) => {
      calls.push(change);
      if (change.addRules && refused++ === 0) throw new Error('Rule with id already exists');
    },
  };
  await withProbeHeaderIsolation({ gatewayUrl: 'https://hermes.example.com', headers: [], active, extensionHost: 'abc' }, async () => 'done', dnr);
  const adds = calls.filter((change) => change.addRules);
  assert.equal(adds.length, 2);
  assert.notEqual(adds[0].addRules[0].id, adds[1].addRules[0].id);
  assert.ok(calls.every((change) => !change.removeRuleIds || change.removeRuleIds[0] === adds[1].addRules[0].id), 'only its own rule is ever removed');
});

test('the rule is removed when the test fails, and no rule is made when none is needed', async () => {
  const calls = [];
  const dnr = { updateSessionRules: async (change) => calls.push(change) };
  await assert.rejects(withProbeHeaderIsolation(
    { gatewayUrl: 'https://hermes.example.com', headers: [], active, extensionHost: 'abc' },
    async () => { throw new Error('aborted'); },
    dnr,
  ), /aborted/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].addRules, undefined);
  calls.length = 0;
  const marker = await withProbeHeaderIsolation(
    { gatewayUrl: 'https://another.example.com', headers: [], active, extensionHost: 'abc' },
    async (given) => given,
    dnr,
  );
  assert.equal(marker, '');
  assert.equal(calls.length, 0);
  assert.equal(await withProbeHeaderIsolation({ gatewayUrl: 'https://hermes.example.com', headers: [], active, extensionHost: 'abc' }, async (given) => given, {}), '', 'a browser without the rule API still tests');
});
