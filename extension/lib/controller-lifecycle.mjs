/**
 * Phase 5 — controller lifecycle (pure module).
 *
 * Service-worker-safe command orchestration for the (still disabled)
 * controller runtime:
 *  - bounded exponential backoff for reconnect attempts;
 *  - heartbeat/reconcile alarm hooks that are dormant until a controller
 *    identity exists (fail closed);
 *  - persistent replay tombstones: a command id that reached a terminal state
 *    can never execute again, even across service-worker restarts;
 *  - per-tab ordered queues: one queue per tab, head executes first, FIFO;
 *  - cancel-head: cancelling aborts only the executing head of a tab queue;
 *  - stale generation rejection: frames from an older controller/document
 *    generation are rejected terminally and never queued or executed;
 *  - restart terminalization: a service-worker restart terminalizes every
 *    pending command with `restarted` and clears all queues;
 *  - every real browser action stays disabled; only `controller.noop` echoes.
 *
 * Pure module: no browser APIs; `now` is injectable for tests. Persisted
 * state is bounded, versioned, and fails closed on corrupt input.
 */

import { CONTROLLER_NOOP_CAPABILITY } from './controller-protocol.mjs';

export const CONTROLLER_LIFECYCLE_VERSION = 1;
export const CONTROLLER_LIFECYCLE_STORAGE_KEY = 'hermesBrowserControllerLifecycle';
export const CONTROLLER_HEARTBEAT_ALARM = 'hermesBrowserControllerHeartbeat';
export const CONTROLLER_RECONCILE_ALARM = 'hermesBrowserControllerReconcile';
export const CONTROLLER_MIN_BACKOFF_MS = 1_000;
export const CONTROLLER_MAX_BACKOFF_MS = 60_000;
export const CONTROLLER_MAX_REPLAY_TOMBSTONES = 512;
export const CONTROLLER_MAX_COMMANDS_PER_TAB = 64;
export const ControllerTransitionReason = Object.freeze({
  TRANSPORT_LOST: 'transport-lost',
  TRANSPORT_REFRESHED: 'transport-refreshed',
  USER_STOP: 'user-stop',
  USER_DETACH: 'user-detach',
  IDENTITY_REPLACED: 'identity-replaced',
  SETTINGS_REPLACED: 'settings-replaced',
  DEBUGGER_DETACHED: 'debugger-detached',
});

/** Default Phase 5 executor: noop echoes; every real action is disabled. */
function defaultExecute(frame = {}, { signal } = {}) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Command cancelled.'));
  }
  if (frame?.action === CONTROLLER_NOOP_CAPABILITY) {
    const args = frame.arguments && typeof frame.arguments === 'object' ? { ...frame.arguments } : {};
    return Promise.resolve({ ok: true, result: args });
  }
  return Promise.resolve({
    ok: false,
    error: {
      code: 'action_disabled',
      message: `Real browser control is disabled in Phase 5: ${String(frame?.action || '')}`,
    },
  });
}

function normalizeFrame(frame = {}) {
  const commandId = String(frame.command_id || '').trim();
  const action = typeof frame.action === 'string' ? frame.action : '';
  const args = frame.arguments && typeof frame.arguments === 'object' ? frame.arguments : {};
  if (!commandId) return null;
  return { command_id: commandId, action, arguments: args, ...frame };
}

function pendingMetadata(entry = {}) {
  const frame = entry.frame || {};
  const metadata = entry.metadata || {};
  return {
    commandId: entry.commandId,
    action: String(frame.action || '').trim(),
    controllerId: String(metadata.controllerId || '').trim(),
    browserProfileId: String(metadata.browserProfileId || '').trim(),
    leaseId: String(metadata.leaseId || '').trim(),
    leaseGeneration: Number(metadata.leaseGeneration),
    tabId: entry.tabId,
    frameId: Math.max(0, Number(frame.frame_id) || 0),
    documentGeneration: Number(frame.document_generation),
    deadlineAt: Number(frame.deadline_at) || 0,
    phase: entry.controller ? 'executing' : 'queued',
    terminalStatus: entry.terminal ? 'terminal' : 'open',
  };
}

