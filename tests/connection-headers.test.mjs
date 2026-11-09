import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createHermesClient } from '../extension/lib/hermes-client.mjs';

import {
  HEADER_RULE_ID,
  applyConnectionHeaderRules,
  connectionHeaderProblems,
  connectionHeaderRules,
  connectionHeadersAsObject,
  headerNameProblem,
  normalizeConnectionHeaders,
} from '../extension/lib/connection-headers.mjs';
import {
  SAVED_CONNECTION_SECRETS_STORAGE_KEY,
  addSavedConnection,
  hydrateSavedConnectionSecrets,
  packSavedConnectionStorage,
  rememberSavedConnection,
  selectSavedConnection,
} from '../extension/lib/saved-connections.mjs';
import { decryptSavedConnectionSecretBag } from '../extension/lib/saved-connection-secrets-crypto.mjs';

const SECRET = 'proxy-secret-value-123';
const proxied = {
  connectionMode: 'remote', connectionTransport: 'remote-api', gatewayMode: 'remote-api',
  gatewayUrl: 'https://hermes.example.com', apiKey: 'key-for-proxied', tokenSource: 'manual',
  connectionHeaders: [{ name: 'X-Proxy-Token', value: SECRET }],
};

test('header names a browser forbids, or the sign-in owns, are refused', () => {
  for (const name of ['Authorization', 'Host', 'Cookie', 'Origin', 'Proxy-Authorization', 'Sec-Fetch-Mode', 'X-Hermes-Profile', 'Content-Length']) {
    assert.equal(headerNameProblem(name), 'blocked', name);
  }
  assert.equal(headerNameProblem(''), 'empty');
  assert.equal(headerNameProblem('Bad Name'), 'invalid');
  assert.equal(headerNameProblem('CF-Access-Client-Id'), '');
});

test('headers are trimmed, checked, de-duplicated and capped', () => {
  const list = normalizeConnectionHeaders([
    { name: ' X-One ', value: ' 1 ' },
    { name: 'x-one', value: 'repeat' },
    { name: 'Authorization', value: 'x' },
    { name: 'X-Two', value: 'line\nbreak' },
    { name: 'X-Three', value: '' },
    ...Array.from({ length: 20 }, (_, index) => ({ name: `X-N${index}`, value: 'v' })),
  ]);
  assert.deepEqual(list[0], { name: 'X-One', value: '1' });
  assert.equal(list.length, 10);
  assert.ok(!list.some((header) => ['x-two', 'x-three', 'authorization'].includes(header.name.toLowerCase())));
  assert.deepEqual(connectionHeadersAsObject([{ name: 'A', value: 'b' }]), { A: 'b' });
});

test('a form is told which row and field is wrong', () => {
  const problems = connectionHeaderProblems([
    { name: 'X-Ok', value: 'fine' },
    { name: 'Host', value: 'x' },
    { name: 'X-Ok', value: 'again' },
    { name: 'X-Empty', value: '' },
    { name: '', value: '' },
  ]);
  assert.deepEqual(problems, [
    { index: 1, field: 'name', problem: 'blocked' },
    { index: 2, field: 'name', problem: 'repeated' },
    { index: 3, field: 'value', problem: 'empty' },
  ]);
});

test('the network rule covers the connection\'s address and this extension only', () => {
  const [rule] = connectionHeaderRules({ gatewayUrl: 'https://hermes.example.com/path', headers: proxied.connectionHeaders, extensionHost: 'abcdefgh' });
  assert.equal(rule.id, HEADER_RULE_ID);
  assert.deepEqual(rule.action.requestHeaders, [{ header: 'X-Proxy-Token', operation: 'set', value: SECRET }]);
  assert.deepEqual(rule.condition.initiatorDomains, ['abcdefgh']);
  const matches = (address) => new RegExp(rule.condition.regexFilter).test(address);
  assert.ok(matches('https://hermes.example.com/api/sessions') && matches('wss://hermes.example.com/api/ws'));
  assert.ok(matches('https://hermes.example.com:443/api'), 'the default port is the same origin');
  assert.ok(!matches('http://hermes.example.com/api') && !matches('https://hermes.example.com:8443/api'));
  assert.ok(!matches('https://other.example.com/api') && !matches('https://hermes.example.com.evil.test/api'));
  assert.ok(rule.condition.resourceTypes.includes('websocket') && rule.condition.resourceTypes.includes('xmlhttprequest'));
  assert.deepEqual(connectionHeaderRules({ gatewayUrl: 'https://hermes.example.com', headers: [], extensionHost: 'abcdefgh' }), []);
  assert.deepEqual(connectionHeaderRules({ gatewayUrl: 'not a url', headers: proxied.connectionHeaders, extensionHost: 'abcdefgh' }), []);
  assert.deepEqual(connectionHeaderRules({ gatewayUrl: 'https://hermes.example.com', headers: proxied.connectionHeaders }), [], 'no initiator, no rule');
});

test('applying rules replaces the previous rule, and removes it when there are no headers', async () => {
  const calls = [];
  const dnr = { updateSessionRules: async (change) => calls.push(change) };
  await applyConnectionHeaderRules({ gatewayUrl: 'https://hermes.example.com', headers: proxied.connectionHeaders, extensionHost: 'abc' }, dnr);
  await applyConnectionHeaderRules({ gatewayUrl: 'https://hermes.example.com', headers: [], extensionHost: 'abc' }, dnr);
  assert.deepEqual(calls[0].removeRuleIds, [HEADER_RULE_ID]);
  assert.equal(calls[0].addRules.length, 1);
  assert.equal(calls[1].addRules.length, 0);
  assert.equal(await applyConnectionHeaderRules({}, {}), false);
});

