// `session.mutate operation=workspace` ("Move to project") for the Hermes
// dashboard gateway.
//
// Pure module over an injected `request(method, params)`. Contract source:
// tui_gateway/contracts/canonical.py (SessionMutateParams / Result),
// gateway/session_mutations.py and gateway/session_mutation_policy.py
// (prepare_workspace) in the installed Hermes.
//
// What the contract requires of a workspace move:
//   * a dashboard WebSocket whose gateway.ready carries `session_authority`;
//   * exactly {session_id, request_id, expected_revision, operation, payload,
//     expected_generation}. `workspace` is a policy operation, so
//     expected_generation is required as well as expected_revision;
//   * a session with no running turn: the gateway refuses `session_busy`;
//   * the receipt is the response. Retrying the same request_id with the same
//     fences replays that receipt, so it is idempotent; a new request_id is a
//     new write.
// The legacy `session.workspace.move` is refused on authority connections
// (tui_gateway/ws_legacy_fallback.py) and is never called from here.
//
// Nothing here throws for a gateway refusal. Each outcome is a typed
// `{ status, ... }` the sessions drawer can render:
//   moved           committed AND read back from the canonical session;
//   live_turn       a turn is running: ask before doing anything (nothing sent);
//   busy            the gateway refused with session_busy / unknown_execution;
//   stale           revision_conflict or stale_generation survived the retry;
//   invalid         the gateway refused the folder (not a directory there);
//   denied          permission_denied / profile_mismatch;
//   unavailable     no authority, REST-only, or session.mutate answered -32601;
//   not_sent        the canonical read before the write failed: nothing sent;
//   indeterminate   the write may or may not have landed: reconcile, never resend blind;
//   not_committed   reconcile found no receipt: resend the SAME request;
//   conflict        reconcile found the session changed by someone else;
//   unconfirmed     the receipt arrived but the read-back did not agree.

import { gatewayAuthorityAvailability } from './projects-client.mjs';

export const SESSION_MUTATE_METHOD = 'session.mutate';
export const SESSION_RESUME_METHOD = 'session.resume';
// Refused on authority connections; listed so tests can prove it is never sent.
export const LEGACY_WORKSPACE_MOVE_METHOD = 'session.workspace.move';

const LIVE_EXECUTION_STATES = new Set(['running', 'waiting', 'unknown']);

export function clean(value = '') {
  return String(value ?? '').trim();
}

export function rpcCodeOf(error) {
  const code = Number(error?.rpcCode ?? error?.code);
  return Number.isFinite(code) ? code : null;
}

export function refusalReason(error) {
  return clean(error?.data?.reason || '').toLowerCase();
}

export function isMethodNotFound(error) {
  return rpcCodeOf(error) === -32601 || refusalReason(error) === 'unknown_method';
}

export function isInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

