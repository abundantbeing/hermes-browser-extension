// Manual "Compact context" on a session-authority gateway:
// `session.mutate operation=compress`.
//
// A session authority does not route the legacy `session.compress` (it answers
// -32601), so the control used to disappear there. The canonical way is the same
// fenced mutation Move to project uses (session-mutate.mjs): read the session,
// send {session_id, request_id, expected_revision, expected_generation,
// operation: 'compress', payload}, take the receipt as the gateway's word, and
// read the canonical session back as the proof.
//
// Contract sources (installed Hermes, read only): gateway/session_mutations.py,
// gateway/session_mutation_compress.py, hermes_state_mutation_compress.py,
// hermes_state_mutations.py (_valid_compress_payload), tui_gateway/contracts/
// canonical.py (SessionMutateParams / Result).
//   * `expected_generation` is required for compress (a policy-style fence);
//   * payload is {} or {focus} (or the structured preview/partial/keep_last,
//     which this control does not send; `preview` is read-only and never sent);
//   * the summarization is an LLM call that runs outside the session gate, so it
//     can take a while; the commit is fenced against anything that landed
//     meanwhile;
//   * the receipt carries target_session_id, previous_target_session_id,
//     execution_generation, message_count and summary. In place (the default)
//     the target is the session itself. A rotating compaction commits a new
//     physical target, but the session id the client holds stays the durable
//     key: `rotated` says so and nothing here asks the caller to rename it;
//   * a prepare that removes nothing answers `status: 'noop'` with no receipt.
//
// Nothing throws for a gateway refusal; each outcome is a typed `{ status }`:
//   compacted       committed AND read back (revision and generation advanced);
//   noop            nothing to remove; no receipt, nothing changed;
//   busy            a turn is running (nothing sent) or the gateway said session_busy;
//   blocked         the gateway refused for a reason that is not transient
//                   (checkpoint required, runtime coordination, options);
//   stale           revision_conflict / stale_generation survived the retry;
//   denied          permission_denied / profile_mismatch;
//   unavailable     no authority, REST-only, or session.mutate answered -32601;
//   not_sent        the canonical read before the write failed: nothing sent;
//   indeterminate   the answer was lost and the session moved: never resend blind;
//   not_committed   the answer was lost and the fences are untouched: the SAME
//                   request may be resent;
//   unconfirmed     the receipt arrived but the read-back did not agree;
//   aborted         the summary failed (nothing was replaced);
//   failed          any other refusal.

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

export const COMPACT_OPERATION = 'compress';
// The summary is an LLM call; the gateway's default request deadline (30 s) is
// shorter than a long session takes, and an answer that arrives late would look
// lost. The write is bounded, not open-ended.
export const COMPACT_REQUEST_TIMEOUT_MS = 180_000;
export const COMPACT_CAPABILITY_ID = 'sessionCompress';

function clean(value = '') {
  return String(value ?? '').trim();
}

export function buildCompactMutateParams({
  sessionId = '',
  requestId = '',
  expectedRevision,
  expectedGeneration,
  focus = '',
} = {}) {
  const session = clean(sessionId);
  const request = clean(requestId);
  const topic = clean(focus);
  if (!session) throw new TypeError('A Hermes session id is required to compact it.');
  if (!request) throw new TypeError('A request id is required for a session mutation.');
  if (!isInteger(expectedRevision)) throw new TypeError('expected_revision must come from a canonical read.');
  if (!isInteger(expectedGeneration)) throw new TypeError('expected_generation must come from a canonical read.');
  if (topic.length > 2000 || topic.includes('\0')) throw new TypeError('The compaction focus is too long.');
  // Exactly the fields session.mutate accepts: the gateway rejects any other key.
  // A focus-only payload goes through the gateway's own /compress parser, which
  // is why it is sent as `focus` and nothing structured.
  return {
    session_id: session,
    request_id: request,
    expected_revision: expectedRevision,
    operation: COMPACT_OPERATION,
    payload: topic ? { focus: topic } : {},
    expected_generation: expectedGeneration,
  };
}

function summaryOf(raw) {
  const summary = raw && typeof raw === 'object' ? raw : {};
  return {
    noop: summary.noop === true,
    aborted: summary.aborted === true,
    headline: clean(summary.headline),
    tokenLine: clean(summary.token_line),
    note: clean(summary.note),
  };
}

// Refusal reasons that no retry fixes. `field` says which part of the request.
const BLOCKED_REASONS = new Set([
  'compression_checkpoint_required',
  'runtime_coordination_required',
  'unsupported_compress_options',
  'invalid_params',
]);

