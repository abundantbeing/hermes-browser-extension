// What a gateway refusal of one request means for the turn that sent it.
//
// A session authority refuses every RuntimeStoreError with rpc code 4001 and the
// reason in `error.data.reason` (session_busy, permission_denied, invalid_params,
// revision_conflict, runtime_draining, not_found, ...). The legacy sidecar answers
// 4001 "session not found" for a stale live id and 4009 "session busy" for a
// session that is running a turn. Only the first of those says the live id is
// stale. Treating every 4001 as stale re-resumed and resubmitted the same prompt
// without limit, and could start a different session under the transcript on screen.

const STALE_SESSION_REASONS = new Set(['not_found', 'unknown_session', 'session_not_found']);
const BUSY_REASONS = new Set(['session_busy', 'admission_conflict']);

function rpcCodeOf(error) {
  const code = Number(error?.rpcCode ?? error?.code);
  return Number.isFinite(code) ? code : null;
}

/** The authority's `data.reason`, lower-cased, or '' when the refusal carries none. */
export function refusalReason(error) {
  const reason = error?.data?.reason ?? error?.reason;
  return typeof reason === 'string' ? reason.trim().toLowerCase() : '';
}

function busyText(error) {
  return /\bsession[ _]busy\b/i.test(String(error?.message || ''));
}

/**
 * Per-session condition: another view or surface is running a turn in this
 * session. The gateway is the single writer and refused this prompt; the
 * gateway itself is fine.
 */
export function isSessionBusyRefusal(error) {
  if (!error || typeof error !== 'object') return false;
  const reason = refusalReason(error);
  if (reason) return BUSY_REASONS.has(reason);
  return rpcCodeOf(error) === 4009 || busyText(error);
}

/** The live id the panel holds is no longer known to the gateway (reaped or re-minted). */
export function isStaleLiveSessionRefusal(error) {
  if (!error || typeof error !== 'object' || rpcCodeOf(error) !== 4001) return false;
  const reason = refusalReason(error);
  // A bare 4001 is the legacy "session not found". A reason that names anything
  // else (invalid_params, permission_denied, session_busy, ...) is a refusal of
  // this request, not proof that the session id is gone.
  return !reason || STALE_SESSION_REASONS.has(reason);
}

/**
 * Classify a refusal of `prompt.submit`:
 *   'stale-session' the live id is gone; one re-resume may recover it
 *   'session-busy'  another writer holds the session; keep the draft
 *   'refused'       the gateway named another reason; keep the draft
 *   ''              not a refusal this module recognises
 */
export function classifyPromptRefusal(error) {
  if (!error || typeof error !== 'object') return '';
  if (isSessionBusyRefusal(error)) return 'session-busy';
  if (isStaleLiveSessionRefusal(error)) return 'stale-session';
  if (rpcCodeOf(error) === 4001 && refusalReason(error)) return 'refused';
  return '';
}

/**
 * The session the person is looking at no longer exists on the gateway. Never
 * replaced by a new one inside a send: the transcript on screen would belong to
 * one session and the turn to another.
 */
export function sessionGoneError(cause) {
  const error = new Error('Hermes no longer has this session.');
  error.sessionGone = true;
  error.cause = cause;
  error.rpcCode = cause?.rpcCode ?? cause?.code;
  return error;
}

/** The turn went out on a reconnect but the gateway never recorded it. */
export function turnNotDeliveredError() {
  const error = new Error('Hermes never recorded this message.');
  error.turnNotDelivered = true;
  return error;
}

function refusalDetailText(error) {
  const reason = refusalReason(error);
  const data = error?.data && typeof error.data === 'object' ? error.data : {};
  const field = typeof data.field === 'string' ? data.field.trim().slice(0, 80) : '';
  const detail = typeof data.detail === 'string' ? data.detail.trim().slice(0, 160) : '';
  const parts = [reason || String(error?.message || '').trim().slice(0, 160)];
  if (field) parts.push(field);
  if (detail) parts.push(detail);
  return parts.filter(Boolean).join(': ');
}

/**
 * The failure state the panel shows for a refused or undelivered turn, in the
 * shape of turnRequestFailureState. Every one of them keeps the draft and leaves
 * the gateway reported as connected: the gateway answered.
 */
export function refusalFailureState(error) {
  if (error?.sessionGone) {
    return {
      kind: 'session-gone',
      title: 'This session no longer exists',
      detail: 'Hermes no longer has this session, so the message was not sent. It was kept as a draft. Open another session or start a new one, then send it again.',
      preserveDraft: true,
      gatewayStatus: 'connected',
      // The history refresh that follows a failed turn rebuilds the transcript, so a message placed
      // in it does not last; the panel also raises a toast for these.
      toast: true,
    };
  }
  if (error?.turnNotDelivered) {
    return {
      kind: 'turn-not-delivered',
      title: 'Message was not delivered',
      detail: 'The connection dropped before Hermes recorded this message, and the session shows no sign of it. It was kept as a draft. Nothing was sent twice; send it again when you are ready.',
      preserveDraft: true,
      gatewayStatus: 'connected',
      // The history refresh that follows a failed turn rebuilds the transcript, so a message placed
      // in it does not last; the panel also raises a toast for these.
      toast: true,
    };
  }
  const kind = classifyPromptRefusal(error);
  if (kind === 'session-busy') {
    return {
      kind: 'session-busy',
      title: 'This session is busy',
      detail: 'Another window or surface is running a turn in this session, so Hermes did not take this message. It was kept as a draft. Send it when that turn finishes, or steer or queue it once this panel shows the run.',
      preserveDraft: true,
      gatewayStatus: 'connected',
      // The history refresh that follows a failed turn rebuilds the transcript, so a message placed
      // in it does not last; the panel also raises a toast for these.
      toast: true,
    };
  }
  if (kind === 'refused') {
    return {
      kind: 'prompt-refused',
      title: 'Hermes refused the message',
      detail: `Hermes answered ${refusalDetailText(error)}. Nothing was sent, and the message was kept as a draft.`,
      preserveDraft: true,
      gatewayStatus: 'connected',
      // The history refresh that follows a failed turn rebuilds the transcript, so a message placed
      // in it does not last; the panel also raises a toast for these.
      toast: true,
    };
  }
  return null;
}
