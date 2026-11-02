import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRosterFromGatewayApi, fetchGatewayProfileAvatar } from '../extension/lib/desktop-roster.mjs';

const base = 'https://gateway.example.test';
const plugin = '/api/plugins/hermes-browser-extension/profiles';
function reply(status, json, bytes = []) {
  return { status, ok: status >= 200 && status < 300, json: async () => json,
    headers: { get: () => 'image/png' }, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
}

test('missing upstream roster falls back to the authenticated companion on the same gateway', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/v1/profiles') ? reply(404, {}) : reply(200, { profiles: [{ name: 'worker' }] });
  };
  const result = await fetchRosterFromGatewayApi({ gatewayUrl: base, apiKey: 'fixture-key', fetchFn });
  assert.deepEqual(result.profiles, [{ name: 'worker' }]);
  assert.deepEqual(calls.map((call) => call.url), [`${base}/v1/profiles`, base + plugin]);
  assert.ok(calls.every((call) => call.options.headers.Authorization === 'Bearer fixture-key'));
});

test('an authentication error is not bypassed through the companion fallback', async () => {
  const calls = [];
  const fetchFn = async (url) => { calls.push(url); return reply(401, {}); };
  await assert.rejects(fetchRosterFromGatewayApi({ gatewayUrl: base, apiKey: 'fixture-key', fetchFn }), /gateway-roster-401/);
  assert.deepEqual(calls, [`${base}/v1/profiles`]);
});

test('upstream errors and transport failures are not replaced by another source', async () => {
  for (const status of [403, 500]) {
    const calls = [];
    await assert.rejects(fetchRosterFromGatewayApi({ gatewayUrl: base, apiKey: 'fixture-key', fetchFn: async (url) => { calls.push(url); return reply(status, {}); } }), /gateway-roster-(403|500)/);
    assert.deepEqual(calls, [`${base}/v1/profiles`]);
  }
  const calls = [];
  await assert.rejects(fetchRosterFromGatewayApi({ gatewayUrl: base, apiKey: 'fixture-key', fetchFn: async (url) => { calls.push(url); throw new Error('network down'); } }), /network down/);
  assert.deepEqual(calls, [`${base}/v1/profiles`]);
});

test('an authoritative empty roster does not trigger the fallback', async () => {
  const calls = [];
  const fetchFn = async (url) => { calls.push(url); return reply(200, { profiles: [] }); };
  const result = await fetchRosterFromGatewayApi({ gatewayUrl: base, apiKey: 'fixture-key', fetchFn });
  assert.deepEqual(result.profiles, []);
  assert.deepEqual(calls, [`${base}/v1/profiles`]);
});

test('avatar falls back to the companion only when the upstream route is missing', async () => {
  const calls = [];
  const fetchFn = async (url) => { calls.push(url); return url.includes('/v1/profiles/') ? reply(404, {}) : reply(200, {}, [137, 80, 78, 71]); };
  const image = await fetchGatewayProfileAvatar({ gatewayUrl: base, apiKey: 'fixture-key', profileName: 'worker', fetchFn });
  assert.equal(image, 'data:image/png;base64,iVBORw==');
  assert.deepEqual(calls, [`${base}/v1/profiles/worker/avatar`, `${base}${plugin}/worker/avatar`]);
});
