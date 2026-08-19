/**
 * Phase 5 service-worker controller owner
 *
 * Owns durable controller/profile identity, monotonic worker generations,
 * leases, document generations, bounded replay state, and a controller
 * transport without relying on a side-panel document. The transport is
 * injected so local/VPS and Cloud admission stay independently testable.
 *
 * Phase 6 real browser actions execute only when explicitly enabled and only
 * through an injected, policy-enforcing adapter. Lease and document authority
 * are checked both at receipt and immediately before queued execution.
 */

import {
  CONTROLLER_LIFECYCLE_STORAGE_KEY,
  ControllerTransitionReason,
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
import { createBrowserControlApprovalStore } from './browser-control-safety.mjs';
import { transportUsesDashboardTicket } from './connection-modes.mjs';

export const CONTROLLER_WORKER_VERSION = 1;
export const CONTROLLER_WORKER_STORAGE_KEY = 'hermesBrowserControllerWorker';
export const CONTROLLER_MAX_DOCUMENT_GENERATIONS = 256;
export const CONTROLLER_MAX_TERMINAL_OUTBOX = 8;
export const CONTROLLER_TERMINAL_OUTBOX_TTL_MS = 5 * 60_000;

export const CONTROLLER_WORKER_MESSAGES = Object.freeze({
  status: 'HERMES_CONTROLLER_STATUS',
  wake: 'HERMES_CONTROLLER_WAKE',
  leaseAcquire: 'HERMES_CONTROLLER_LEASE_ACQUIRE',
  leaseRelease: 'HERMES_CONTROLLER_LEASE_RELEASE',
  documentReady: 'HERMES_CONTROLLER_DOCUMENT_READY',
  approvalGrant: 'HERMES_CONTROLLER_APPROVAL_GRANT',
  approvalReject: 'HERMES_CONTROLLER_APPROVAL_REJECT',
  pause: 'HERMES_CONTROLLER_PAUSE',
  resume: 'HERMES_CONTROLLER_RESUME',
  stop: 'HERMES_CONTROLLER_STOP',
  detach: 'HERMES_CONTROLLER_DETACH',
  settingsRefresh: 'HERMES_CONTROLLER_SETTINGS_REFRESH',
  targetResolve: 'HERMES_CONTROLLER_TARGET_RESOLVE',
});

const KNOWN_LEASE_KINDS = new Set(Object.values(TAB_LEASE_KINDS));
const KNOWN_OWNERSHIPS = new Set(Object.values(TAB_LEASE_OWNERSHIPS));
const CONTROL_PLANE_TAB_ID = 2_147_483_647;
const STATUS_RECONNECT_COOLDOWN_MS = 5_000;

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

function cleanPausedLeases(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw)
    .map(([tabId, reason]) => [String(Number(tabId)), String(reason || '').trim().slice(0, 120)])
    .filter(([tabId, reason]) => /^\d+$/.test(tabId) && Number(tabId) > 0 && reason)
    .slice(-32));
}

function frameKey(tabId, frameId = 0) {
  return `${Number(tabId)}:${Math.max(0, Number(frameId) || 0)}`;
}

function canonicalControlUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function connectionSettings(stored = {}) {
  const settings = stored?.hermesBrowserSettings;
  return settings && typeof settings === 'object' ? settings : {};
}

function durableSessionId(settings = {}) {
  const transport = settings?.connectionTransport || settings?.gatewayMode;
  const dashboardSessionId = transportUsesDashboardTicket(transport)
    ? settings?.remoteDashboardSession?.storedSessionId
    : '';
  return String(dashboardSessionId || settings?.sessionId || '').trim();
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
    'browserControlEnabled',
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

function normalizeTerminalOutbox(raw = [], { at = Date.now() } = {}) {
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
      const createdAt = Number(entry?.createdAt);
      const expiresAt = Number(entry?.expiresAt);
      if (!routeKey || !commandId || !Number.isInteger(tabId) || tabId <= 0 || !errorCode
        || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || Number(at) >= expiresAt) return null;
      return { routeKey, commandId, tabId, ok: false, errorCode, createdAt, expiresAt };
    })
    .filter(Boolean)
    .slice(-CONTROLLER_MAX_TERMINAL_OUTBOX);
}

