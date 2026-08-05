// Async delegation helpers for the browser surfaces.
//
// The gateway dispatches delegate_task asynchronously: the turn stream ends
// with the dispatcher's acknowledgement and the subagent batch result is
// injected into the session later as a separate message. These helpers decide
// when a turn triggered a delegation and when the injected batch has settled,
// so the side panel knows to poll the session until the result lands.

const ASYNC_DELEGATION_BATCH_MARKER = /\[ASYNC DELEGATION BATCH COMPLETE|deleg_[a-z0-9_-]+/i;
const DELEGATION_TURN_MARKER = /\[ASYNC DELEGATION|deleg_[a-z0-9_-]+|dispatched.*subagent|subagent.*dispatched/i;

const DEFAULT_POLL_MAX_MS = 10 * 60 * 1000;

/**
 * Whether a streamed tool event looks like a delegate/subagent dispatch.
 * The gateway emits tool.* and hermes.tool.progress events with a raw
 * toolName; both names are checked so remote-dashboard and local-api
 * surfaces behave identically.
 */
export function isDelegationToolEvent(event = {}) {
  const toolName = String(event?.toolName || event?.name || event?.rawName || '').toLowerCase();
  return toolName.includes('delegate') || toolName.includes('subagent');
}

/**
 * Whether the turn's final answer carries an async-delegation marker. This is
 * a fallback for gateways that acknowledge a dispatch in the stream text
 * without a separate tool event (e.g. "[ASYNC DELEGATION — deleg_abc]").
 */
export function turnMentionsDelegation(finalAnswer = '') {
  return DELEGATION_TURN_MARKER.test(finalAnswer || '');
}

/**
 * Whether an injected subagent batch has landed: either the session grew past
 * the turn baseline (the batch result was appended) or the last assistant
 * message carries the gateway's async-delegation completion marker. A hard
 * time cap stops the watch from running forever if the gateway never reports.
 */
export function delegationBatchSettled(messages = [], baselineCount = 0, startedAt = 0, maxMs = DEFAULT_POLL_MAX_MS) {
  if (!Array.isArray(messages) || messages.length > baselineCount) return true;
  const last = messages.length ? messages[messages.length - 1] : null;
  if (last?.role === 'assistant' && ASYNC_DELEGATION_BATCH_MARKER.test(String(last.content || ''))) return true;
  return Date.now() - startedAt >= maxMs;
}
