import assert from 'node:assert/strict';
import test from 'node:test';

import {
  certificateAddress,
  connectionFromDraft,
  draftGatewayUrl,
  firstInvalidStep,
  newConnectionDraft,
  signInMethodsFor,
  stepProblems,
  stepsFor,
} from '../extension/lib/add-connection.mjs';
import { probeConnection } from '../extension/lib/probe-connection.mjs';
import { addSavedConnection, rememberSavedConnection } from '../extension/lib/saved-connections.mjs';

const draft = (overrides) => newConnectionDraft(overrides);

test('Hermes Cloud signs in through the Cloud tab, so it is one step with no methods', () => {
  assert.deepEqual(stepsFor(draft({ type: 'cloud' })), ['where']);
  assert.deepEqual(stepsFor(draft({ type: 'remote' })), ['where', 'signin', 'options']);
  assert.deepEqual(signInMethodsFor('cloud'), []);
  assert.deepEqual(signInMethodsFor('local'), ['browser', 'token']);
});

test('a local connection may leave the address empty, and must stay on this computer', () => {
  assert.deepEqual(stepProblems(draft({ type: 'local' }), 'where'), {});
  assert.equal(draftGatewayUrl(draft({ type: 'local' })), 'http://127.0.0.1:8642');
  assert.equal(draftGatewayUrl(draft({ type: 'local', address: 'localhost:9000' })), 'http://localhost:9000');
  assert.equal(stepProblems(draft({ type: 'local', address: 'https://hermes.example.com' }), 'where').address, 'not-local');
});

test('the browser sign-in of a remote gateway needs https, loopback included: the dashboard connection is https only', () => {
  for (const address of ['http://127.0.0.1:9119', 'http://localhost:9119', 'http://[::1]:9119', 'http://192.168.1.20:9119']) {
    assert.equal(stepProblems(draft({ type: 'remote', address, method: 'browser' }), 'where').address, 'https-required', address);
  }
  assert.deepEqual(stepProblems(draft({ type: 'remote', address: 'https://hermes.example.com', method: 'browser' }), 'where'), {});
  assert.deepEqual(stepProblems(draft({ type: 'remote', address: 'http://127.0.0.1:8642', method: 'token', apiKey: 'k' }), 'where'), {}, 'a key over a tunnel to loopback is the API connection and may use http');
});

test('a remote connection needs a real address, and the browser sign-in needs https', () => {
  assert.equal(stepProblems(draft({ type: 'remote' }), 'where').address, 'required');
  assert.equal(stepProblems(draft({ type: 'remote', address: 'ftp://hermes.example.com' }), 'where').address, 'invalid');
  assert.equal(stepProblems(draft({ type: 'remote', address: 'https://user:pass@hermes.example.com' }), 'where').address, 'invalid');
  assert.deepEqual(stepProblems(draft({ type: 'remote', address: 'https://hermes.example.com', method: 'token' }), 'where'), {});
  assert.deepEqual(stepProblems(draft({ type: 'remote', address: 'http://192.168.1.20:8642', method: 'token' }), 'where'), {});
  assert.equal(stepProblems(draft({ type: 'remote', address: 'http://192.168.1.20:9119', method: 'browser' }), 'where').address, 'https-required');
  assert.equal(draftGatewayUrl(draft({ type: 'remote', address: 'hermes.example.com/' })), 'https://hermes.example.com');
});

test('a remote key is required, a local one is optional, and headers are checked on their own step', () => {
  assert.equal(stepProblems(draft({ type: 'remote', method: 'token' }), 'signin').key, 'required');
  assert.deepEqual(stepProblems(draft({ type: 'remote', method: 'browser' }), 'signin'), {});
  assert.deepEqual(stepProblems(draft({ type: 'local', method: 'token' }), 'signin'), {});
  const bad = stepProblems(draft({ headers: [{ name: 'Host', value: 'x' }] }), 'options');
  assert.deepEqual(bad.headers, [{ index: 0, field: 'name', problem: 'blocked' }]);
  assert.equal(firstInvalidStep(draft({ type: 'remote', address: 'https://h.example.com', method: 'token' })), 'signin');
  assert.equal(firstInvalidStep(draft({ type: 'cloud' })), '');
});

