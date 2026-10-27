// Edit and Restore checkpoint on a session-authority gateway:
// `session.mutate operation=rewind`, then a plain `prompt.submit`.
//
// The legacy dashboard socket truncates inside prompt.submit
// (confirm_truncate / truncate_before_row_id / confirm_empty_truncate, see
// message-rewind.mjs truncateSubmitParams). A session authority's canonical
// prompt.submit (tui_gateway/contracts/canonical_sessions.py CanonicalSubmitParams)
// has a closed key set and refuses those keys with 4001 invalid_params. Its
// way to take turns back is a fenced mutation, the same one the gateway's own
// /rollback uses (gateway/session_tui_ops.py _rewind_last_turn):
//
//   session.mutate {
//     session_id, request_id, expected_revision, expected_generation,
//     operation: 'rewind', payload: { target_message_id }
//   }
//
// Contract sources (Hermes origin/main, read only): hermes_state_mutations.py
// (payload validation, _rewind), hermes_state_mutation_transcript.py
// (rewind_in_transaction), gateway/session_mutations.py.
//   * target_message_id is the physical row id of an ACTIVE USER message of the
//     session. Every active row with id >= target_message_id is soft-deleted
//     (active=0): the target itself and everything after it. Rows before it keep
//     their ids. That is exactly what truncate_before_row_id does on the legacy
//     path, so Edit (replace this user turn) and Restore (rerun from this turn)
//     both rewind to the turn's own row and then submit the replacement text;
//   * rewind needs an idle session (a running turn is refused session_busy) and
//     expected_generation as well as expected_revision; the receipt carries
//     rewound_count, target_message, new_head_id and replacement_message_id;
//   * a target a compaction summarized is refused invalid_params with a detail
//     that starts `compacted:`; a row already taken back, an assistant row or an
//     unknown id is refused invalid_params too;
//   * retrying the same request_id with the same fences replays the receipt, so a
//     lost answer is settled by sending the identical request again, never a new one.
//
// Nothing here throws for a gateway refusal. Each outcome is a typed `{ status }`:
//   rewound         committed (the receipt is the gateway's word);
//   busy            a turn is running or the gateway said session_busy: nothing changed;
//   compacted       the target turn was summarized by compaction: nothing changed;
//   invalid         the target is not an active user message: nothing changed;
//   stale           revision_conflict / stale_generation survived the retry: nothing changed;
//   denied          permission_denied / profile_mismatch: nothing changed;
//   unavailable     no authority, REST-only, or session.mutate answered -32601: nothing sent;
//   not_sent        the canonical read before the write failed: nothing sent;
//   indeterminate   the answer was lost twice: the rewind may have been applied;
//   failed          any other refusal: nothing changed.

import {
  createMutationRequestId,
  describeTransportFailure,
  isInteger,
  isMethodNotFound,
  readCanonicalSession,
  refusalReason,
  rpcCodeOf,
  SESSION_MUTATE_METHOD,
} from './session-mutate.mjs';
import { gatewayAuthorityAvailability } from './projects-client.mjs';

export const REWIND_OPERATION = 'rewind';

function clean(value = '') {
  return String(value ?? '').trim();
}

function isRowId(value) {
  return Number.isInteger(value) && value > 0;
}

export function buildRewindMutateParams({
  sessionId = '',
  requestId = '',
  expectedRevision,
  expectedGeneration,
  targetMessageId,
} = {}) {
  const session = clean(sessionId);
  const request = clean(requestId);
  if (!session) throw new TypeError('A Hermes session id is required to rewind it.');
  if (!request) throw new TypeError('A request id is required for a session mutation.');
  if (!isInteger(expectedRevision)) throw new TypeError('expected_revision must come from a canonical read.');
  if (!isInteger(expectedGeneration)) throw new TypeError('expected_generation must come from a canonical read.');
  if (!isRowId(targetMessageId)) throw new TypeError('target_message_id must be a durable message row id.');
  // Exactly the fields session.mutate accepts: the gateway rejects any other key.
  return {
    session_id: session,
    request_id: request,
    expected_revision: expectedRevision,
    operation: REWIND_OPERATION,
    payload: { target_message_id: targetMessageId },
    expected_generation: expectedGeneration,
  };
}

function typedRefusal(error, context) {
  const reason = refusalReason(error);
  const detail = clean(error?.data?.detail);
  if (reason === 'session_busy' || reason === 'unknown_execution') return { status: 'busy', reason, ...context };
  if (reason === 'invalid_params') {
    if (/^compacted:/i.test(detail)) return { status: 'compacted', reason, detail, ...context };
    return { status: 'invalid', reason, detail, ...context };
  }
  if (reason === 'permission_denied' || reason === 'profile_mismatch') return { status: 'denied', reason, ...context };
  return { status: 'failed', reason: reason || 'gateway-error', message: clean(error?.message), code: rpcCodeOf(error), ...context };
}

