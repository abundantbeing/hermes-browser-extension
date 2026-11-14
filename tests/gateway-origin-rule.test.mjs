import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  GATEWAY_ORIGIN_RULE_ID,
  applyGatewayOriginRule,
  draftOriginRule,
  gatewayOriginRules,
  withDraftOriginRule,
} from '../extension/lib/gateway-origin-rule.mjs';
import { HEADER_RULE_ID } from '../extension/lib/connection-headers.mjs';

const HOST = 'abcdefghijklmnopabcdefghijklmnop';

function fakeDnr() {
  const rules = new Map();
  const calls = [];
  return {
    rules,
    calls,
    async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
      calls.push({ removeRuleIds, addRules });
      for (const id of removeRuleIds) rules.delete(id);
      for (const rule of addRules) {
        if (rules.has(rule.id)) throw new Error(`duplicate rule id ${rule.id}`);
        rules.set(rule.id, rule);
      }
    },
  };
}

function matches(rule, url, initiator = HOST, type = 'xmlhttprequest') {
  const { condition } = rule;
  return new RegExp(condition.regexFilter).test(url)
    && condition.initiatorDomains.includes(initiator)
    && condition.resourceTypes.includes(type);
}

test('an API connection gets one rule that removes Origin from this extension\'s requests to its address', () => {
  const [rule] = gatewayOriginRules({ gatewayUrl: 'http://127.0.0.1:8642', connectionTransport: 'local-api', extensionHost: HOST });
  assert.equal(rule.id, GATEWAY_ORIGIN_RULE_ID);
  assert.deepEqual(rule.action, { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] });
  assert.ok(matches(rule, 'http://127.0.0.1:8642/v1/runs'));
  assert.ok(matches(rule, 'http://127.0.0.1:8642/api/sessions/abc?x=1'));
  assert.ok(matches(rule, 'http://127.0.0.1:8642/p/work/v1/chat/completions'));
});

test('the rule reaches nothing but this connection, from nothing but this extension', () => {
  const [rule] = gatewayOriginRules({ gatewayUrl: 'https://hermes.example.com', connectionTransport: 'remote-api', extensionHost: HOST });
  assert.ok(matches(rule, 'https://hermes.example.com/v1/models'));
  assert.ok(matches(rule, 'https://hermes.example.com:443/v1/models'));
  assert.ok(!matches(rule, 'http://hermes.example.com/v1/models'), 'another scheme');
  assert.ok(!matches(rule, 'https://hermes.example.com:8443/v1/models'), 'another port');
  assert.ok(!matches(rule, 'https://hermes.example.com.evil.test/v1/models'), 'a look-alike host');
  assert.ok(!matches(rule, 'https://evil.test/?u=https://hermes.example.com/'), 'the address inside another URL');
  assert.ok(!matches(rule, 'https://hermes.example.com/v1/models', 'some-web-page.example'), 'a web page asking');
  assert.ok(!matches(rule, 'wss://hermes.example.com/api/ws', HOST, 'websocket'), 'WebSocket handshakes keep their Origin');
  const [local] = gatewayOriginRules({ gatewayUrl: 'http://127.0.0.1:8642', connectionTransport: 'local-api', extensionHost: HOST });
  assert.ok(!matches(local, 'http://127.0.0.1:9119/api/status'), 'the Desktop dashboard on the same computer');
});

test('dashboard and Cloud connections, which sign in through a tab, get no rule', () => {
  for (const connectionTransport of ['remote-dashboard', 'cloud-ticket-ws']) {
    assert.deepEqual(gatewayOriginRules({ gatewayUrl: 'https://hermes.example.com', connectionTransport, extensionHost: HOST }), [], connectionTransport);
  }
});

test('no rule without an address or an extension host', () => {
  assert.deepEqual(gatewayOriginRules({ gatewayUrl: '', connectionTransport: 'local-api', extensionHost: HOST }), []);
  assert.deepEqual(gatewayOriginRules({ gatewayUrl: 'not a url', connectionTransport: 'local-api', extensionHost: HOST }), []);
  assert.deepEqual(gatewayOriginRules({ gatewayUrl: 'file:///etc/passwd', connectionTransport: 'local-api', extensionHost: HOST }), []);
  assert.deepEqual(gatewayOriginRules({ gatewayUrl: 'http://127.0.0.1:8642', connectionTransport: 'local-api', extensionHost: '' }), []);
});

test('an unknown or missing transport is treated as the local API, the default', () => {
  assert.equal(gatewayOriginRules({ gatewayUrl: 'http://127.0.0.1:8642', extensionHost: HOST }).length, 1);
});