function normalizePendingMetadata(entry = {}) {
  const legacyCommandId = String(entry.commandId || '').trim();
  const legacyTabId = Number(entry.tabId);
  const legacyGeneration = Number(entry.generation);
  const normalized = {
    commandId: legacyCommandId,
    action: String(entry.action || '').trim(),
    controllerId: String(entry.controllerId || '').trim(),
    browserProfileId: String(entry.browserProfileId || '').trim(),
    leaseId: String(entry.leaseId || '').trim(),
    leaseGeneration: Number(entry.leaseGeneration),
    tabId: Number(entry.tabId),
    frameId: Math.max(0, Number(entry.frameId) || 0),
    documentGeneration: Number(entry.documentGeneration),
    deadlineAt: Number(entry.deadlineAt) || 0,
    phase: ['queued', 'executing', 'approval-paused'].includes(entry.phase) ? entry.phase : '',
    terminalStatus: entry.terminalStatus === 'open' ? 'open' : '',
  };
  if (!normalized.commandId || !normalized.action || !normalized.controllerId
    || !normalized.browserProfileId || !normalized.leaseId
    || !Number.isInteger(normalized.leaseGeneration) || normalized.leaseGeneration < 1
    || !Number.isInteger(normalized.tabId) || normalized.tabId <= 0
    || !Number.isInteger(normalized.documentGeneration) || normalized.documentGeneration < 1
    || !normalized.phase || !normalized.terminalStatus) {
    // Phase 5 wrote only command/tab/generation. Accept that shape only while
    // hydrating so boot can terminalize it; new snapshots never emit it.
    if (legacyCommandId && Number.isInteger(legacyTabId) && legacyTabId > 0
      && Number.isInteger(legacyGeneration) && legacyGeneration >= 1) {
      return { commandId: legacyCommandId, tabId: legacyTabId, generation: legacyGeneration };
    }
    return null;
  }
  return normalized;
}

/**
 * Create a controller lifecycle.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] - current epoch ms
 * @param {(frame: object, context: { signal: AbortSignal }) => Promise<object>} [options.execute]
 * @param {(terminal: object) => void} [options.onTerminal] - observes terminal results
 * @param {number} [options.minBackoffMs]
 * @param {number} [options.maxBackoffMs]
 * @param {number} [options.maxTombstones]
 * @param {number} [options.maxCommandsPerTab]
 */
