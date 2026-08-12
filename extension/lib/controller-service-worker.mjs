/**
 * Phase 5 service-worker controller owner
 *
 * Owns durable controller/profile identity, monotonic worker generations,
 * leases, document generations, bounded replay state, and a controller
 * transport without relying on a side-panel document. The transport is
 * injected so local/VPS and Cloud admission stay independently testable.
 *
 * Real browser actions remain disabled. Only controller.noop can execute.
 */

import {
  CONTROLLER_LIFECYCLE_STORAGE_KEY,
  createControllerLifecycle,
} from './controller-lifecycle.mjs';
import {
  CONTROLLER_REGISTRY_STORAGE_KEY,
  createControllerRegistry,
} from './controller-registry.mjs';
import {
  TAB_LEASE_KINDS,
  TAB_LEASE_OWNERSHIPS,
  TAB_LEASE_STORAGE_KEY,
  createTabLeaseStore,
} from './tab-leases.mjs';
import { CONTROLLER_METHODS } from './controller-protocol.mjs';

export const CONTROLLER_WORKER_VERSION = 1;
export const CONTROLLER_WORKER_STORAGE_KEY = 'hermesBrowserControllerWorker';
export const CONTROLLER_MAX_DOCUMENT_GENERATIONS = 256;
export const CONTROLLER_MAX_TERMINAL_OUTBOX = 64;

export const CONTROLLER_WORKER_MESSAGES = Object.freeze({
  status: 'HERMES_CONTROLLER_STATUS',
  wake: 'HERMES_CONTROLLER_WAKE',
  leaseAcquire: 'HERMES_CONTROLLER_LEASE_ACQUIRE',
  leaseRelease: 'HERMES_CONTROLLER_LEASE_RELEASE',
  documentReady: 'HERMES_CONTROLLER_DOCUMENT_READY',
});

const KNOWN_LEASE_KINDS = new Set(Object.values(TAB_LEASE_KINDS));
const KNOWN_OWNERSHIPS = new Set(Object.values(TAB_LEASE_OWNERSHIPS));
const CONTROL_PLANE_TAB_ID = 2_147_483_647;

function cleanIdentity(raw = {}) {
  const controllerId = String(raw?.controllerId || '').trim();
  const browserProfileId = String(raw?.browserProfileId || '').trim();
  return controllerId && browserProfileId ? { controllerId, browserProfileId } : null;
}

function cleanDocumentGenerations(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = Object.entries(raw)
    .map(([key, value]) => [String(key), Number(value)])
    .filter(([key, value]) => /^\d+:\d+$/.test(key) && Number.isInteger(value) && value >= 1)
    .slice(-CONTROLLER_MAX_DOCUMENT_GENERATIONS);
  return Object.fromEntries(entries);
}

function frameKey(tabId, frameId = 0) {
  return `${Number(tabId)}:${Math.max(0, Number(frameId) || 0)}`;
}

function connectionSettings(stored = {}) {
  const settings = stored?.hermesBrowserSettings;
  return settings && typeof settings === 'object' ? settings : {};
}

function durableSessionId(settings = {}) {
  return String(
    settings?.remoteDashboardSession?.storedSessionId
    || settings?.sessionId
    || '',
  ).trim();
}

function controllerRouteChanged(previous = {}, next = {}) {
  const fields = [
    'connectionMode',
    'connectionTransport',
    'gatewayMode',
    'gatewayUrl',
    'apiKey',
    'activeProfile',
    'trustedDashboardOrigin',
    'trustedDashboardTabId',
  ];
  return fields.some((field) => String(previous?.[field] ?? '') !== String(next?.[field] ?? ''))
    || durableSessionId(previous) !== durableSessionId(next);
}