test('headers for a loopback gateway do not reach another service on the same machine', () => {
  const [rule] = connectionHeaderRules({ gatewayUrl: 'http://127.0.0.1:8642', headers: proxied.connectionHeaders, extensionHost: 'abc' });
  const matches = (address) => new RegExp(rule.condition.regexFilter).test(address);
  assert.ok(matches('http://127.0.0.1:8642/v1/health') && matches('ws://127.0.0.1:8642/ws'));
  assert.ok(!matches('http://127.0.0.1:9119/api/status'), 'the dashboard on the same host is not this connection');
  assert.ok(!matches('http://127.0.0.1/api'));
});

test('header values are stored protected, restored on hydrate, and removed when the list is cleared', async () => {
  const live = rememberSavedConnection({ ...proxied, activeSavedConnectionId: 'default' });
  const packed = await packSavedConnectionStorage(live);
  assert.equal(JSON.stringify(packed).includes(SECRET), false, 'no plain header value in either record');
  assert.equal(packed.hermesBrowserSettings.connectionHeaders, null, 'the settings record keeps no header');
  assert.equal(packed.hermesBrowserSettings.savedConnections[0].connection.connectionHeaders, null);
  const sidecar = packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY].default;
  assert.deepEqual((await decryptSavedConnectionSecretBag(sidecar)).headers, [{ name: 'X-Proxy-Token', value: SECRET }]);

  const restored = await hydrateSavedConnectionSecrets(packed.hermesBrowserSettings, packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY]);
  assert.deepEqual(restored.connectionHeaders, [{ name: 'X-Proxy-Token', value: SECRET }]);
  assert.equal(restored.apiKey, 'key-for-proxied');

  const stripped = await packSavedConnectionStorage(
    { ...packed.hermesBrowserSettings, connectionHeaders: null },
    packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY],
  );
  const again = await hydrateSavedConnectionSecrets(stripped.hermesBrowserSettings, stripped[SAVED_CONNECTION_SECRETS_STORAGE_KEY]);
  assert.deepEqual(again.connectionHeaders, [{ name: 'X-Proxy-Token', value: SECRET }], 'a writer that never read the headers does not lose them');

  const cleared = await packSavedConnectionStorage({ ...restored, connectionHeaders: [] }, packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY]);
  const none = await hydrateSavedConnectionSecrets(cleared.hermesBrowserSettings, cleared[SAVED_CONNECTION_SECRETS_STORAGE_KEY]);
  assert.deepEqual(none.connectionHeaders || [], []);
  assert.equal(none.apiKey, 'key-for-proxied', 'the key stays when only the headers are cleared');
});

test('each connection keeps its own headers when you switch', async () => {
  const live = rememberSavedConnection({ ...proxied, activeSavedConnectionId: 'default' });
  const withSecond = addSavedConnection(live, 'Plain', 'plain');
  assert.deepEqual(withSecond.connectionHeaders || [], [], 'a new connection starts with none');
  const packed = await packSavedConnectionStorage(withSecond);
  const hydrated = await hydrateSavedConnectionSecrets(packed.hermesBrowserSettings, packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY]);
  const back = selectSavedConnection(hydrated, 'default');
  assert.deepEqual(back.connectionHeaders, [{ name: 'X-Proxy-Token', value: SECRET }]);
});

test('the client sends the connection custom headers and never lets them replace the sign-in', async () => {
  const seen = [];
  const client = createHermesClient({
    fetchImpl: async (_url, init) => { seen.push(init.headers); return { ok: true, status: 200 }; },
    getConnection: () => ({
      gatewayUrl: 'https://hermes.example.com',
      apiKey: 'real-key',
      connectionHeaders: [{ name: 'X-Proxy-Token', value: 'proxy-value' }, { name: 'Authorization', value: 'Bearer attacker' }],
    }),
  });
  await client.fetch('/health');
  assert.equal(seen[0]['X-Proxy-Token'], 'proxy-value');
  assert.equal(seen[0].Authorization, 'Bearer real-key');
});

test('the panel\'s own public requests carry the headers directly, so a browser that skips the network rule still signs in', async () => {
  const panel = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const body = /async function publicApiFetch\(path, options = \{\}\) \{[\s\S]*?\n\}/.exec(panel)?.[0] || '';
  assert.match(body, /\.\.\.connectionHeadersAsObject\(settings\.connectionHeaders\),[\s\S]*\.\.\.\(options\.headers \|\| \{\}\)/, 'the sign-in headers of a request still win');
});

test('the background keeps the network rule in step with the active connection', async () => {
  const background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(background, /applyConnectionHeaderRules\(\{\s*gatewayUrl: settings\.gatewayUrl,\s*headers: settings\.connectionHeaders,\s*extensionHost: extensionInitiatorHost\(/);
  assert.doesNotMatch(background, /extensionHost: browserApi\.runtime/, 'the initiator is the host of the extension pages, not the runtime id');
  assert.match(background, /const syncConnectionHeaders = createHeaderRuleSync\(/, 'updates run one after another');
  assert.match(background, /changes\.hermesBrowserSettings \|\| changes\[SAVED_CONNECTION_SECRETS_STORAGE_KEY\]\) void syncConnectionHeaders\(\)/);
  assert.match(background, /onStartup\.addListener\(async \(\) => \{[\s\S]*await syncConnectionHeaders\(\)/);
});
