// What the agent shows while a turn runs, apart from its tools: the reasoning it
// streams, the commentary it writes between tool calls, and how long the turn
// took. Pure: no DOM, no globals, safe to unit test.
//
// Hermes sends these in three shapes:
//   - native socket: reasoning.delta (tokens), reasoning.available (a step's
//     block), message.interim (commentary between tool calls), thinking.delta
//     (spinner text, or an explained provider wait);
//   - REST session stream: tool.progress with tool_name "_thinking" and the
//     step's reasoning in `delta`, and assistant.commentary.
// The "_thinking" row is not a tool. Counted as one, every model step added a
// tool to the list while its reasoning was dropped.

export const REASONING_PSEUDO_TOOL = '_thinking';
const REASONING_MAX_CHARS = 20_000;
// Turn lengths past this are a stale timestamp, not a turn.
const MAX_TURN_MS = 24 * 60 * 60 * 1000;

export function isReasoningPseudoTool(name = '') {
  return String(name || '').trim() === REASONING_PSEUDO_TOOL;
}

/**
 * The reasoning or commentary carried by one REST session-stream event, or null
 * when the event is something else.
 */
export function turnReasoningFromRestEvent(type = '', data = {}) {
  const payload = data && typeof data === 'object' ? data : {};
  if (type === 'tool.progress' && isReasoningPseudoTool(payload.tool_name || payload.name)) {
    return { kind: 'available', text: String(payload.delta ?? payload.preview ?? '') };
  }
  if (type === 'assistant.commentary') {
    return { kind: 'commentary', text: String(payload.text || ''), alreadyStreamed: payload.already_streamed === true };
  }
  return null;
}

/**
 * The reasoning or commentary carried by one native-socket event, or null.
 * thinking.delta is spinner text and is read with providerWaitText instead.
 */
export function turnReasoningFromSocketEvent(type = '', payload = {}) {
  const data = payload && typeof payload === 'object' ? payload : {};
  if (type === 'reasoning.delta') return { kind: 'delta', text: String(data.text || '') };
  if (type === 'reasoning.available') return { kind: 'available', text: String(data.text || '') };
  if (type === 'message.interim') {
    return { kind: 'commentary', text: String(data.text || ''), alreadyStreamed: data.already_streamed === true };
  }
  return null;
}

export function emptyTurnReasoning() {
  return { text: '', segmentStart: 0, closed: true };
}

function appendParagraph(state, text) {
  const body = String(text || '').trim();
  if (!body) return { ...state, closed: true };
  const joined = state.text ? `${state.text.trimEnd()}\n\n${body}` : body;
  return { text: joined, segmentStart: joined.length - body.length, closed: true };
}

const fingerprint = (value) => String(value || '').replace(/\s+/g, ' ').trim();

/**
 * Fold one update into the turn's reasoning text.
 *   delta: tokens of the current step, appended as they stream;
 *   available: a step's whole block (REST sends only this, capped at 500 chars;
 *     the socket sends it after the step's deltas, so a block the deltas
 *     already showed is not repeated);
 *   commentary: text written beside tool calls;
 *   boundary: a tool started, so the next delta opens a new paragraph.
 */
export function reduceTurnReasoning(state = emptyTurnReasoning(), update = {}) {
  const current = { ...emptyTurnReasoning(), ...state };
  const text = String(update?.text || '');
  let next = current;
  switch (update?.kind) {
    case 'delta': {
      if (!text) return current;
      if (current.closed) {
        const prefix = current.text ? `${current.text.trimEnd()}\n\n` : '';
        next = { text: `${prefix}${text.replace(/^\s+/, '')}`, segmentStart: prefix.length, closed: false };
      } else {
        next = { ...current, text: `${current.text}${text}` };
      }
      break;
    }
    case 'available': {
      const block = fingerprint(text);
      if (!block) return { ...current, closed: true };
      const streamed = fingerprint(current.text.slice(current.segmentStart));
      // REST caps the block at 500 chars, so compare the shorter of the two.
      const probe = block.slice(0, Math.min(block.length, 160));
      if (streamed && (streamed.startsWith(probe) || fingerprint(current.text).includes(probe))) {
        return { ...current, closed: true };
      }
      next = appendParagraph(current, text);
      break;
    }
    case 'commentary':
      next = appendParagraph(current, text);
      break;
    case 'boundary':
      return current.closed ? current : { ...current, closed: true };
    default:
      return current;
  }
  if (next.text.length > REASONING_MAX_CHARS) {
    const cut = next.text.length - REASONING_MAX_CHARS;
    next = { ...next, text: `…${next.text.slice(cut)}`, segmentStart: Math.max(0, next.segmentStart - cut + 1) };
  }
  return next;
}