function typedRefusal(error, context) {
  const reason = refusalReason(error);
  if (reason === 'session_busy') {
    return { status: 'busy', reason, compressing: clean(error?.data?.field) === 'compression', ...context };
  }
  if (reason === 'unknown_execution') return { status: 'busy', reason, compressing: false, ...context };
  if (BLOCKED_REASONS.has(reason)) return { status: 'blocked', reason, detail: clean(error?.data?.detail), ...context };
  if (reason === 'permission_denied' || reason === 'profile_mismatch') return { status: 'denied', reason, ...context };
  return { status: 'failed', reason: reason || 'gateway-error', message: clean(error?.message), code: rpcCodeOf(error), ...context };
}

function compactedResult({ snapshot, receipt, before, requestId, reconciled = false }) {
  const previous = clean(receipt?.previous_target_session_id);
  const target = clean(receipt?.target_session_id);
  return {
    status: 'compacted',
    // The durable key the client sent and keeps. It survives compression.
    sessionId: snapshot.sessionId || clean(receipt?.session_id),
    targetSessionId: target,
    previousTargetSessionId: previous,
    rotated: Boolean(target && previous && target !== previous),
    revision: snapshot.revision,
    generation: snapshot.generation,
    messageCountBefore: before?.messageCount ?? null,
    messageCountAfter: snapshot.messageCount ?? (isInteger(receipt?.message_count) ? receipt.message_count : null),
    summary: summaryOf(receipt?.summary),
    requestId,
    receipt: receipt || null,
    reconciled,
  };
}

/**
 * Decide, from a fresh canonical read, what became of a compaction whose answer
 * was lost. It never sends a mutation. A metadata edit also advances the
 * revision, so only the execution generation (which a compaction bumps and a
 * rename does not) can say the write landed, and a new turn bumps it too, so a
 * moved session is reported as unproven rather than as success.
 */
export async function reconcileCompaction({ request, pending } = {}) {
  if (typeof request !== 'function') throw new TypeError('A gateway request function is required.');
  if (!pending?.requestId) throw new TypeError('A pending compaction from an indeterminate result is required.');
  let snapshot;
  try {
    snapshot = await readCanonicalSession(request, pending.sessionId);
  } catch (error) {
    return { outcome: 'unreadable', pending, ...describeTransportFailure(error) };
  }
  if (snapshot.revision === pending.expectedRevision && snapshot.generation === pending.expectedGeneration) {
    return { outcome: 'not_committed', snapshot, pending };
  }
  return { outcome: 'moved', snapshot, pending };
}

/**
 * Compact a session canonically and report success only after reading it back.
 *
 * `sessionId` is the durable id (on a session authority the live and stored ids
 * are the same). `pending` resumes a `not_committed` result with the identical
 * request id and fences, so a late commit of the first attempt is replayed by the
 * gateway instead of summarizing twice.
 */
