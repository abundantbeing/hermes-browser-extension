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

// A profile's Bot Chat from before the gateway kept chats itself (a Desktop, CLI or TUI chat with
// no gateway receipt) is handed over only by a native client on the host: a Desktop or TUI open, or
// `hermes sessions adopt`. Browser reaches the gateway over the API and is never that client, so a
// turn into it is refused `bot_chat_unbound` until the owner adopts it once. The state names the
// one step that unblocks it instead of the gateway's bare refusal.
export function botChatRefusalState(delivery, { profile = '', name = '' } = {}) {
  if (delivery?.status !== 'refused' || delivery.code !== 'bot_chat_unbound') return null;
  const who = text(name) || 'This bot';
  const scoped = text(profile);
  const command = scoped && scoped !== 'default' ? `hermes -p ${scoped} sessions adopt` : 'hermes sessions adopt';
  return {
    kind: 'bot-chat-unbound',
    title: 'Open this Bot Chat once in Hermes Desktop',
    detail: `${who}'s Bot Chat was started before Hermes kept chats itself, and only the computer running Hermes can hand it over. Open ${who}'s Bot Chat once in Hermes Desktop, or run \`${command}\` on that computer, then send again. Nothing was sent, and your message was kept as a draft.`,
    preserveDraft: true,
    gatewayStatus: 'connected',
  };
}

// A Bot Chat the gateway moved aside keeps its id and its messages under a visible title,
// `Bot Chat (<source> <id>)` (gateway/session_bot.py _displace_bot_chat): the bot's earlier messages
// before Hermes started its chat over. The newest such chat that holds any, else null.
export function movedAsideBotChat(rows = []) {
  const moved = (Array.isArray(rows) ? rows : []).filter((row) => /^Bot Chat \(.+\)$/.test(text(row?.title))
    && text(row?.id) && Number(row?.message_count || 0) > 0);
  const recency = (row) => Number(row?.last_active || row?.started_at || 0);
  moved.sort((a, b) => recency(b) - recency(a));
  return moved[0] || null;
}
