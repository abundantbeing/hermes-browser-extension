import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMON_DASHBOARD_PORTS,
  discoverLocalDashboardBaseUrl,
  extractDashboardSessionToken,
  fetchRosterFromDashboard,
  fetchRosterFromGateway,
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
  assert.equal(calls[0], 'http://127.0.0.1:8642/api/desktop/dashboard-candidates');
  assert.ok(calls.includes('http://127.0.0.1:43210'));
  assert.ok(!calls.includes('http://127.0.0.1:1297') || calls.indexOf('http://127.0.0.1:8642/api/desktop/dashboard-candidates') < calls.indexOf('http://127.0.0.1:1297'));
  assert.ok(!calls.some((url) => /:(17\d{3}|18\d{3}|35\d{3}|36\d{3})/.test(url)), 'discovery must not scan arbitrary ephemeral ranges');
});

test('desktop discovery accepts an existing loopback tab candidate without probing arbitrary ports', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (String(url) === 'http://127.0.0.1:43211/api/status') {
      return response({ json: { version: '0.21.0', auth_required: false, gateway_mode: 'multiplex', profiles: ['default'] } });
    }
    return response({ status: 404, body: 'not found' });
  };

  const discovered = await discoverLocalDashboardBaseUrl({
    candidateUrls: ['http://127.0.0.1:43211/dashboard'],
    gatewayUrl: '',
    fetchFn,
    timeoutMs: 2_000,
  });

  assert.equal(discovered, 'http://127.0.0.1:43211');
  assert.ok(!calls.some((url) => url.includes(':22784') || url.includes(':17445')));
  assert.ok(COMMON_DASHBOARD_PORTS.every((port) => !calls.includes(`http://127.0.0.1:${port}/api/status`)));
});

test('desktop discovery sends the gateway key only to the exact sidecar candidate endpoint', async () => {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url: String(url), headers: { ...(options.headers || {}) } });
    if (String(url) === 'http://127.0.0.1:8642/api/desktop/dashboard-candidates') {
      return response({ json: { candidates: [43212] } });
    }
    if (String(url) === 'http://127.0.0.1:43212/api/status') {
      return response({ json: { version: '0.21.0', auth_required: false, gateway_mode: 'multiplex', profiles: ['default'] } });
    }
    return response({ status: 404, body: 'not found' });
  };

  const discovered = await discoverLocalDashboardBaseUrl({
    gatewayUrl: 'http://127.0.0.1:8642',
    apiKey: 'gateway-key-fixture',
    fetchFn,
    timeoutMs: 2_000,
  });

  assert.equal(discovered, 'http://127.0.0.1:43212');
  const sidecar = calls.find((call) => call.url.endsWith('/api/desktop/dashboard-candidates'));
  assert.equal(sidecar.headers.Authorization, 'Bearer gateway-key-fixture');
  const dashboardCalls = calls.filter((call) => call.url.startsWith('http://127.0.0.1:43212'));
  assert.ok(dashboardCalls.length > 0);
  assert.ok(dashboardCalls.every((call) => call.headers.Authorization === undefined));
});

test('live sidecar dashboard port wins over a stale cached URL after Hermes restart', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (String(url) === 'http://127.0.0.1:8642/api/desktop/dashboard-candidates') {
      return response({ json: { candidates: [43210] } });
    }
    if (String(url) === 'http://127.0.0.1:9119') {
      return response({ status: 404, body: 'stale' });
    }
    if (String(url) === 'http://127.0.0.1:43210') {
      return response({ body: '<script>window.__HERMES_SESSION_TOKEN__ = "dash-token"</script>' });
    }
    return response({ status: 404, body: 'not found' });
  };

  const discovered = await discoverLocalDashboardBaseUrl({
    gatewayUrl: 'http://127.0.0.1:8642',
    cachedUrl: 'http://127.0.0.1:9119',
    fetchFn,
    timeoutMs: 2_000,
  });

  assert.equal(discovered, 'http://127.0.0.1:43210');
  assert.equal(calls[0], 'http://127.0.0.1:8642/api/desktop/dashboard-candidates');
});

test('dynamic dashboard discovery recognizes an authenticated dashboard through public status', async () => {
  const fetchFn = async (url) => {
    const target = String(url);
    if (target === 'http://127.0.0.1:9119') {
      return response({ body: '<title>Sign in — Hermes Agent</title>' });
    }
    if (target === 'http://127.0.0.1:9119/api/status') {
      return response({ json: { version: '0.21.0', auth_required: true, gateway_mode: 'multiple', profiles: ['default', 'agency', 'learning'] } });
    }
    return response({ status: 404, body: 'not found' });
  };

  const discovered = await discoverLocalDashboardBaseUrl({
    gatewayUrl: 'http://127.0.0.1:8642',
    fetchFn,
    timeoutMs: 2_000,
  });

  assert.equal(discovered, 'http://127.0.0.1:9119');
});

test('dynamic dashboard discovery rejects generic profile-shaped status payloads', async () => {
  const fetchFn = async (url) => {
    const target = String(url);
    if (target === 'http://127.0.0.1:43210') {
      return response({ body: '<title>Sign in</title>' });
    }
    if (target === 'http://127.0.0.1:43210/api/status') {
      return response({ json: { auth_required: false, profiles: [] } });
    }
    return response({ status: 404, body: 'not found' });
  };

  const discovered = await discoverLocalDashboardBaseUrl({
    explicitUrl: 'http://127.0.0.1:43210',
    fetchFn,
    timeoutMs: 500,
  });

  assert.equal(discovered, '');
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

test('dashboard roster requires signed-in Dashboard authentication instead of trusting public status', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (String(url) === 'http://127.0.0.1:9119') {
      return response({ body: '<title>Sign in — Hermes Agent</title>' });
    }
    return response({
      json: {
        version: '0.21.0',
        auth_required: true,
        gateway_mode: 'multiple',
        profiles: ['default', 'agency', 'learning'],
      },
    });
  };

  await assert.rejects(fetchRosterFromDashboard({
    baseUrl: 'http://127.0.0.1:9119',
    fetchFn,
  }), /dashboard-authentication-required/);

  assert.deepEqual(calls, [
    'http://127.0.0.1:9119',
    'http://127.0.0.1:9119/api/status',
  ]);
});