export async function compactSessionCanonical({
  request,
  dashboardWs = false,
  getReadyPayload = () => null,
  unsupportedMethods = new Set(),
  sessionId = '',
  focus = '',
  pending = null,
  maxConflictRetries = 1,
  timeoutMs = COMPACT_REQUEST_TIMEOUT_MS,
  newRequestId = () => createMutationRequestId('hbe-compact'),
} = {}) {
  if (typeof request !== 'function') throw new TypeError('A gateway request function is required.');
  const target = clean(sessionId);
  if (!target) throw new TypeError('A Hermes session id is required to compact it.');

  const gate = gatewayAuthorityAvailability({
    dashboardWs, readyPayload: getReadyPayload(), unsupportedMethods, method: SESSION_MUTATE_METHOD,
  });
  if (!gate.available) return { status: 'unavailable', reason: gate.reason, message: gate.message };

  let resend = null;
  if (pending) {
    if (pending.sessionId !== target) throw new TypeError('The pending compaction belongs to a different session.');
    const settled = await reconcileCompaction({ request, pending });
    if (settled.outcome === 'unreadable') return { status: 'indeterminate', pending, reason: settled.reason, message: settled.message };
    if (settled.outcome === 'moved') return { status: 'indeterminate', pending, reason: 'session-moved', snapshot: settled.snapshot };
    resend = { pending, snapshot: settled.snapshot };
  }

  for (let attempt = 0; ; attempt += 1) {
    let before;
    if (resend) {
      before = resend.snapshot;
    } else {
      try {
        before = await readCanonicalSession(request, target);
      } catch (error) {
        return { status: 'not_sent', ...describeTransportFailure(error) };
      }
      if (before.running) {
        return { status: 'busy', reason: 'turn-running', compressing: false, sessionId: target, executionState: before.executionState };
      }
    }

    const params = resend
      ? buildCompactMutateParams({
        sessionId: target,
        requestId: resend.pending.requestId,
        expectedRevision: resend.pending.expectedRevision,
        expectedGeneration: resend.pending.expectedGeneration,
        focus: resend.pending.focus,
      })
      : buildCompactMutateParams({
        sessionId: target,
        requestId: newRequestId(),
        expectedRevision: before.revision,
        expectedGeneration: before.generation,
        focus,
      });
    resend = null;
    const context = { sessionId: target, requestId: params.request_id };
    const pendingCompaction = {
      sessionId: target,
      requestId: params.request_id,
      expectedRevision: params.expected_revision,
      expectedGeneration: params.expected_generation,
      focus: clean(focus),
    };

    let receipt;
    let lost = null;
    try {
      receipt = await request(SESSION_MUTATE_METHOD, params, { timeoutMs });
    } catch (error) {
      if (isMethodNotFound(error)) {
        if (unsupportedMethods instanceof Set) unsupportedMethods.add(SESSION_MUTATE_METHOD);
        return {
          status: 'unavailable',
          reason: 'method-not-found',
          message: 'The connected Hermes gateway answered "method not found" (-32601) for session.mutate, so context cannot be compacted from here.',
        };
      }
      const reason = refusalReason(error);
      if (reason === 'revision_conflict' || reason === 'stale_generation') {
        // A fence refusal happens before any commit, so a fresh read and a new
        // request id cannot double-apply.
        if (attempt < maxConflictRetries) continue;
        return { status: 'stale', reason, ...context };
      }
      if (rpcCodeOf(error) !== null && reason !== 'storage_unavailable') return typedRefusal(error, context);
      lost = error;
    }

    if (lost) {
      const settled = await reconcileCompaction({ request, pending: pendingCompaction });
      if (settled.outcome === 'not_committed') {
        return { status: 'not_committed', pending: pendingCompaction, snapshot: settled.snapshot };
      }
      const failure = describeTransportFailure(lost);
      return {
        status: 'indeterminate',
        pending: pendingCompaction,
        reason: settled.outcome === 'unreadable' ? settled.reason : 'session-moved',
        message: failure.message,
        snapshot: settled.snapshot || null,
      };
    }

    // A prepare that removes nothing is a report, not a write: no receipt.
    if (receipt && receipt.status === 'noop') {
      return { status: 'noop', summary: summaryOf(receipt.summary), ...context };
    }
    const summary = summaryOf(receipt?.summary);
    if (summary.aborted) return { status: 'aborted', summary, ...context };

    const committed = receipt && receipt.operation === COMPACT_OPERATION
      && clean(receipt.session_id) === target && isInteger(receipt.revision);
    if (!committed) {
      return {
        status: 'indeterminate',
        pending: pendingCompaction,
        reason: 'receipt-malformed',
        message: 'Hermes answered the compaction without a usable receipt.',
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
        reason: 'readback-failed',
        receipt,
        summary,
        message: describeTransportFailure(error).message,
        ...context,
      };
    }
    const receiptGeneration = isInteger(receipt.execution_generation) ? receipt.execution_generation : null;
    const agrees = readback.revision >= receipt.revision
      && (receiptGeneration === null || readback.generation >= receiptGeneration);
    if (!agrees) {
      return { status: 'unconfirmed', committed: true, reason: 'readback-mismatch', receipt, summary, snapshot: readback, ...context };
    }
    return compactedResult({ snapshot: readback, receipt, before, requestId: params.request_id });
  }
}

/** The English wording for each outcome; the side panel localizes by `status` / `reason`. */
export function describeCompactOutcome(result = {}) {
  switch (result.status) {
    case 'compacted':
      return result.summary?.headline || 'Hermes compacted the session context.';
    case 'noop':
      return result.summary?.headline || 'Nothing to compact: the session is already short enough to keep whole.';
    case 'busy':
      return result.reason === 'turn-running'
        ? 'A turn is running in this session. Stop it before compacting. Nothing was sent.'
        : (result.compressing
          ? 'Hermes is already compacting this session.'
          : 'Hermes refused because the session is busy. Nothing was changed.');
    case 'blocked':
      return `Hermes will not compact this session (${result.reason}).`;
    case 'stale':
      return 'The session changed while compacting, twice in a row. Nothing was changed. Try again.';
    case 'denied':
      return 'Hermes denied the compaction for this account or profile.';
    case 'unavailable':
      return result.message || 'Compaction is unavailable on this connection.';
    case 'not_sent':
      return 'Hermes could not be reached to read the session first. Nothing was sent.';
    case 'indeterminate':
      return 'The answer was lost and the session has moved on. Hermes may have compacted it; nothing was sent again.';
    case 'not_committed':
      return 'The answer was lost, and Hermes shows the session unchanged. The same request can be sent again.';
    case 'unconfirmed':
      return 'Hermes accepted the compaction, but reading the session back did not confirm it.';
    case 'aborted':
      return 'Hermes could not summarize the session, so nothing was replaced.';
    default:
      return result.message || 'Hermes did not complete the compaction.';
  }
}