function terminalOutboxEntry(routeKey, params = {}, { at = Date.now() } = {}) {
  const commandId = String(params?.command_id || '').trim();
  const tabId = Number(params?.tab_id);
  const ok = params?.ok === true;
  const errorCode = ok
    ? 'delivery_interrupted'
    : String(params?.error?.code || 'command_error').trim();
  if (!routeKey || !commandId || !Number.isInteger(tabId) || tabId <= 0 || !errorCode) return null;
  const createdAt = Number(at);
  return {
    routeKey,
    commandId,
    tabId,
    ok: false,
    errorCode,
    createdAt,
    expiresAt: createdAt + CONTROLLER_TERMINAL_OUTBOX_TTL_MS,
  };
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
  executeBrowserCommand = undefined,
  approvalStore = undefined,
  getControllerCapabilities = undefined,
  getTab = undefined,
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
  let pausedLeases = {};
  let terminalOutbox = [];
  let recoveredPending = [];
  let registry = createControllerRegistry({ now });
  let leases = createTabLeaseStore({ now, supportsTabGroups, generation });
  const approvals = approvalStore?.grant && approvalStore?.consume && approvalStore?.count
    ? approvalStore
    : createBrowserControlApprovalStore({ now });
  let activeAction = null;
  const browserExecutor = typeof executeBrowserCommand === 'function' ? executeBrowserCommand : null;

  async function executeWorkerCommand(frame = {}, context = {}) {
    if (typeof executeCommand === 'function' && !browserExecutor) return executeCommand(frame, context);
    if (frame?.action === 'controller.noop') {
      const args = frame.arguments && typeof frame.arguments === 'object' ? { ...frame.arguments } : {};
      return { ok: true, result: args };
    }
    if (settings?.browserControlEnabled !== true || !browserExecutor) {
      return terminalError('action_disabled', `Real browser control is disabled: ${String(frame?.action || '')}`);
    }
    if (settings?.browserControlPaused === true) {
      return terminalError('controller_paused', 'Browser control is paused.');
    }

    const tabId = Number(frame?.tab_id);
    if (pausedLeases[String(tabId)]) {
      return terminalError('debugger_detached', `Browser control paused after debugger detach: ${pausedLeases[String(tabId)]}.`);
    }
    const frameId = Math.max(0, Number(frame?.frame_id) || 0);
    const lease = leases.leaseForTab(tabId);
    if (!lease || lease.generation !== generation) {
      return terminalError('lease_required', 'The target tab is no longer leased by this controller generation.');
    }
    if (lease.ownership !== TAB_LEASE_OWNERSHIPS.OWNED || lease.ownerId !== controllerId) {
      return terminalError('lease_not_owned', 'The target tab lease is no longer owned by this controller.');
    }
    const authoritative = Number(documentGenerations[frameKey(tabId, frameId)] || 0);
    if (!authoritative || Number(frame?.document_generation) !== authoritative) {
      return terminalError('stale_document', 'The target document changed before this action could execute.');
    }

    const action = String(frame?.action || '').trim();
    const actionArgs = frame?.arguments && typeof frame.arguments === 'object' ? frame.arguments : {};
    if (action === 'browser_tab_group' || action === 'browser_tab_ungroup') {
      const groupedTabIds = [...new Set((Array.isArray(actionArgs.tab_ids) ? actionArgs.tab_ids : []).map(Number))];
      const groupedLeases = groupedTabIds.map((groupedTabId) => leases.leaseForTab(groupedTabId));
      const taskSetIds = new Set(groupedLeases.map((groupedLease) => groupedLease?.taskSetId).filter(Boolean));
      if (!groupedTabIds.length || groupedLeases.some((groupedLease) => (
        !groupedLease
        || groupedLease.generation !== generation
        || groupedLease.ownership !== TAB_LEASE_OWNERSHIPS.OWNED
        || groupedLease.ownerId !== controllerId
        || groupedLease.kind !== TAB_LEASE_KINDS.TASK_SET
      )) || taskSetIds.size !== 1) {
        return terminalError('lease_not_owned', 'Every grouped tab must belong to one owned task set.');
      }
    }

    activeAction = {
      commandId: String(frame?.command_id || '').trim(),
      action,
      tabId,
      startedAt: Number(now()),
    };
    try {
      const ownedLeases = ownedControllerLeases();
      const result = await browserExecutor(frame, {
        ...context,
        approvals,
        settings: { ...settings },
        leasedTabIds: ownedLeases.map((ownedLease) => ownedLease.tabId),
        ownedTabIds: ownedLeases.map((ownedLease) => ownedLease.tabId),
        currentWindowId: lease.windowId,
        scope: {
          controllerId,
          leaseOwnerId: lease.ownerId,
          leaseId: lease.leaseId,
          leaseGeneration: lease.generation,
          tabId,
          frameId,
          documentGeneration: authoritative,
        },
      });
      if (!result?.ok) return result;

      if (action === 'browser_tab_create') {
        const createdTab = result?.result?.tab || {};
        const createdTabId = Number(createdTab.id);
        if (!Number.isInteger(createdTabId) || createdTabId <= 0) {
          return terminalError('tab_create_invalid', 'The browser did not return a valid created tab.');
        }
        const requestedKind = String(actionArgs.lease_kind || TAB_LEASE_KINDS.TASK_SET).trim();
        const kind = KNOWN_LEASE_KINDS.has(requestedKind) ? requestedKind : TAB_LEASE_KINDS.TASK_SET;
        const taskSetId = kind === TAB_LEASE_KINDS.TASK_SET
          ? String(actionArgs.task_set_id || `task-${String(frame?.command_id || '').trim()}`).trim()
          : null;
        const acquired = leases.acquire({
          tabId: createdTabId,
          windowId: Number(createdTab.windowId) || lease.windowId,
          kind,
          ownerId: controllerId,
          ownership: TAB_LEASE_OWNERSHIPS.OWNED,
          taskSetId,
        });
        if (!acquired.ok) return terminalError('lease_acquire_failed', 'The created tab could not be adopted by this controller.');
        await persist();
      }

      if (action === 'browser_tab_close') {
        const closedTabId = Number(actionArgs.tab_id);
        lifecycle.cancelTab(closedTabId);
        leases.release({ tabId: closedTabId, ownerId: controllerId });
        const nextPaused = { ...pausedLeases };
        delete nextPaused[String(closedTabId)];
        pausedLeases = nextPaused;
        documentGenerations = Object.fromEntries(Object.entries(documentGenerations)
          .filter(([key]) => !key.startsWith(`${closedTabId}:`)));
        await persist();
      }
      const renewed = leases.renew({
        tabId,
        ownerId: controllerId,
        leaseId: lease.leaseId,
        generation: lease.generation,
        at: Number(now()),
      });
      if (renewed.ok) await persist();
      return result;
    } finally {
      activeAction = null;
    }
  }

  function createWorkerLifecycle() {
    return createControllerLifecycle({ now, execute: executeWorkerCommand });
  }

  let lifecycle = createWorkerLifecycle();
  let activeConnection = null;
  let connected = false;
  let connecting = null;
  let lastReconnectKickAt = 0;
  let lastConnectFailure = null;
  let transportLost = false;
  let terminalRouteOverride = '';
  let settingsRevision = 0;
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
      pausedLeases: cleanPausedLeases(pausedLeases),
      terminalOutbox: normalizeTerminalOutbox(terminalOutbox, { at: Number(now()) }),
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
      controlEnabled: settings?.browserControlEnabled === true && Boolean(browserExecutor),
      paused: settings?.browserControlPaused === true,
      controllerId,
      browserProfileId,
      generation,
      leasedTabIds: leases.leasedTabIds(),
      pausedLeases: { ...pausedLeases },
      pendingCommands: lifecycle.pendingCount(),
      pendingApprovals: approvals.count(),
      pendingApproval: approvals.pending?.()[0] || null,
      activeAction: activeAction ? { ...activeAction } : null,
      settingsRevision,
      lastConnectFailure: lastConnectFailure ? { ...lastConnectFailure } : null,
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
    const entry = terminalOutboxEntry(routeKey, params, { at: Number(now()) });
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
    const controlPlaneOnly = !Number.isInteger(tabId) || tabId <= 0;
    const result = {
      command_id: commandId,
      tab_id: controlPlaneOnly ? CONTROL_PLANE_TAB_ID : tabId,
      ...terminalError(code, message),
    };
    if (controlPlaneOnly && connection?.send) {
      await sendTerminal(connection, result);
      return { ok: false, error: code };
    }
    await queueTerminal(result, {
      connection,
      routeKey: controllerRouteKey(settings),
      allowInactiveConnection: code === 'stale_generation',
    });
    return { ok: false, error: code };
  }

  function ownedControllerLeases() {
    return leases.snapshot().entries.filter((lease) => (
      lease.generation === generation
      && lease.ownership === TAB_LEASE_OWNERSHIPS.OWNED
      && lease.ownerId === controllerId
    ));
  }

  function normalizeBrokerCommandTarget(rawParams = {}) {
    const params = { ...rawParams };
    const tabIdValue = Number(params.tab_id);
    if (Number.isInteger(tabIdValue) && tabIdValue > 0) {
      const lease = leases.leaseForTab(tabIdValue);
      if (!lease || lease.generation !== generation) {
        return {
          ok: false,
          code: 'lease_required',
          message: 'The requested source tab is not leased by this controller generation.',
        };
      }
      if (lease.ownership !== TAB_LEASE_OWNERSHIPS.OWNED || lease.ownerId !== controllerId) {
        return {
          ok: false,
          code: 'lease_not_owned',
          message: 'The requested source tab lease is not owned by this controller.',
        };
      }
      const frameId = Math.max(0, Number(params.frame_id) || 0);
      const authoritative = Number(documentGenerations[frameKey(tabIdValue, frameId)] || 0);
      if (!authoritative) {
        return {
          ok: false,
          code: 'stale_document',
          message: 'The requested source tab has no current document generation.',
        };
      }
      const suppliedGeneration = Number(params.document_generation);
      return {
        ok: true,
        params: {
          ...params,
          tab_id: tabIdValue,
          frame_id: frameId,
          document_generation: Number.isInteger(suppliedGeneration) && suppliedGeneration > 0
            ? suppliedGeneration
            : authoritative,
        },
      };
    }
    if (String(params.action || '') === 'controller.noop') return { ok: true, params };

    const owned = ownedControllerLeases();
    if (owned.length !== 1) {
      return {
        ok: false,
        code: owned.length === 0 ? 'target_unavailable' : 'ambiguous_target',
        message: owned.length === 0
          ? 'No exact owned browser tab is available for this controller.'
          : 'The controller owns more than one browser tab; an exact target is required.',
      };
    }
    const tabId = owned[0].tabId;
    const frameId = 0;
    const documentGeneration = Number(documentGenerations[frameKey(tabId, frameId)] || 0);
    if (!documentGeneration) {
      return {
        ok: false,
        code: 'stale_document',
        message: 'The only owned browser tab has no current document generation.',
      };
    }
    return {
      ok: true,
      params: {
        ...params,
        tab_id: tabId,
        frame_id: frameId,
        document_generation: documentGeneration,
      },
    };
  }

  async function handleTransportFrame(frame, { epoch, connection }) {
    const inbound = normalizeInboundFrame(frame);
    if (!inbound) return { ok: false, error: 'ignored_frame' };
    let params = inbound.params;
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
    const normalizedTarget = normalizeBrokerCommandTarget(params);
    if (!normalizedTarget.ok) {
      return rejectFrame(connection, params, normalizedTarget.code, normalizedTarget.message);
    }
    params = normalizedTarget.params;
    const tabIdValue = Number(params.tab_id);
    const hasTab = Number.isInteger(tabIdValue) && tabIdValue > 0;
    const tabId = hasTab ? tabIdValue : CONTROL_PLANE_TAB_ID;

    if (hasTab) {
      if (settings?.browserControlPaused === true) {
        return rejectFrame(connection, params, 'controller_paused', 'Browser control is paused.');
      }
      if (pausedLeases[String(tabId)]) {
        return rejectFrame(connection, params, 'debugger_detached', `Browser control paused after debugger detach: ${pausedLeases[String(tabId)]}.`);
      }
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

    const lease = hasTab ? leases.leaseForTab(tabId) : null;
    const queued = lifecycle.handleInboundFrame({
      frame: { method: inbound.method, params },
      tabId,
      frameGeneration: epoch,
      metadata: {
        controllerId,
        browserProfileId,
        leaseId: lease?.leaseId || 'control-plane',
        leaseGeneration: lease?.generation || generation,
      },
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
    if (!sessionId) {
      lastConnectFailure = { reason: 'missing_session', detail: 'No Hermes session is active.' };
      return { ...status(), connected: false, dormant: true, reason: 'missing_session' };
    }

    const epoch = generation;
    connecting = (async () => {
      let candidate = null;
      try {
        const resolvedCapabilities = typeof getControllerCapabilities === 'function'
          ? await getControllerCapabilities({ ...settings }, normalizedProduct)
          : undefined;
        candidate = await connector.connect({
          settings: { ...settings },
          identity: {
            controllerId,
            browserProfileId,
            hermesSessionId: sessionId,
            product: normalizedProduct,
            ...(Array.isArray(resolvedCapabilities) ? { capabilities: [...resolvedCapabilities] } : {}),
          },
          generation: epoch,
          onFrame: (frame) => handleTransportFrame(frame, { epoch, connection: candidate }),
          onClose: () => {
            if (candidate === activeConnection) {
              activeConnection = null;
              connected = false;
              transportLost = true;
              lifecycle.transition(ControllerTransitionReason.TRANSPORT_LOST);
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
        lastConnectFailure = null;
        transportLost = false;
        lifecycle.transition(ControllerTransitionReason.TRANSPORT_REFRESHED);
        registry.touch(controllerId);
        await persist();
        await flushTerminalOutbox(candidate);
        return status();
      } catch (error) {
        if (candidate === activeConnection) activeConnection = null;
        connected = false;
        lastConnectFailure = {
          reason: 'connect_failed',
          detail: String(error?.message || error || 'Controller connection failed.').slice(0, 180),
          retryAfterMs: lifecycle.nextBackoffDelay(),
        };
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
        pausedLeases = Number(previousWorker?.version) === CONTROLLER_WORKER_VERSION
          ? cleanPausedLeases(previousWorker.pausedLeases)
          : {};
        const routeKey = controllerRouteKey(settings);
        const previousRouteKey = String(previousWorker?.routeKey || '').trim();
        const sameDurableRoute = Boolean(identity && routeKey && previousRouteKey === routeKey);
        terminalOutbox = Number(previousWorker?.version) === CONTROLLER_WORKER_VERSION
          ? normalizeTerminalOutbox(previousWorker.terminalOutbox, { at: Number(now()) })
            .filter((entry) => entry.routeKey === routeKey)
          : [];

        registry = createControllerRegistry({ now });
        registry.hydrate(stored[CONTROLLER_REGISTRY_STORAGE_KEY]);

        const restoredLifecycle = createWorkerLifecycle();
        const hydrated = restoredLifecycle.hydrate(stored[CONTROLLER_LIFECYCLE_STORAGE_KEY]);
        recoveredPending = Array.isArray(hydrated?.pending) ? hydrated.pending : [];
        if (identity && !sameDurableRoute) restoredLifecycle.restart();
        resetLifecycle(restoredLifecycle);
        generation = lifecycle.snapshot().generation;
        for (const entry of recoveredPending) {
          const terminal = terminalOutboxEntry(routeKey, {
            command_id: entry.commandId,
            tab_id: entry.tabId,
            ok: false,
            error: { code: 'restarted' },
          }, { at: Number(now()) });
          if (terminal) terminalOutbox.push(terminal);
        }
        terminalOutbox = normalizeTerminalOutbox(terminalOutbox, { at: Number(now()) });
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
        transportLost = true;
        lifecycle.transition(ControllerTransitionReason.TRANSPORT_LOST);
      }
    }
    closeConnection();
    if (transportLost) lifecycle.transition(ControllerTransitionReason.TRANSPORT_LOST);
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
    pausedLeases = {};
    closeConnection();
    terminalRouteOverride = previousRouteKey;
    lifecycle.restart();
    terminalRouteOverride = '';
    generation = lifecycle.snapshot().generation;
    leases.reclaimExpired();
    leases.adoptGeneration({ generation });
    terminalOutbox = terminalOutbox.filter((entry) => entry.routeKey === controllerRouteKey(settings));
    transportLost = false;
    ensureRegistryBinding();
    await persist();
    return connect();
  }

  function syncSettings(nextSettings = {}, { revision = null } = {}) {
    const requestedRevision = Number.isInteger(Number(revision))
      ? Number(revision)
      : settingsRevision + 1;
    settingsRevision = Math.max(settingsRevision, requestedRevision);
    return runTransition(() => {
      if (requestedRevision !== settingsRevision) {
        return { ...status(), staleSettingsRevision: true };
      }
      return syncSettingsTransition(nextSettings);
    });
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
      const existing = leases.leaseForTab(tabId);
      if (existing && pausedLeases[String(tabId)]
        && existing.ownerId === ownerId && existing.generation === generation) {
        const nextPaused = { ...pausedLeases };
        delete nextPaused[String(tabId)];
        pausedLeases = nextPaused;
        acquired.push(existing);
        continue;
      }
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
      if (result.ok) {
        released.push(result.lease);
        const nextPaused = { ...pausedLeases };
        delete nextPaused[String(tabId)];
        pausedLeases = nextPaused;
      }
    }
    await persist();
    return { ok: true, leases: released };
  }

  async function setPaused(paused) {
    settings = { ...settings, browserControlPaused: paused === true };
    await storageArea.set({ hermesBrowserSettings: { ...settings } });
    await persist();
    return { ...status(), paused: settings.browserControlPaused };
  }

  async function stopCommands() {
    const stopped = lifecycle.cancelAll();
    await persist();
    return { ...stopped, pendingCommands: lifecycle.pendingCount() };
  }

  async function detachControl() {
    const stopped = lifecycle.cancelAll();
    const releasedTabIds = [];
    for (const tabId of leases.leasedTabIds()) {
      const lease = leases.leaseForTab(tabId);
      if (lease?.ownership !== TAB_LEASE_OWNERSHIPS.OWNED || lease.ownerId !== controllerId) continue;
      if (leases.release({ tabId, ownerId: controllerId }).ok) releasedTabIds.push(tabId);
    }
    approvals.clear?.();
    const nextSettings = { ...settings, browserControlEnabled: false, browserControlPaused: false };
    await storageArea.set({ hermesBrowserSettings: { ...nextSettings } });
    await syncSettingsTransition(nextSettings);
    return { ok: true, cancelled: stopped.cancelled, releasedTabIds };
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

  function grantApproval(message = {}) {
    const tabId = Number(message.tabId);
    const documentGeneration = Number(message.documentGeneration);
    const lease = leases.leaseForTab(tabId);
    const authoritative = Number(documentGenerations[frameKey(tabId, message.frameId)] || 0);
    if (!lease || lease.generation !== generation) return { ok: false, error: 'lease_required' };
    if (lease.ownership !== TAB_LEASE_OWNERSHIPS.OWNED || lease.ownerId !== controllerId) {
      return { ok: false, error: 'lease_not_owned' };
    }
    if (!authoritative || documentGeneration !== authoritative) return { ok: false, error: 'stale_document' };
    const pending = approvals.pending?.().find((entry) => entry.approvalId === String(message.approvalId || '').trim());
    if (!pending
      || pending.commandId !== String(message.commandId || '').trim()
      || pending.action !== String(message.action || '').trim()
      || pending.tabId !== tabId
      || pending.documentGeneration !== documentGeneration) {
      return { ok: false, error: 'approval_missing' };
    }
    if (!lifecycle.hasPending(pending.commandId) || pending.state !== 'paused') {
      approvals.cancelRequest?.(pending.approvalId, 'approval_cancelled');
      return { ok: false, error: 'approval_terminal' };
    }
    if (pending.controllerId && pending.controllerId !== controllerId) return { ok: false, error: 'approval_mismatch' };
    if (pending.leaseId && pending.leaseId !== lease.leaseId) return { ok: false, error: 'approval_mismatch' };
    if (pending.leaseGeneration && pending.leaseGeneration !== lease.generation) {
      return { ok: false, error: 'approval_mismatch' };
    }
    return approvals.grant(pending);
  }

  function rejectApproval(message = {}) {
    const approvalId = String(message.approvalId || '').trim();
    const commandId = String(message.commandId || '').trim();
    const pending = approvals.pending?.().find((entry) => entry.approvalId === approvalId);
    if (!pending || !commandId || pending.commandId !== commandId) return { ok: false, error: 'approval_missing' };
    const cancelled = lifecycle.cancelCommand(commandId);
    approvals.cancelRequest?.(approvalId, 'approval_denied');
    return { ok: true, commandId, cancelled: cancelled.ok === true };
  }

  function unavailableControlTarget(reason, message) {
    return {
      ok: false,
      route: 'extension-controller',
      availability: 'unavailable',
      isolatedFallback: 'forbidden',
      reason,
      message,
    };
  }

  async function resolveControlTarget(message = {}) {
    if (settings?.browserControlEnabled !== true || !browserExecutor || !connected) {
      return unavailableControlTarget('controller_unavailable', 'Hermes control is not connected to this browser tab.');
    }
    const tabId = Number(message.tabId);
    const frameId = Math.max(0, Number(message.frameId) || 0);
    const expectedUrl = canonicalControlUrl(message.expectedUrl);
    if (!Number.isInteger(tabId) || tabId <= 0 || !expectedUrl) {
      return unavailableControlTarget('target_invalid', 'The requested browser tab target is incomplete.');
    }
    let tab;
    try {
      tab = typeof getTab === 'function' ? await getTab(tabId) : null;
    } catch {
      tab = null;
    }
    if (!tab || Number(tab.id) !== tabId) {
      return unavailableControlTarget('tab_not_found', 'Tab not found in your browser.');
    }
    const actualUrl = canonicalControlUrl(tab.url);
    if (!actualUrl || actualUrl !== expectedUrl) {
      return unavailableControlTarget('tab_url_mismatch', 'The requested tab changed before Hermes could bind control.');
    }
    const lease = leases.leaseForTab(tabId);
    if (!lease || lease.generation !== generation) {
      return unavailableControlTarget('lease_required', 'The requested tab is not leased to this controller.');
    }
    if (lease.ownership !== TAB_LEASE_OWNERSHIPS.OWNED || lease.ownerId !== controllerId) {
      return unavailableControlTarget('lease_not_owned', 'The requested tab is not owned by this controller.');
    }
    let documentGeneration = Number(documentGenerations[frameKey(tabId, frameId)] || 0);
    if (!documentGeneration) {
      documentGeneration = 1;
      documentGenerations = { ...documentGenerations, [frameKey(tabId, frameId)]: 1 };
      await persist();
    }
    return {
      ok: true,
      route: 'extension-controller',
      availability: 'available',
      isolatedFallback: 'forbidden',
      controllerId,
      browserProfileId,
      tabId,
      frameId,
      documentGeneration,
      url: actualUrl,
      leaseOwned: true,
    };
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
    const pauseRemoved = Object.hasOwn(pausedLeases, String(normalizedTabId));
    if (pauseRemoved) {
      const nextPaused = { ...pausedLeases };
      delete nextPaused[String(normalizedTabId)];
      pausedLeases = nextPaused;
    }
    const leaseRemoved = leases.removeTab(normalizedTabId).ok;
    if (documentChanged || leaseRemoved || pauseRemoved) await persist();
    return { ok: true, documentChanged, leaseRemoved, pauseRemoved };
  }

  async function handleDebuggerDetach({ tabId, reason = 'unknown' } = {}) {
    await boot();
    const normalizedTabId = Number(tabId);
    const normalizedReason = String(reason || 'unknown').trim().slice(0, 120) || 'unknown';
    if (!Number.isInteger(normalizedTabId) || normalizedTabId <= 0) return { ok: false, error: 'invalid_tab' };
    const cancelled = lifecycle.cancelTab(normalizedTabId).cancelled;
    if (normalizedReason === 'target_closed') {
      const leaseRemoved = leases.removeTab(normalizedTabId).ok;
      const nextPaused = { ...pausedLeases };
      delete nextPaused[String(normalizedTabId)];
      pausedLeases = nextPaused;
      await persist();
      return {
        ok: true,
        tabId: normalizedTabId,
        reason: normalizedReason,
        paused: false,
        leaseRemoved,
        cancelled,
      };
    }
    pausedLeases = cleanPausedLeases({
      ...pausedLeases,
      [String(normalizedTabId)]: normalizedReason,
    });
    await persist();
    return {
      ok: true,
      tabId: normalizedTabId,
      reason: normalizedReason,
      paused: true,
      leaseRemoved: false,
      cancelled,
    };
  }

  async function handleMessage(message = {}, sender = {}) {
    await boot();
    const type = String(message?.type || '');
    const trustedExtension = extensionSenderTrusted(sender, extensionOrigin);
    if (type === CONTROLLER_WORKER_MESSAGES.status) {
      const current = status();
      const enabled = settings?.browserControlEnabled === true;
      if (enabled && !current.connected && !connecting && Boolean(durableSessionId(settings))
        && Number(now()) - lastReconnectKickAt >= STATUS_RECONNECT_COOLDOWN_MS) {
        lastReconnectKickAt = Number(now());
        void reconcile({ reason: 'status-reconnect' }).catch(() => undefined);
      }
      return current;
    }
    if (type === CONTROLLER_WORKER_MESSAGES.wake) return reconcile({ reason: 'message-wake' });
    if (type === CONTROLLER_WORKER_MESSAGES.documentReady) return documentReady(message, sender);
    if (!trustedExtension) return { ok: false, error: 'untrusted_sender' };
    if (type === CONTROLLER_WORKER_MESSAGES.settingsRefresh) {
      const revision = settingsRevision + 1;
      settingsRevision = revision;
      const stored = await storageArea.get('hermesBrowserSettings');
      return syncSettings(connectionSettings(stored), { revision });
    }
    if (type === CONTROLLER_WORKER_MESSAGES.leaseAcquire) return acquireLeases(message);
    if (type === CONTROLLER_WORKER_MESSAGES.leaseRelease) return releaseLeases(message);
    if (type === CONTROLLER_WORKER_MESSAGES.targetResolve) return resolveControlTarget(message);
    if (type === CONTROLLER_WORKER_MESSAGES.approvalGrant) return grantApproval(message);
    if (type === CONTROLLER_WORKER_MESSAGES.approvalReject) return rejectApproval(message);
    if (type === CONTROLLER_WORKER_MESSAGES.pause) return setPaused(true);
    if (type === CONTROLLER_WORKER_MESSAGES.resume) return setPaused(false);
    if (type === CONTROLLER_WORKER_MESSAGES.stop) return stopCommands();
    if (type === CONTROLLER_WORKER_MESSAGES.detach) return detachControl();
    return { ok: false, error: 'unknown_message' };
  }

  return {
    boot,
    reconcile,
    syncSettings,
    handleMessage,
    handleTabUpdated,
    handleTabRemoved,
    handleDebuggerDetach,
    status,
  };
}
