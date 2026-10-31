// A chat written before the gateway owned sessions (main's CLI, TUI and Desktop
// rows, #106742) has no gateway receipt. Only a native, same-OS-user client may
// make the first claim on it (gateway/session_local_migration.py), so a browser
// that resumes one is refused. The session authority answers that refusal as
// every RuntimeStoreError: rpc code 4001, message and `data.reason` the bounded
// code, `data.field` / `data.detail` when the raiser named them. For this case
// the code is `not_found` (adopt_legacy_session: not a native transport), with
// no field and no detail, which is also what a truly missing session answers.
// So the code alone proves nothing: this module only calls a refusal a
// pre-gateway chat when the session being resumed has the shape of a legacy
// local row id (YYYYMMDD_HHMMSS or YYYYMMDD_HHMMSS_<hex>, what the CLI, TUI and
// Desktop minted), and `permission_denied` is accepted on a resume as well.
//
// The panel shows the gateway's own reason, plus one hint, and never resends:
// the turn was refused before it was recorded, so the draft stays in the composer.

export const PRE_GATEWAY_ADOPT_HINT = 'Run `hermes sessions adopt` (or `hermes -p <profile> sessions adopt`) on the host, or open this chat once in the Desktop app.';

const LEGACY_LOCAL_SESSION_ID = /^\d{8}_\d{6}(?:_[0-9a-f]+)?$/i;
const RESUME_REFUSAL_REASONS = new Set(['not_found', 'permission_denied']);

export function isLegacyLocalSessionId(sessionId = '') {
  return LEGACY_LOCAL_SESSION_ID.test(String(sessionId || '').trim());
}

function reasonOf(error) {
  const reason = error?.data?.reason ?? error?.reason;
  return typeof reason === 'string' ? reason.trim().toLowerCase() : '';
}

function rpcCodeOf(error) {
  const code = Number(error?.rpcCode ?? error?.code);
  return Number.isFinite(code) ? code : null;
}

function clipped(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/**
 * The gateway's refusal of a resume of `sessionId`, when it is the pre-gateway
 * chat case; otherwise null. `error` is the rejection of `session.resume`.
 */
export function preGatewayChatRefusal(error, sessionId = '') {
  if (!error || typeof error !== 'object') return null;
  if (error.preGatewayChat) return error.preGatewayChat;
  if (rpcCodeOf(error) !== 4001) return null;
  const reason = reasonOf(error);
  if (!RESUME_REFUSAL_REASONS.has(reason)) return null;
  if (reason === 'not_found' && !isLegacyLocalSessionId(sessionId)) return null;
  const data = error.data && typeof error.data === 'object' ? error.data : {};
  return Object.freeze({
    sessionId: String(sessionId || '').trim(),
    reason,
    field: clipped(data.field, 80),
    detail: clipped(data.detail, 160),
  });
}

/** The error a refused resume becomes, or null when it is not this case. */
export function preGatewayChatError(cause, sessionId = '') {
  const refusal = preGatewayChatRefusal(cause, sessionId);
  if (!refusal) return null;
  const error = new Error('Hermes will not continue this chat until it is adopted.');
  error.name = 'HermesPreGatewayChatError';
  error.preGatewayChat = refusal;
  error.cause = cause;
  error.rpcCode = cause?.rpcCode ?? cause?.code ?? 4001;
  return error;
}

/**
 * The failure state the panel shows, in the shape of turnRequestFailureState:
 * the gateway's own reason, one hint, the draft kept, the gateway still connected.
 */
export function preGatewayChatFailureState(error) {
  const refusal = error?.preGatewayChat;
  if (!refusal) return null;
  const answered = [refusal.reason, refusal.field, refusal.detail].filter(Boolean).join(': ');
  return {
    kind: 'pre-gateway-chat',
    title: 'Hermes cannot continue this chat yet',
    detail: `Hermes answered ${answered}. ${PRE_GATEWAY_ADOPT_HINT} Nothing was sent, and the message was kept as a draft.`,
    preserveDraft: true,
    gatewayStatus: 'connected',
    toast: true,
  };
}