test('each choice makes the connection the Settings form would have saved', () => {
  const local = connectionFromDraft(draft({ type: 'local', method: 'token', apiKey: ' local-key ' }));
  assert.deepEqual(
    [local.connectionMode, local.connectionTransport, local.gatewayMode, local.gatewayUrl, local.apiKey, local.tokenSource],
    ['local', 'local-api', 'local-api', 'http://127.0.0.1:8642', 'local-key', 'manual'],
  );
  const remoteKey = connectionFromDraft(draft({ type: 'remote', address: 'https://hermes.example.com', method: 'token', apiKey: 'k' }));
  assert.deepEqual([remoteKey.connectionTransport, remoteKey.gatewayMode, remoteKey.apiKey], ['remote-api', 'remote-api', 'k']);
  const remoteBrowser = connectionFromDraft(draft({ type: 'remote', address: 'https://hermes.example.com', method: 'browser', apiKey: 'ignored' }));
  assert.deepEqual([remoteBrowser.connectionTransport, remoteBrowser.gatewayMode, remoteBrowser.apiKey, remoteBrowser.tokenSource], ['remote-dashboard', 'remote-dashboard', '', '']);
  const cloud = connectionFromDraft(draft({ type: 'cloud', apiKey: 'ignored', headers: [{ name: 'X-A', value: 'b' }], trustSelfSigned: true }));
  assert.deepEqual(
    [cloud.connectionMode, cloud.connectionTransport, cloud.gatewayUrl, cloud.apiKey, cloud.connectionHeaders, cloud.connectionTrustSelfSigned],
    ['cloud', 'cloud-ticket-ws', '', '', [], false],
  );
  const options = connectionFromDraft(draft({ type: 'remote', address: 'https://h.example.com', method: 'browser', trustSelfSigned: true, headers: [{ name: 'X-A', value: 'b' }, { name: 'Host', value: 'no' }] }));
  assert.equal(options.connectionTrustSelfSigned, true);
  assert.deepEqual(options.connectionHeaders, [{ name: 'X-A', value: 'b' }]);
});

test('the certificate step only offers to open an https address', () => {
  assert.equal(certificateAddress(draft({ type: 'remote', address: 'https://box.local:9119/some/path' })), 'https://box.local:9119');
  assert.equal(certificateAddress(draft({ type: 'remote', address: 'http://box.local:8642' })), '');
  assert.equal(certificateAddress(draft({ type: 'remote', address: '' })), '');
});

test('a new connection starts from what the window collected and leaves the others alone', () => {
  const base = rememberSavedConnection({ gatewayUrl: 'http://127.0.0.1:8642', apiKey: 'first-key', tokenSource: 'manual' });
  const made = connectionFromDraft(draft({ type: 'remote', address: 'https://hermes.example.com', method: 'token', apiKey: 'second-key' }));
  const next = addSavedConnection(base, 'Studio', 'studio', made);
  assert.equal(next.activeSavedConnectionId, 'studio');
  assert.equal(next.gatewayUrl, 'https://hermes.example.com');
  assert.equal(next.apiKey, 'second-key');
  assert.equal(next.connectionMode, 'remote');
  const first = next.savedConnections.find((entry) => entry.id === 'default');
  assert.equal(first.connection.gatewayUrl, 'http://127.0.0.1:8642');
  assert.equal(first.connection.apiKey, 'first-key');
});

const HERMES_HEALTH = { status: 'ok', platform: 'hermes-agent', version: '1' };

// A handler is a status, an Error, or { status, body }; /health answers as Hermes unless told otherwise.
function gateway(handlers) {
  const seen = [];
  return {
    seen,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      seen.push({ path, search: parsed.search, headers: init.headers, signal: init.signal });
      const answer = handlers[path];
      if (answer instanceof Error) throw answer;
      const status = typeof answer === 'object' && answer ? answer.status : (answer ?? 200);
      const body = typeof answer === 'object' && answer && 'body' in answer ? answer.body : (path === '/health' ? HERMES_HEALTH : { sessions: [] });
      return { ok: status < 400, status, json: async () => { if (body === undefined) throw new SyntaxError('no json'); return body; } };
    },
  };
}

