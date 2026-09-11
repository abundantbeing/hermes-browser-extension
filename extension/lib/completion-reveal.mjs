// Smooth reveal for background completion replies. Async delegation results
// land through history reconciliation (a fetch), not a live token stream, so
// the transcript otherwise pops the finished reply in fully formed. These are
// the pure helpers: which trailing rows are new, and how to pace the reveal.
// DOM work stays in the surface scripts.

export const COMPLETION_REVEAL_MIN_MS = 900;
export const COMPLETION_REVEAL_MAX_MS = 2600;
export const COMPLETION_REVEAL_MS_PER_CHAR = 1.6;

function asRows(value) {
  return Array.isArray(value) ? value : [];
}

export function trailingNewMessages(previous = [], incoming = []) {
  const before = asRows(previous);
  const after = asRows(incoming);
  const tail = before[before.length - 1];
  if (!tail || typeof tail !== 'object' || !after.length) return [];
  for (let index = after.length - 1; index >= 0; index -= 1) {
    const row = after[index];
    if (!row || typeof row !== 'object') continue;
    if (String(row.role || '') === String(tail.role || '')
      && String(row.content || '') === String(tail.content || '')) {
      return after.slice(index + 1);
    }
  }
  return [];
}

export function newestAssistantReply(rows = []) {
  const list = asRows(rows);
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const row = list[index];
    if (!row || typeof row !== 'object') continue;
    if (String(row.role || '').toLowerCase() !== 'assistant') continue;
    if (Array.isArray(row.tool_calls) && row.tool_calls.length) continue;
    const content = String(row.content || '');
    if (content.trim()) return content;
  }
  return '';
}

export function completionRevealPlan(text = '', {
  minMs = COMPLETION_REVEAL_MIN_MS,
  maxMs = COMPLETION_REVEAL_MAX_MS,
  msPerChar = COMPLETION_REVEAL_MS_PER_CHAR,
} = {}) {
  const total = Array.from(String(text || '')).length;
  if (!total) return { total: 0, durationMs: 0, initialCount: 0 };
  const durationMs = Math.min(maxMs, Math.max(minMs, Math.round(total * msPerChar)));
  const initialCount = Math.max(1, Math.min(total, Math.round(total * 0.06)));
  return { total, durationMs, initialCount };
}

export function revealSlice(text = '', count = 0) {
  const points = Array.from(String(text || ''));
  const bounded = Math.max(0, Math.min(points.length, Math.floor(Number(count)) || 0));
  return points.slice(0, bounded).join('');
}