function controllerRouteKey(settings = {}) {
  const transport = String(settings?.connectionTransport || settings?.gatewayMode || '').trim();
  const gatewayUrl = String(settings?.gatewayUrl || '').trim();
  const profile = String(settings?.activeProfile || '').trim();
  const sessionId = durableSessionId(settings);
  return transport && gatewayUrl && sessionId
    ? `route-v2:${JSON.stringify([transport, gatewayUrl, profile, sessionId])}`
    : '';
}

function normalizeTerminalOutbox(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const routeKey = String(entry?.routeKey || '').trim();
      const commandId = String(entry?.commandId || '').trim();
      const tabId = Number(entry?.tabId);
      const ok = entry?.ok === true;
      const errorCode = ok
        ? 'delivery_interrupted'
        : String(entry?.errorCode || 'restarted').trim();
      if (!routeKey || !commandId || !Number.isInteger(tabId) || tabId <= 0 || !errorCode) return null;
      return { routeKey, commandId, tabId, ok: false, errorCode };
    })
    .filter(Boolean)
    .slice(-CONTROLLER_MAX_TERMINAL_OUTBOX);
}

function terminalOutboxEntry(routeKey, params = {}) {
  const commandId = String(params?.command_id || '').trim();
  const tabId = Number(params?.tab_id);
  const ok = params?.ok === true;
  const errorCode = ok
    ? 'delivery_interrupted'
    : String(params?.error?.code || 'command_error').trim();
  if (!routeKey || !commandId || !Number.isInteger(tabId) || tabId <= 0 || !errorCode) return null;
  return { routeKey, commandId, tabId, ok: false, errorCode };
}

function terminalOutboxParams(entry) {
  return {
    command_id: entry.commandId,
    tab_id: entry.tabId,
    ...(entry.ok
      ? { ok: true }
      : { ok: false, error: { code: entry.errorCode, message: 'Controller command reached a terminal state.' } }),
  };
}

function safeProduct(product = {}) {
  const id = String(product?.id || '').trim();
  const engine = String(product?.engine || '').trim();
  const label = String(product?.label || '').trim();
  if (!id || !engine || !label) throw new Error('Controller product identity is required.');
  return { id, engine, label };
}

function extensionSenderTrusted(sender = {}, extensionOrigin = '') {
  const senderUrl = String(sender?.url || sender?.documentUrl || '').trim();
  const origin = String(extensionOrigin || '').replace(/\/$/, '');
  return Boolean(origin) && (senderUrl === origin || senderUrl.startsWith(`${origin}/`));
}

function senderTabId(sender = {}) {
  const tabId = Number(sender?.tab?.id);
  return Number.isInteger(tabId) && tabId > 0 ? tabId : null;
}

function normalizeInboundFrame(frame = {}) {
  if (!frame || typeof frame !== 'object') return null;
  if (frame.method === 'event' && frame.params?.type) {
    const type = String(frame.params.type || '');
    if (type !== CONTROLLER_METHODS.command && type !== CONTROLLER_METHODS.cancel) return null;
    return {
      method: type,
      params: frame.params.payload && typeof frame.params.payload === 'object'
        ? frame.params.payload
        : {},
      sessionId: String(frame.params.session_id || frame.params.sessionId || '').trim(),
    };
  }
  if (frame.method !== CONTROLLER_METHODS.command && frame.method !== CONTROLLER_METHODS.cancel) return null;
  return { method: frame.method, params: frame.params && typeof frame.params === 'object' ? frame.params : {} };
}

function terminalError(code, message) {
  return { ok: false, error: { code, message } };
}

