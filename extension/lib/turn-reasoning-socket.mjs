// Reasoning on the native socket: asking a session authority to stream it, and
// folding its frames for a reply's reasoning box (see turn-activity.mjs).
import { WS_METHODS } from './gateway-ws.mjs';
import { providerWaitText, replyTextAfterCommentary, turnReasoningFromSocketEvent } from './turn-activity.mjs';

const reasoningShownSessions = new WeakMap();

/**
 * A session authority streams a turn's reasoning only to a session that asked
 * for it (config.set show_reasoning: session-scoped, never a settings write);
 * Desktop and the TUI get it by default. Asked once per session on each
 * socket, before its first prompt, because a turn wires its reasoning sink as
 * it starts. A gateway without the key streams no reasoning; the turn runs the
 * same.
 */
export async function ensureSessionShowsReasoning(client, sessionId, { shown = reasoningShownSessions } = {}) {
  if (client?.readyPayload?.session_authority !== true || !sessionId) return false;
  let sessions = shown.get(client);
  if (!sessions) shown.set(client, sessions = new Set());
  if (sessions.has(sessionId)) return false;
  sessions.add(sessionId);
  try {
    await client.request(WS_METHODS.configSet, { session_id: sessionId, key: 'show_reasoning', value: 'on' }, { timeoutMs: 3_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Subscribe to the frames that carry reasoning, between-tool notes or a
 * provider wait for one session. A note Hermes already streamed as reply text
 * leaves the reply text through setText. Returns the unsubscribe functions.
 */
export function bindDashboardReasoning(client, forThisSession, { getText, setText, onReasoning, onActivity = () => {} } = {}) {
  const offs = ['reasoning.delta', 'reasoning.available', 'message.interim'].map((type) => client.on(type, (event) => {
    if (!forThisSession(event)) return;
    onActivity();
    const update = turnReasoningFromSocketEvent(type, event.payload);
    if (update?.kind === 'commentary' && update.alreadyStreamed) {
      const rest = replyTextAfterCommentary(getText?.(), update.text);
      if (rest !== null) setText?.(rest);
    }
    onReasoning?.(update);
  }));
  offs.push(client.on('thinking.delta', (event) => {
    if (!forThisSession(event)) return;
    const wait = providerWaitText(event.payload?.text);
    if (wait) onReasoning?.({ kind: 'wait', text: wait });
  }));
  return offs;
}
