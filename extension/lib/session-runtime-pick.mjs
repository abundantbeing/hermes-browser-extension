// Model, reasoning and Fast picks for a session a session authority owns.
//
// On a dashboard WebSocket whose gateway.ready carries `session_authority`, the session itself holds
// its model and reasoning level: a turn carries neither, so a pick the panel only remembers never
// reaches the run. Contract source: gateway/session_tui_config.py (config_set), gateway/
// session_busy_controls.py, hermes_state_mutations.py (validate_action) and gateway/
// session_mutation_model.py in Hermes.
//   * Reasoning is `config.set {session_id, key: 'reasoning', value}`: the gateway commits the
//     revision-fenced /reasoning mutation itself. `value` is a level, or 'none' for thinking off.
//   * Fast is `config.set {session_id, key: 'fast', value: 'fast' | 'normal'}`.
//   * A model is `session.mutate {session_id, request_id, expected_revision, expected_generation,
//     operation: 'model', payload: {model, provider?, confirm?}}`, fenced by the session.resume
//     snapshot. The legacy `config.set key=model` is refused there (use_session_mutation_model).
//     A guarded target (cost, data policy, context size) answers `status: confirmation_required`
//     with a `confirm` token to resend with.

import { sessionRuntimeFromSnapshot } from './gateway-ws.mjs';
import { createMutationRequestId, isMethodNotFound, readCanonicalSession, refusalReason, SESSION_MUTATE_METHOD, SESSION_RESUME_METHOD } from './session-mutate.mjs';

const CONFIG_SET = 'config.set';

function clean(value) {
  return String(value ?? '').trim();
}

/** The level a set of panel model options asks for: 'none' with thinking off. */
export function reasoningLevel(options) {
  if (!options || typeof options !== 'object') return '';
  if (options.thinkingEnabled === false) return 'none';
  return clean(options.reasoningEffort).toLowerCase();
}

/**
 * The config.set requests that move a session from `previous` to `requested` panel options:
 * reasoning when its level changed, Fast when it changed. Nothing for an unchanged pick.
 */
export function modelOptionPickRequests({ sessionId = '', requested = null, previous = null } = {}) {
  const target = clean(sessionId);
  if (!target || !requested || typeof requested !== 'object') return [];
  const requests = [];
  const level = reasoningLevel(requested);
  if (level && level !== reasoningLevel(previous)) {
    requests.push({ method: CONFIG_SET, params: { session_id: target, key: 'reasoning', value: level } });
  }
  const fast = requested.fastMode === true;
  if (fast !== (previous?.fastMode === true)) {
    requests.push({ method: CONFIG_SET, params: { session_id: target, key: 'fast', value: fast ? 'fast' : 'normal' } });
  }
  return requests;
}

/** Send a reasoning / Fast pick. Resolves the requests sent; a refusal rejects with the gateway's error. */
export async function applyModelOptionPick(request, { sessionId = '', requested = null, previous = null } = {}) {
  const requests = modelOptionPickRequests({ sessionId, requested, previous });
  for (const { method, params } of requests) await request(method, params);
  return requests;
}

export function buildModelMutateParams({ sessionId = '', requestId = '', expectedRevision, expectedGeneration, model = '', provider = '', confirm = '' } = {}) {
  const target = clean(sessionId);
  const picked = clean(model);
  if (!target) throw new TypeError('A Hermes session id is required to switch its model.');
  if (!picked) throw new TypeError('A model is required to switch a session to it.');
  if (!Number.isInteger(expectedRevision) || !Number.isInteger(expectedGeneration)) {
    throw new TypeError('A model switch needs the revision and execution generation from a canonical read.');
  }
  // validate_action takes only non-empty strings in the payload: an empty provider or token is left out.
  const payload = { model: picked };
  if (clean(provider)) payload.provider = clean(provider);
  if (clean(confirm)) payload.confirm = clean(confirm);
  return {
    session_id: target,
    request_id: clean(requestId) || createMutationRequestId('hbe-model'),
    expected_revision: expectedRevision,
    expected_generation: expectedGeneration,
    operation: 'model',
    payload,
  };
}

/**
 * Switch a session's model on a session authority.
 *   { status: 'switched', runtime }        committed; `runtime` is the session read back after it
 *   { status: 'confirm', message, confirm } the gateway asks first: resend with `confirm` once agreed
 *   { status: 'unavailable' }              the gateway has no session.mutate (-32601)
 * Any other refusal rejects with the gateway's error. A fence refusal is re-read and sent once more:
 * it happens before any commit, so a fresh read and a new request id cannot apply twice.
 */
export async function switchSessionModel(request, { sessionId = '', model = '', provider = '', confirm = '' } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const snapshot = await readCanonicalSession(request, sessionId);
    const params = buildModelMutateParams({
      sessionId,
      expectedRevision: snapshot.revision,
      expectedGeneration: snapshot.generation,
      model,
      provider,
      confirm,
    });
    let receipt;
    try {
      receipt = await request(SESSION_MUTATE_METHOD, params);
    } catch (error) {
      if (isMethodNotFound(error)) return { status: 'unavailable' };
      const reason = refusalReason(error);
      if ((reason === 'revision_conflict' || reason === 'stale_generation') && attempt < 1) continue;
      throw error;
    }
    if (receipt?.status === 'confirmation_required' || receipt?.confirm_required === true) {
      return { status: 'confirm', message: clean(receipt.confirm_message), confirm: clean(receipt.confirm) };
    }
    if (receipt?.status === 'refused') {
      const error = new Error(`Hermes refused the model switch: ${clean(receipt.reason) || 'refused'}.`);
      error.data = { reason: clean(receipt.reason) };
      throw error;
    }
    const after = await request(SESSION_RESUME_METHOD, { session_id: params.session_id, omit_messages: true }).catch(() => null);
    return { status: 'switched', runtime: sessionRuntimeFromSnapshot(after), receipt };
  }
}