export function createControllerServiceWorker({
  storageArea,
  connector,
  product,
  randomUUID = () => globalThis.crypto?.randomUUID?.(),
  extensionOrigin = '',
  now = Date.now,
  supportsTabGroups = true,
  executeCommand = undefined,
} = {}) {
  if (!storageArea?.get || !storageArea?.set) throw new TypeError('Controller storage area is required.');
  if (!connector?.connect) throw new TypeError('Controller connector is required.');
  const normalizedProduct = safeProduct(product);

  let bootPromise = null;
  let settings = {};
  let controllerId = '';
  let browserProfileId = '';
  let generation = 1;
  let documentGenerations = {};
  let terminalOutbox = [];
  let recoveredPending = [];
  let registry = createControllerRegistry({ now });
  let leases = createTabLeaseStore({ now, supportsTabGroups, generation });
  let lifecycle = createControllerLifecycle({ now, ...(typeof executeCommand === 'function' ? { execute: executeCommand } : {}) });
  let activeConnection = null;
  let connected = false;
  let connecting = null;
  let reconnectRequiresRestart = false;
  let terminalRouteOverride = '';
  let persistChain = Promise.resolve();
  let transitionChain = Promise.resolve();

  function runTransition(operation) {
    const next = transitionChain
      .catch(() => undefined)
      .then(operation);
    transitionChain = next.catch(() => undefined);
    return next;
  }

  function workerSnapshot() {
    return {
      version: CONTROLLER_WORKER_VERSION,
      controllerId,
      browserProfileId,
      generation,
      routeKey: controllerRouteKey(settings),
      documentGenerations: cleanDocumentGenerations(documentGenerations),
      terminalOutbox: normalizeTerminalOutbox(terminalOutbox),
      updatedAt: Number(now()),
    };
  }

  function persist() {
    const values = {
      [CONTROLLER_WORKER_STORAGE_KEY]: workerSnapshot(),
      [CONTROLLER_REGISTRY_STORAGE_KEY]: registry.snapshot(),
      [TAB_LEASE_STORAGE_KEY]: leases.snapshot(),
      [CONTROLLER_LIFECYCLE_STORAGE_KEY]: lifecycle.snapshot(),
    };
    persistChain = persistChain
      .catch(() => undefined)
      .then(() => storageArea.set(values));
    return persistChain;
  }

  function status() {
    return {
      ok: true,
      connected,
      controllerId,
      browserProfileId,
      generation,
      leasedTabIds: leases.leasedTabIds(),
      pendingCommands: lifecycle.pendingCount(),
    };
  }

  function ensureRegistryBinding(sessionId = durableSessionId(settings)) {
    if (!sessionId) return null;
    const existing = registry.get(controllerId);
    if (!existing) {
      return registry.register({
        controllerId,
        browserProfileId,
        product: normalizedProduct,
        hermesSessionId: sessionId,
        generation,
      });
    }
    if (existing.hermesSessionId !== sessionId || existing.generation !== generation) {
      return registry.bindSession({ controllerId, hermesSessionId: sessionId, generation });
    }
    return registry.touch(controllerId);
  }

  async function sendTerminal(connection, params) {
    if (!connection?.send) return false;
    await connection.send({ method: CONTROLLER_METHODS.result, params });
    return true;
  }

  function queueTerminal(params, {
    connection = activeConnection,
    routeKey = controllerRouteKey(settings),
    allowInactiveConnection = false,
  } = {}) {
    const entry = terminalOutboxEntry(routeKey, params);
    if (!entry) return Promise.resolve(false);
    terminalOutbox = [
      ...terminalOutbox.filter((candidate) => !(candidate.routeKey === entry.routeKey && candidate.commandId === entry.commandId)),
      entry,
    ].slice(-CONTROLLER_MAX_TERMINAL_OUTBOX);
    return persist().then(async () => {
      if (!connection?.send || routeKey !== controllerRouteKey(settings)) return false;
      if (!allowInactiveConnection && connection !== activeConnection) return false;
      try {
        await sendTerminal(connection, params);
      } catch {
        return false;
      }
      terminalOutbox = terminalOutbox.filter(
        (candidate) => !(candidate.routeKey === entry.routeKey && candidate.commandId === entry.commandId),
      );
      await persist();
      return true;
    });
  }

  async function flushTerminalOutbox(connection = activeConnection) {
    const routeKey = controllerRouteKey(settings);
    if (!routeKey || !connection?.send || connection !== activeConnection) return 0;
    let delivered = 0;
    for (const entry of terminalOutbox.filter((candidate) => candidate.routeKey === routeKey)) {
      if (connection !== activeConnection || routeKey !== controllerRouteKey(settings)) break;
      try {
        await sendTerminal(connection, terminalOutboxParams(entry));
      } catch {
        break;
      }
      terminalOutbox = terminalOutbox.filter(
        (candidate) => !(candidate.routeKey === entry.routeKey && candidate.commandId === entry.commandId),
      );
      delivered += 1;
      await persist();
    }
    return delivered;
  }

  function attachTerminalObserver(targetLifecycle) {
    targetLifecycle.onTerminal((terminal) => {
      void queueTerminal(terminal.params, {
        connection: activeConnection,
        routeKey: terminalRouteOverride || controllerRouteKey(settings),
      }).catch(() => undefined);
    });
  }

  attachTerminalObserver(lifecycle);

  function resetLifecycle(nextLifecycle) {
    lifecycle = nextLifecycle;
    attachTerminalObserver(lifecycle);
  }

  async function rejectFrame(connection, params, code, message) {
    const commandId = String(params?.command_id || '').trim();
    if (commandId) lifecycle.rememberTerminal(commandId);
    const tabId = Number(params?.tab_id);
    const result = {
      command_id: commandId,
      ...(Number.isInteger(tabId) && tabId > 0 ? { tab_id: tabId } : {}),
      ...terminalError(code, message),
    };
    await queueTerminal(result, {
      connection,
      routeKey: controllerRouteKey(settings),
      allowInactiveConnection: code === 'stale_generation',
    });
    return { ok: false, error: code };
  }

  async function handleTransportFrame(frame, { epoch, connection }) {
    const inbound = normalizeInboundFrame(frame);
    if (!inbound) return { ok: false, error: 'ignored_frame' };
    const params = inbound.params;
    if (epoch !== generation || connection !== activeConnection) {
      return rejectFrame(connection, params, 'stale_generation', 'Controller connection generation is stale.');
    }

    if (inbound.method === CONTROLLER_METHODS.cancel) {
      const cancelled = lifecycle.cancelCommand(params.command_id);
      await persist();
      return cancelled;
    }

    const commandId = String(params.command_id || '').trim();
    if (!commandId) return rejectFrame(connection, params, 'invalid_command', 'Controller command id is required.');
    const tabIdValue = Number(params.tab_id);
    const hasTab = Number.isInteger(tabIdValue) && tabIdValue > 0;
    const tabId = hasTab ? tabIdValue : CONTROL_PLANE_TAB_ID;

    if (hasTab) {
      const lease = leases.leaseForTab(tabId);
      if (!lease || lease.generation !== generation) {
        return rejectFrame(connection, params, 'lease_required', 'The target tab is not leased by this controller generation.');
      }
      if (lease.ownership !== TAB_LEASE_OWNERSHIPS.OWNED || lease.ownerId !== controllerId) {
        return rejectFrame(connection, params, 'lease_not_owned', 'The target tab lease is not owned by this controller.');
      }
      const requestedDocumentGeneration = Number(params.document_generation);
      const authoritative = Number(documentGenerations[frameKey(tabId, params.frame_id)] || 0);
      if (!authoritative || requestedDocumentGeneration !== authoritative) {
        return rejectFrame(connection, params, 'stale_document', 'The target document generation is stale.');
      }
    }

    const queued = lifecycle.handleInboundFrame({
      frame: { method: inbound.method, params },
      tabId,
      frameGeneration: epoch,
    });
    if (!queued?.ok) {
      const code = String(queued?.error || 'command_rejected');
      return rejectFrame(connection, params, code, `Controller command rejected: ${code}.`);
    }
    await persist();
    return queued;
  }

  function closeConnection() {
    const connection = activeConnection;
    activeConnection = null;
    connected = false;
    try {
      connection?.close?.();
    } catch {
      // A failed close cannot keep stale ownership alive.
    }
  }

  async function connect() {
    if (connected && activeConnection) return status();
    if (connecting) return connecting;
    const sessionId = durableSessionId(settings);
    if (!sessionId) return { ...status(), connected: false, dormant: true, reason: 'missing_session' };

    const epoch = generation;
    connecting = (async () => {
      let candidate = null;
      try {
        candidate = await connector.connect({
          settings: { ...settings },
          identity: {
            controllerId,
            browserProfileId,
            hermesSessionId: sessionId,
            product: normalizedProduct,
          },
          generation: epoch,
          onFrame: (frame) => handleTransportFrame(frame, { epoch, connection: candidate }),
          onClose: () => {
            if (candidate === activeConnection) {
              activeConnection = null;
              connected = false;
              reconnectRequiresRestart = true;
              void persist();
            }
          },
        });
        if (!candidate?.send) throw new Error('Controller connector returned an invalid connection.');
        if (epoch !== generation) {
          candidate.close?.();
          return { ...status(), connected: false, reason: 'stale_connect' };
        }
        activeConnection = candidate;
        connected = true;
        reconnectRequiresRestart = false;
        lifecycle.resetBackoff();
        registry.touch(controllerId);
        await persist();
        await flushTerminalOutbox(candidate);
        return status();
      } catch (error) {
        if (candidate === activeConnection) activeConnection = null;
        connected = false;
        await persist();
        return {
          ...status(),
          connected: false,
          reason: 'connect_failed',
          detail: error?.message || String(error),
          retryAfterMs: lifecycle.nextBackoffDelay(),
        };
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  }

  async function boot() {
    if (bootPromise) return bootPromise;
    bootPromise = (async () => {
      try {
        const stored = await storageArea.get([
          'hermesBrowserSettings',
          CONTROLLER_WORKER_STORAGE_KEY,
          CONTROLLER_REGISTRY_STORAGE_KEY,
          TAB_LEASE_STORAGE_KEY,
          CONTROLLER_LIFECYCLE_STORAGE_KEY,
        ]);
        settings = connectionSettings(stored);
        const previousWorker = stored[CONTROLLER_WORKER_STORAGE_KEY];
        const identity = Number(previousWorker?.version) === CONTROLLER_WORKER_VERSION
          ? cleanIdentity(previousWorker)
          : null;
        controllerId = identity?.controllerId || String(randomUUID?.() || '').trim();
        browserProfileId = identity?.browserProfileId || String(randomUUID?.() || '').trim();
        if (!controllerId || !browserProfileId) throw new Error('Could not mint durable controller identity.');
        documentGenerations = Number(previousWorker?.version) === CONTROLLER_WORKER_VERSION
          ? cleanDocumentGenerations(previousWorker.documentGenerations)
          : {};
        const routeKey = controllerRouteKey(settings);
        terminalOutbox = Number(previousWorker?.version) === CONTROLLER_WORKER_VERSION
          ? normalizeTerminalOutbox(previousWorker.terminalOutbox).filter((entry) => entry.routeKey === routeKey)
          : [];

        registry = createControllerRegistry({ now });
        registry.hydrate(stored[CONTROLLER_REGISTRY_STORAGE_KEY]);

        const restoredLifecycle = createControllerLifecycle({
          now,
          ...(typeof executeCommand === 'function' ? { execute: executeCommand } : {}),
        });
        const hydrated = restoredLifecycle.hydrate(stored[CONTROLLER_LIFECYCLE_STORAGE_KEY]);
        recoveredPending = Array.isArray(hydrated?.pending) ? hydrated.pending : [];
        if (identity) restoredLifecycle.restart();
        resetLifecycle(restoredLifecycle);
        generation = lifecycle.snapshot().generation;
        for (const entry of recoveredPending) {
          const terminal = terminalOutboxEntry(routeKey, {
            command_id: entry.commandId,
            tab_id: entry.tabId,
            ok: false,
            error: { code: 'restarted' },
          });
          if (terminal) terminalOutbox.push(terminal);
        }
        terminalOutbox = normalizeTerminalOutbox(terminalOutbox);
        recoveredPending = [];

        leases = createTabLeaseStore({ now, supportsTabGroups, generation });
        leases.hydrate(stored[TAB_LEASE_STORAGE_KEY]);
        leases.reclaimExpired();
        leases.adoptGeneration({ generation });

        ensureRegistryBinding();
        await persist();
        return connect();
      } catch (error) {
        bootPromise = null;
        throw error;
      }
    })();
    return bootPromise;
  }

  async function reconcileTransition({ reason = 'reconcile' } = {}) {
    await boot();
    leases.reclaimExpired();
    if (connected && activeConnection) {
      try {
        if (typeof activeConnection.heartbeat !== 'function') throw new Error('Controller heartbeat is unavailable.');
        await activeConnection.heartbeat();
        ensureRegistryBinding();
        lifecycle.markHeartbeat({ at: Number(now()) });
        await persist();
        return { ...status(), reason };
      } catch {
        closeConnection();
        reconnectRequiresRestart = true;
      }
    }
    closeConnection();
    if (reconnectRequiresRestart) {
      terminalRouteOverride = controllerRouteKey(settings);
      lifecycle.restart();
      terminalRouteOverride = '';
      generation = lifecycle.snapshot().generation;
      leases.adoptGeneration({ generation });
      reconnectRequiresRestart = false;
    }
    ensureRegistryBinding();
    await persist();
    return connect();
  }

  function reconcile(options = {}) {
    return runTransition(() => reconcileTransition(options));
  }

  async function syncSettingsTransition(nextSettings = {}) {
    await boot();
    const normalized = nextSettings && typeof nextSettings === 'object' ? { ...nextSettings } : {};
    if (!controllerRouteChanged(settings, normalized)) {
      settings = normalized;
      return status();
    }

    const previousRouteKey = controllerRouteKey(settings);
    settings = normalized;
    closeConnection();
    terminalRouteOverride = previousRouteKey;
    lifecycle.restart();
    terminalRouteOverride = '';
    generation = lifecycle.snapshot().generation;
    leases.reclaimExpired();
    leases.adoptGeneration({ generation });
    terminalOutbox = terminalOutbox.filter((entry) => entry.routeKey === controllerRouteKey(settings));
    reconnectRequiresRestart = false;
    ensureRegistryBinding();
    await persist();
    return connect();
  }

  function syncSettings(nextSettings = {}) {
    return runTransition(() => syncSettingsTransition(nextSettings));
  }

  async function acquireLeases(message = {}) {
    const kind = String(message.kind || '').trim();
    const ownership = String(message.ownership || TAB_LEASE_OWNERSHIPS.OWNED).trim();
    const ownerId = String(message.ownerId || '').trim();
    const tabIds = [...new Set((Array.isArray(message.tabIds) ? message.tabIds : [])
      .map(Number)
      .filter((tabId) => Number.isInteger(tabId) && tabId > 0))];
    if (!KNOWN_LEASE_KINDS.has(kind) || !KNOWN_OWNERSHIPS.has(ownership) || !ownerId || !tabIds.length) {
      return { ok: false, error: 'invalid_lease_request' };
    }
    if (ownership === TAB_LEASE_OWNERSHIPS.OWNED && ownerId !== controllerId) {
      return { ok: false, error: 'invalid_lease_owner' };
    }
    const acquired = [];
    for (const tabId of tabIds) {
      const result = leases.acquire({
        tabId,
        windowId: message.windowId,
        kind,
        ownerId,
        ownership,
        taskSetId: message.taskSetId,
      });
      if (!result.ok) {
        for (const lease of acquired) leases.release({ tabId: lease.tabId, ownerId });
        return { ok: false, error: result.error, tabId };
      }
      acquired.push(result.lease);
    }
    await persist();
    return { ok: true, leases: acquired };
  }

  async function releaseLeases(message = {}) {
    const ownerId = String(message.ownerId || '').trim();
    const tabIds = [...new Set((Array.isArray(message.tabIds) ? message.tabIds : [])
      .map(Number)
      .filter((tabId) => Number.isInteger(tabId) && tabId > 0))];
    if (!ownerId || !tabIds.length) return { ok: false, error: 'invalid_lease_request' };
    const released = [];
    for (const tabId of tabIds) {
      const result = leases.release({ tabId, ownerId });
      if (result.ok) released.push(result.lease);
    }
    await persist();
    return { ok: true, leases: released };
  }

  async function documentReady(message = {}, sender = {}) {
    const tabId = senderTabId(sender) || Number(message.tabId);
    const frameId = Math.max(0, Number(sender?.frameId ?? message.frameId) || 0);
    if (!Number.isInteger(tabId) || tabId <= 0) return { ok: false, error: 'invalid_tab' };
    const key = frameKey(tabId, frameId);
    const next = Number(documentGenerations[key] || 0) + 1;
    documentGenerations = { ...documentGenerations, [key]: next };
    const entries = Object.entries(documentGenerations).slice(-CONTROLLER_MAX_DOCUMENT_GENERATIONS);
    documentGenerations = Object.fromEntries(entries);
    await persist();
    return { ok: true, tabId, frameId, documentGeneration: next };
  }

  async function handleTabUpdated(tabId, changeInfo = {}) {
    await boot();
    const normalizedTabId = Number(tabId);
    if (!Number.isInteger(normalizedTabId) || normalizedTabId <= 0) return { ok: false, error: 'invalid_tab' };
    if (changeInfo?.status !== 'loading' && !Object.hasOwn(changeInfo || {}, 'url')) return { ok: true, changed: false };
    let changed = false;
    documentGenerations = Object.fromEntries(Object.entries(documentGenerations).map(([key, value]) => {
      if (!key.startsWith(`${normalizedTabId}:`)) return [key, value];
      changed = true;
      return [key, Number(value) + 1];
    }));
    if (changed) await persist();
    return { ok: true, changed };
  }

  async function handleTabRemoved(tabId) {
    await boot();
    const normalizedTabId = Number(tabId);
    if (!Number.isInteger(normalizedTabId) || normalizedTabId <= 0) return { ok: false, error: 'invalid_tab' };
    const next = Object.fromEntries(
      Object.entries(documentGenerations).filter(([key]) => !key.startsWith(`${normalizedTabId}:`)),
    );
    const documentChanged = Object.keys(next).length !== Object.keys(documentGenerations).length;
    documentGenerations = next;
    const leaseRemoved = leases.removeTab(normalizedTabId).ok;
    if (documentChanged || leaseRemoved) await persist();
    return { ok: true, documentChanged, leaseRemoved };
  }

  async function handleMessage(message = {}, sender = {}) {
    await boot();
    const type = String(message?.type || '');
    const trustedExtension = extensionSenderTrusted(sender, extensionOrigin);
    if (type === CONTROLLER_WORKER_MESSAGES.status) return status();
    if (type === CONTROLLER_WORKER_MESSAGES.wake) return reconcile({ reason: 'message-wake' });
    if (type === CONTROLLER_WORKER_MESSAGES.documentReady) return documentReady(message, sender);
    if (!trustedExtension) return { ok: false, error: 'untrusted_sender' };
    if (type === CONTROLLER_WORKER_MESSAGES.leaseAcquire) return acquireLeases(message);
    if (type === CONTROLLER_WORKER_MESSAGES.leaseRelease) return releaseLeases(message);
    return { ok: false, error: 'unknown_message' };
  }

  return {
    boot,
    reconcile,
    syncSettings,
    handleMessage,
    handleTabUpdated,
    handleTabRemoved,
    status,
  };
}
