/**
 * Phase 4 — Disabled controller command runtime.
 *
 * Executes the controller protocol's command/cancel/result frames with a
 * no-op-only capability surface:
 *  - `controller.noop` echoes its arguments (or defers to a custom executor).
 *  - Every real browser action returns `action_disabled`.
 *  - Cancellation aborts only the matching in-flight command via its
 *    AbortController and reports exactly one terminal result.
 *
 * No UI or manifest wiring in Phase 4.
 */

import { CONTROLLER_METHODS, CONTROLLER_NOOP_CAPABILITY } from './controller-protocol.mjs';

const ERROR_CODE_CANCELLED = 'cancelled';
const ERROR_CODE_ACTION_DISABLED = 'action_disabled';
const ERROR_CODE_COMMAND_ERROR = 'command_error';

/** Default no-op executor: echo the command arguments back as the result. */
async function defaultNoopExecutor({ arguments: args }) {
  return args && typeof args === 'object' ? { ...args } : {};
}

/**
 * Create a Phase 4 controller command runtime.
 *
 * @param {object} [options]
 * @param {(frame: object) => Promise<void>} [options.send] - delivers outgoing result frames
 * @param {(error: unknown, frame: object) => void} [options.onSendError] - observes contained delivery failures
 * @param {(invocation: { signal: AbortSignal, command_id: string, arguments: object }) => Promise<object>} [options.executeNoop]
 *   custom executor for `controller.noop` commands; receives the command's AbortSignal
 * @returns {{
 *   handleFrame: (frame: object) => Promise<unknown>,
 *   capabilities: () => string[],
 *   pendingCount: () => number,
 * }}
 */
export function createControllerCommandRuntime({ send, executeNoop, sessionId, onSendError } = {}) {
  const sendFrame = typeof send === 'function' ? send : async () => {};
  const reportSendError = typeof onSendError === 'function' ? onSendError : () => {};
  const executeNoopFrame = typeof executeNoop === 'function' ? executeNoop : defaultNoopExecutor;
  const expectedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';

  /** @type {Map<string, { controller: AbortController, task: Promise<unknown> }>} */
  const pending = new Map();
  // Bounded at-most-once tombstones. A terminal result whose socket write
  // fails must not make the same command id executable again later.
  const seenCommandIds = new Set();
  const maxSeenCommandIds = 512;

  function resultParams(params) {
    return expectedSessionId ? { ...params, session_id: expectedSessionId } : params;
  }

  async function deliver(frame) {
    try {
      await sendFrame(frame);
    } catch (error) {
      try {
        reportSendError(error, frame);
      } catch {
        // Delivery observation must never destabilize the controller runtime.
      }
    }
  }

  function rememberCommandId(commandId) {
    seenCommandIds.add(commandId);
    while (seenCommandIds.size > maxSeenCommandIds) {
      seenCommandIds.delete(seenCommandIds.values().next().value);
    }
  }

  async function runCommand(params = {}) {
    const commandId = typeof params.command_id === 'string' ? params.command_id.trim() : '';
    const action = params.action;
    const args = params.arguments ?? {};

    if (!commandId) {
      await deliver({
        method: CONTROLLER_METHODS.result,
        params: resultParams({
          command_id: '',
          ok: false,
          error: { code: 'invalid_command', message: 'Controller command id is required.' },
        }),
      });
      return undefined;
    }
    if (pending.has(commandId) || seenCommandIds.has(commandId)) {
      await deliver({
        method: CONTROLLER_METHODS.result,
        params: resultParams({
          command_id: commandId,
          ok: false,
          error: { code: 'duplicate_command', message: 'Controller command id is already in flight.' },
        }),
      });
      return undefined;
    }

    const controller = new AbortController();
    let settled = false;
    let settleCancellation;
    const cancellation = new Promise((resolve) => {
      settleCancellation = () => resolve({ cancelled: true });
    });
    const entry = { controller, task: null, settleCancellation };
    rememberCommandId(commandId);
    pending.set(commandId, entry);

    const task = (async () => {
      let outcome;
      if (action === CONTROLLER_NOOP_CAPABILITY) {
        const execution = Promise.resolve()
          .then(() => executeNoopFrame({
            signal: controller.signal,
            command_id: commandId,
            arguments: args,
          }))
          .then(
            (result) => ({ result }),
            (error) => ({ error }),
          );
        const completion = await Promise.race([execution, cancellation]);
        if (completion.cancelled || controller.signal.aborted) {
          outcome = { ok: false, error: { code: ERROR_CODE_CANCELLED, message: 'Command cancelled.' } };
        } else if ('error' in completion) {
          const { error } = completion;
          outcome = {
            ok: false,
            error: {
              code: ERROR_CODE_COMMAND_ERROR,
              message: error && error.message ? error.message : 'Command failed.',
            },
          };
        } else {
          outcome = { ok: true, result: completion.result ?? {} };
        }
      } else {
        outcome = {
          ok: false,
          error: {
            code: ERROR_CODE_ACTION_DISABLED,
            message: `Real browser control is disabled in Phase 4: ${String(action || '')}`,
          },
        };
      }

      if (settled) return;
      settled = true;
      try {
        await deliver({
          method: CONTROLLER_METHODS.result,
          params: resultParams({ command_id: commandId, ...outcome }),
        });
      } finally {
        if (pending.get(commandId) === entry) pending.delete(commandId);
      }
    })();

    entry.task = task;
    return task;
  }

  function cancelCommand(commandId) {
    const entry = pending.get(commandId);
    if (!entry) return;
    entry.controller.abort(new Error('Command cancelled.'));
    entry.settleCancellation();
  }

  /**
   * Dispatch an inbound controller frame.
   * Commands run to a single terminal result; cancels abort only the matching
   * in-flight command. Unknown frames are ignored.
   */
  async function handleFrame(frame = {}) {
    let { method, params = {} } = frame;
    // Cloud/dashboard connections carry controller traffic as ordinary Gateway
    // events. Local/VPS dedicated sockets carry the protocol method directly.
    // Normalize both into the same command runtime without widening actions.
    if (method === 'event' && params && typeof params === 'object') {
      const eventType = params.type;
      if (eventType === CONTROLLER_METHODS.command || eventType === CONTROLLER_METHODS.cancel) {
        const rawSessionId = params.session_id ?? params.sessionId;
        const eventSessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
        if (!expectedSessionId || eventSessionId !== expectedSessionId) return undefined;
        method = eventType;
        params = params.payload && typeof params.payload === 'object' ? params.payload : {};
      }
    }
    if (method === CONTROLLER_METHODS.command) return runCommand(params);
    if (method === CONTROLLER_METHODS.cancel) return cancelCommand(params.command_id);
    return undefined;
  }

  return {
    handleFrame,
    capabilities: () => [CONTROLLER_NOOP_CAPABILITY],
    pendingCount: () => pending.size,
  };
}
