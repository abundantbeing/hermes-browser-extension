import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMON_DASHBOARD_PORTS,
  classifyDashboardCandidate,
  discoverLocalDashboardBaseUrl,
  fetchRosterFromDashboard,
} from '../extension/lib/desktop-roster.mjs';

const WEBAPP = 'http://127.0.0.1:9120';
const TOKEN = `cred-${'0123456789'.repeat(4)}`.slice(0, 43);

const STATUS = { version: '0.22.5', gateway_mode: 'multiplex', profiles: ['default', 'work'], auth_required: false };

function reply(status, { json, body = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    json: async () => (json === undefined ? JSON.parse(body || 'null') : json),
    text: async () => (json === undefined ? body : JSON.stringify(json)),
  };
}

// What the gateway's Webapp listener does: /api/status is open, /api/profiles needs its credential,
// and the page injects no token. Everything else on every other port refuses.
function webappFetch({ base = WEBAPP, accepts = TOKEN, profilesStatus = 401, status = STATUS, html = '<!doctype html><title>Hermes</title>' } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, headers: { ...(init.headers || {}) } });
    if (!target.startsWith(base)) throw new TypeError('connection refused');
    const path = target.slice(base.length).split('?')[0];
    if (path === '/api/status') return reply(200, { json: status });
    if (path === '/api/profiles') {
      const presented = init.headers?.['X-Hermes-Session-Token'];
      if (accepts && presented === accepts) return reply(200, { json: { profiles: [{ name: 'default' }, { name: 'work' }] } });
      return reply(presented ? 401 : profilesStatus, { json: { detail: 'Unauthorized' } });
    }
    if (path === '' || path === '/') return reply(200, { body: html });
    return reply(404, { body: 'not found' });
  };
  impl.calls = calls;
  return impl;
}

const discover = (options) => discoverLocalDashboardBaseUrl({ gatewayMode: 'local-api', gatewayUrl: '', timeoutMs: 3_000, ...options });

// --- telling the Webapp from a dashboard ------------------------------------------------------

test('Hermes Web is recognised by an open /api/status, a 401 on an uncredentialed /api/profiles and a page with no token', async () => {
  assert.equal(await classifyDashboardCandidate(WEBAPP, webappFetch()), 'webapp');
});

test('a dashboard that serves /api/profiles to a loopback caller is a dashboard', async () => {
  assert.equal(await classifyDashboardCandidate(WEBAPP, webappFetch({ profilesStatus: 200 })), 'dashboard');
});

test('a token-injecting dashboard that refuses an uncredentialed read is still a dashboard', async () => {
  const html = '<script>window.__HERMES_SESSION_TOKEN__ = "dash-token"</script>';
  assert.equal(await classifyDashboardCandidate(WEBAPP, webappFetch({ html })), 'dashboard');
});

test('a sign-in gated dashboard is a dashboard without any further probe', async () => {
  const fetchFn = webappFetch({ status: { ...STATUS, auth_required: true } });
  assert.equal(await classifyDashboardCandidate(WEBAPP, fetchFn), 'dashboard');
  assert.deepEqual(fetchFn.calls.map((call) => call.url), [`${WEBAPP}/api/status`]);
});

test('something that is not a Hermes dashboard is neither', async () => {
  assert.equal(await classifyDashboardCandidate(WEBAPP, webappFetch({ status: { auth_required: false, profiles: [] } })), '');
  assert.equal(await classifyDashboardCandidate(WEBAPP, async () => { throw new TypeError('refused'); }), '');
});

// --- discovery -------------------------------------------------------------------------------

test('without a credential the Webapp listener is reported and not adopted, so the roster can use the gateway routes', async () => {
  const fetchFn = webappFetch();
  const seen = [];
  const found = await discover({ fetchFn, webappUrl: `${WEBAPP}/`, webappCredentialFor: async () => '', onWebapp: (info) => seen.push(info) });
  assert.equal(found, '');
  assert.deepEqual(seen, [{ origin: WEBAPP, url: WEBAPP, credential: 'none' }]);
  assert.ok(fetchFn.calls.every((call) => !call.headers['X-Hermes-Session-Token']), 'no credential was sent');
});

test('with a credential the Webapp accepts, the listener is adopted as the dashboard', async () => {
  const fetchFn = webappFetch();
  const seen = [];
  const asked = [];
  const found = await discover({
    fetchFn, webappUrl: WEBAPP,
    webappCredentialFor: async (origin) => { asked.push(origin); return TOKEN; },
    onWebapp: (info) => seen.push(info),
  });
  assert.equal(found, WEBAPP);
  assert.deepEqual(seen, [{ origin: WEBAPP, url: WEBAPP, credential: 'accepted' }]);
  assert.deepEqual(asked, [WEBAPP], 'the credential is asked for by origin, only after the listener proved to be the Webapp');
  const credentialed = fetchFn.calls.filter((call) => call.headers['X-Hermes-Session-Token']);
  assert.deepEqual(credentialed.map((call) => call.url), [`${WEBAPP}/api/profiles`], 'sent only to the Webapp, only to /api/profiles');
});