/**
 * The reply text left once a note Hermes already streamed as reply text moves
 * to the reasoning box: what followed the note, usually ''. Null when the
 * streamed text does not contain the note, so the caller leaves it alone.
 */
export function replyTextAfterCommentary(streamed = '', commentary = '') {
  const text = String(streamed || '');
  const note = String(commentary || '').trim();
  if (!note) return null;
  const at = text.lastIndexOf(note);
  if (at < 0) return null;
  return text.slice(at + note.length).replace(/^\s+/, '');
}

/**
 * A thinking.delta frame that explains a wait on the provider ("⏳ still waiting
 * on …", "↻ rate limited …"), or '' for the spinner rewrites Hermes sends the
 * rest of the time. Same rule as Hermes Desktop.
 */
export function providerWaitText(text = '') {
  const value = String(text || '').trim();
  return /^(?:⏳|⚠|↻|⚙)\s*(?:(?:still\s+)?waiting on|loading|processing prompt|no (?:output|response)|model returned|rate limited|provider (?:overloaded|temporarily unavailable))/i.test(value)
    ? value
    : '';
}

function durationParts(ms) {
  const total = Math.round(ms / 1000);
  return { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60 };
}

/**
 * A short turn length: "<1s", "14s", "1m 05s", "1h 02m". The UI locale's
 * narrow duration format where the browser has Intl.DurationFormat.
 * '' for an unknown, negative or implausible length.
 * An explicit `DurationFormat` option (even `undefined` or `null`) replaces the
 * browser's: a destructuring default would quietly bring the global back.
 */
export function formatTurnDuration(ms, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const { locale } = opts;
  const DurationFormat = Object.hasOwn(opts, 'DurationFormat') ? opts.DurationFormat : globalThis.Intl?.DurationFormat;
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0 || value > MAX_TURN_MS) return '';
  if (value < 1000) return '<1s';
  const { hours, minutes, seconds } = durationParts(value);
  const parts = hours ? { hours, minutes } : minutes ? { minutes, seconds } : { seconds };
  if (typeof DurationFormat === 'function') {
    try {
      return new DurationFormat(locale || undefined, { style: 'narrow' }).format(parts);
    } catch {
      // Unknown locale tag: the fixed form below.
    }
  }
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function storedReasoningText(message = {}) {
  for (const value of [message.reasoning, message.reasoning_content]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * What each turn of a stored transcript shows beside its last reply: how long
 * the turn ran (user message to last reply, from their timestamps) and the
 * reasoning Hermes stored on the turn's assistant rows, including the rows
 * that only called tools. Returns Map(last assistant message -> { durationMs,
 * reasoning }); durationMs is null when either time is unknown. Messages carry
 * `role`, `content` and `ts` (ms or unix seconds through normalizeTs).
 */
export function storedTurnSummaries(messages = [], { normalizeTs = (value) => value } = {}) {
  const summaries = new Map();
  let startedAt = null;
  let lastReply = null;
  let reasoning = [];
  const close = () => {
    if (!lastReply) return;
    const endedAt = normalizeTs(lastReply.ts);
    const length = startedAt !== null && Number.isFinite(endedAt) ? endedAt - startedAt : NaN;
    const durationMs = Number.isFinite(length) && length >= 0 && length <= MAX_TURN_MS ? length : null;
    const text = [...new Set(reasoning)].join('\n\n');
    summaries.set(lastReply, {
      durationMs,
      reasoning: text.length > REASONING_MAX_CHARS ? `…${text.slice(text.length - REASONING_MAX_CHARS)}` : text,
    });
  };
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = String(message?.role || '').toLowerCase();
    if (role === 'user') {
      close();
      const at = normalizeTs(message.ts);
      startedAt = Number.isFinite(at) ? at : null;
      lastReply = null;
      reasoning = [];
    } else if (role === 'assistant') {
      const text = storedReasoningText(message);
      if (text) reasoning.push(text);
      if (String(message.content || '').trim()) lastReply = message;
    }
  }
  close();
  return summaries;
}

/**
 * When a run the panel starts following began: the user message the loaded
 * history ends with (its reply is still being written), else now. Only the
 * length shown beside its tools depends on it.
 */
export function liveTurnStartedAt(history = [], { normalizeTs = (value) => value, now = Date.now() } = {}) {
  const rows = Array.isArray(history) ? history : [];
  const lastUser = rows.findLastIndex((message) => message?.role === 'user');
  const replied = lastUser >= 0 && rows.slice(lastUser + 1)
    .some((message) => message?.role === 'assistant' && String(message.content || '').trim());
  const at = lastUser >= 0 && !replied ? normalizeTs(rows[lastUser].ts) : null;
  return Number.isFinite(at) && at <= now && now - at < MAX_TURN_MS ? at : now;
}
