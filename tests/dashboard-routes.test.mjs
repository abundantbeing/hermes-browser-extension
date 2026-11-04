import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DASHBOARD_ROUTE_CAPABILITIES,
  dashboardRouteRecordFields,
  probeDashboardRoutes,
  uploadImageViaDashboard,
} from '../extension/lib/dashboard-routes.mjs';
import { deriveCapabilityRecords, normalizeGatewayCapabilities } from '../extension/lib/capabilities.mjs';
import { capabilityIdentity, createCapabilityLedger } from '../extension/lib/capability-status.mjs';

const TOKEN = 'T'.repeat(43);
const reply = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('the probe sends the token as a header, never in the URL, and reads one GET', async () => {
  const calls = [];
  const result = await probeDashboardRoutes({
    baseUrl: 'http://127.0.0.1:9120/', token: TOKEN, now: () => 5,
    fetchFn: async (url, init) => { calls.push({ url, init }); return reply(200); },
  });
  assert.deepEqual(result, { reachable: true, status: 200, checkedAt: 5 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:9120/api/audio/voice-config');
  assert.equal(calls[0].init.headers['X-Hermes-Session-Token'], TOKEN);
  assert.equal(calls[0].init.method, 'GET');
  assert.ok(!calls[0].url.includes(TOKEN));
});

test('the probe names why the dashboard cannot be used', async () => {
  const run = (fetchFn, token = TOKEN) => probeDashboardRoutes({ baseUrl: 'http://127.0.0.1:9119', token, fetchFn });
  assert.equal((await run(async () => reply(401))).reason, 'rejected');
  assert.equal((await run(async () => reply(404))).reason, 'unsupported');
  assert.equal((await run(async () => { throw new Error('refused'); })).reason, 'unreachable');
  let called = false;
  assert.equal((await run(async () => { called = true; return reply(200); }, '')).reason, 'no-token');
  assert.equal(called, false, 'no token, no request');
});

test('a reachable dashboard becomes an available dashboard-route record; otherwise nothing', () => {
  assert.equal(dashboardRouteRecordFields({ reachable: false, reason: 'rejected' }), null);
  const fields = dashboardRouteRecordFields({ reachable: true, checkedAt: 9 });
  assert.equal(fields.state, 'available');
  assert.equal(fields.reasonCode, 'dashboard-route');
});

test('on the 0.22.5 gateway the dashboard probe turns imageUpload on and an advertised route is not overwritten', () => {
  const identity = capabilityIdentity({ endpoint: 'http://127.0.0.1:8642', principal: 'p', profile: 'default' });
  const caps = normalizeGatewayCapabilities({
    object: 'hermes.api_server.capabilities', platform: 'hermes-agent',
    features: { audio_api: true, media_api: true },
    endpoints: { audio_transcribe: { method: 'POST', path: '/api/audio/transcribe' } },
  }, { healthOk: true, hasApiKey: true });
  const ledger = createCapabilityLedger({ now: () => 100 });
  ledger.rebind(identity);
  ledger.ingest(deriveCapabilityRecords(caps, { identityKey: identity.key, checkedAt: 100 }));
  assert.equal(ledger.get('imageUpload').state, 'unknown', 'the API server has no upload route');
  const fields = dashboardRouteRecordFields({ reachable: true, checkedAt: 100 });
  for (const id of DASHBOARD_ROUTE_CAPABILITIES) ledger.observeProbe(id, fields);
  assert.equal(ledger.get('imageUpload').state, 'available');
  assert.equal(ledger.get('imageUpload').reasonCode, 'dashboard-route');
  assert.equal(ledger.get('audioTranscription').reasonCode, 'advertised');
  assert.equal(ledger.get('mediaRead').reasonCode, 'advertised');
});

test('image upload posts the pasted image to /api/chat/image-upload and maps the answer', async () => {
  let seen;
  const result = await uploadImageViaDashboard({
    baseUrl: 'http://127.0.0.1:9120', token: TOKEN, profile: 'work',
    dataUrl: 'data:image/png;base64,AAAA', filename: 'shot.png',
    fetchFn: async (url, init) => { seen = { url, init }; return reply(200, { ok: true, path: '/h/images/a.png', name: 'a.png', bytes: 3, mime_type: 'image/png' }); },
  });
  assert.deepEqual(result, { ok: true, path: '/h/images/a.png', filename: 'a.png', mimeType: 'image/png', size: 3 });
  assert.equal(seen.url, 'http://127.0.0.1:9120/api/chat/image-upload?profile=work');
  assert.equal(seen.init.headers['X-Hermes-Session-Token'], TOKEN);
  assert.deepEqual(JSON.parse(seen.init.body), { data_url: 'data:image/png;base64,AAAA', filename: 'shot.png' });
  assert.ok(!seen.url.includes(TOKEN));
});

test('image upload refuses non-images and reports the dashboard error text', async () => {
  const bad = await uploadImageViaDashboard({ baseUrl: 'http://127.0.0.1:9119', token: TOKEN, dataUrl: 'data:text/plain;base64,AA', fetchFn: async () => reply(200) });
  assert.equal(bad.ok, false);
  const big = await uploadImageViaDashboard({
    baseUrl: 'http://127.0.0.1:9119', token: TOKEN, dataUrl: 'data:image/png;base64,AAAA',
    fetchFn: async () => reply(413, { detail: 'Image is too large; cap is 20 MB' }),
  });
  assert.equal(big.ok, false);
  assert.equal(big.status, 413);
  assert.match(big.error, /too large/);
});
