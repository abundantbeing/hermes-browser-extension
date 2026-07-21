export const CONNECTION_SCHEMA_VERSION = 1;

export const CONNECTION_MODES = Object.freeze([
  { value: 'local', label: 'Local gateway' },
  { value: 'cloud', label: 'Hermes Cloud Preview' },
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
const API_KEY_TRANSPORTS = new Set([
  CONNECTION_TRANSPORTS.LOCAL_API,
  CONNECTION_TRANSPORTS.REMOTE_API,
]);
const TICKET_TRANSPORTS = new Set([
  CONNECTION_TRANSPORTS.CLOUD_TICKET_WS,
  CONNECTION_TRANSPORTS.REMOTE_DASHBOARD,
]);

export function normalizeConnectionMode(value = 'local') {
  const mode = String(value || '').trim().toLowerCase();
  return VALID_MODES.has(mode) ? mode : 'local';
}

export function normalizeConnectionTransport(value = '') {
  const transport = String(value || '').trim();
  return VALID_TRANSPORTS.has(transport) ? transport : CONNECTION_TRANSPORTS.LOCAL_API;
}

export function transportRequiresApiKey(value = '') {
  return API_KEY_TRANSPORTS.has(normalizeConnectionTransport(value));
}

export function transportUsesDashboardTicket(value = '') {
  return TICKET_TRANSPORTS.has(normalizeConnectionTransport(value));
}

export function apiCredentialSatisfied(input = {}) {
  if (normalizeConnectionMode(input?.connectionMode) === 'cloud') return true;
  const settings = migrateConnectionSettings(input);
  const transport = VALID_TRANSPORTS.has(String(input?.connectionTransport || '').trim())
    ? input.connectionTransport
    : settings.connectionTransport;
  return !transportRequiresApiKey(transport)
    || Boolean(String(settings.apiKey || '').trim());
}

export function isLoopbackGatewayUrl(raw = '') {
  try {
    const host = new URL(String(raw || '').trim()).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

export function automaticApiPairingAllowed(input = {}) {
  const settings = migrateConnectionSettings(input);
  return settings.connectionMode === 'local'
    && settings.connectionTransport === CONNECTION_TRANSPORTS.LOCAL_API
    && isLoopbackGatewayUrl(settings.gatewayUrl);
}

export function sanitizeGatewayUrlForConnectionMode({ connectionMode, gatewayUrl = '', localDefaultUrl = '' } = {}) {
  const mode = normalizeConnectionMode(connectionMode);
  const raw = String(gatewayUrl || '').trim();
  if (mode !== 'cloud') return raw;
  if (!raw || raw === String(localDefaultUrl || '').trim() || isLoopbackGatewayUrl(raw)) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    return parsed.origin;
  } catch {
    return '';
  }
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

  if (mode === 'cloud') {
    return sanitizeGatewayUrlForConnectionMode({
      connectionMode: mode,
      gatewayUrl: current,
      localDefaultUrl: localDefault,
    });
  }
  if (current && current !== localDefault) return current;
  return transportDefault || localDefault;
}