test('applying replaces the previous rule, and a dashboard connection removes it', async () => {
  const dnr = fakeDnr();
  assert.equal(await applyGatewayOriginRule({ gatewayUrl: 'http://127.0.0.1:8642', connectionTransport: 'local-api', extensionHost: HOST }, dnr), true);
  await applyGatewayOriginRule({ gatewayUrl: 'http://100.64.0.7:8642', connectionTransport: 'remote-api', extensionHost: HOST }, dnr);
  assert.equal(dnr.rules.size, 1);
  assert.ok(matches(dnr.rules.get(GATEWAY_ORIGIN_RULE_ID), 'http://100.64.0.7:8642/v1/runs'));
  await applyGatewayOriginRule({ gatewayUrl: 'https://hermes.example.com', connectionTransport: 'remote-dashboard', extensionHost: HOST }, dnr);
  assert.equal(dnr.rules.size, 0);
  assert.equal(await applyGatewayOriginRule({ gatewayUrl: 'http://127.0.0.1:8642', extensionHost: HOST }, null), false);
});

test('several loopback pairing attempts stay covered beside the active connection', () => {
  const [rule] = gatewayOriginRules({
    gatewayUrl: 'http://127.0.0.1:8642',
    connectionTransport: 'local-api',
    extensionHost: HOST,
    pendingGatewayUrls: ['http://127.0.0.1:8650', 'http://localhost:8651'],
  });
  assert.ok(matches(rule, 'http://127.0.0.1:8650/api/browser-extension/pair/start'));
  assert.ok(matches(rule, 'http://localhost:8651/v1/models'));
  assert.ok(!matches(rule, 'http://127.0.0.1:9119/api/status'));
});

test('a loopback address being paired before it is saved is covered beside the active one, and only loopback', () => {
  const [rule] = gatewayOriginRules({
    gatewayUrl: 'http://127.0.0.1:8642', connectionTransport: 'local-api', extensionHost: HOST, pendingGatewayUrl: 'http://127.0.0.1:8650',
  });
  assert.ok(matches(rule, 'http://127.0.0.1:8642/v1/runs'));
  assert.ok(matches(rule, 'http://127.0.0.1:8650/api/browser-extension/pair/start'));
  assert.ok(!matches(rule, 'http://127.0.0.1:9119/api/status'));
  const [remote] = gatewayOriginRules({
    gatewayUrl: 'http://127.0.0.1:8642', connectionTransport: 'local-api', extensionHost: HOST, pendingGatewayUrl: 'http://192.168.1.50:8642',
  });
  assert.ok(!matches(remote, 'http://192.168.1.50:8642/v1/runs'), 'pairing only runs on loopback, so nothing else is added');
  const [dashboard] = gatewayOriginRules({
    gatewayUrl: 'https://hermes.example.com', connectionTransport: 'remote-dashboard', extensionHost: HOST, pendingGatewayUrl: 'http://localhost:8642',
  });
  assert.ok(matches(dashboard, 'http://localhost:8642/api/browser-extension/pair/start'));
  assert.ok(!matches(dashboard, 'https://hermes.example.com/api/ws'));
});

test('a test of an unsaved address gets a rule for its own marked requests only', () => {
  const rule = draftOriginRule({ gatewayUrl: 'http://192.168.1.50:8642', extensionHost: HOST, marker: 'abc123def456', id: 1_200_000_001 });
  assert.ok(matches(rule, 'http://192.168.1.50:8642/v1/models?hermes_probe=abc123def456'));
  assert.ok(matches(rule, 'http://192.168.1.50:8642/v1/models?limit=1&hermes_probe=abc123def456&x=2'));
  assert.ok(!matches(rule, 'http://192.168.1.50:8642/v1/models'), 'an unmarked request, such as one after the panel closed');
  assert.ok(!matches(rule, 'http://192.168.1.50:8642/v1/models?hermes_probe=abc123def4567'), 'another marker');
  assert.equal(draftOriginRule({ gatewayUrl: 'http://192.168.1.50:8642', extensionHost: HOST, marker: '' }), null);
  assert.equal(draftOriginRule({ gatewayUrl: 'http://192.168.1.50:8642', extensionHost: HOST, marker: 'a.b' }), null);
});

test('the test of an unsaved address has its rule while it runs, and only then', async () => {
  const dnr = fakeDnr();
  let during = null;
  const result = await withDraftOriginRule({ gatewayUrl: 'http://192.168.1.50:8642', extensionHost: HOST, marker: 'feedface01' }, async () => {
    during = [...dnr.rules.values()][0];
    return 'probed';
  }, dnr);
  assert.equal(result, 'probed');
  assert.ok(matches(during, 'http://192.168.1.50:8642/v1/models?hermes_probe=feedface01'));
  assert.ok(during.id >= 1_200_000_000 && during.id < 1_200_000_000 + 2 ** 29);
  assert.equal(dnr.rules.size, 0);
  await assert.rejects(withDraftOriginRule({ gatewayUrl: 'http://192.168.1.50:8642', extensionHost: HOST, marker: 'feedface02' }, async () => {
    throw new Error('nothing answered');
  }, dnr), /nothing answered/);
  assert.equal(dnr.rules.size, 0, 'removed after a failed test too');
  assert.equal(await withDraftOriginRule({ gatewayUrl: '', extensionHost: HOST, marker: 'feedface03' }, async () => 'no rule', dnr), 'no rule');
  assert.equal(await withDraftOriginRule({ gatewayUrl: 'http://192.168.1.50:8642', extensionHost: HOST, marker: 'feedface04' }, async () => 'no dnr', null), 'no dnr');
});

