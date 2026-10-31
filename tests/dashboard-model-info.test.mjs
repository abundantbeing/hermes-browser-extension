import test from 'node:test';
import assert from 'node:assert/strict';
import { readDashboardModelInfo } from '../extension/lib/dashboard-routes.mjs';

const answer = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('reads the effective window of the configured model', async () => {
  let seen;
  const result = await readDashboardModelInfo({
    baseUrl: 'http://127.0.0.1:9119/', token: 'abc', profile: 'work',
    fetchFn: async (url, init) => { seen = { url, init }; return answer({ model: 'gpt-6.1-sol', provider: 'openai', auto_context_length: 1_050_000, config_context_length: 500_000, effective_context_length: 500_000 })(); },
  });
  assert.deepEqual(result, { ok: true, model: 'gpt-6.1-sol', provider: 'openai', tokens: 500_000 });
  assert.equal(seen.url, 'http://127.0.0.1:9119/api/model/info?profile=work');
  assert.equal(seen.init.headers['X-Hermes-Session-Token'], 'abc');
  assert.equal(seen.init.credentials, 'omit');
});

test('falls back to the auto-detected window, and treats 0 as unresolved', async () => {
  assert.equal((await readDashboardModelInfo({ baseUrl: 'http://x', token: 't', fetchFn: answer({ model: 'm', auto_context_length: 200_000, effective_context_length: 0 }) })).tokens, 200_000);
  assert.deepEqual(await readDashboardModelInfo({ baseUrl: 'http://x', token: 't', fetchFn: answer({ model: 'm', auto_context_length: 0, effective_context_length: 0 }) }), { ok: false, reason: 'unresolved' });
});

test('refusals and failures say why and never throw', async () => {
  assert.deepEqual(await readDashboardModelInfo({ baseUrl: 'http://x', token: '', fetchFn: answer({}) }), { ok: false, reason: 'no-token' });
  assert.equal((await readDashboardModelInfo({ baseUrl: 'http://x', token: 't', fetchFn: answer({}, 401) })).reason, 'rejected');
  assert.equal((await readDashboardModelInfo({ baseUrl: 'http://x', token: 't', fetchFn: answer({}, 404) })).reason, 'unsupported');
  assert.equal((await readDashboardModelInfo({ baseUrl: 'http://x', token: 't', fetchFn: async () => { throw new Error('down'); } })).reason, 'unreachable');
});