/**
 * Take the session back to before one of its user turns: that turn and every
 * row after it are removed. `sessionId` is the durable id (on a session
 * authority the live and stored ids are the same); `rowId` is the turn's
 * durable row id.
 */
export async function rewindSessionToMessage({
  request,
  dashboardWs = false,
  getReadyPayload = () => null,
  unsupportedMethods = new Set(),
  sessionId = '',
  rowId,
  maxConflictRetries = 1,
  newRequestId = () => createMutationRequestId('hbe-rewind'),
} = {}) {
  if (typeof request !== 'function') throw new TypeError('A gateway request function is required.');
  const target = clean(sessionId);
  if (!target) throw new TypeError('A Hermes session id is required to rewind it.');
  if (!isRowId(rowId)) return { status: 'invalid', reason: 'no-row-id', sessionId: target };

  const gate = gatewayAuthorityAvailability({
    dashboardWs, readyPayload: getReadyPayload(), unsupportedMethods, method: SESSION_MUTATE_METHOD,
  });
  if (!gate.available) return { status: 'unavailable', reason: gate.reason, message: gate.message };

  for (let attempt = 0; ; attempt += 1) {
    let snapshot;
    try {
      snapshot = await readCanonicalSession(request, target);
    } catch (error) {
      return { status: 'not_sent', ...describeTransportFailure(error), sessionId: target };
    }
    if (snapshot.running) {
      return { status: 'busy', reason: 'turn-running', sessionId: target, executionState: snapshot.executionState };
    }
    const params = buildRewindMutateParams({
      sessionId: target,
      requestId: newRequestId(),
      expectedRevision: snapshot.revision,
      expectedGeneration: snapshot.generation,
      targetMessageId: rowId,
    });
    const context = { sessionId: target, requestId: params.request_id };

    let receipt = null;
    let lost = null;
    // A lost answer is settled by sending the identical request again: the same
    // id and fences replay a committed receipt and cannot apply twice.
    for (let send = 0; send < 2; send += 1) {
      try {
        receipt = await request(SESSION_MUTATE_METHOD, params);
        lost = null;
        break;
      } catch (error) {
        if (isMethodNotFound(error)) {
          if (unsupportedMethods instanceof Set) unsupportedMethods.add(SESSION_MUTATE_METHOD);
          return {
            status: 'unavailable',
            reason: 'method-not-found',
            message: 'The connected Hermes gateway answered "method not found" (-32601) for session.mutate, so a turn cannot be rewound from here.',
          };
        }
        const reason = refusalReason(error);
        if (reason === 'revision_conflict' || reason === 'stale_generation') {
          // A fence refusal happens before any commit: a fresh read and a new request id cannot double-apply.
          lost = { fence: reason };
          break;
        }
        if (rpcCodeOf(error) !== null && reason !== 'storage_unavailable') return typedRefusal(error, context);
        lost = error;
      }
    }
    if (lost?.fence) {
      if (attempt < maxConflictRetries) continue;
      return { status: 'stale', reason: lost.fence, ...context };
    }
    if (lost) {
      return { status: 'indeterminate', ...describeTransportFailure(lost), ...context };
    }

    const committed = receipt && receipt.operation === REWIND_OPERATION
      && clean(receipt.session_id) === target && isInteger(receipt.revision);
    if (!committed) {
      return {
        status: 'indeterminate',
        reason: 'receipt-malformed',
        message: 'Hermes answered the rewind without a usable receipt.',
        ...context,
      };
    }
    return {
      status: 'rewound',
      rewoundCount: isInteger(receipt.rewound_count) ? receipt.rewound_count : null,
      revision: receipt.revision,
      generation: isInteger(receipt.execution_generation) ? receipt.execution_generation : snapshot.generation,
      receipt,
      ...context,
    };
  }
}

/**
 * Does this connection need the rewind mutation instead of truncate keys on
 * prompt.submit? Only a session authority does; every other gateway keeps the
 * legacy truncation contract.
 */
export function usesAuthorityRewind(client) {
  return client?.readyPayload?.session_authority === true;
}

/** An Error for a failed authority rewind that the send retry loops must not treat as a refused prompt. */
export function rewindFailureError(outcome = {}) {
  const error = new Error(`Hermes could not rewind the conversation (${outcome.reason || outcome.status || 'failed'}).`);
  error.rewindFailed = true;
  error.rewindStatus = outcome.status || 'failed';
  // Only an indeterminate outcome may have been applied; every other status changed nothing.
  error.rewindMaybeApplied = outcome.status === 'indeterminate';
  return error;
}