test('a browser that refuses the rule still runs the test', async () => {
  const refusing = { calls: 0, async updateSessionRules() { this.calls += 1; throw new Error('rule refused'); } };
  const warn = console.warn;
  console.warn = () => {};
  try {
    let ran = false;
    const result = await withDraftOriginRule({ gatewayUrl: 'http://192.168.1.50:8642', extensionHost: HOST, marker: 'feedface05' }, async () => {
      ran = true;
      return 'answered';
    }, refusing);
    assert.equal(ran, true);
    assert.equal(result, 'answered');
    assert.equal(refusing.calls, 1, 'nothing to remove afterwards');
  } finally {
    console.warn = warn;
  }
});

test('two tests at once keep their own rules', async () => {
  const dnr = fakeDnr();
  let releaseFirst;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  let firstRule = null;
  const first = withDraftOriginRule({ gatewayUrl: 'http://192.168.1.50:8642', extensionHost: HOST, marker: 'aaaaaa01' }, async () => {
    firstRule = [...dnr.rules.values()].find((rule) => rule.condition.regexFilter.includes('aaaaaa01'));
    await firstHeld;
    return 'first';
  }, dnr);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await withDraftOriginRule({ gatewayUrl: 'http://192.168.1.51:8642', extensionHost: HOST, marker: 'bbbbbb02' }, async () => {
    assert.equal(dnr.rules.size, 2, 'both rules are installed together');
    return 'second';
  }, dnr);
  assert.equal(second, 'second');
  assert.ok(dnr.rules.has(firstRule.id), 'finishing the second test leaves the rule of the first');
  releaseFirst();
  assert.equal(await first, 'first');
  assert.equal(dnr.rules.size, 0);
});

test('the rule ids do not collide with the other session rules', () => {
  const ids = new Set([GATEWAY_ORIGIN_RULE_ID, HEADER_RULE_ID, 7745]);
  assert.equal(ids.size, 3);
  assert.ok(GATEWAY_ORIGIN_RULE_ID < 1_000_000, 'below the probe rule ranges');
  assert.ok(1_000_000 + 2 ** 30 <= 1_200_000_000, 'the header probe range ends before the test origin range');
  assert.ok(1_200_000_000 + 2 ** 29 < 2 ** 31, 'rule ids stay 32-bit');
});

test('only the worker writes the active rule; a panel asks it and waits', async () => {
  const background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(background, /pendingGatewayUrls: \[\.\.\.pendingPairingGatewayUrls\]/);
  assert.match(background, /const pendingPairingGatewayUrls = new Set\(\)/);
  assert.match(background, /message\?\.type === SYNC_GATEWAY_RULES_MESSAGE\s*\?\s*syncGatewayRulesForPanel\(message\)/);
  assert.match(background, /LOOPBACK_FETCH_MESSAGE,\s*SYNC_GATEWAY_RULES_MESSAGE,/, 'only extension pages may ask');
  assert.match(background, /if \(changes\.hermesBrowserSettings\) pendingPairingGatewayUrls\.clear\(\);\s*void syncConnectionHeaders\(\);/, 'a settings change drops pending pairing addresses');
  const panel = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(panel, /applyGatewayOriginRule\(/, 'the panel never writes the active rule');
  assert.match(panel, /type: SYNC_GATEWAY_RULES_MESSAGE,\s*pendingGatewayUrl,/);
  assert.match(panel, /async function testConnection\(\) \{[\s\S]{0,600}await syncGatewayOriginRule\(\)/, 'Test connection waits for the rule');
  assert.match(panel, /const pairingGatewayUrl = settings\.gatewayUrl;/, 'pairing remembers the loopback address for release');
  assert.match(panel, /releasePendingGatewayUrl: pairingGatewayUrl/, 'pairing releases its loopback address when it finishes');
  assert.match(panel, /const marker = newProbeMarker\(\);[\s\S]{0,200}withDraftOriginRule\(\s*\{ gatewayUrl, extensionHost, marker \}[\s\S]{0,500}extensionHost,\s*marker,\s*\}[\s\S]{0,100}probeConnection\(\{ gatewayUrl, apiKey, headers, marker, signal \}\)/, 'one marker for the requests of the test and both its rules');
});

test('the extension manifest grants what the rule needs, and the Firefox build keeps it', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'));
  const firefox = await readFile(new URL('../scripts/manifest-profiles.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(firefox, /['"]declarativeNetRequestWithHostAccess['"]/, 'the Firefox profile does not strip it');
});

test('the permission docs say what the network rules do', async () => {
  const permissions = await readFile(new URL('../PERMISSIONS.md', import.meta.url), 'utf8');
  assert.match(permissions, /removes the `Origin` header from the extension's API requests/);
  assert.doesNotMatch(permissions, /currently installs no active rules/);
  const security = await readFile(new URL('../SECURITY.md', import.meta.url), 'utf8');
  assert.doesNotMatch(security, /currently installs no active rules/);
});