export function createMutationRequestId(prefix = 'hbe-workspace', cryptoImpl = globalThis.crypto) {
  const suffix = typeof cryptoImpl?.randomUUID === 'function'
    ? cryptoImpl.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${suffix}`;
}

// The gateway host's path, which the browser cannot resolve. Absolute (POSIX,
// drive-letter, UNC) or ~-relative only: a relative path would resolve against
// the gateway's own cwd and move the session somewhere unintended.
export function isGatewayHostPath(path) {
  return /^(\/|~(?:[\\/]|$)|[A-Za-z]:[\\/]|\\\\)/.test(path);
}

export function comparablePath(path = '') {
  let text = clean(path).replace(/\\/g, '/');
  if (text.length > 1) text = text.replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(text) ? text.toLowerCase() : text;
}

export function samePath(a, b) {
  const left = comparablePath(a);
  return Boolean(left) && left === comparablePath(b);
}

export function buildWorkspaceMutateParams({
  sessionId = '',
  requestId = '',
  expectedRevision,
  expectedGeneration,
  cwd = '',
} = {}) {
  const session = clean(sessionId);
  const request = clean(requestId);
  const folder = clean(cwd);
  if (!session) throw new TypeError('A Hermes session id is required to move it.');
  if (!request) throw new TypeError('A request id is required for a session mutation.');
  if (!isInteger(expectedRevision)) throw new TypeError('expected_revision must come from a canonical read.');
  if (!isInteger(expectedGeneration)) throw new TypeError('expected_generation must come from a canonical read.');
  if (!folder || folder.length > 4096 || folder.includes('\0') || !isGatewayHostPath(folder)) {
    throw new TypeError('A folder path on the gateway host is required (absolute, or starting with ~).');
  }
  // Exactly the fields session.mutate accepts: the gateway rejects any other key.
  return {
    session_id: session,
    request_id: request,
    expected_revision: expectedRevision,
    operation: 'workspace',
    payload: { cwd: folder },
    expected_generation: expectedGeneration,
  };
}

/** The canonical session as `session.resume omit_messages` reports it (CanonicalSnapshot). */
export function normalizeCanonicalSession(raw = null) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isInteger(raw.revision) || !isInteger(raw.execution_generation)) return null;
  const info = raw.info && typeof raw.info === 'object' ? raw.info : {};
  const executionState = clean(raw.execution_state).toLowerCase();
  return {
    sessionId: clean(raw.session_id),
    storedSessionId: clean(raw.stored_session_id) || clean(raw.session_id),
    revision: raw.revision,
    generation: raw.execution_generation,
    executionState,
    running: raw.running === true || LIVE_EXECUTION_STATES.has(executionState),
    cwd: clean(info.cwd),
    messageCount: isInteger(raw.message_count) ? raw.message_count : null,
    title: clean(info.title),
    profileName: clean(info.profile_name),
  };
}

export async function readCanonicalSession(request, sessionId) {
  const raw = await request(SESSION_RESUME_METHOD, { session_id: clean(sessionId), omit_messages: true });
  const snapshot = normalizeCanonicalSession(raw);
  if (!snapshot) {
    const error = new Error('Hermes answered session.resume without a revision and execution generation.');
    error.code = 'malformed-snapshot';
    throw error;
  }
  return snapshot;
}

export function describeTransportFailure(error) {
  const message = clean(error?.message) || 'Hermes could not be reached.';
  return { reason: /timed out/i.test(message) ? 'timeout' : 'disconnected', message };
}

function pendingFrom({ params, previousCwd }) {
  return {
    sessionId: params.session_id,
    requestId: params.request_id,
    expectedRevision: params.expected_revision,
    expectedGeneration: params.expected_generation,
    cwd: params.payload.cwd,
    previousCwd,
  };
}

/**
 * Decide, from a fresh canonical read, what became of a write whose answer was
 * lost. It never sends a mutation.
 *   applied        the revision advanced onto the folder we asked for;
 *   not_committed  the fences are untouched, so no receipt exists. `sameRequest`
 *                  says whether resending the identical request is still valid
 *                  (same fences) or the write needs a fresh id and fences;
 *   conflict       the session changed in a way that is not this write;
 *   unreadable     the read itself failed (still disconnected).
 */
export async function reconcileWorkspaceMove({ request, pending } = {}) {
  if (typeof request !== 'function') throw new TypeError('A gateway request function is required.');
  if (!pending?.requestId) throw new TypeError('A pending move from an indeterminate result is required.');
  let snapshot;
  try {
    snapshot = await readCanonicalSession(request, pending.sessionId);
  } catch (error) {
    return { outcome: 'unreadable', pending, ...describeTransportFailure(error) };
  }
  const advanced = snapshot.revision - pending.expectedRevision;
  if (advanced > 0) {
    const landed = samePath(snapshot.cwd, pending.cwd)
      || (advanced === 1 && snapshot.cwd !== '' && !samePath(snapshot.cwd, pending.previousCwd));
    return { outcome: landed ? 'applied' : 'conflict', snapshot, pending };
  }
  if (advanced === 0) {
    return {
      outcome: 'not_committed',
      sameRequest: snapshot.generation === pending.expectedGeneration,
      snapshot,
      pending,
    };
  }
  return { outcome: 'conflict', snapshot, pending };
}

function movedResult({ snapshot, previousCwd, requestId, receipt = null, noop = false }) {
  return {
    status: 'moved',
    sessionId: snapshot.sessionId,
    cwd: snapshot.cwd,
    previousCwd,
    revision: snapshot.revision,
    generation: snapshot.generation,
    requestId,
    receipt,
    noop,
  };
}

function typedRefusal(error, context) {
  const reason = refusalReason(error);
  if (reason === 'session_busy') {
    return { status: 'busy', reason, compressing: clean(error?.data?.field) === 'compression', ...context };
  }
  if (reason === 'unknown_execution') return { status: 'busy', reason, compressing: false, ...context };
  if (reason === 'invalid_params') {
    return {
      status: 'invalid',
      reason,
      message: 'That folder is not a directory on the Hermes gateway host.',
      detail: clean(error?.data?.detail),
      ...context,
    };
  }
  if (reason === 'permission_denied' || reason === 'profile_mismatch') return { status: 'denied', reason, ...context };
  return { status: 'failed', reason: reason || 'gateway-error', message: clean(error?.message), code: rpcCodeOf(error), ...context };
}

/**
 * Move a session to a gateway-host folder (Move to project) and report success
 * only after reading the session back.
 *
 * `sessionId` is the canonical id (on a session authority the live and stored
 * ids are the same). `pending` resumes an `indeterminate` or `not_committed`
 * result after a reconnect: the write is reconciled against the canonical state
 * first, and only a proven-absent write is sent again.
 */
export async function moveSessionToWorkspace({
  request,
  dashboardWs = false,
  getReadyPayload = () => null,
  unsupportedMethods = new Set(),
  sessionId = '',
  cwd = '',
  confirmLiveTurn = false,
  pending = null,
  maxConflictRetries = 1,
  newRequestId = createMutationRequestId,
} = {}) {
  if (typeof request !== 'function') throw new TypeError('A gateway request function is required.');
  const target = clean(sessionId);
  const folder = clean(cwd);
  if (!target) throw new TypeError('A Hermes session id is required to move it.');
  // Validates the folder before anything is read or sent.
  buildWorkspaceMutateParams({ sessionId: target, requestId: 'probe', expectedRevision: 0, expectedGeneration: 0, cwd: folder });

  const gate = gatewayAuthorityAvailability({
    dashboardWs, readyPayload: getReadyPayload(), unsupportedMethods, method: SESSION_MUTATE_METHOD,
  });
  if (!gate.available) return { status: 'unavailable', reason: gate.reason, message: gate.message };

  // A lost answer is settled by reading the session, not by sending again.
  let resend = null;
  if (pending) {
    if (pending.sessionId !== target || !samePath(pending.cwd, folder)) {
      throw new TypeError('The pending move belongs to a different session or folder.');
    }
    const settled = await reconcileWorkspaceMove({ request, pending });
    if (settled.outcome === 'applied') {
      return movedResult({ snapshot: settled.snapshot, previousCwd: pending.previousCwd, requestId: pending.requestId });
    }
    if (settled.outcome === 'conflict') return { status: 'conflict', pending, snapshot: settled.snapshot };
    if (settled.outcome === 'unreadable') {
      return { status: 'indeterminate', pending, reason: settled.reason, message: settled.message };
    }
    if (settled.sameRequest) resend = { pending, snapshot: settled.snapshot };
  }

  for (let attempt = 0; ; attempt += 1) {
    let snapshot;
    if (resend) {
      snapshot = resend.snapshot;
    } else {
      try {
        snapshot = await readCanonicalSession(request, target);
      } catch (error) {
        return { status: 'not_sent', ...describeTransportFailure(error) };
      }
    }
    const previousCwd = resend ? resend.pending.previousCwd : snapshot.cwd;

    if (!resend) {
      if (snapshot.running && confirmLiveTurn !== true) {
        return {
          status: 'live_turn',
          confirmationRequired: true,
          sessionId: target,
          executionState: snapshot.executionState,
          cwd: snapshot.cwd,
          message: 'A turn is running in this session. Moving it changes the folder its commands run in, and Hermes refuses the move until the turn ends.',
        };
      }
      if (samePath(snapshot.cwd, folder)) {
        return movedResult({ snapshot, previousCwd, requestId: '', noop: true });
      }
    }

    // A resend reuses the exact request: same id, same fences, so a late commit
    // of the first attempt is replayed rather than applied twice.
    const params = resend
      ? buildWorkspaceMutateParams({
        sessionId: target,
        requestId: resend.pending.requestId,
        expectedRevision: resend.pending.expectedRevision,
        expectedGeneration: resend.pending.expectedGeneration,
        cwd: folder,
      })
      : buildWorkspaceMutateParams({
        sessionId: target,
        requestId: newRequestId(),
        expectedRevision: snapshot.revision,
        expectedGeneration: snapshot.generation,
        cwd: folder,
      });
    resend = null;
    const context = { sessionId: target, requestId: params.request_id, cwd: folder };

    let receipt;
    let lost = null;
    try {
      receipt = await request(SESSION_MUTATE_METHOD, params);
    } catch (error) {
      if (isMethodNotFound(error)) {
        if (unsupportedMethods instanceof Set) unsupportedMethods.add(SESSION_MUTATE_METHOD);
        return {
          status: 'unavailable',
          reason: 'method-not-found',
          message: 'The connected Hermes gateway answered "method not found" (-32601) for session.mutate, so sessions cannot be moved from here.',
        };
      }
      const reason = refusalReason(error);
      if (reason === 'revision_conflict' || reason === 'stale_generation') {
        // A fence refusal happens before any commit, so a fresh read and a new
        // request id cannot double-apply.
        if (attempt < maxConflictRetries) continue;
        return {
          status: 'stale',
          reason,
          revision: isInteger(error?.data?.revision) ? error.data.revision : null,
          generation: isInteger(error?.data?.execution_generation) ? error.data.execution_generation : null,
          ...context,
        };
      }
      if (rpcCodeOf(error) !== null && reason !== 'storage_unavailable') return typedRefusal(error, context);
      lost = error;
    }

    const committed = receipt && receipt.operation === 'workspace'
      && clean(receipt.session_id) === target && isInteger(receipt.revision);
    if (lost || !committed) {
      // The write may have landed. Read the canonical state to find out; do not send again.
      const pendingMove = pendingFrom({ params, previousCwd });
      const settled = await reconcileWorkspaceMove({ request, pending: pendingMove });
      if (settled.outcome === 'applied') {
        return movedResult({ snapshot: settled.snapshot, previousCwd, requestId: params.request_id });
      }
      if (settled.outcome === 'conflict') return { status: 'conflict', pending: pendingMove, snapshot: settled.snapshot };
      if (settled.outcome === 'not_committed') {
        return { status: 'not_committed', pending: pendingMove, sameRequest: settled.sameRequest, snapshot: settled.snapshot };
      }
      return {
        status: 'indeterminate',
        pending: pendingMove,
        reason: lost
          ? (rpcCodeOf(lost) !== null ? 'storage_unavailable' : describeTransportFailure(lost).reason)
          : 'receipt-malformed',
        message: lost ? describeTransportFailure(lost).message : 'Hermes answered the move without a usable receipt.',
      };
    }

    // The receipt is the gateway's word; the canonical session is the proof.
    let readback;
    try {
      readback = await readCanonicalSession(request, target);
    } catch (error) {
      return {
        status: 'unconfirmed',
        committed: true,
        receipt,
        ...context,
        message: describeTransportFailure(error).message,
        reason: 'readback-failed',
      };
    }
    const agrees = readback.revision >= receipt.revision
      && (samePath(readback.cwd, folder) || (readback.cwd !== '' && !samePath(readback.cwd, previousCwd)));
    if (!agrees) {
      return { status: 'unconfirmed', committed: true, reason: 'readback-mismatch', receipt, snapshot: readback, ...context };
    }
    return movedResult({ snapshot: readback, previousCwd, requestId: params.request_id, receipt });
  }
}
