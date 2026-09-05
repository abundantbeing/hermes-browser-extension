import test from 'node:test';
import assert from 'node:assert/strict';

import {
  discoverLocalDashboardBaseUrl,
  extractDashboardSessionToken,
  fetchRosterFromDashboard,
} from '../extension/lib/desktop-roster.mjs';

function response({ status = 200, body = '', json = undefined, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => String(body),
    json: async () => (json === undefined ? JSON.parse(String(body || 'null')) : json),
  };
}

test('dashboard session token extraction accepts the Desktop bootstrap marker only', () => {
  assert.equal(extractDashboardSessionToken('<script>window.__HERMES_SESSION_TOKEN__ = "dash-token"</script>'), 'dash-token');
  assert.equal(extractDashboardSessionToken('<script>window.__HERMES_SESSION_TOKEN__ = ""</script>'), '');
  assert.equal(extractDashboardSessionToken('<script>window.__OTHER_TOKEN__ = "dash-token"</script>'), '');
});

test('dynamic dashboard discovery uses the sidecar candidate route before scanning', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (String(url) === 'http://127.0.0.1:8642/api/desktop/dashboard-candidates') {
      return response({ json: { candidates: [43210] } });
    }
    if (String(url) === 'http://127.0.0.1:43210') {
      return response({ body: '<script>window.__HERMES_SESSION_TOKEN__ = "dash-token"</script>' });
    }
    return response({ status: 404, body: 'not found' });
  };

  const discovered = await discoverLocalDashboardBaseUrl({
    gatewayUrl: 'http://127.0.0.1:8642',
    fetchFn,
    timeoutMs: 2_000,
  });

  assert.equal(discovered, 'http://127.0.0.1:43210');
  assert.deepEqual(calls, [
    'http://127.0.0.1:1297',
    'http://127.0.0.1:22784',
    'http://127.0.0.1:9119',
    'http://127.0.0.1:8642/api/desktop/dashboard-candidates',
    'http://127.0.0.1:43210',
  ]);
});

test('dashboard roster fetch bootstraps a token and sends it only to the dashboard API', async () => {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url: String(url), headers: { ...(options.headers || {}) } });
    if (String(url) === 'http://127.0.0.1:43210') {
      return response({ body: '<script>window.__HERMES_SESSION_TOKEN__ = "dash-token"</script>' });
    }
    return response({ json: { profiles: [{ name: 'Naminé' }] } });
  };

  const payload = await fetchRosterFromDashboard({
    baseUrl: 'http://127.0.0.1:43210/',
    fetchFn,
  });

  assert.deepEqual(payload, { profiles: [{ name: 'Naminé' }] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['X-Hermes-Session-Token'], undefined);
  assert.equal(calls[1].url, 'http://127.0.0.1:43210/api/profiles?include_sessions=true');
  assert.equal(calls[1].headers['X-Hermes-Session-Token'], 'dash-token');
});
