import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMON_DASHBOARD_PORTS, discoverLocalDashboardBaseUrl } from '../extension/lib/desktop-roster.mjs';
import { resolveDashboardTranscriptionBaseUrl } from '../extension/lib/model-discovery.mjs';

const REMOTE_GATEWAY = 'https://agent.example.test';

function recordingFetch(calls) {
  return async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ version: '0.21.0', gateway_mode: 'multiplex', profiles: ['default'], auth_required: false }),
      text: async () => '<script>window.__HERMES_SESSION_TOKEN__ = "dash-token"</script>',
    };
  };
}

test('dashboard discovery makes no request outside the local gateway, whatever it is handed', async () => {
  for (const gatewayMode of ['remote-api', 'remote-dashboard', 'cloud', '']) {
    const calls = [];
    const found = await discoverLocalDashboardBaseUrl({
      gatewayMode,
      gatewayUrl: REMOTE_GATEWAY,
      candidateUrls: ['http://127.0.0.1:43211'],
      explicitUrl: 'http://127.0.0.1:9119',
      cachedUrl: 'http://localhost:22784',
      apiKey: 'gateway-key-fixture',
      fetchFn: recordingFetch(calls),
      timeoutMs: 2_000,
    });
    assert.equal(found, '', `${gatewayMode || 'an unnamed mode'} must not discover a dashboard`);
    assert.deepEqual(calls, [], `${gatewayMode || 'an unnamed mode'} must not probe this machine or the remote gateway`);
  }
});

test('dashboard discovery stays closed when the caller omits the gateway mode', async () => {
  const calls = [];
  const found = await discoverLocalDashboardBaseUrl({
    candidateUrls: ['http://127.0.0.1:43211'],
    gatewayUrl: 'http://127.0.0.1:8642',
    fetchFn: recordingFetch(calls),
    timeoutMs: 2_000,
  });
  assert.equal(found, '');
  assert.deepEqual(calls, []);
});

test('voice transcription targets a loopback dashboard only from the local gateway', async () => {
  let discoveries = 0;
  const discover = async () => {
    discoveries += 1;
    return 'http://127.0.0.1:43210';
  };
  assert.equal(await resolveDashboardTranscriptionBaseUrl({
    gatewayMode: 'remote-api',
    gatewayUrl: REMOTE_GATEWAY,
    desktopDashboardUrl: 'http://127.0.0.1:9119',
    discover,
  }), '');
  assert.equal(await resolveDashboardTranscriptionBaseUrl({
    gatewayMode: 'remote-dashboard',
    gatewayUrl: 'https://dashboard.example.test',
    desktopDashboardUrl: 'http://127.0.0.1:9119',
    discover,
  }), 'https://dashboard.example.test');
  assert.equal(discoveries, 0, 'remote modes never run loopback discovery');
  assert.equal(await resolveDashboardTranscriptionBaseUrl({
    gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642',
    discover,
  }), 'http://127.0.0.1:43210');
  assert.equal(discoveries, 1);
});

test('the fixed Desktop dashboard ports are kept for local discovery, with the Webapp listener last', () => {
  assert.deepEqual([...COMMON_DASHBOARD_PORTS], [1297, 22784, 9119, 9120]);
});
