import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONNECTION_MODES,
  CONNECTION_SCHEMA_VERSION,
  CONNECTION_TRANSPORTS,
  connectionModePreviewUrl,
  legacyGatewayModeForConnection,
  migrateConnectionSettings,
  normalizeConnectionMode,
  resolvePhaseATransport,
} from '../extension/lib/connection-modes.mjs';

test('connection modes expose Desktop-aligned product choices', () => {
  assert.deepEqual(CONNECTION_MODES.map((mode) => mode.value), ['local', 'cloud', 'remote']);
  assert.equal(normalizeConnectionMode('CLOUD'), 'cloud');
  assert.equal(normalizeConnectionMode('bogus'), 'local');
  const freshInstall = migrateConnectionSettings({});
  assert.equal(freshInstall.connectionMode, 'local');
  assert.equal(freshInstall.connectionTransport, 'local-api');
});

test('legacy settings migrate without relabeling remote dashboards as Cloud', () => {
  const local = migrateConnectionSettings({
    gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642',
  });
  assert.deepEqual(
    {
      connectionSchemaVersion: local.connectionSchemaVersion,
      connectionMode: local.connectionMode,
      connectionTransport: local.connectionTransport,
    },
    {
      connectionSchemaVersion: CONNECTION_SCHEMA_VERSION,
      connectionMode: 'local',
      connectionTransport: 'local-api',
    },
  );

  const remoteApi = migrateConnectionSettings({ gatewayMode: 'remote-api' });
  assert.equal(remoteApi.connectionMode, 'remote');
  assert.equal(remoteApi.connectionTransport, 'remote-api');

  const remoteDashboard = migrateConnectionSettings({ gatewayMode: 'remote-dashboard' });
  assert.equal(remoteDashboard.connectionMode, 'remote');
  assert.equal(remoteDashboard.connectionTransport, 'remote-dashboard');
});

test('explicit Cloud provenance survives migration and maps to ticket WebSocket', () => {
  const migrated = migrateConnectionSettings({
    connectionSchemaVersion: 1,
    connectionMode: 'cloud',
    connectionTransport: 'remote-dashboard',
    gatewayMode: 'remote-dashboard',
  });
  assert.equal(migrated.connectionMode, 'cloud');
  assert.equal(migrated.connectionTransport, CONNECTION_TRANSPORTS.CLOUD_TICKET_WS);
  assert.equal(legacyGatewayModeForConnection(migrated), 'remote-dashboard');
  assert.deepEqual(migrateConnectionSettings(migrated), migrated);
});

test('compatibility mapping preserves current local and remote transports', () => {
  assert.equal(legacyGatewayModeForConnection({ connectionMode: 'local' }), 'local-api');
  assert.equal(legacyGatewayModeForConnection({ connectionMode: 'cloud' }), 'remote-dashboard');
  assert.equal(
    legacyGatewayModeForConnection({ connectionMode: 'remote', connectionTransport: 'remote-api' }),
    'remote-api',
  );
  assert.equal(
    legacyGatewayModeForConnection({ connectionMode: 'remote', connectionTransport: 'remote-dashboard' }),
    'remote-dashboard',
  );
});

test('Phase A transport resolution preserves explicit remote transport', () => {
  assert.equal(resolvePhaseATransport({ connectionMode: 'local' }), 'local-api');
  assert.equal(resolvePhaseATransport({ connectionMode: 'cloud' }), 'cloud-ticket-ws');
  assert.equal(
    resolvePhaseATransport({ connectionMode: 'remote', currentTransport: 'remote-api' }),
    'remote-api',
  );
  assert.equal(
    resolvePhaseATransport({ connectionMode: 'remote', currentTransport: 'remote-dashboard' }),
    'remote-dashboard',
  );
  assert.equal(resolvePhaseATransport({ connectionMode: 'remote', apiKey: 'set' }), 'remote-api');
  assert.equal(resolvePhaseATransport({ connectionMode: 'remote', apiKey: '' }), 'remote-dashboard');
});

test('Cloud mode never writes an example host into the actual gateway URL', () => {
  assert.equal(connectionModePreviewUrl({
    connectionMode: 'cloud',
    currentUrl: 'http://127.0.0.1:8642',
    localDefaultUrl: 'http://127.0.0.1:8642',
    transportDefaultUrl: 'https://your-hermes-host.example.com',
  }), '');
  assert.equal(connectionModePreviewUrl({
    connectionMode: 'remote',
    currentUrl: 'http://127.0.0.1:8642',
    localDefaultUrl: 'http://127.0.0.1:8642',
    transportDefaultUrl: 'https://your-hermes-host.example.com',
  }), 'https://your-hermes-host.example.com');
  assert.equal(connectionModePreviewUrl({
    connectionMode: 'cloud',
    currentUrl: 'https://cloud-agent.example.test',
    localDefaultUrl: 'http://127.0.0.1:8642',
    transportDefaultUrl: 'https://your-hermes-host.example.com',
  }), 'https://cloud-agent.example.test');
});

test('migration preserves unrelated settings and repairs malformed connection values', () => {
  const input = {
    connectionSchemaVersion: 1,
    connectionMode: 'bogus',
    connectionTransport: 'bogus',
    gatewayMode: 'remote-api',
    gatewayUrl: 'https://api.example.test',
    selectedModel: 'provider/model',
  };
  const migrated = migrateConnectionSettings(input);
  assert.equal(migrated.connectionMode, 'local');
  assert.equal(migrated.connectionTransport, 'local-api');
  assert.equal(migrated.gatewayUrl, input.gatewayUrl);
  assert.equal(migrated.selectedModel, input.selectedModel);
});