const LIVE_STATUS = {
  version: '0.21.0',
  auth_required: false,
  gateway_mode: 'multiplex',
  profiles: ['default', 'namine', 'riku'],
};

test('loopback dashboard status with auth_required false still identifies Hermes Desktop', async () => {
  const fetchFn = async (url) => {
    const target = String(url);
    if (target === 'http://127.0.0.1:17445/api/status') {
      return response({ json: LIVE_STATUS });
    }
    if (target === 'http://127.0.0.1:8642/api/desktop/dashboard-candidates') {
      return response({ status: 404, body: 'not found' });
    }
    return response({ status: 404, body: 'not found' });
  };

  const discovered = await discoverLocalDashboardBaseUrl({
    gatewayUrl: 'http://127.0.0.1:8642',
    candidateUrls: ['http://127.0.0.1:17445'],
    fetchFn,
    timeoutMs: 8_000,
  });

  assert.equal(discovered, 'http://127.0.0.1:17445');
});

test('dashboard roster fetch uses loopback profiles when session token injection is gone', async () => {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url: String(url), headers: { ...(options.headers || {}) } });
    if (String(url) === 'http://127.0.0.1:17445') {
      return response({ body: '<title>Hermes</title>' });
    }
    if (String(url).includes('/api/profiles')) {
      return response({ json: { profiles: [{ name: 'namine' }, { name: 'riku' }] } });
    }
    return response({ json: LIVE_STATUS });
  };

  const payload = await fetchRosterFromDashboard({
    baseUrl: 'http://127.0.0.1:17445',
    fetchFn,
  });

  assert.deepEqual(payload, { profiles: [{ name: 'namine' }, { name: 'riku' }] });
  const profileCall = calls.find((call) => call.url.includes('/api/profiles'));
  assert.equal(profileCall?.headers['X-Hermes-Session-Token'], undefined);
});

test('dashboard roster fetch omits cookies so chrome-extension CORS can succeed', async () => {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push(options);
    if (String(url) === 'http://127.0.0.1:17445') {
      return response({ body: '<script>window.__HERMES_SESSION_TOKEN__ = "dash-token"</script>' });
    }
    return response({ json: { profiles: [{ name: 'namine' }] } });
  };
  await fetchRosterFromDashboard({ baseUrl: 'http://127.0.0.1:17445', fetchFn });
  const profileCall = calls.find((options) => options.headers?.['X-Hermes-Session-Token'] === 'dash-token' || options.headers?.Accept === 'application/json');
  assert.equal(profileCall?.credentials, 'omit');
});

test('dashboard roster rejects public status profile names when profiles API is blocked', async () => {
  const fetchFn = async (url) => {
    if (String(url) === 'http://127.0.0.1:17445') {
      return response({ body: '<title>Hermes</title>' });
    }
    if (String(url).includes('/api/profiles')) {
      throw new TypeError('Failed to fetch');
    }
    return response({ json: LIVE_STATUS });
  };
  await assert.rejects(fetchRosterFromDashboard({
    baseUrl: 'http://127.0.0.1:17445',
    fetchFn,
  }), (error) => {
    assert.equal(error.code, 'no-rich-roster');
    assert.equal(error.degraded, true);
    assert.equal(error.metadata.source, 'dashboard-status');
    assert.deepEqual(error.metadata.profileNames, ['default', 'namine', 'riku']);
    return true;
  });
});

test('failed discovery keeps the previous roster instead of wiping it', async () => {
  const { retainRosterAfterFailedDiscovery } = await import('../extension/lib/desktop-roster.mjs');
  const previous = {
    agents: [{ name: 'namine' }],
    groupChats: [{ id: 'room-1', type: 'group' }],
    profiles: ['namine', 'riku'],
  };
  const kept = retainRosterAfterFailedDiscovery({
    incomingAgents: [],
    incomingGroups: [],
    previous,
  });
  assert.equal(kept.keep, true);
  assert.equal(kept.agents, previous.agents);
  assert.equal(kept.groupChats, previous.groupChats);
});

test('gateway health names are degraded metadata, not a rich roster', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/health/detailed')) return response({ status: 401, body: 'no' });
    if (String(url).includes('/p/namine/health')) return response({ json: { status: 'ok' } });
    if (String(url).includes('/p/default/health')) return response({ json: { status: 'ok' } });
    return response({ status: 404, body: 'missing' });
  };
  await assert.rejects(fetchRosterFromGateway({
    gatewayUrl: 'http://127.0.0.1:8642',
    apiKey: ['gateway', 'fixture'].join('-'),
    knownProfileNames: ['namine'],
    fetchFn,
  }), (error) => {
    assert.equal(error.code, 'no-rich-roster');
    assert.equal(error.degraded, true);
    assert.equal(error.metadata.source, 'gateway-health');
    assert.deepEqual(error.metadata.profileNames.sort(), ['default', 'namine']);
    return true;
  });
  assert.ok(calls.some((url) => url.includes('/p/default/health')));
});