export function createControllerLifecycle({
  now = Date.now,
  execute = defaultExecute,
  onTerminal: terminalObserver = () => {},
  minBackoffMs = CONTROLLER_MIN_BACKOFF_MS,
  maxBackoffMs = CONTROLLER_MAX_BACKOFF_MS,
  maxTombstones = CONTROLLER_MAX_REPLAY_TOMBSTONES,
  maxCommandsPerTab = CONTROLLER_MAX_COMMANDS_PER_TAB,
} = {}) {
  let generation = 1;
  let backoffAttempts = 0;
  let lastHeartbeatAt = 0;
  /** @type {Set<string>} */
  const replayTombstones = new Set();
  /** @type {Map<number, { head: object|null, tail: object[] }>} */
  const perTabQueues = new Map();
  /** @type {Map<string, object>} */
  const pending = new Map();
  /** @type {Array<(terminal: object) => void>} */
  const terminalHandlers = [];
  if (typeof terminalObserver === 'function') terminalHandlers.push(terminalObserver);

  function onTerminal(handler) {
    if (typeof handler === 'function') terminalHandlers.push(handler);
    return () => {
      const index = terminalHandlers.indexOf(handler);
      if (index >= 0) terminalHandlers.splice(index, 1);
    };
  }

  function rememberTerminal(commandId) {
    replayTombstones.add(commandId);
    while (replayTombstones.size > maxTombstones) {
      replayTombstones.delete(replayTombstones.values().next().value);
    }
  }

  function isReplay(commandId) {
    return replayTombstones.has(String(commandId || '').trim());
  }

  function tombstoneCount() {
    return replayTombstones.size;
  }

  function queueDepth(tabId) {
    const queue = perTabQueues.get(Number(tabId));
    if (!queue) return 0;
    return (queue.head ? 1 : 0) + queue.tail.length;
  }

  function pendingCount() {
    return pending.size;
  }

  function hasPending(commandId) {
    return pending.has(String(commandId || '').trim());
  }

  function terminalParams(entry, outcome) {
    return {
      command_id: entry.commandId,
      tab_id: entry.tabId,
      ...outcome,
    };
  }

  function terminalize(entry, outcome) {
    if (entry.terminal) return;
    entry.terminal = true;
    rememberTerminal(entry.commandId);
    pending.delete(entry.commandId);
    const terminal = { commandId: entry.commandId, tabId: entry.tabId, params: terminalParams(entry, outcome) };
    for (const handler of terminalHandlers) {
      try {
        handler(terminal);
      } catch {
        // Terminal observation must never destabilize the lifecycle.
      }
    }
  }

  function promoteHead(tabId) {
    const queue = perTabQueues.get(tabId);
    if (!queue) return;
    if (queue.head) return;
    const next = queue.tail.shift();
    if (!next) {
      if (queue.head === null && queue.tail.length === 0) perTabQueues.delete(tabId);
      return;
    }
    queue.head = next;
    void runHead(tabId, next);
  }

  async function runHead(tabId, entry) {
    const controller = new AbortController();
    entry.controller = controller;
    let settleCancellation;
    const cancellation = new Promise((resolve) => {
      settleCancellation = () => resolve({ cancelled: true });
    });
    entry.settleCancellation = settleCancellation;

    const execution = Promise.resolve()
      .then(() => entry.executor(entry.frame, { signal: controller.signal, command_id: entry.commandId, tab_id: tabId }))
      .then(
        (result) => ({ outcome: result && typeof result === 'object' ? result : { ok: true, result } }),
        (error) => ({
          outcome: {
            ok: false,
            error: { code: 'command_error', message: error?.message ? error.message : 'Command failed.' },
          },
        }),
      );
    const completion = await Promise.race([execution, cancellation]);
    const queue = perTabQueues.get(tabId);
    if (queue?.head === entry) queue.head = null;
    if (completion?.cancelled || controller.signal.aborted) {
      terminalize(entry, { ok: false, error: { code: 'cancelled', message: 'Command cancelled.' } });
    } else {
      terminalize(entry, completion.outcome);
    }
    promoteHead(tabId);
  }

  /**
   * Queue one command for a tab. Returns the queue position or a terminal
   * rejection ({ ok: false, error }) for stale generations, replays,
   * duplicates, or a full queue.
   */
  function enqueueCommand({
    frame,
    tabId,
    ownerGeneration = generation,
    execute: executeOverride,
    metadata = {},
  } = {}) {
    const normalizedFrame = normalizeFrame(frame);
    const normalizedTabId = Number(tabId);
    if (!normalizedFrame) return { ok: false, error: 'invalid_command' };
    if (!Number.isInteger(normalizedTabId) || normalizedTabId <= 0) return { ok: false, error: 'invalid_tab' };
    if (Number(ownerGeneration) !== generation) return { ok: false, error: 'stale_generation' };
    if (isReplay(normalizedFrame.command_id)) return { ok: false, error: 'duplicate_command' };
    if (pending.has(normalizedFrame.command_id)) return { ok: false, error: 'duplicate_command' };

    if (!perTabQueues.has(normalizedTabId)) perTabQueues.set(normalizedTabId, { head: null, tail: [] });
    const queue = perTabQueues.get(normalizedTabId);
    if (queue.tail.length >= maxCommandsPerTab) return { ok: false, error: 'queue_full' };

    const entry = {
      commandId: normalizedFrame.command_id,
      tabId: normalizedTabId,
      frame: normalizedFrame,
      generation,
      metadata: metadata && typeof metadata === 'object' ? { ...metadata } : {},
      terminal: false,
      controller: null,
      settleCancellation: null,
      executor: typeof executeOverride === 'function' ? executeOverride : execute,
    };
    pending.set(entry.commandId, entry);

    if (!queue.head) {
      queue.head = entry;
      void runHead(normalizedTabId, entry);
      return { ok: true, position: 0 };
    }
    queue.tail.push(entry);
    return { ok: true, position: queue.tail.length };
  }

  /** Cancel only the executing head of a tab queue. */
  function cancelHead(tabId) {
    const queue = perTabQueues.get(Number(tabId));
    if (!queue?.head) return { ok: false, error: 'nothing-in-flight' };
    const entry = queue.head;
    try {
      entry.controller?.abort(new Error('Command cancelled.'));
    } catch {
      /* ignore */
    }
    entry.settleCancellation?.();
    return { ok: true, commandId: entry.commandId };
  }

  /** Cancel the exact matching command, whether executing or still queued. */
  function cancelCommand(commandId) {
    const normalizedCommandId = String(commandId || '').trim();
    const entry = pending.get(normalizedCommandId);
    if (!entry) return { ok: false, error: 'not-pending' };
    const queue = perTabQueues.get(entry.tabId);
    if (queue?.head === entry) return cancelHead(entry.tabId);
    const index = queue?.tail?.indexOf(entry) ?? -1;
    if (index < 0) return { ok: false, error: 'not-pending' };
    queue.tail.splice(index, 1);
    terminalize(entry, { ok: false, error: { code: 'cancelled', message: 'Command cancelled.' } });
    if (!queue.head && queue.tail.length === 0) perTabQueues.delete(entry.tabId);
    return { ok: true, commandId: entry.commandId };
  }

  /** Cancel every executing and queued command without advancing generation. */
  function cancelAll() {
    const commandIds = [...pending.keys()];
    for (const commandId of commandIds) cancelCommand(commandId);
    return { ok: true, cancelled: commandIds.length };
  }

  function cancelTab(tabId) {
    const normalizedTabId = Number(tabId);
    const commandIds = [...pending.values()]
      .filter((entry) => entry.tabId === normalizedTabId)
      .map((entry) => entry.commandId);
    for (const commandId of commandIds) cancelCommand(commandId);
    return { ok: true, tabId: normalizedTabId, cancelled: commandIds.length };
  }

  /** Terminalize every pending command and clear all queues (restart). */
  function restart() {
    generation += 1;
    const entries = [...pending.values()];
    for (const entry of entries) {
      try {
        entry.controller?.abort(new Error('Lifecycle restarted.'));
      } catch {
        /* ignore */
      }
      entry.settleCancellation?.();
      terminalize(entry, { ok: false, error: { code: 'restarted', message: 'Controller lifecycle restarted.' } });
    }
    perTabQueues.clear();
    pending.clear();
    return generation;
  }

  /**
   * Dispatch an inbound controller frame. Frames from a stale generation are
   * rejected terminally; commands queue per tab; cancels hit only the head.
   */
  function handleInboundFrame({ frame, tabId, frameGeneration = generation, metadata = {} } = {}) {
    if (Number(frameGeneration) !== generation) {
      return { ok: false, error: 'stale_generation' };
    }
    if (frame?.method === 'browser.controller.cancel') {
      const commandId = String(frame?.params?.command_id || '').trim();
      return commandId ? cancelCommand(commandId) : cancelHead(tabId ?? frame?.params?.tab_id);
    }
    return enqueueCommand({
      frame: frame?.params ?? frame,
      tabId,
      ownerGeneration: generation,
      metadata,
    });
  }

  function nextBackoffDelay() {
    const delay = Math.min(
      Math.max(1, Number(minBackoffMs) || 1) * (2 ** Math.max(0, backoffAttempts)),
      Math.max(1, Number(maxBackoffMs) || 1),
    );
    backoffAttempts += 1;
    return Math.round(delay);
  }

  function resetBackoff() {
    backoffAttempts = 0;
  }

  function markHeartbeat({ at = Number(now()) } = {}) {
    lastHeartbeatAt = Number(at);
  }

  /** Reconcile is intentionally dormant until a controller identity exists. */
  function reconcile() {
    return { ok: true, dormant: true, pending: pending.size };
  }

  function transition(reason) {
    if (reason === ControllerTransitionReason.TRANSPORT_LOST) {
      return { ok: true, reason, generation, pending: pending.size, terminal: false };
    }
    if (reason === ControllerTransitionReason.TRANSPORT_REFRESHED) {
      resetBackoff();
      return { ok: true, reason, generation, pending: pending.size, terminal: false };
    }
    return { ok: false, error: 'unsupported_transition' };
  }

  function snapshot() {
    return {
      version: CONTROLLER_LIFECYCLE_VERSION,
      generation,
      backoffAttempts,
      lastHeartbeatAt,
      tombstones: [...replayTombstones].slice(-maxTombstones),
      pending: [...pending.values()]
        .slice(0, Math.max(1, Number(maxCommandsPerTab) || CONTROLLER_MAX_COMMANDS_PER_TAB))
        .map(pendingMetadata),
    };
  }

  function hydrate(raw) {
    if (!raw || typeof raw !== 'object') return [];
    if (Number(raw.version) !== CONTROLLER_LIFECYCLE_VERSION) return [];
    if (!Array.isArray(raw.tombstones)) return [];
    const restored = raw.tombstones
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
      .slice(-maxTombstones);
    for (const commandId of restored) replayTombstones.add(commandId);
    while (replayTombstones.size > maxTombstones) {
      replayTombstones.delete(replayTombstones.values().next().value);
    }
    const recoveredPending = Array.isArray(raw.pending)
      ? raw.pending
        .map(normalizePendingMetadata)
        .filter(Boolean)
        .slice(0, Math.max(1, Number(maxCommandsPerTab) || CONTROLLER_MAX_COMMANDS_PER_TAB))
      : [];
    for (const entry of recoveredPending) rememberTerminal(entry.commandId);
    const restoredGeneration = Number(raw.generation);
    if (Number.isInteger(restoredGeneration) && restoredGeneration >= 1) generation = restoredGeneration;
    const restoredAttempts = Number(raw.backoffAttempts);
    if (Number.isInteger(restoredAttempts) && restoredAttempts >= 0) backoffAttempts = restoredAttempts;
    return { tombstones: restored, pending: recoveredPending };
  }

  return {
    enqueueCommand,
    cancelHead,
    cancelCommand,
    cancelAll,
    cancelTab,
    handleInboundFrame,
    restart,
    rememberTerminal,
    isReplay,
    tombstoneCount,
    queueDepth,
    pendingCount,
    hasPending,
    nextBackoffDelay,
    resetBackoff,
    markHeartbeat,
    reconcile,
    transition,
    onTerminal,
    snapshot,
    hydrate,
  };
}