test('a credential the Webapp refuses is reported as rejected and the listener is not adopted', async () => {
  const seen = [];
  const found = await discover({
    fetchFn: webappFetch({ accepts: 'someone-else' }), webappUrl: WEBAPP,
    webappCredentialFor: async () => TOKEN, onWebapp: (info) => seen.push(info),
  });
  assert.equal(found, '');
  assert.deepEqual(seen.map((info) => info.credential), ['rejected']);
});

test('a Webapp that errors on the credentialed probe is not adopted and not called a rejection', async () => {
  const fetchFn = webappFetch();
  const flaky = async (url, init = {}) => {
    if (init.headers?.['X-Hermes-Session-Token']) return reply(503, { body: 'starting' });
    return fetchFn(url, init);
  };
  const seen = [];
  const found = await discover({ fetchFn: flaky, webappUrl: WEBAPP, webappCredentialFor: async () => TOKEN, onWebapp: (info) => seen.push(info) });
  assert.equal(found, '');
  assert.deepEqual(seen.map((info) => info.credential), ['unknown']);
});

test('a broken credential lookup or listener cannot break discovery', async () => {
  const found = await discover({
    fetchFn: webappFetch(), webappUrl: WEBAPP,
    webappCredentialFor: async () => { throw new Error('storage gone'); },
    onWebapp: () => { throw new Error('listener bug'); },
  });
  assert.equal(found, '');
});

test('9120 is one of the ports scanned, after the Desktop dashboard ports', async () => {
  assert.deepEqual([...COMMON_DASHBOARD_PORTS].slice(-2), [9119, 9120]);
  const fetchFn = webappFetch();
  const found = await discover({ fetchFn, webappCredentialFor: async () => TOKEN });
  assert.equal(found, WEBAPP, 'found without the Hermes Web address setting');
  const statusCalls = fetchFn.calls.map((call) => call.url).filter((url) => url.endsWith('/api/status'));
  assert.ok(statusCalls.indexOf('http://127.0.0.1:9119/api/status') < statusCalls.indexOf(`${WEBAPP}/api/status`));
});

test('the Hermes Web address setting is a candidate, and only when it is on this computer', async () => {
  const custom = 'http://127.0.0.1:9300';
  const fetchFn = webappFetch({ base: custom });
  assert.equal(await discover({ fetchFn, webappUrl: `${custom}/`, webappCredentialFor: async () => TOKEN }), custom);

  const remote = webappFetch({ base: 'https://web.example.com' });
  assert.equal(await discover({ fetchFn: remote, webappUrl: 'https://web.example.com', webappCredentialFor: async () => TOKEN }), '');
  assert.ok(remote.calls.every((call) => !call.url.startsWith('https://web.example.com')), 'a remote address is never probed');
});

test('an open dashboard is adopted exactly as before and never reported as a Webapp', async () => {
  const fetchFn = webappFetch({ profilesStatus: 200 });
  const seen = [];
  const found = await discover({ fetchFn, webappCredentialFor: async () => TOKEN, onWebapp: (info) => seen.push(info) });
  assert.equal(found, WEBAPP);
  assert.deepEqual(seen, []);
  assert.ok(fetchFn.calls.every((call) => !call.headers['X-Hermes-Session-Token']));
});

test('discovery stays closed outside the local gateway even when a Webapp address is handed in', async () => {
  const fetchFn = webappFetch();
  for (const gatewayMode of ['remote-api', 'remote-dashboard', 'cloud', '']) {
    assert.equal(await discoverLocalDashboardBaseUrl({ gatewayMode, webappUrl: WEBAPP, webappCredentialFor: async () => TOKEN, fetchFn }), '');
  }
  assert.deepEqual(fetchFn.calls, []);
});

// --- the rich roster over the Webapp listener --------------------------------------------------

test('the dashboard roster fetch uses the held credential when the page injects no token', async () => {
  const fetchFn = webappFetch();
  const payload = await fetchRosterFromDashboard({ baseUrl: `${WEBAPP}/`, fetchFn, token: TOKEN });
  assert.deepEqual(payload.profiles.map((row) => row.name), ['default', 'work']);
  const profileCall = fetchFn.calls.find((call) => call.url.includes('/api/profiles'));
  assert.equal(profileCall.headers['X-Hermes-Session-Token'], TOKEN);
  assert.equal(profileCall.url, `${WEBAPP}/api/profiles?include_sessions=true`);
});

test('a token the page injects wins over the held credential, and without either a gated listener is refused', async () => {
  const html = '<script>window.__HERMES_SESSION_TOKEN__ = "dash-token"</script>';
  const fetchFn = webappFetch({ html, accepts: 'dash-token' });
  await fetchRosterFromDashboard({ baseUrl: WEBAPP, fetchFn, token: TOKEN });
  assert.equal(fetchFn.calls.find((call) => call.url.includes('/api/profiles')).headers['X-Hermes-Session-Token'], 'dash-token');

  await assert.rejects(
    fetchRosterFromDashboard({ baseUrl: WEBAPP, fetchFn: webappFetch({ status: { ...STATUS, auth_required: true } }) }),
    /dashboard-authentication-required/,
  );
});
