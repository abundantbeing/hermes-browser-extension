import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CONNECTION_MODES,
  CONNECTION_SCHEMA_VERSION,
  CONNECTION_TRANSPORTS,
  apiCredentialSatisfied,
  automaticApiPairingAllowed,
  connectionModePreviewUrl,
  connectionSettingsAfterTokenClear,
  isLoopbackGatewayUrl,
  legacyGatewayModeForConnection,
  migrateConnectionSettings,
  normalizeConnectionMode,
  resolvePhaseATransport,
  sanitizeGatewayUrlForConnectionMode,
  transportRequiresApiKey,
  transportUsesDashboardTicket,
  isGatewayAuthRejection,
  isGatewayControlKeyUnconfigured,
  isMissingGatewayCredential,
} from '../extension/lib/connection-modes.mjs';

const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const sidepanelHtmlSource = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');

test('connection modes expose Desktop-aligned product choices', () => {
  assert.deepEqual(CONNECTION_MODES.map((mode) => mode.value), ['local', 'cloud', 'remote']);
  assert.equal(CONNECTION_MODES.find((mode) => mode.value === 'cloud')?.label, 'Hermes Cloud Preview');
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

test('ticket transports are keyless while Local and Remote API require credentials', () => {
  assert.equal(transportRequiresApiKey(CONNECTION_TRANSPORTS.LOCAL_API), true);
  assert.equal(transportRequiresApiKey(CONNECTION_TRANSPORTS.REMOTE_API), true);
  assert.equal(transportRequiresApiKey(CONNECTION_TRANSPORTS.CLOUD_TICKET_WS), false);
  assert.equal(transportRequiresApiKey(CONNECTION_TRANSPORTS.REMOTE_DASHBOARD), false);
  assert.equal(transportUsesDashboardTicket(CONNECTION_TRANSPORTS.CLOUD_TICKET_WS), true);
  assert.equal(transportUsesDashboardTicket(CONNECTION_TRANSPORTS.REMOTE_DASHBOARD), true);
  assert.equal(apiCredentialSatisfied({ connectionMode: 'cloud', apiKey: '' }), true);
  assert.equal(apiCredentialSatisfied({ connectionMode: 'local', apiKey: '' }), false);
});

test('automatic API pairing is loopback-only and enforced by the side-panel connect path', () => {
  assert.equal(automaticApiPairingAllowed({
    connectionMode: 'local',
    connectionTransport: CONNECTION_TRANSPORTS.LOCAL_API,
    gatewayUrl: 'http://127.0.0.1:8642',
  }), true);
  assert.equal(automaticApiPairingAllowed({
    connectionMode: 'local',
    connectionTransport: CONNECTION_TRANSPORTS.LOCAL_API,
    gatewayUrl: 'https://api.example.test',
  }), false);
  assert.equal(automaticApiPairingAllowed({
    connectionMode: 'remote',
    connectionTransport: CONNECTION_TRANSPORTS.REMOTE_API,
    gatewayUrl: 'https://api.example.test',
  }), false);
  const connectBody = sidepanelSource.match(/async function connectApiWithPairing\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(connectBody, /automaticApiPairingAllowed\(settings\)/);
  assert.match(connectBody, /Automatic pairing is available only for a loopback Local gateway/);
});

test('a completed pairing rebinds the controller instead of leaving it on stale settings', () => {
  const pairingBody = sidepanelSource.match(/async function connectApiWithPairing\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(pairingBody, /tokenSource = 'pairing'/, 'the pairing success path must persist the token');
  assert.match(pairingBody, /HERMES_CONTROLLER_SETTINGS_REFRESH/, 'the pairing success path must rebind the controller');
  assert.ok(
    pairingBody.indexOf("tokenSource = 'pairing'") < pairingBody.indexOf('HERMES_CONTROLLER_SETTINGS_REFRESH'),
    'the controller refresh must follow the stored token',
  );
});

test('creating the browser session never reuses the colliding default title', () => {
  const ensureBody = sidepanelSource.match(/async function ensureHermesSession\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(ensureBody, /isDefaultBrowserSessionTitle\(settings\.sessionTitle\)/, 'the default title must be detected before the create');
  assert.match(ensureBody, /makeBrowserSessionTitle\(\)/);
  assert.ok(
    ensureBody.indexOf('makeBrowserSessionTitle()') < ensureBody.indexOf("apiFetch('/api/sessions'"),
    'a unique title must be minted before the create POST',
  );
});

test('tab control keeps its credential path reachable when chat runs on the desktop dashboard', () => {
  // Chat can be "connected" over the local Desktop dashboard transport with no
  // API credential, while the controller still needs one. The repair must live
  // on the control surface, never on the first-run setup card, and it must not
  // depend on the panel's own connection state.
  assert.match(
    sidepanelSource,
    /els\.connectPanel\.hidden = connected;/,
    'the first-run setup card must never reappear for a connected panel',
  );
  assert.doesNotMatch(
    sidepanelSource,
    /els\.connectPanel\.hidden = connected &&/,
    'connection state alone decides the setup card',
  );
  assert.match(
    sidepanelSource,
    /function controllerCredentialMissing\(\) \{[^}]*transportRequiresApiKey\(settings\.connectionTransport\)[^}]*apiCredentialSatisfied\(settings\)/s,
    'the credential check must be transport-aware and credential-aware',
  );
  assert.match(
    sidepanelSource,
    /els\.browserControlAuthorizeButton\.hidden = !view\.canAuthorize/,
    'the strip must show the authorize action for exactly the missing-credential views',
  );
  const authorizeHandler = sidepanelSource.match(/els\.browserControlAuthorizeButton\?\.addEventListener\('click', async \(\) => \{([\s\S]*?)\n {2}\}\);/)?.[1] || '';
  assert.match(authorizeHandler, /ensureControllerCredentialForControl\(\)/, 'the strip action must run the pairing flow');
  assert.match(authorizeHandler, /attachBrowserControlToCurrentTab\(\)/, 'the strip action must continue into attaching the tab');
  const enableBody = sidepanelSource.match(/async function enableBrowserControl\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(enableBody, /ensureControllerCredentialForControl\(\)/, 'enabling control must run the pairing flow when no credential is saved');
  const attachBody = sidepanelSource.match(/async function attachBrowserControlToCurrentTab\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(attachBody, /ensureControllerCredentialForControl\(\)/, 'attaching a tab must run the pairing flow when no credential is saved');
  assert.match(sidepanelHtmlSource, /id="browserControlAuthorizeButton"[^>]*data-i18n="browser_control\.authorize"/, 'the authorize button needs an i18n-owned label');
});

test('Cloud sanitization rejects loopback, insecure, and credential-bearing origins', () => {
  assert.equal(isLoopbackGatewayUrl('http://127.0.0.1:8642'), true);
  assert.equal(isLoopbackGatewayUrl('https://agent.example.test'), false);
  assert.equal(sanitizeGatewayUrlForConnectionMode({ connectionMode: 'cloud', gatewayUrl: 'http://127.0.0.1:8642' }), '');
  assert.equal(sanitizeGatewayUrlForConnectionMode({ connectionMode: 'cloud', gatewayUrl: 'http://agent.example.test' }), '');
  assert.equal(sanitizeGatewayUrlForConnectionMode({ connectionMode: 'cloud', gatewayUrl: 'https://user@agent.example.test' }), '');
  assert.equal(sanitizeGatewayUrlForConnectionMode({ connectionMode: 'cloud', gatewayUrl: 'https://agent.example.test/chat' }), 'https://agent.example.test');
});

test('clearing an API token falls back to ticket-based dashboard transport for remote connections', () => {
  const remoteApi = connectionSettingsAfterTokenClear({
    connectionSchemaVersion: CONNECTION_SCHEMA_VERSION,
    connectionMode: 'remote',
    connectionTransport: CONNECTION_TRANSPORTS.REMOTE_API,
    apiKey: 'remote-api-token',
  });
  assert.equal(remoteApi.connectionMode, 'remote');
  assert.equal(remoteApi.connectionTransport, CONNECTION_TRANSPORTS.REMOTE_DASHBOARD);
  assert.equal(remoteApi.apiKey, '');
  assert.equal(remoteApi.gatewayMode, 'remote-dashboard');

  const remoteDashboard = connectionSettingsAfterTokenClear({
    connectionSchemaVersion: CONNECTION_SCHEMA_VERSION,
    connectionMode: 'remote',
    connectionTransport: CONNECTION_TRANSPORTS.REMOTE_DASHBOARD,
    apiKey: 'remote-dashboard-token',
  });
  assert.equal(remoteDashboard.connectionTransport, CONNECTION_TRANSPORTS.REMOTE_DASHBOARD);
  assert.equal(remoteDashboard.apiKey, '');

  const local = connectionSettingsAfterTokenClear({
    connectionSchemaVersion: CONNECTION_SCHEMA_VERSION,
    connectionMode: 'local',
    connectionTransport: CONNECTION_TRANSPORTS.LOCAL_API,
    apiKey: 'local-api-token',
  });
  assert.equal(local.connectionTransport, CONNECTION_TRANSPORTS.LOCAL_API);
  assert.equal(local.gatewayMode, 'local-api');

  const legacyRemoteApi = connectionSettingsAfterTokenClear({ gatewayMode: 'remote-api', apiKey: 'legacy-remote-token' });
  assert.equal(legacyRemoteApi.connectionMode, 'remote');
  assert.equal(legacyRemoteApi.connectionTransport, CONNECTION_TRANSPORTS.REMOTE_DASHBOARD);
  assert.equal(legacyRemoteApi.gatewayMode, 'remote-dashboard');
});

test('clearStoredToken applies the post-clear transport fallback and re-runs readiness on transport change', () => {
  const clearBody = sidepanelSource.match(/async function clearStoredToken\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(clearBody, /connectionSettingsAfterTokenClear\(settings\)/);
  assert.doesNotMatch(clearBody, /runPanelConnectionReadiness\(\)/);
  assert.match(clearBody, /updateConnectionPrompt\(\)/);
  assert.match(clearBody, /HERMES_CONTROLLER_SETTINGS_REFRESH/);
  assert.match(clearBody, /clearCachedRosterUrl/);
  assert.match(clearBody, /profileWsConnection/);
  assert.match(clearBody, /activeDashboardWsConnection/);
});

test('loadSkills uses the profile dashboard socket and never REST-falls-back onto a named profile', () => {
  assert.match(sidepanelSource, /profileWsConnection/);
  assert.match(sidepanelSource, /restSkillsFallbackAllowed/);
});

test('loadSkills recovers dashboard skills when the REST catalog fails', () => {
  const loadBody = sidepanelSource.match(/async function loadSkills\([\s\S]*?\nfunction replaceActiveSkillToken/)?.[0] || '';
  assert.match(loadBody, /ensureProfileWsConnection/);
  assert.match(loadBody, /shouldRecoverSkillsFromDashboard/);
  assert.match(loadBody, /WS_METHODS\.profilesDescribe/);
  assert.match(
    sidepanelSource,
    /void loadProfiles\(\{ quiet: true, allowDashboardTrust: true \}\);\s*void loadSkills\(\{ quiet: true \}\);/s,
  );
});

test('isGatewayAuthRejection classifies pairing and HTTP auth failures', () => {
  assert.equal(isGatewayAuthRejection('Controller registration failed (HTTP 401).'), true);
  assert.equal(isGatewayAuthRejection('Network unreachable.'), false);
  // Only a credential the gateway actually rejected may clear a saved token.
  assert.equal(isGatewayAuthRejection('Invalid gateway API key (API_SERVER_KEY)'), true);
  assert.equal(isGatewayAuthRejection('gateway_auth_failed'), true);
  assert.equal(isGatewayAuthRejection('Controller API registration requires an API credential.'), false);
  assert.equal(isGatewayAuthRejection('Browser control registration requires a configured API key.'), false);
  assert.equal(isGatewayAuthRejection('Browser control may register only for an existing server session.'), false);
  assert.equal(isGatewayAuthRejection('Controller registration failed (HTTP 403).'), false);
});

test('isMissingGatewayCredential names the local no-token states', () => {
  assert.equal(isMissingGatewayCredential('Controller API registration requires an API credential.'), true);
  assert.equal(isMissingGatewayCredential('Browser control registration requires a configured API key.'), true);
  assert.equal(isMissingGatewayCredential('Controller registration failed (HTTP 401).'), false);
  assert.equal(isMissingGatewayCredential('Network unreachable.'), false);
  assert.equal(isGatewayControlKeyUnconfigured('Browser control registration requires a configured API key.'), true);
  assert.equal(isGatewayControlKeyUnconfigured('Controller API registration requires an API credential.'), false);
});
