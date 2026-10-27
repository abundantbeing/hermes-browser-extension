// A REST turn into a profile's Bot Chat on a session authority is not run by the API edge: the
// gateway hands it to that chat's own queue (api_server_bot_chat.admit_peer_turn) and streams the
// delivery's receipt instead of a run. Every receipt frame names `delivery_id`, and `session_id` is
// the local Bot Chat the turn entered. That is a new id when the gateway moved an older Bot Chat
// aside (one no queue can own, such as a chat an older Browser build made over REST), so the reply
// is never in the session the panel asked for. The run id those frames carry is never registered:
// GET /v1/runs/{id} answers 404, so there is no run to poll, stop or reconcile.

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// The delivery a stream frame reports, or null for an ordinary run frame.
// status: 'settled' (the reply is in the frame), 'queued' / 'claimed' (still waiting at the
// gateway's budget), or 'refused' (nothing was admitted; `code` names why).
export function botChatDeliveryFrame(type, data = {}) {
  const deliveryId = text(data?.delivery_id);
  if (!deliveryId) return null;
  const sessionId = text(data?.session_id);
  if (type === 'run.queued') {
    return { status: text(data?.status) === 'claimed' ? 'claimed' : 'queued', deliveryId, sessionId };
  }
  if (type === 'error') return { status: 'refused', deliveryId, sessionId, code: text(data?.code) };
  return { status: 'settled', deliveryId, sessionId };
}

export function isPendingBotChatDelivery(delivery) {
  return delivery?.status === 'queued' || delivery?.status === 'claimed';
}

// The Bot Chat the turn entered when it is not the one the panel asked for, else ''. A refused
// delivery entered nothing, so it never moves the view.
export function movedBotChatSessionId(requestedId, delivery) {
  const requested = String(requestedId ?? '').trim();
  const entered = text(delivery?.sessionId);
  if (!requested || !entered || entered === requested || delivery?.status === 'refused') return '';
  return entered;
}
