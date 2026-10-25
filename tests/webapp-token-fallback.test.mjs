import assert from 'node:assert/strict';
import test from 'node:test';

import { ticketFailureHelp } from '../extension/lib/dashboard-bridge.mjs';
import { restartGatewayViaDashboard } from '../extension/lib/gateway-restart.mjs';
import {
  discoverModelsFromDashboard,
  fetchDashboardSessionToken,
  fetchVoiceLiveStatus,
  transcribeAudioViaDashboard,
} from '../extension/lib/model-discovery.mjs';

const BASE = 'http://127.0.0.1:9120';
const HELD = `cred-${'0123456789'.repeat(4)}`.slice(0, 43);
const NO_TOKEN_PAGE = '<!doctype html><title>Hermes</title>';
const PAGE_TOKEN_HTML = '<script>window.__HERMES_SESSION_TOKEN__ = "page-token"</script>';

function reply(status, { json, body = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => (json === undefined ? JSON.parse(body || 'null') : json),
    text: async () => (json === undefined ? body : JSON.stringify(json)),
  };
}

function recorder(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init, header: init.headers?.['X-Hermes-Session-Token'] });
    return handler(String(url), init);
  };
  impl.calls = calls;
  return impl;
}

// A page that injects no token (the Webapp), and routes that answer only to the right header.
const webappRoutes = (answers = {}, { html = NO_TOKEN_PAGE, expect = HELD } = {}) => recorder((url, init) => {
  if (url === BASE || url === `${BASE}/`) return reply(200, { body: html });
  const presented = init.headers?.['X-Hermes-Session-Token'];
  if (presented !== expect) return reply(401, { json: { detail: 'Unauthorized' } });
  for (const [needle, answer] of Object.entries(answers)) if (url.includes(needle)) return typeof answer === 'function' ? answer(url, init) : answer;
  return reply(404, { body: 'not found' });
});

// --- the session token the dashboard calls send ------------------------------------------------

test('the page token wins, else the held credential, else nothing', async () => {
  const none = recorder(() => reply(200, { body: NO_TOKEN_PAGE }));
  assert.equal(await fetchDashboardSessionToken({ baseUrl: BASE, fetchFn: none }), '');
  assert.equal(await fetchDashboardSessionToken({ baseUrl: BASE, fetchFn: none, dashboardToken: HELD }), HELD);
  const legacy = recorder(() => reply(200, { body: PAGE_TOKEN_HTML }));
  assert.equal(await fetchDashboardSessionToken({ baseUrl: BASE, fetchFn: legacy, dashboardToken: HELD }), 'page-token');
});

test('the held credential still stands in when the page itself does not load', async () => {
  const down = recorder(() => reply(503, { body: 'bundle is stale' }));
  assert.equal(await fetchDashboardSessionToken({ baseUrl: BASE, fetchFn: down, dashboardToken: HELD }), HELD);
  assert.equal(await fetchDashboardSessionToken({ baseUrl: BASE, fetchFn: down }), '', 'and without one nothing is invented');
});

test('models are read over the Webapp listener with the held credential', async () => {
  const fetchFn = webappRoutes({ '/api/model/options': reply(200, { json: { providers: [{ slug: 'p', name: 'P', models: ['m1'] }], model: 'm1', provider: 'p' } }) });
  const withToken = await discoverModelsFromDashboard({ baseUrl: BASE, fetchFn, dashboardToken: HELD });
  assert.equal(withToken.ok, true);
  assert.ok(withToken.models.length >= 1);
  const optionsCall = fetchFn.calls.find((call) => call.url.includes('/api/model/options'));
  assert.equal(optionsCall.header, HELD);
  assert.ok(!optionsCall.url.includes(HELD));

  const without = await discoverModelsFromDashboard({ baseUrl: BASE, fetchFn: webappRoutes() });
  assert.deepEqual({ ok: without.ok, error: without.error }, { ok: false, error: 'no-dashboard-session-token' });
});

test('transcription and the live voice status use the held credential too', async () => {
  const fetchFn = webappRoutes({
    '/api/audio/transcribe': reply(200, { json: { transcript: 'hello', provider: 'local' } }),
    '/api/audio': reply(200, { json: {} }),
  });
  const result = await transcribeAudioViaDashboard({ baseUrl: BASE, fetchFn, dataUrl: 'data:audio/webm;base64,AAAA', dashboardToken: HELD });
  assert.deepEqual({ ok: result.ok, transcript: result.transcript }, { ok: true, transcript: 'hello' });
  assert.equal(fetchFn.calls.find((call) => call.url.includes('/api/audio/transcribe')).header, HELD);
  const refused = await transcribeAudioViaDashboard({ baseUrl: BASE, fetchFn: webappRoutes(), dataUrl: 'data:audio/webm;base64,AAAA' });
  assert.equal(refused.error, 'no-dashboard-session-token');

  const live = webappRoutes({ '/api/audio': reply(200, { json: {} }) });
  await fetchVoiceLiveStatus({ baseUrl: BASE, fetchFn: live, dashboardToken: HELD });
  assert.ok(live.calls.some((call) => call.header === HELD), 'the status request carried the credential');
});

test('the gateway restart works over the Webapp listener with the held credential, and says so when it has none', async () => {
  const fetchFn = webappRoutes({
    '/api/gateway/restart': reply(200, { json: { ok: true } }),
    '/api/status': reply(200, { json: { version: '0.22.5', gateway_mode: 'multiplex', profiles: [], boot_id: 'b1' } }),
  });
  fetchFn.calls.length = 0;
  // The status read is open on the real listener; the restart is the credentialed call.
  const openStatus = async (url, init = {}) => (String(url).endsWith('/api/status')
    ? reply(200, { json: { version: '0.22.5', gateway_mode: 'multiplex', profiles: [], boot_id: 'b1' } })
    : fetchFn(url, init));
  const restarted = await restartGatewayViaDashboard({ baseUrl: BASE, fetchFn: openStatus, dashboardToken: HELD, waitMs: 1, pollMs: 1, sleep: async () => {} });
  assert.notEqual(restarted.reason, 'no-token');
  assert.equal(fetchFn.calls.find((call) => call.url.endsWith('/api/gateway/restart')).header, HELD);

  const without = await restartGatewayViaDashboard({ baseUrl: BASE, fetchFn: openStatus, waitMs: 1, pollMs: 1, sleep: async () => {} });
  assert.deepEqual(without, { ok: false, reason: 'no-token' });
});

// --- what the person is told -------------------------------------------------------------------

test('the sign-in reason names the command, not a dashboard tab', () => {
  const help = ticketFailureHelp('webapp_sign_in_required');
  assert.match(help, /hermes webapp/);
  assert.doesNotMatch(help, /dashboard tab/i);
});
