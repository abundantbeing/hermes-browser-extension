import { DEFAULT_SETTINGS } from './common.mjs';
import { migrateConnectionSettings } from './connection-modes.mjs';
import { DEFAULT_AGENT_PORTS } from './agent-discovery.mjs';

// Only connection configuration is saved. Sessions, browser-control grants,
// account tokens and single-use socket tickets never enter a saved connection.
const CONNECTION_FIELDS = [
  'connectionSchemaVersion', 'connectionMode', 'connectionTransport', 'gatewayMode',
  'gatewayUrl', 'apiKey', 'tokenSource', 'hermesWebAddress', 'webappKeepSignedIn',
  'trustedDashboardOrigin', 'trustedDashboardTabId',
  'agentDiscoveryHost', 'agentDiscoveryScheme', 'agentPorts', 'customModelSources',
];

function connectionConfig(settings = {}) {
  const input = settings && typeof settings === 'object' ? settings : {};
  const source = { ...DEFAULT_SETTINGS, ...migrateConnectionSettings(input), agentPorts: input.agentPorts || DEFAULT_AGENT_PORTS };
  const config = Object.fromEntries(Object.entries(source)
    .filter(([key, value]) => CONNECTION_FIELDS.includes(key) && value !== undefined));
  if (source.connectionMode === 'cloud') {
    config.apiKey = '';
    config.tokenSource = '';
  }
  return structuredClone(config);
}

function connectionName(name, fallback = 'Connection 1') {
  return String(name || '').trim().slice(0, 80) || fallback;
}

export function rememberSavedConnection(settings = {}, defaultName = 'Connection 1') {
  const seen = new Set();
  const savedConnections = (Array.isArray(settings.savedConnections) ? settings.savedConnections : [])
    .filter((entry) => {
      if (!entry || typeof entry.id !== 'string' || !/^[\w-]{1,80}$/.test(entry.id) || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .map((entry) => ({ id: entry.id, name: connectionName(entry.name), connection: connectionConfig(entry.connection) }));
  let activeSavedConnectionId = settings.activeSavedConnectionId;
  let active = savedConnections.find((entry) => entry.id === activeSavedConnectionId);
  if (!active) {
    activeSavedConnectionId = 'default';
    active = savedConnections.find((entry) => entry.id === activeSavedConnectionId);
    if (!active) {
      active = { id: activeSavedConnectionId, name: connectionName(defaultName) };
      savedConnections.unshift(active);
    }
  }
  // The live settings are authoritative: pairing or token revocation may have
  // changed them since the last time this connection was selected.
  active.connection = connectionConfig(settings);
  return { ...settings, activeSavedConnectionId, savedConnections };
}

// Settings changed outside this module (a cleared or rejected token) must reach
// the saved copy too, or the old key comes back on the next switch.
export function syncActiveSavedConnection(settings = {}) {
  return Array.isArray(settings.savedConnections) && settings.savedConnections.length
    ? rememberSavedConnection(settings)
    : settings;
}

export function selectSavedConnection(settings, id) {
  const current = rememberSavedConnection(settings);
  const target = current.savedConnections.find((entry) => entry.id === id);
  if (!target) throw new Error('Unknown saved connection.');
  if (id === current.activeSavedConnectionId) return current;
  return {
    ...current,
    ...connectionConfig(target.connection),
    activeSavedConnectionId: id,
    // Each switch starts a fresh chat in every open panel. Each panel remembers
    // the last revision it acted on, so no panel consumes another's switch.
    savedConnectionSwitchRevision: (Number(current.savedConnectionSwitchRevision) || 0) + 1,
    sessionId: '',
    sessionTitle: DEFAULT_SETTINGS.sessionTitle,
    activeProfile: '',
    botModeSelectedProfile: '',
    botModeReturnProfile: '',
    pendingProfileContextHandoff: '',
    pendingProfileContextHandoffSessionId: '',
    remoteDashboardSession: null,
    model: DEFAULT_SETTINGS.model,
    modelContextTokens: 0,
    extensionPreferredModel: null,
    sessionModelBindings: {},
    sessionModelOptionBindings: {},
    groupRoomModelBindings: {},
    inlineAssistModel: '',
    inlineAssistRawModel: '',
    inlineAssistProvider: '',
    lastConnectionTestedAt: 0,
    agentToken: '',
    agentApiUrl: '',
    browserControlEnabled: false,
    browserControlPaused: false,
  };
}

export function addSavedConnection(settings, name, id) {
  const current = rememberSavedConnection(settings);
  if (!/^[\w-]{1,80}$/.test(id || '') || current.savedConnections.some((entry) => entry.id === id)) {
    throw new Error('Invalid saved connection ID.');
  }
  const savedConnections = [...current.savedConnections, {
    id, name: connectionName(name), connection: connectionConfig(DEFAULT_SETTINGS),
  }];
  return selectSavedConnection({ ...current, savedConnections }, id);
}

export function renameSavedConnection(settings, id, name) {
  const current = rememberSavedConnection(settings);
  return { ...current, savedConnections: current.savedConnections.map((entry) => (
    entry.id === id ? { ...entry, name: connectionName(name, entry.name) } : entry
  )) };
}

export function deleteSavedConnection(settings, id) {
  const current = rememberSavedConnection(settings);
  if (current.savedConnections.length < 2) throw new Error('Keep at least one saved connection.');
  if (!current.savedConnections.some((entry) => entry.id === id)) throw new Error('Unknown saved connection.');
  const next = current.activeSavedConnectionId === id
    ? selectSavedConnection(current, current.savedConnections.find((entry) => entry.id !== id).id)
    : current;
  return { ...next, savedConnections: next.savedConnections.filter((entry) => entry.id !== id) };
}

export function savedConnectionStorageKey(settings, key) {
  const id = settings.activeSavedConnectionId;
  return id && id !== 'default' ? `${key}:connection:${id}` : key;
}

// Every record kept per connection carries its key suffix. The first connection
// keeps its original, unsuffixed keys.
export function savedConnectionRecordKeys(keys, id) {
  const suffix = `:connection:${id}`;
  return [...keys].filter((key) => typeof key === 'string' && key.endsWith(suffix));
}
