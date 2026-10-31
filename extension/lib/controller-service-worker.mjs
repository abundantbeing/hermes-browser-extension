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
import { CONTROLLER_METHODS, CONTROLLER_SESSION_PENDING, CONTROLLER_UNSUPPORTED_GATEWAY } from './controller-protocol.mjs';
import {
  BROWSER_CONTROL_RISKS,
  classifyBrowserControlAction,
  createBrowserControlApprovalStore,
  validateBrowserControlUrl,
} from './browser-control-safety.mjs';
import { isGatewayAuthRejection, transportUsesDashboardTicket } from './connection-modes.mjs';
import { CONTROL_TOOL_FAMILIES, controlToolFamily, controlToolName, setControlToolFamily } from './control-tool-names.mjs';

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
  scopeReplace: 'HERMES_CONTROLLER_SCOPE_REPLACE',
  documentReady: 'HERMES_CONTROLLER_DOCUMENT_READY',
  approvalGrant: 'HERMES_CONTROLLER_APPROVAL_GRANT',
  approvalReject: 'HERMES_CONTROLLER_APPROVAL_REJECT',
  pause: 'HERMES_CONTROLLER_PAUSE',
  resume: 'HERMES_CONTROLLER_RESUME',
  stop: 'HERMES_CONTROLLER_STOP',
  detach: 'HERMES_CONTROLLER_DETACH',
  settingsRefresh: 'HERMES_CONTROLLER_SETTINGS_REFRESH',
  targetResolve: 'HERMES_CONTROLLER_TARGET_RESOLVE',
  prepareTurn: 'HERMES_CONTROLLER_PREPARE_TURN',
});

const KNOWN_LEASE_KINDS = new Set(Object.values(TAB_LEASE_KINDS));
const KNOWN_OWNERSHIPS = new Set(Object.values(TAB_LEASE_OWNERSHIPS));
const CONTROL_PLANE_TAB_ID = 2_147_483_647;
const STATUS_RECONNECT_COOLDOWN_MS = 5_000;
// The page view prepared for a turn must never hold the turn up for long.
const PREPARE_TURN_SNAPSHOT_MS = 1_500;
const PREPARE_TURN_BACKSTOP_MS = 1_750;
// A new chat has no Hermes session until its first turn creates one. That turn reconnects at once
// (prepareTurn), bounded by this; until then the worker only retries slowly, without growing backoff.
const PREPARE_TURN_CONNECT_MS = 2_500;
const SESSION_PENDING_RETRY_MS = 15_000;
// Commands that carry their own arguments.tab_id meaning (act on / group that
// tab) never use it to pick the command's target tab.
const TAB_ARGUMENT_OWNED_ACTIONS = new Set([
  'browser_tab_activate', 'browser_tab_close', 'browser_tab_group', 'browser_tab_ungroup',
]);
// Commands about the tab list rather than one page: any owned tab can carry them, so they never
// need the default target the page actions fall back on.
const TAB_MANAGEMENT_ACTIONS = new Set(['browser_tabs', 'browser_tab_create', ...TAB_ARGUMENT_OWNED_ACTIONS]);
// The task set of the tabs Hermes opens itself (tab_create, or a link or page script one of its actions
// opened) when the person's attached tabs are not a task set: one set, so those tabs can be grouped.
const HERMES_OPENED_TASK_SET = 'hermes-opened';
// A tab a page opens just after a Hermes action on it ended (a link's navigation, a script's window.open
// after a delay) still belongs to that action.
// The actions that can open a tab: a click or key press on a link, a script's window.open after one, a form
// submitted by typing, a navigation. A snapshot, screenshot, scroll or tab command never does, so a tab the
// person opens while one of those runs stays theirs.
// Told to the model when a tab opened while its action ran: the tab is not attached, whoever opened it.
const OPENED_TAB_NOTE = 'A new tab opened. Hermes cannot tell whether this action or the person opened it, so it was not attached. '
  + 'If you need it, ask the person to attach it in Hermes Control.';

const TAB_OPENING_ACTIONS = new Set([
  'browser_click', 'browser_press', 'browser_type', 'browser_drag', 'browser_select', 'browser_navigate', 'browser_back',
]);

// A batch can open a tab when one of its steps can.
function actionCanOpenTab(action, args = {}) {
  if (action !== 'browser_batch') return TAB_OPENING_ACTIONS.has(action);
  return (Array.isArray(args.actions) ? args.actions : []).some((step) => {
    const name = String(step?.action || '').trim();
    return TAB_OPENING_ACTIONS.has(name.startsWith('browser_') ? name : `browser_${name}`);
  });
}

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