test('only a gateway that answers as Hermes and serves its sessions passes the test', async () => {
  const check = async (handlers, extra = {}) => probeConnection({ gatewayUrl: 'https://h.example.com', apiKey: 'k', fetchImpl: gateway(handlers).fetchImpl, ...extra });
  assert.equal((await check({ '/health': { status: 200, body: { status: 'ok' } } })).status, 'not-hermes', 'a health answer that is not Hermes');
  assert.equal((await check({ '/health': { status: 200, body: { platform: 'other-service' } } })).status, 'not-hermes');
  assert.equal((await check({ '/health': { status: 200, body: undefined } })).status, 'not-hermes', 'a page that is not JSON, such as a proxy sign-in page');
  assert.deepEqual(await check({ '/api/sessions': 404 }), { ok: false, status: 'not-hermes', detail: 'HTTP 404' });
  assert.equal((await check({ '/api/sessions': 500 })).status, 'not-hermes');
  assert.equal((await check({ '/api/sessions': 403 })).status, 'unauthorized');
  assert.deepEqual(await check({}), { ok: true, status: 'ok' });
});

test('without a key the sessions answer decides: open gateways pass, signed-in ones ask for a sign-in', async () => {
  const open = await probeConnection({ gatewayUrl: 'https://h.example.com', fetchImpl: gateway({}).fetchImpl });
  assert.deepEqual(open, { ok: true, status: 'ok' });
  const gated = await probeConnection({ gatewayUrl: 'https://h.example.com', fetchImpl: gateway({ '/api/sessions': 401 }).fetchImpl });
  assert.deepEqual(gated, { ok: true, status: 'untested', detail: 'needs-sign-in' });
  assert.equal((await probeConnection({ gatewayUrl: 'https://h.example.com', fetchImpl: gateway({ '/api/sessions': 404 }).fetchImpl })).status, 'not-hermes');
});

test('a test marker rides in every request, and a cancel signal reaches the request', async () => {
  const marked = gateway({});
  const controller = new AbortController();
  await probeConnection({ gatewayUrl: 'https://h.example.com', apiKey: 'k', marker: 'abc123def456', signal: controller.signal, fetchImpl: marked.fetchImpl });
  assert.deepEqual(marked.seen.map((entry) => entry.search), ['?hermes_probe=abc123def456', '?limit=1&hermes_probe=abc123def456']);
  controller.abort();
  assert.ok(marked.seen.every((entry) => entry.signal), 'each request can be cancelled');
  assert.equal(marked.seen[0].signal.aborted, true);
  const plain = gateway({});
  await probeConnection({ gatewayUrl: 'https://h.example.com', apiKey: 'k', fetchImpl: plain.fetchImpl });
  assert.deepEqual(plain.seen.map((entry) => entry.search), ['', '?limit=1']);
});

test('the probe says whether the address answers, the key works, and sends the custom headers', async () => {
  const good = gateway({});
  assert.deepEqual(await probeConnection({ gatewayUrl: 'https://h.example.com/', apiKey: 'k', headers: [{ name: 'X-Proxy', value: 'p' }], fetchImpl: good.fetchImpl }), { ok: true, status: 'ok' });
  assert.equal(good.seen[0].headers['X-Proxy'], 'p');
  assert.equal(good.seen[0].headers.Authorization, undefined, 'health is asked without the key');
  assert.equal(good.seen[1].headers.Authorization, 'Bearer k');

  const down = await probeConnection({ gatewayUrl: 'https://h.example.com', fetchImpl: gateway({ '/health': new TypeError('Failed to fetch') }).fetchImpl });
  assert.equal(down.status, 'unreachable');
  assert.equal((await probeConnection({ gatewayUrl: 'https://h.example.com', apiKey: 'bad', fetchImpl: gateway({ '/api/sessions': 401 }).fetchImpl })).status, 'unauthorized');
  assert.equal((await probeConnection({ gatewayUrl: 'https://h.example.com', apiKey: 'bad', fetchImpl: gateway({ '/health': 403 }).fetchImpl })).status, 'unauthorized');
  assert.equal((await probeConnection({ gatewayUrl: 'https://h.example.com', fetchImpl: gateway({ '/health': 502 }).fetchImpl })).status, 'not-hermes');
  assert.deepEqual(await probeConnection({ gatewayUrl: 'https://h.example.com', fetchImpl: gateway({ '/health': 401 }).fetchImpl }), { ok: true, status: 'untested', detail: 'needs-sign-in' });
  assert.deepEqual(await probeConnection({ gatewayUrl: '' }), { ok: true, status: 'untested' });
});
