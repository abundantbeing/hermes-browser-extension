import { DEFAULT_SETTINGS } from './common.mjs';
import { migrateConnectionSettings } from './connection-modes.mjs';
import { DEFAULT_AGENT_PORTS } from './agent-discovery.mjs';
import {
  decryptSavedConnectionSecretBag,
  encryptSavedConnectionSecretBag,
  isEncryptedSecretRecord,
  isPlainSecretBag,
  secretBagHeaders,
} from './saved-connection-secrets-crypto.mjs';

// Only connection configuration is saved. Sessions, browser-control grants,
// account tokens and single-use socket tickets never enter a saved connection.
const CONNECTION_FIELDS = [
  'connectionSchemaVersion', 'connectionMode', 'connectionTransport', 'gatewayMode',
  'gatewayUrl', 'apiKey', 'tokenSource', 'hermesWebAddress', 'webappKeepSignedIn',
  'trustedDashboardOrigin', 'trustedDashboardTabId',
  'agentDiscoveryHost', 'agentDiscoveryScheme', 'agentPorts', 'customModelSources',
  'connectionTrustSelfSigned', 'connectionHeaders',
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
export const SAVED_CONNECTION_SECRETS_STORAGE_KEY = 'hermesBrowserSavedConnectionSecrets';

function cloneSecrets(secrets = {}) {
  return structuredClone(secrets && typeof secrets === 'object' ? secrets : {});
}

/**
 * @param {unknown} value
 * @returns {{ apiKey: string, tokenSource: string }|null}
 */
async function plaintextSecretBagFromStored(value) {
  if (!value || typeof value !== 'object') return null;
  if (isEncryptedSecretRecord(value)) {
    const decrypted = await decryptSavedConnectionSecretBag(value);
    return decrypted || { apiKey: '', tokenSource: '', headers: [] };
  }
  if (isPlainSecretBag(value)) {
    return {
      apiKey: String(value.apiKey ?? ''),
      tokenSource: String(value.tokenSource ?? ''),
      headers: secretBagHeaders(value.headers),
    };
  }
  return null;
}

/** Merge inline saved keys into the sidecar and strip them from the settings blob. */
export function mergeSavedConnectionSecrets(settings = {}, secrets = {}) {
  if (!Array.isArray(settings.savedConnections)) return { settings, secrets: cloneSecrets(secrets) };
  const nextSecrets = cloneSecrets(secrets);
  const savedConnections = settings.savedConnections.map((entry) => {
    if (!entry || typeof entry.id !== 'string') return entry;
    const conn = entry.connection && typeof entry.connection === 'object' ? entry.connection : {};
    // A list means the writer has the headers in hand; null or nothing means it never read them, so the stored ones stay.
    const headersInHand = Array.isArray(conn.connectionHeaders);
    if (conn.apiKey || conn.tokenSource || headersInHand) {
      nextSecrets[entry.id] = {
        apiKey: String(conn.apiKey || ''),
        tokenSource: String(conn.tokenSource || ''),
        ...(headersInHand ? { headers: secretBagHeaders(conn.connectionHeaders) } : {}),
      };
    }
    return {
      ...entry,
      connection: { ...conn, apiKey: '', tokenSource: '', ...(conn.connectionHeaders === undefined ? {} : { connectionHeaders: null }) },
    };
  });
  const liveIds = new Set(savedConnections.map((e) => e?.id).filter((id) => typeof id === 'string'));
  for (const id of Object.keys(nextSecrets)) {
    if (!liveIds.has(id)) delete nextSecrets[id];
  }
  return { settings: { ...settings, savedConnections }, secrets: nextSecrets };
}

/** Restore saved keys from the sidecar (and migrate any legacy inline copies). */
export async function hydrateSavedConnectionSecrets(settings = {}, secrets = {}) {
  const merged = mergeSavedConnectionSecrets(settings, secrets);
  if (!Array.isArray(merged.settings.savedConnections)) return merged.settings;
  const savedConnections = await Promise.all(merged.settings.savedConnections.map(async (entry) => {
    if (!entry || typeof entry.id !== 'string') return entry;
    const raw = merged.secrets[entry.id];
    const bag = raw ? await plaintextSecretBagFromStored(raw) : null;
    if (!bag) return entry;
    const conn = entry.connection && typeof entry.connection === 'object' ? entry.connection : {};
    return {
      ...entry,
      connection: {
        ...conn,
        apiKey: bag.apiKey ?? '',
        tokenSource: bag.tokenSource ?? '',
        connectionHeaders: bag.headers ?? [],
      },
    };
  }));
  const activeId = merged.settings.activeSavedConnectionId;
  const activeEntry = typeof activeId === 'string' && activeId
    ? savedConnections.find((e) => e?.id === activeId) : null;
  const activeConn = activeEntry?.connection && typeof activeEntry.connection === 'object' ? activeEntry.connection : null;
  return {
    ...merged.settings,
    savedConnections,
    ...(activeConn ? {
      apiKey: activeConn.apiKey ?? merged.settings.apiKey ?? '',
      tokenSource: activeConn.tokenSource ?? merged.settings.tokenSource ?? '',
      connectionHeaders: activeConn.connectionHeaders ?? merged.settings.connectionHeaders ?? null,
    } : {}),
  };
}

export async function packSavedConnectionStorage(settings = {}, existingSecrets = {}) {
  let merged = mergeSavedConnectionSecrets(rememberSavedConnection(settings), existingSecrets);
  const activeId = merged.settings.activeSavedConnectionId;
  const topApiKey = String(merged.settings.apiKey ?? '');
  const topTokenSource = String(merged.settings.tokenSource ?? '');
  const topHeaders = Array.isArray(merged.settings.connectionHeaders) ? secretBagHeaders(merged.settings.connectionHeaders) : null;
  if (typeof activeId === 'string' && activeId && (topApiKey || topTokenSource || topHeaders)) {
    const existing = merged.secrets[activeId];
    const existingPlain = existing ? await plaintextSecretBagFromStored(existing) : null;
    merged = {
      settings: { ...merged.settings, apiKey: '', tokenSource: '', connectionHeaders: null },
      secrets: {
        ...merged.secrets,
        [activeId]: {
          apiKey: topApiKey || existingPlain?.apiKey || '',
          tokenSource: topTokenSource || existingPlain?.tokenSource || '',
          headers: topHeaders ?? existingPlain?.headers ?? [],
        },
      },
    };
  }
  const storedSecrets = {};
  for (const [id, bag] of Object.entries(merged.secrets)) {
    // A record that is already encrypted is unchanged: keep it as it is, so a browser that cannot reach its key never loses it.
    if (isEncryptedSecretRecord(bag)) { storedSecrets[id] = bag; continue; }
    let plain = isPlainSecretBag(bag) ? bag : (await plaintextSecretBagFromStored(bag));
    if (plain && isPlainSecretBag(bag) && bag.headers === undefined && existingSecrets?.[id]) {
      plain = { ...plain, headers: (await plaintextSecretBagFromStored(existingSecrets[id]))?.headers ?? [] };
    }
    if (!plain || (!plain.apiKey && !plain.tokenSource && !secretBagHeaders(plain.headers).length)) continue;
    const encrypted = await encryptSavedConnectionSecretBag(plain);
    // Never fall back to plaintext: refuse the save and leave every stored record as it was.
    if (!encrypted) throw new Error('Saved keys cannot be encrypted in this browser, so nothing was saved.');
    storedSecrets[id] = encrypted;
  }
  return {
    hermesBrowserSettings: merged.settings,
    [SAVED_CONNECTION_SECRETS_STORAGE_KEY]: storedSecrets,
  };
}

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
    // Options a connection never set are off for it, not carried over from the one being left.
    connectionHeaders: [],
    connectionTrustSelfSigned: false,
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

export function addSavedConnection(settings, name, id, connection = null) {
  const current = rememberSavedConnection(settings);
  if (!/^[\w-]{1,80}$/.test(id || '') || current.savedConnections.some((entry) => entry.id === id)) {
    throw new Error('Invalid saved connection ID.');
  }
  const savedConnections = [...current.savedConnections, {
    id, name: connectionName(name), connection: connectionConfig({ ...DEFAULT_SETTINGS, ...(connection || {}) }),
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

// Every panel reads, changes and writes the one settings record, so each change to the
// saved list runs one at a time across panels. Without cross-document locks the
// queue still orders this document's own changes.
const SAVED_CONNECTIONS_LOCK = 'hermes-saved-connections';
let ownQueue = Promise.resolve();

export function withSavedConnectionsLock(task, locks = globalThis.navigator?.locks) {
  if (typeof locks?.request === 'function') return locks.request(SAVED_CONNECTIONS_LOCK, task);
  const run = ownQueue.then(task);
  ownQueue = run.catch(() => {});
  return run;
}

// The stored list is the truth; a panel's copy can be older than another panel's write. The switch
// revision only ever goes up: a panel that has not seen the latest switch cannot take it back.
export function withStoredSavedConnections(settings, stored) {
  if (!Array.isArray(stored?.savedConnections)) return settings;
  return {
    ...settings,
    savedConnections: stored.savedConnections,
    savedConnectionSwitchRevision: Math.max(Number(settings?.savedConnectionSwitchRevision) || 0, Number(stored.savedConnectionSwitchRevision) || 0),
  };
}

export function savedConnectionsBase(settings, stored, expectedId) {
  const activeId = stored?.activeSavedConnectionId;
  if (activeId && activeId !== expectedId) throw new Error('The active saved connection changed.');
  return withStoredSavedConnections(settings, stored);
}

/** Read a full local storage snapshot and return live settings with secrets restored. */
export async function hydrateHermesBrowserSettingsFromStorage(raw = {}, storageArea = null) {
  const area = storageArea?.get ? storageArea : null;
  const bundle = area
    ? await area.get(['hermesBrowserSettings', SAVED_CONNECTION_SECRETS_STORAGE_KEY])
    : (raw && typeof raw === 'object' ? raw : {});
  const blob = bundle?.hermesBrowserSettings && typeof bundle.hermesBrowserSettings === 'object'
    ? bundle.hermesBrowserSettings
    : {};
  const secrets = bundle?.[SAVED_CONNECTION_SECRETS_STORAGE_KEY];
  return hydrateSavedConnectionSecrets(blob, secrets);
}

/** Pack settings and secrets for storage.local.set (single call). */
export async function packedHermesBrowserSettingsWrite(nextSettings = {}, storageArea = null) {
  const area = storageArea?.get ? storageArea : null;
  const existing = area
    ? (await area.get(SAVED_CONNECTION_SECRETS_STORAGE_KEY))[SAVED_CONNECTION_SECRETS_STORAGE_KEY]
    : undefined;
  return packSavedConnectionStorage(nextSettings, existing && typeof existing === 'object' ? existing : {});
}

/**
 * Writes the live settings of the connection a panel, the worker or the wake listener is on.
 * Run under the lock every change to the saved list takes, it keeps the list as stored (another
 * panel may have added, renamed or deleted a connection since this copy was read) and writes
 * nothing when the stored active connection is no longer the one the caller is on.
 * A caller that already holds the lock and has merged with the stored record passes lockHeld
 * and its settings are written as they are.
 * `extra` may be a function, read just before the write.
 */
export async function writeSettingsOnStoredConnections(settings, storageArea, { extra = {}, lockHeld = false } = {}) {
  const records = () => (typeof extra === 'function' ? extra() : extra);
  const write = async (next) => {
    await storageArea.set({ ...(await packedHermesBrowserSettingsWrite(next, storageArea)), ...records() });
    return true;
  };
  if (lockHeld) return write(settings);
  return withSavedConnectionsLock(async () => {
    const stored = await hydrateHermesBrowserSettingsFromStorage({}, storageArea);
    const activeId = settings?.activeSavedConnectionId;
    if (activeId && stored.activeSavedConnectionId && stored.activeSavedConnectionId !== activeId) return false;
    return write(withStoredSavedConnections(settings, stored));
  });
}

export function savedConnectionSummary(connection = {}, modeLabels = {}) {
  const mode = connection.connectionMode === 'cloud' || connection.connectionMode === 'remote' ? connection.connectionMode : 'local';
  const label = modeLabels[mode] || mode;
  if (mode === 'cloud') return label;
  let host = '';
  try { host = new URL(String(connection.gatewayUrl || '')).host; } catch { /* no usable address */ }
  return host ? `${label} · ${host}` : label;
}