// How long a refusal stays in the Hermes Control window's status line when nothing else happens.
const NOTE_TTL_MS = 120_000;

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
  releaseTabDebugger = undefined,
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
  // Frames whose generation the worker gave itself because the page had not reported one yet. The page's
  // own first report then confirms that generation instead of starting a new one, so refs minted under it
  // stay valid; a navigation clears the mark.
  const seededGenerations = new Set();
  let pausedLeases = {};
  // The tab the latest turn was prepared for; the default target when several
  // tabs are attached and a command names none.
  let lastTurnTabId = 0;
  // The tab of the most recent action Hermes ran. Show tab points at it between
  // actions, so the button does not flicker with each action.
  let lastActionTabId = 0;
  // The last refusal worth telling the person about (a frame withheld a screenshot, a pointer action would land in
  // a frame Hermes cannot read): a code, never page details. The model gets the full message with its result; this
  // is for the Hermes Control window. It ends when the next command starts or after a couple of minutes.
  let lastNote = null;
  let terminalOutbox = [];
  let recoveredPending = [];
  let registry = createControllerRegistry({ now });
  let leases = createTabLeaseStore({ now, supportsTabGroups, generation });
  const approvals = approvalStore?.grant && approvalStore?.consume && approvalStore?.count
    ? approvalStore
    : createBrowserControlApprovalStore({ now });
  // Commands wait in one queue per tab, so commands on two tabs run at once (and a cancelled command's action
  // may still be finishing when the next one starts): each running action has its own record here, and only its
  // own run takes it out. Insertion order, so the last one is the latest to start.
  const activeActions = new Set();
  const latestActiveAction = () => {
    const latest = [...activeActions].at(-1);
    return latest ? { ...latest } : null;
  };
  let scopeChanging = false;
  // The turn's page read runs outside the command lifecycle, so it is tracked here: tabId -> its abort controllers.
  // Anything that takes control away from Hermes (a debugger detach, a closed tab, Pause, Turn off, releasing the
  // tab) stops the read at once, rather than letting it attach again to finish.
  const turnReads = new Map();
  const browserExecutor = typeof executeBrowserCommand === 'function' ? executeBrowserCommand : null;

  function personNoteCode(action, outcome) {
    const code = outcome?.error?.code;
    if (action === 'browser_screenshot') {
      if (code === 'restricted_frame') return 'screenshot_frame';
      if (code === 'screenshot_unavailable') return 'screenshot_permission';
      if (code === 'restricted_page' || code === 'page_changed') return 'screenshot_page';
      return '';
    }
    return code === 'restricted_frame' ? 'action_frame' : '';
  }

  function executorContext(base = {}, { lease, tabId, frameId, authoritative }) {
    const ownedLeases = ownedControllerLeases();
    return {
      ...base,
      approvals,
      settings: { ...settings },
      leasedTabIds: ownedLeases.map((ownedLease) => ownedLease.tabId),
      ownedTabIds: ownedLeases.map((ownedLease) => ownedLease.tabId),
      currentWindowId: lease.windowId,
      // A batch asks this between steps: Pause, a debugger detach or turning
      // control off while it runs must end it, not let the rest of the steps
      // re-attach and carry on.
      controlHalted: () => settings?.browserControlEnabled !== true
        || settings?.browserControlPaused === true
        || Boolean(pausedLeases[String(tabId)]),
      // The executor mints post-action refs under the generation the next
      // command will carry, which a navigation advances while it runs.
      currentDocumentGeneration: (hookTabId, hookFrameId = 0) => Number(
        documentGenerations[frameKey(Number(hookTabId), Math.max(0, Number(hookFrameId) || 0))] || 0,
      ),
      scope: {
        controllerId,
        leaseOwnerId: lease.ownerId,
        leaseId: lease.leaseId,
        leaseGeneration: lease.generation,
        tabId,
        frameId,
        documentGeneration: authoritative,
      },
    };
  }

  async function executeWorkerCommand(frame = {}, context = {}) {
    if (scopeChanging) return terminalError('controller_busy', 'Control scope is being updated.');
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
        return terminalError(
          'lease_not_owned',
          'Only tabs of one task set can be grouped: the tabs Hermes opened, or tabs the person attached as a task set. Tabs the person attached one by one stay as they are.',
        );
      }
    }

    const commandId = String(frame?.command_id || '').trim();
    const running = {
      commandId,
      action,
      tabId,
      startedAt: Number(now()),
      // Whether this action can open a tab: only then does handleTabCreated tell it about one.
      opensTab: actionCanOpenTab(action, actionArgs),
      // How many tabs opened from a tab Hermes acts in while this action ran. None is attached.
      openedTabs: 0,
      ...(action === 'browser_tab_close' ? { closingTabId: Number(actionArgs.tab_id) } : {}),
    };
    activeActions.add(running);
    lastActionTabId = tabId;
    lastNote = null;
    try {
      let result = await browserExecutor(frame, executorContext(context, { lease, tabId, frameId, authoritative }));
      if (!result?.ok) {
        const noteCode = personNoteCode(action, result);
        if (noteCode) lastNote = { code: noteCode, tabId, at: Number(now()) };
        return result;
      }

      if (action === 'browser_tab_create') {
        const createdTab = result?.result?.tab || {};
        const createdTabId = Number(createdTab.id);
        if (!Number.isInteger(createdTabId) || createdTabId <= 0) {
          return terminalError('tab_create_invalid', 'The browser did not return a valid created tab.');
        }
        const requestedKind = String(actionArgs.lease_kind || TAB_LEASE_KINDS.TASK_SET).trim();
        const kind = KNOWN_LEASE_KINDS.has(requestedKind) ? requestedKind : TAB_LEASE_KINDS.TASK_SET;
        const taskSetId = kind === TAB_LEASE_KINDS.TASK_SET
          ? String(actionArgs.task_set_id || openedTaskSetId(lease)).trim()
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
        // The tab Hermes just opened is the one Show tab offers, though it opens in the background.
        lastActionTabId = createdTabId;
        await persist();
      }

      if (action === 'browser_tab_close') {
        const closedTabId = Number(actionArgs.tab_id);
        // Commands still queued on the closed tab end with it; this one, which closed it, keeps its result.
        lifecycle.cancelTab(closedTabId, { except: commandId });
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
      if (result.result && typeof result.result === 'object' && !Array.isArray(result.result)) {
        // Every page action says which tab it ran in: refs are numbered per page, so results from two
        // tabs are told apart by this. A tab that opened meanwhile is only counted: the model asks the person.
        const extra = {};
        if (!TAB_MANAGEMENT_ACTIONS.has(action)) extra.tab_id = tabId;
        if (running.openedTabs) {
          extra.opened_tabs_not_attached = running.openedTabs;
          extra.opened_tabs_note = OPENED_TAB_NOTE;
        }
        if (Object.keys(extra).length) result = { ...result, result: { ...result.result, ...extra } };
      }
      return result;
    } finally {
      activeActions.delete(running);
    }
  }

  // Tabs Hermes opens join the task set of the tab it acted in when that is one the person chose, else
  // Hermes's own, so they can be grouped together.
  function openedTaskSetId(carrierLease) {
    return carrierLease?.kind === TAB_LEASE_KINDS.TASK_SET && carrierLease.taskSetId
      ? carrierLease.taskSetId
      : HERMES_OPENED_TASK_SET;
  }

  // The first document generation of an owned tab whose page has not reported one (the content script
  // does not run on PDFs, error pages or tabs open since before the extension loaded). Returns whether
  // it set one; the caller persists.
  function seedDocumentGeneration(tabId, frameId = 0) {
    const key = frameKey(tabId, frameId);
    if (Number(documentGenerations[key] || 0) > 0) return false;
    documentGenerations = Object.fromEntries(Object.entries({ ...documentGenerations, [key]: 1 })
      .slice(-CONTROLLER_MAX_DOCUMENT_GENERATIONS));
    seededGenerations.add(key);
    return true;
  }

  function forgetSeededGenerations(tabId) {
    for (const key of [...seededGenerations]) if (key.startsWith(`${Number(tabId)}:`)) seededGenerations.delete(key);
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
  // Route this gateway answered "no extension control" for. While it matches the
  // current route nothing reconnects; a route or credential change clears it.
  let unsupportedRouteKey = '';
  // No transient reconnect before this time (retryAfterMs backoff).
  let nextConnectAt = 0;
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
      lastTurnTabId,
      lastActionTabId,
      unsupportedRouteKey,
      terminalOutbox: normalizeTerminalOutbox(terminalOutbox, { at: Number(now()) }),
      updatedAt: Number(now()),
    };
  }

  function persist({ includeSettings = false } = {}) {
    const values = {
      ...(includeSettings ? { hermesBrowserSettings: { ...settings } } : {}),
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
      // Which names the model has for the control tools while connected (control-tool-names.mjs).
      controlToolFamily: connected ? controlToolFamily() : null,
      controlEnabled: settings?.browserControlEnabled === true && Boolean(browserExecutor),
      paused: settings?.browserControlPaused === true,
      controllerId,
      browserProfileId,
      generation,
      leasedTabIds: leases.leasedTabIds(),
      ownedTabIds: ownedControllerLeases().map((lease) => lease.tabId),
      scopeChanging,
      pausedLeases: { ...pausedLeases },
      pendingCommands: lifecycle.pendingCount(),
      pendingApprovals: approvals.count(),
      pendingApproval: approvals.pending?.()[0] || null,
      activeAction: latestActiveAction(),
      lastActionTabId: lastActionTabId > 0 ? lastActionTabId : null,
      ...(lastNote && Number(now()) - lastNote.at < NOTE_TTL_MS ? { lastNote: { code: lastNote.code, tabId: lastNote.tabId } } : {}),
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

  // The owned tab a tab-list command is queued and authorized on: a switch is carried by the tab it
  // names, a group by one of its tabs, a close by another tab when there is one (so the close does not
  // end with the tab it closes), anything else by the turn's tab, then the last tab Hermes acted in,
  // then any owned tab. 0 when none is owned.
  function tabListCarrier(action, args = {}, ownedTabIds = new Set()) {
    const owned = (value) => {
      const id = Number(value);
      return Number.isInteger(id) && ownedTabIds.has(id) ? id : 0;
    };
    const preferred = [lastTurnTabId, lastActionTabId, ...ownedTabIds].map((id) => owned(id)).filter(Boolean);
    const named = owned(args.tab_id);
    if (action === 'browser_tab_close') return preferred.find((id) => id !== named) || named;
    if (action === 'browser_tab_activate') return named || preferred[0] || 0;
    if (action === 'browser_tab_group' || action === 'browser_tab_ungroup') {
      const grouped = (Array.isArray(args.tab_ids) ? args.tab_ids : []).map((id) => owned(id)).find(Boolean);
      return grouped || preferred[0] || 0;
    }
    return preferred[0] || 0;
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
    const ownedTabIds = new Set(owned.map((lease) => lease.tabId));
    // The model may name an attached tab in the command arguments; it must be
    // one this controller owns. Actions that use arguments.tab_id for their own
    // purpose keep the default target.
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const argTabId = Number(args.tab_id);
    const namesTab = args.tab_id !== undefined && args.tab_id !== null && args.tab_id !== ''
      && !TAB_ARGUMENT_OWNED_ACTIONS.has(String(params.action || ''));
    const action = String(params.action || '');
    let tabId = 0;
    if (namesTab) {
      if (!Number.isInteger(argTabId) || !ownedTabIds.has(argTabId)) {
        return {
          ok: false,
          code: 'lease_not_owned',
          message: `tab_id is not a browser tab attached to Hermes Control. ${controlToolName('browser_tabs')} lists the ones it can use.`,
        };
      }
      tabId = argTabId;
    } else if (TAB_MANAGEMENT_ACTIONS.has(action)) {
      tabId = tabListCarrier(action, args, ownedTabIds);
    } else if (owned.length === 1) {
      tabId = owned[0].tabId;
    } else if (owned.length > 1 && ownedTabIds.has(lastTurnTabId)) {
      tabId = lastTurnTabId;
    }
    if (!tabId) {
      return {
        ok: false,
        code: owned.length === 0 ? 'target_unavailable' : 'ambiguous_target',
        message: owned.length === 0
          ? 'No exact owned browser tab is available for this controller.'
          : `Hermes Control has ${owned.length} tabs and this command did not say which: pass tab_id, one of ${[...ownedTabIds].join(', ')} (${controlToolName('browser_tabs')} shows each tab's title and URL).`,
      };
    }
    const frameId = 0;
    // An owned tab whose page never reported itself (a PDF, an error page, a tab open since before the
    // extension loaded) gets its first generation now, as the turn's tab does when a turn resolves it.
    if (seedDocumentGeneration(tabId, frameId)) void persist();
    const documentGeneration = Number(documentGenerations[frameKey(tabId, frameId)] || 0);
    if (!documentGeneration) {
      return {
        ok: false,
        code: 'stale_document',
        message: 'The target browser tab has no current document generation.',
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
    if (settings?.browserControlEnabled !== true) {
      // A controller registered while control is off would still bind the lane
      // at the gateway (noop only) and keep the legacy browser from answering.
      lastConnectFailure = null;
      // Turning control off is the person's reset: the next enable gets a fresh attempt.
      unsupportedRouteKey = '';
      nextConnectAt = 0;
      return { ...status(), connected: false, dormant: true, reason: 'control_off' };
    }
    const currentRouteKey = controllerRouteKey(settings);
    if (unsupportedRouteKey && unsupportedRouteKey === currentRouteKey) {
      // Terminal: this gateway has no extension control. Do not dial again.
      if (lastConnectFailure?.reason !== CONTROLLER_UNSUPPORTED_GATEWAY) {
        lastConnectFailure = {
          reason: CONTROLLER_UNSUPPORTED_GATEWAY,
          detail: 'This Hermes does not support Hermes Control.',
        };
      }
      return { ...status(), connected: false, dormant: true, terminal: true, reason: CONTROLLER_UNSUPPORTED_GATEWAY };
    }
    const sessionId = durableSessionId(settings);
    if (!sessionId) {
      lastConnectFailure = { reason: 'missing_session', detail: 'No Hermes session is active.' };
      return { ...status(), connected: false, dormant: true, reason: 'missing_session' };
    }
    if (Number(now()) < nextConnectAt) {
      // A transient failure set a backoff; callers (alarms, status polls) wait it out.
      return {
        ...status(),
        connected: false,
        reason: 'backoff',
        retryAfterMs: Math.max(0, nextConnectAt - Number(now())),
      };
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
        setControlToolFamily(candidate.route === CONTROL_TOOL_FAMILIES.plugin
          ? CONTROL_TOOL_FAMILIES.plugin
          : CONTROL_TOOL_FAMILIES.core);
        lastConnectFailure = null;
        nextConnectAt = 0;
        lifecycle.resetBackoff();
        transportLost = false;
        lifecycle.transition(ControllerTransitionReason.TRANSPORT_REFRESHED);
        registry.touch(controllerId);
        await persist();
        await flushTerminalOutbox(candidate);
        return status();
      } catch (error) {
        if (candidate === activeConnection) activeConnection = null;
        connected = false;
        if (error?.code === CONTROLLER_UNSUPPORTED_GATEWAY) {
          unsupportedRouteKey = controllerRouteKey(settings);
          nextConnectAt = 0;
          lastConnectFailure = {
            reason: CONTROLLER_UNSUPPORTED_GATEWAY,
            detail: String(error?.message || 'This Hermes does not support Hermes Control.').slice(0, 180),
          };
          await persist();
          return {
            ...status(),
            connected: false,
            terminal: true,
            reason: CONTROLLER_UNSUPPORTED_GATEWAY,
            detail: lastConnectFailure.detail,
          };
        }
        if (error?.code === CONTROLLER_SESSION_PENDING) {
          // Not a failure: the chat's first turn creates its session and reconnects then.
          nextConnectAt = Number(now()) + SESSION_PENDING_RETRY_MS;
          lastConnectFailure = {
            reason: CONTROLLER_SESSION_PENDING,
            detail: 'Hermes Control connects once this chat has a Hermes session.',
            retryAfterMs: SESSION_PENDING_RETRY_MS,
          };
          await persist();
          return { ...status(), connected: false, reason: CONTROLLER_SESSION_PENDING, retryAfterMs: SESSION_PENDING_RETRY_MS };
        }
        const retryAfterMs = lifecycle.nextBackoffDelay();
        nextConnectAt = Number(now()) + retryAfterMs;
        lastConnectFailure = {
          reason: 'connect_failed',
          detail: String(error?.message || error || 'Controller connection failed.').slice(0, 180),
          retryAfterMs,
        };
        if (isGatewayAuthRejection(lastConnectFailure.detail) && String(settings.tokenSource || '') === 'pairing') {
          // The gateway refused the credential itself: drop it so the next
          // pairing can mint a fresh one. Never fire on "no credential saved"
          // or on a 403 that was decided after the token authenticated.
          settings = { ...settings, tokenSource: '', lastConnectionTestedAt: 0 };
          settings.apiKey = '';
          const stored = await storageArea.get('hermesBrowserSettings');
          const current = stored?.hermesBrowserSettings && typeof stored.hermesBrowserSettings === 'object'
            ? stored.hermesBrowserSettings
            : {};
          current.tokenSource = '';
          current.lastConnectionTestedAt = 0;
          current.apiKey = '';
          await storageArea.set({ hermesBrowserSettings: current });
        }
        await persist();
        return {
          ...status(),
          connected: false,
          reason: 'connect_failed',
          detail: error?.message || String(error),
          retryAfterMs,
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
        const previousTurnTab = Number(previousWorker?.lastTurnTabId);
        lastTurnTabId = sameDurableRoute && Number.isInteger(previousTurnTab) && previousTurnTab > 0
          ? previousTurnTab
          : 0;
        const previousActionTab = Number(previousWorker?.lastActionTabId);
        lastActionTabId = sameDurableRoute && Number.isInteger(previousActionTab) && previousActionTab > 0
          ? previousActionTab
          : 0;
        unsupportedRouteKey = sameDurableRoute && String(previousWorker?.unsupportedRouteKey || '') === routeKey
          ? routeKey
          : '';
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
    lastTurnTabId = 0;
    lastActionTabId = 0;
    unsupportedRouteKey = '';
    nextConnectAt = 0;
    lastConnectFailure = null;
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
    // Callers without a revision are "latest wins" writers: the background
    // storage.onChanged rebind is one of them. Number(null) is 0, so testing
    // Number.isInteger(Number(revision)) treated a missing revision as revision 0
    // and dropped every storage rebind as stale once any explicit refresh had
    // bumped the counter — a freshly paired token then never reached the socket.
    const hasRevision = revision !== null && revision !== undefined && revision !== ''
      && Number.isInteger(Number(revision));
    const requestedRevision = hasRevision ? Number(revision) : settingsRevision + 1;
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

  // Stage a complete replacement before changing authority. No partial lease set
  // or optimistic preference write may survive a rejected selection.
  async function replaceScopeLeases(message = {}) {
    if (message.expectedGeneration !== generation || message.expectedSettingsRevision !== settingsRevision) {
      return { ok: false, error: 'stale_controller' };
    }
    const kind = message.kind;
    const tabIds = message.tabIds;
    const ownerId = String(message.ownerId || '').trim();
    const taskSetId = kind === TAB_LEASE_KINDS.TASK_SET ? String(message.taskSetId || '').trim() : null;
    if (!KNOWN_LEASE_KINDS.has(kind) || !Array.isArray(tabIds) || !tabIds.length
      || tabIds.length > 32 || tabIds.some((id) => !Number.isInteger(id) || id <= 0)
      || new Set(tabIds).size !== tabIds.length
      || (kind === TAB_LEASE_KINDS.THIS_TAB && tabIds.length !== 1)
      || (kind === TAB_LEASE_KINDS.TASK_SET && (!taskSetId || taskSetId.length > 120))
      || ownerId !== controllerId) return { ok: false, error: 'invalid_scope_request' };
    if (!connected || settings.browserControlEnabled !== true || !browserExecutor) {
      return { ok: false, error: 'controller_unavailable' };
    }
    if (scopeChanging || activeActions.size || lifecycle.pendingCount() || approvals.count()) {
      return { ok: false, error: 'controller_busy' };
    }
    scopeChanging = true;
    try {
      const tabs = [];
      for (const tabId of tabIds) {
        let tab;
        try { tab = await getTab?.(tabId); } catch { /* closed tab */ }
        if (!tab || Number(tab.id) !== tabId) return { ok: false, error: 'tab_unavailable' };
        const eligible = validateBrowserControlUrl(tab.url, { allowLocalFiles: true });
        if (!eligible.ok) return { ok: false, error: eligible.error };
        tabs.push(tab);
      }
      if (!connected || ownerId !== controllerId || settings.browserControlEnabled !== true) {
        return { ok: false, error: 'controller_unavailable' };
      }
      if (activeActions.size || lifecycle.pendingCount() || approvals.count()) return { ok: false, error: 'controller_busy' };
      const previousLeases = leases;
      const previousSettings = settings;
      const previousPausedLeases = pausedLeases;
      const staged = createTabLeaseStore({ now, supportsTabGroups, generation });
      const snapshot = leases.snapshot();
      staged.hydrate(snapshot);
      // The person picks which of their tabs Hermes may use; the tabs Hermes opened itself are not theirs to
      // pick and stay Hermes's, so they are not stranded open with nothing able to use or close them.
      const dropped = [];
      for (const lease of snapshot.entries) {
        if (lease.ownerId === ownerId && lease.ownership === TAB_LEASE_OWNERSHIPS.OWNED) {
          const hermesOpened = lease.kind === TAB_LEASE_KINDS.TASK_SET && lease.taskSetId === HERMES_OPENED_TASK_SET;
          if (hermesOpened && !tabIds.includes(lease.tabId)) continue;
          staged.release({ tabId: lease.tabId, ownerId });
          if (!tabIds.includes(lease.tabId)) dropped.push(lease.tabId);
        }
      }
      const at = Math.max(Number(now()), ...snapshot.entries.map((lease) => lease.acquiredAt + 1));
      for (const tab of tabs) {
        const result = staged.acquire({ tabId: tab.id, windowId: tab.windowId, kind, ownerId,
          ownership: TAB_LEASE_OWNERSHIPS.OWNED, taskSetId, at });
        if (!result.ok) return { ok: false, error: result.error };
      }
      leases = staged;
      settings = { ...settings, browserControlScope: kind };
      const committedSettings = settings;
      pausedLeases = Object.fromEntries(Object.entries(pausedLeases).filter(([id]) => !tabIds.includes(Number(id)) && staged.leaseForTab(Number(id))));
      try {
        // Preferences and the lease snapshot land in one ordered storage write.
        await persist({ includeSettings: true });
      } catch {
        if (leases === staged && settings === committedSettings) {
          leases = previousLeases;
          settings = previousSettings;
          pausedLeases = previousPausedLeases;
          // Flush the rollback after any metadata snapshots queued during the
          // failed write, so none can resurrect the staged attachment set.
          await persist().catch(() => undefined);
        }
        return { ok: false, error: 'scope_persist_failed' };
      }
      // A tab no longer attached lets its debugger go now, as releasing it from the panel does.
      for (const droppedTabId of dropped) releaseDebuggerSession(droppedTabId);
      return { ...status(), scopeChanging: false, scope: kind };
    } finally {
      scopeChanging = false;
    }
  }

  // Lease ended or paused: let the adapter detach its debugger session now
  // instead of waiting for the idle timeout. Best effort, never blocks.
  function stopTurnReads(tabId) {
    const tabIds = tabId === undefined ? [...turnReads.keys()] : [Number(tabId)];
    for (const id of tabIds) {
      for (const read of [...(turnReads.get(id) || [])]) read.abort(new Error('Browser control stopped.'));
    }
  }

  function releaseDebuggerSession(tabId) {
    stopTurnReads(tabId);
    if (typeof releaseTabDebugger !== 'function') return;
    Promise.resolve().then(() => releaseTabDebugger(tabId)).catch(() => undefined);
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
        // A command running on the tab ends with it, so it cannot attach again to finish.
        lifecycle.cancelTab(tabId);
        releaseDebuggerSession(tabId);
        const nextPaused = { ...pausedLeases };
        delete nextPaused[String(tabId)];
        pausedLeases = nextPaused;
      }
    }
    await persist();
    return { ok: true, leases: released };
  }

  async function setPaused(paused) {
    if (paused === true) {
      // Pause is Stop plus a hold: the command that is running, or waiting for an approval, ends now. Releasing
      // the debugger alone left it to attach again and carry on.
      stopTurnReads();
      lifecycle.cancelAll();
    }
    settings = { ...settings, browserControlPaused: paused === true };
    await storageArea.set({ hermesBrowserSettings: { ...settings } });
    await persist();
    if (paused === true) {
      for (const tabId of leases.leasedTabIds()) releaseDebuggerSession(tabId);
    }
    return { ...status(), paused: settings.browserControlPaused };
  }

  async function stopCommands() {
    stopTurnReads();
    const stopped = lifecycle.cancelAll();
    await persist();
    return { ...stopped, pendingCommands: lifecycle.pendingCount() };
  }

  async function detachControl() {
    stopTurnReads();
    const stopped = lifecycle.cancelAll();
    const releasedTabIds = [];
    for (const tabId of leases.leasedTabIds()) {
      const lease = leases.leaseForTab(tabId);
      if (lease?.ownership !== TAB_LEASE_OWNERSHIPS.OWNED || lease.ownerId !== controllerId) continue;
      if (leases.release({ tabId, ownerId: controllerId }).ok) {
        releasedTabIds.push(tabId);
        releaseDebuggerSession(tabId);
      }
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
    const current = Number(documentGenerations[key] || 0);
    if (seededGenerations.delete(key) && current > 0) {
      // The page reporting the document the worker already gave a generation to: no new document.
      return { ok: true, tabId, frameId, documentGeneration: current };
    }
    const next = current + 1;
    documentGenerations = { ...documentGenerations, [key]: next };
    const entries = Object.entries(documentGenerations).slice(-CONTROLLER_MAX_DOCUMENT_GENERATIONS);
    documentGenerations = Object.fromEntries(entries);
    await persist();
    return { ok: true, tabId, frameId, documentGeneration: next };
  }

  function grantApproval(message = {}) {
    const tabId = Number(message.tabId);
    const documentGeneration = Number(message.documentGeneration);
    // Nothing is approved while control is paused: the command it was for has ended, and a new one asks again.
    if (settings?.browserControlPaused === true || pausedLeases[String(tabId)]) {
      return { ok: false, error: 'controller_paused' };
    }
    const lease = leases.leaseForTab(tabId);
    const requestedFrame = Number.isInteger(Number(message.frameId)) ? Number(message.frameId) : 0;
    const authoritative = Number(documentGenerations[frameKey(tabId, requestedFrame)] || 0);
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
      || (pending.frameId ?? 0) !== requestedFrame
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
      seedDocumentGeneration(tabId, frameId);
      documentGeneration = 1;
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

  // Page view for the turn's first action. The refs in it are minted by the
  // same snapshot path browser_snapshot uses, under the tab's current document
  // generation, so the model's first browser_click can use them directly.
  // Every failure only omits the view; the turn goes on without it.
  async function collectTurnSnapshot(target) {
    if (!browserExecutor) return { reason: 'executor_unavailable' };
    // Firefox has no debugger session; only Chromium reads the page this way.
    if (normalizedProduct.engine !== 'chromium') return { reason: 'unsupported_browser' };
    if (scopeChanging || activeActions.size || lifecycle.pendingCount() || approvals.count()) {
      return { reason: 'controller_busy' };
    }
    const allowLocalDocuments = settings?.allowLocalDocuments === true;
    if (classifyBrowserControlAction({
      action: 'browser_snapshot', currentUrl: target.url, allowLocalDocuments,
    }).risk === BROWSER_CONTROL_RISKS.BLOCKED) {
      return { reason: 'restricted_page' };
    }
    const lease = leases.leaseForTab(target.tabId);
    if (!lease) return { reason: 'lease_required' };
    const frame = {
      command_id: `prepare-turn-${Number(now())}`,
      action: 'browser_snapshot',
      tab_id: target.tabId,
      frame_id: target.frameId,
      document_generation: target.documentGeneration,
      arguments: { full: false },
      deadline_at: Number(now()) + PREPARE_TURN_SNAPSHOT_MS,
    };
    const abort = new AbortController();
    const reads = turnReads.get(target.tabId) || new Set();
    reads.add(abort);
    turnReads.set(target.tabId, reads);
    let backstop = null;
    try {
      const outcome = await Promise.race([
        Promise.resolve(browserExecutor(frame, executorContext({
          signal: abort.signal,
          snapshotBudget: 'turn',
        }, {
          lease,
          tabId: target.tabId,
          frameId: target.frameId,
          authoritative: target.documentGeneration,
        }))),
        new Promise((resolve) => {
          backstop = setTimeout(() => resolve({ ok: false, error: { code: 'snapshot_timeout' } }), PREPARE_TURN_BACKSTOP_MS);
        }),
      ]);
      if (!outcome?.ok) return { reason: String(outcome?.error?.code || 'snapshot_failed').slice(0, 80) };
      const view = outcome.result || {};
      const text = String(view.text || '');
      if (!text) return { reason: 'snapshot_empty' };
      return {
        snapshot: {
          title: String(view.title || ''),
          text,
          truncated: view.truncated === true,
          elementCount: Math.max(0, Number(view.element_count) || 0),
        },
      };
    } catch {
      return { reason: 'snapshot_failed' };
    } finally {
      clearTimeout(backstop);
      abort.abort();
      reads.delete(abort);
      if (!reads.size && turnReads.get(target.tabId) === reads) turnReads.delete(target.tabId);
    }
  }

  const PREPARE_TURN_MESSAGES = Object.freeze({
    controller_unavailable: 'Hermes Control is not connected right now. Ask the user to check Hermes Control in the Hermes panel, then try again.',
    lease_required: 'This tab is not attached to Hermes Control. Ask the user to press Attach this tab in the Hermes panel.',
    lease_not_owned: 'This tab is not attached to Hermes Control. Ask the user to press Attach this tab in the Hermes panel.',
  });

  // Resolves the turn's exact target and, when control is attached and ready,
  // the page view the model can act on straight away. Also records the tab as
  // the default target for commands that name none.
  async function prepareTurn(message = {}) {
    if (!connected && lastConnectFailure?.reason === CONTROLLER_SESSION_PENDING) {
      // The panel created this chat's Hermes session just before this turn: connect now, so the
      // chat's first turn can already use control.
      nextConnectAt = 0;
      await Promise.race([
        reconcile({ reason: 'turn-session-ready' }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, PREPARE_TURN_CONNECT_MS)),
      ]);
    }
    const resolved = await resolveControlTarget(message);
    if (!resolved.ok) {
      const hint = PREPARE_TURN_MESSAGES[resolved.reason];
      return hint ? { ...resolved, message: hint } : resolved;
    }
    if (settings?.browserControlPaused === true) {
      return unavailableControlTarget('controller_paused', 'Browser control is paused. Ask the user to resume it in the Hermes panel.');
    }
    if (pausedLeases[String(resolved.tabId)]) {
      return unavailableControlTarget('debugger_detached', 'Browser control stopped on this tab because the debugger was detached. Ask the user to attach the tab again in the Hermes panel.');
    }
    if (lastTurnTabId !== resolved.tabId) {
      lastTurnTabId = resolved.tabId;
      await persist();
    }
    const view = await collectTurnSnapshot(resolved);
    return {
      ...resolved,
      state: 'ready',
      ...(view.snapshot ? { controlSnapshot: view.snapshot } : { controlSnapshotOmitted: view.reason }),
    };
  }

  async function handleTabUpdated(tabId, changeInfo = {}) {
    await boot();
    const normalizedTabId = Number(tabId);
    if (!Number.isInteger(normalizedTabId) || normalizedTabId <= 0) return { ok: false, error: 'invalid_tab' };
    if (changeInfo?.status !== 'loading' && !Object.hasOwn(changeInfo || {}, 'url')) return { ok: true, changed: false };
    // A navigation: the page's next report is a new document, never the seeded one confirmed.
    forgetSeededGenerations(normalizedTabId);
    let changed = false;
    documentGenerations = Object.fromEntries(Object.entries(documentGenerations).map(([key, value]) => {
      if (!key.startsWith(`${normalizedTabId}:`)) return [key, value];
      changed = true;
      return [key, Number(value) + 1];
    }));
    if (changed) await persist();
    return { ok: true, changed };
  }

  // A tab that opens from a tab Hermes acts in is never attached by itself. Hermes's own click and the person's
  // reach the browser the same way (both are trusted input, at the same moment), so nothing here can say whose
  // the new tab is, and a tab the person opened must not become one Hermes controls. The action running then
  // only learns that a tab opened, with no address or id, so the model can ask the person to attach it.
  async function handleTabCreated(tab = {}) {
    await boot();
    const tabId = Number(tab?.id);
    const openerTabId = Number(tab?.openerTabId);
    if (!Number.isInteger(tabId) || tabId <= 0 || !Number.isInteger(openerTabId) || openerTabId <= 0) {
      return { ok: true, adopted: false };
    }
    if (settings?.browserControlEnabled !== true || settings?.browserControlPaused === true) {
      return { ok: true, adopted: false };
    }
    // Only an action that can open a tab hears of one; a snapshot, screenshot or scroll never does.
    const openers = [...activeActions].filter((running) => running.opensTab);
    const opener = leases.leaseForTab(openerTabId);
    if (!openers.length || leases.leaseForTab(tabId) || !opener || opener.generation !== generation
      || opener.ownership !== TAB_LEASE_OWNERSHIPS.OWNED || opener.ownerId !== controllerId) {
      return { ok: true, adopted: false };
    }
    // The action running in the opener's tab, else the latest to start: Chrome names the tab in front as the
    // opener of a link clicked in a background tab, so the opener alone does not always say whose it is.
    const claiming = openers.find((running) => running.tabId === openerTabId) || openers.at(-1);
    claiming.openedTabs += 1;
    return { ok: true, adopted: false, reported: true };
  }

  async function handleTabRemoved(tabId) {
    stopTurnReads(tabId);
    await boot();
    const normalizedTabId = Number(tabId);
    if (!Number.isInteger(normalizedTabId) || normalizedTabId <= 0) return { ok: false, error: 'invalid_tab' };
    forgetSeededGenerations(normalizedTabId);
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
    const turnTabRemoved = lastTurnTabId === normalizedTabId;
    if (turnTabRemoved) lastTurnTabId = 0;
    const actionTabRemoved = lastActionTabId === normalizedTabId;
    if (actionTabRemoved) lastActionTabId = 0;
    if (documentChanged || leaseRemoved || pauseRemoved || turnTabRemoved || actionTabRemoved) await persist();
    return { ok: true, documentChanged, leaseRemoved, pauseRemoved };
  }

  async function handleDebuggerDetach({ tabId, reason = 'unknown' } = {}) {
    // First and synchronously: the adapter reports a detach and the person's choice is already made, so a page
    // read in flight must not get another command in before boot() resolves.
    stopTurnReads(tabId);
    await boot();
    const normalizedTabId = Number(tabId);
    const normalizedReason = String(reason || 'unknown').trim().slice(0, 120) || 'unknown';
    if (!Number.isInteger(normalizedTabId) || normalizedTabId <= 0) return { ok: false, error: 'invalid_tab' };
    // The tab closing because Hermes's own close is running on it: that close keeps its result.
    const closing = normalizedReason === 'target_closed'
      ? [...activeActions].find((running) => running.closingTabId === normalizedTabId)?.commandId || ''
      : '';
    const cancelled = lifecycle.cancelTab(normalizedTabId, { except: closing }).cancelled;
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
      const unsupported = Boolean(unsupportedRouteKey) && unsupportedRouteKey === controllerRouteKey(settings);
      if (enabled && !unsupported && !current.connected && !connecting && Boolean(durableSessionId(settings))
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
    if (type === CONTROLLER_WORKER_MESSAGES.scopeReplace) return runTransition(() => replaceScopeLeases(message));
    if (scopeChanging && [CONTROLLER_WORKER_MESSAGES.leaseAcquire, CONTROLLER_WORKER_MESSAGES.leaseRelease,
      CONTROLLER_WORKER_MESSAGES.pause, CONTROLLER_WORKER_MESSAGES.resume,
      CONTROLLER_WORKER_MESSAGES.approvalGrant, CONTROLLER_WORKER_MESSAGES.approvalReject].includes(type)) {
      return { ok: false, error: 'controller_busy' };
    }
    if (type === CONTROLLER_WORKER_MESSAGES.leaseAcquire) return acquireLeases(message);
    if (type === CONTROLLER_WORKER_MESSAGES.leaseRelease) return releaseLeases(message);
    if (type === CONTROLLER_WORKER_MESSAGES.targetResolve) return resolveControlTarget(message);
    if (type === CONTROLLER_WORKER_MESSAGES.prepareTurn) return prepareTurn(message);
    if (type === CONTROLLER_WORKER_MESSAGES.approvalGrant) return grantApproval(message);
    if (type === CONTROLLER_WORKER_MESSAGES.approvalReject) return rejectApproval(message);
    if (type === CONTROLLER_WORKER_MESSAGES.pause) return setPaused(true);
    if (type === CONTROLLER_WORKER_MESSAGES.resume) return setPaused(false);
    if (type === CONTROLLER_WORKER_MESSAGES.stop) return stopCommands();
    if (type === CONTROLLER_WORKER_MESSAGES.detach) return runTransition(detachControl);
    return { ok: false, error: 'unknown_message' };
  }

  return {
    boot,
    reconcile,
    syncSettings,
    handleMessage,
    handleTabUpdated,
    handleTabCreated,
    handleTabRemoved,
    handleDebuggerDetach,
    status,
  };
}
