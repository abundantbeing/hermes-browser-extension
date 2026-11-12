import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DRAFT_ORIGIN_RULE_ID,
  GATEWAY_ORIGIN_RULE_ID,
  applyGatewayOriginRule,
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

test('a test of an address that is not saved yet gets its own rule while it runs, and only then', async () => {
  const dnr = fakeDnr();
  let during = null;
  const result = await withDraftOriginRule({ gatewayUrl: 'http://192.168.1.50:8642', extensionHost: HOST }, async () => {
    during = dnr.rules.get(DRAFT_ORIGIN_RULE_ID);
    return 'probed';
  }, dnr);
  assert.equal(result, 'probed');
  assert.ok(matches(during, 'http://192.168.1.50:8642/v1/models'));
  assert.equal(dnr.rules.size, 0);
  await assert.rejects(withDraftOriginRule({ gatewayUrl: 'http://192.168.1.50:8642', extensionHost: HOST }, async () => {
    throw new Error('nothing answered');
  }, dnr), /nothing answered/);
  assert.equal(dnr.rules.size, 0, 'removed after a failed test too');
  assert.equal(await withDraftOriginRule({ gatewayUrl: '', extensionHost: HOST }, async () => 'no rule', dnr), 'no rule');
  assert.equal(await withDraftOriginRule({ gatewayUrl: 'http://192.168.1.50:8642', extensionHost: HOST }, async () => 'no dnr', null), 'no dnr');
});

test('the rule ids do not collide with the other session rules', () => {
  const ids = new Set([GATEWAY_ORIGIN_RULE_ID, DRAFT_ORIGIN_RULE_ID, HEADER_RULE_ID, 7745]);
  assert.equal(ids.size, 4);
  assert.ok(GATEWAY_ORIGIN_RULE_ID < 1_000_000 && DRAFT_ORIGIN_RULE_ID < 1_000_000, 'below the random probe rule range');
});

test('the worker keeps the rule in step with the active connection, and the panel applies it before it tests', async () => {
  const background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(background, /applyGatewayOriginRule\(/);
  assert.match(background, /changes\.hermesBrowserSettings[^\n]*syncConnectionHeaders\(\)/);
  const panel = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(panel, /withDraftOriginRule\(/, 'the Add connection test of a new address');
  assert.match(panel, /async function testConnection\(\) \{[\s\S]{0,600}await syncGatewayOriginRule\(\)/, 'Test connection waits for the rule');
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
