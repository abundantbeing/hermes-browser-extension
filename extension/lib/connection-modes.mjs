export const CONNECTION_SCHEMA_VERSION = 1;

export const CONNECTION_MODES = Object.freeze([
  { value: 'local', label: 'Local gateway' },
  { value: 'cloud', label: 'Hermes Cloud' },
  { value: 'remote', label: 'Remote gateway' },
]);

export const CONNECTION_TRANSPORTS = Object.freeze({
  LOCAL_API: 'local-api',
  CLOUD_TICKET_WS: 'cloud-ticket-ws',
  REMOTE_API: 'remote-api',
  REMOTE_DASHBOARD: 'remote-dashboard',
});

const VALID_MODES = new Set(CONNECTION_MODES.map((mode) => mode.value));
const VALID_TRANSPORTS = new Set(Object.values(CONNECTION_TRANSPORTS));

export function normalizeConnectionMode(value = 'local') {
  const mode = String(value || '').trim().toLowerCase();
  return VALID_MODES.has(mode) ? mode : 'local';
}

function legacyProductMode(gatewayMode) {
  return gatewayMode === 'remote-api' || gatewayMode === 'remote-dashboard'
    ? 'remote'
    : 'local';
}

function legacyTransport(gatewayMode) {
  if (gatewayMode === 'remote-api') return CONNECTION_TRANSPORTS.REMOTE_API;
  if (gatewayMode === 'remote-dashboard') return CONNECTION_TRANSPORTS.REMOTE_DASHBOARD;
  return CONNECTION_TRANSPORTS.LOCAL_API;
}

export function migrateConnectionSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const explicitMode = source.connectionSchemaVersion === CONNECTION_SCHEMA_VERSION
    ? normalizeConnectionMode(source.connectionMode)
    : legacyProductMode(source.gatewayMode);
  let transport = VALID_TRANSPORTS.has(source.connectionTransport)
    ? source.connectionTransport
    : legacyTransport(source.gatewayMode);

  if (explicitMode === 'local') transport = CONNECTION_TRANSPORTS.LOCAL_API;
  if (explicitMode === 'cloud') transport = CONNECTION_TRANSPORTS.CLOUD_TICKET_WS;
  if (explicitMode === 'remote' && transport === CONNECTION_TRANSPORTS.CLOUD_TICKET_WS) {
    transport = CONNECTION_TRANSPORTS.REMOTE_DASHBOARD;
  }

  return {
    ...source,
    connectionSchemaVersion: CONNECTION_SCHEMA_VERSION,
    connectionMode: explicitMode,
    connectionTransport: transport,
  };
}

export function legacyGatewayModeForConnection(input = {}) {
  const explicitMode = normalizeConnectionMode(input?.connectionMode);
  const settings = migrateConnectionSettings(
    VALID_MODES.has(String(input?.connectionMode || '').trim().toLowerCase())
      ? { ...input, connectionSchemaVersion: CONNECTION_SCHEMA_VERSION, connectionMode: explicitMode }
      : input,
  );
  if (settings.connectionMode === 'local') return 'local-api';
  if (settings.connectionMode === 'cloud') return 'remote-dashboard';
  return settings.connectionTransport === CONNECTION_TRANSPORTS.REMOTE_API
    ? 'remote-api'
    : 'remote-dashboard';
}

export function resolvePhaseATransport({ connectionMode, currentTransport, apiKey = '' } = {}) {
  const mode = normalizeConnectionMode(connectionMode);
  if (mode === 'local') return CONNECTION_TRANSPORTS.LOCAL_API;
  if (mode === 'cloud') return CONNECTION_TRANSPORTS.CLOUD_TICKET_WS;
  if (currentTransport === CONNECTION_TRANSPORTS.REMOTE_API) return CONNECTION_TRANSPORTS.REMOTE_API;
  if (currentTransport === CONNECTION_TRANSPORTS.REMOTE_DASHBOARD) return CONNECTION_TRANSPORTS.REMOTE_DASHBOARD;
  return String(apiKey || '').trim()
    ? CONNECTION_TRANSPORTS.REMOTE_API
    : CONNECTION_TRANSPORTS.REMOTE_DASHBOARD;
}

export function connectionModePreviewUrl({
  connectionMode,
  currentUrl = '',
  localDefaultUrl = '',
  transportDefaultUrl = '',
} = {}) {
  const mode = normalizeConnectionMode(connectionMode);
  const current = String(currentUrl || '').trim();
  const localDefault = String(localDefaultUrl || '').trim();
  const transportDefault = String(transportDefaultUrl || '').trim();

  if (current && current !== localDefault) return current;
  if (mode === 'cloud') return '';
  return transportDefault || localDefault;
}
