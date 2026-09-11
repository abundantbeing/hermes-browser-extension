// Live subagent roster for the Browser composer dock. Pure helpers only.

export const SUBAGENT_EVENT_TYPES = Object.freeze([
  'subagent.spawn_requested',
  'subagent.start',
  'subagent.thinking',
  'subagent.tool',
  'subagent.progress',
  'subagent.complete',
]);

const SUBAGENT_EVENT_SET = new Set(SUBAGENT_EVENT_TYPES);
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const MAX_STREAM = 6;
const PREVIEW_MAX = 220;
const TOOL_PREVIEW_MAX = 96;

export const SUBAGENT_STEER_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 4 6 10h4v4a4 4 0 0 0 4 4h4v-2h-4a2 2 0 0 1-2-2v-4h4L12 4Z"/></svg>';
export const SUBAGENT_STOP_ICON = '■';

const isStr = (value) => typeof value === 'string';
const str = (value) => (isStr(value) ? value : '');
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

export function isSubagentEventName(name = '') {
  return SUBAGENT_EVENT_SET.has(String(name || '').trim());
}

function compact(text, max = PREVIEW_MAX) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function toolLabel(name = '') {
  const parts = String(name || '').split('_').filter(Boolean);
  if (!parts.length) return String(name || '');
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

export function formatSubagentTool(name = '', preview = '') {
  const snippet = compact(preview, TOOL_PREVIEW_MAX);
  const label = toolLabel(name);
  return snippet ? `${label}("${snippet}")` : label;
}

function asStatus(value, eventType = '') {
  if (value === 'completed' || value === 'failed' || value === 'interrupted') return value;
  if (value === 'timeout' || value === 'error') return 'failed';
  if (value === 'cancelled' || value === 'canceled') return 'interrupted';
  if (eventType === 'subagent.complete') return 'failed';
  if (eventType === 'subagent.spawn_requested' && !value) return 'queued';
  return value === 'queued' ? 'queued' : 'running';
}

export function subagentIdOf(payload = {}) {
  const id = str(payload.subagent_id);
  if (id) return id;
  return `${str(payload.parent_id) || 'root'}:${num(payload.task_index) ?? 0}:${str(payload.goal)}`;
}

function asTail(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      isError: item.is_error === true,
      preview: str(item.preview) || undefined,
      tool: str(item.tool) || undefined,
    }));
}

function appendStream(stream, entry) {
  const last = stream.at(-1);
  if (last?.kind === entry.kind && last.text === entry.text && last.isError === entry.isError) return stream;
  return [...stream, entry].slice(-MAX_STREAM);
}

function timeoutSummary(payload) {
  const seconds = num(payload.duration_seconds);
  return str(payload.status) === 'timeout' ? `Timed out after ${seconds ?? '?'}s` : '';
}

function eventPayload(event = {}) {
  if (event.payload && typeof event.payload === 'object') return event.payload;
  if (event.data && typeof event.data === 'object') return event.data;
  return event && typeof event === 'object' ? event : {};
}

function streamFromPayload(payload, status, eventType, at) {
  const out = [];
  const tool = str(payload.tool_name);
  const preview = str(payload.tool_preview) || str(payload.text);
  const text = compact(str(payload.text) || preview);

  for (const tail of asTail(payload.output_tail)) {
    const line = tail.tool ? formatSubagentTool(tail.tool, tail.preview ?? '') : compact(tail.preview ?? '');
    if (line) out.push({ at, isError: tail.isError, kind: tail.tool ? 'tool' : 'progress', text: line });
  }
  if (tool) out.push({ at, isError: Boolean(payload.error), kind: 'tool', text: formatSubagentTool(tool, preview) });
  if (eventType === 'subagent.progress' && text) {
    out.push({ at, isError: Boolean(payload.error), kind: 'progress', text });
  }
  if (eventType === 'subagent.thinking' && text) {
    out.push({ at, kind: 'thinking', text });
  }
  const summary = compact(str(payload.summary) || str(payload.text) || timeoutSummary(payload));
  if (TERMINAL.has(status) && summary) {
    out.push({ at, isError: status === 'failed', kind: 'summary', text: summary });
  }
  return out;
}

function toProgress(payload, prev, eventType = '') {
  const at = Date.now();
  const status = asStatus(payload.status, eventType);
  const tool = str(payload.tool_name);
  const stream = streamFromPayload(payload, status, eventType, at).reduce(appendStream, prev?.stream ?? []);
  return {
    id: prev?.id ?? subagentIdOf(payload),
    parentId: str(payload.parent_id) || prev?.parentId || null,
    goal: str(payload.goal) || prev?.goal || 'Subagent',
    sessionId: str(payload.child_session_id) || prev?.sessionId,
    delegationId: str(payload.delegation_id) || prev?.delegationId,
    model: str(payload.model) || prev?.model,
    status,
    startedAt: prev?.startedAt ?? at,
    updatedAt: at,
    currentTool: TERMINAL.has(status)
      ? undefined
      : (tool ? formatSubagentTool(tool, str(payload.tool_preview)) : prev?.currentTool),
    stream,
    summary: str(payload.summary) || timeoutSummary(payload) || prev?.summary || undefined,
    acceptingSteer: payload.accepting_steer !== false,
  };
}

function replaceSession(state, sessionId, list) {
  return { ...state, [sessionId]: list };
}

export function applySubagentEvent(state = {}, sessionId = '', event = {}) {
  const sid = String(sessionId || '').trim();
  const type = String(event?.type || event?.name || '').trim();
  if (!sid || !isSubagentEventName(type)) return state;
  const payload = eventPayload(event);
  const id = subagentIdOf(payload);
  if (!id || id === 'root:0:') return state;
  const list = Array.isArray(state[sid]) ? state[sid] : [];
  const index = list.findIndex((item) => item.id === id);
  const prev = index >= 0 ? list[index] : undefined;
  if (prev && TERMINAL.has(prev.status)) return state;
  const next = toProgress(payload, prev, type);
  const nextList = index >= 0
    ? list.map((item) => (item.id === id ? next : item))
    : [...list, next];
  return replaceSession(state, sid, nextList);
}

export function reconcileSubagentSnapshot(state = {}, sessionId = '', children = []) {
  const sid = String(sessionId || '').trim();
  if (!sid) return state;
  const previous = Array.isArray(state[sid]) ? state[sid] : [];
  const rows = Array.isArray(children) ? children : [];
  const ids = new Set(rows.map((payload) => str(payload?.subagent_id)).filter(Boolean));
  const next = previous.filter((item) => TERMINAL.has(item.status) || ids.has(item.id));
  for (const payload of rows) {
    const id = str(payload?.subagent_id);
    if (!id) continue;
    const index = next.findIndex((item) => item.id === id);
    const prev = next[index];
    if (prev && TERMINAL.has(prev.status)) continue;
    const projected = toProgress(payload, prev);
    projected.startedAt = (num(payload.started_at) ?? 0) * 1000 || prev?.startedAt || projected.startedAt;
    projected.updatedAt = prev?.updatedAt ?? projected.startedAt;
    if (!projected.stream.length && str(payload.last_tool)) {
      projected.stream = [{ at: projected.updatedAt, kind: 'tool', text: formatSubagentTool(str(payload.last_tool)) }];
      projected.currentTool = projected.currentTool || formatSubagentTool(str(payload.last_tool));
    }
    if (index < 0) next.push(projected);
    else next[index] = projected;
  }
  return replaceSession(state, sid, next);
}

export function pruneFinishedSubagents(state = {}, sessionId = '') {
  const sid = String(sessionId || '').trim();
  if (!sid || !Array.isArray(state[sid])) return state;
  return replaceSession(state, sid, state[sid].filter((item) => item.status === 'running' || item.status === 'queued'));
}

export function clearSessionSubagents(state = {}, sessionId = '') {
  const sid = String(sessionId || '').trim();
  if (!sid || !(sid in state)) return state;
  const next = { ...state };
  delete next[sid];
  return next;
}

export function activeSubagentView(items = []) {
  return (Array.isArray(items) ? items : []).filter((item) => item.status === 'queued' || item.status === 'running');
}

export function visibleSubagentView(items = []) {
  return (Array.isArray(items) ? items : []).filter(Boolean);
}

export function subagentStackSummary(items = []) {
  const rows = visibleSubagentView(items);
  const live = activeSubagentView(rows);
  const done = rows.filter((item) => TERMINAL.has(item.status));
  if (!rows.length) return '';
  const models = [...new Set(live.map((item) => String(item.model || '').trim()).filter(Boolean))];
  const short = (model) => model.split('/').pop() || model;
  const bits = [];
  if (live.length) {
    bits.push(`${live.length} live`);
    if (models.length === 1) bits.push(short(models[0]));
    else if (models.length > 1) bits.push(`${models.length} models`);
  }
  if (done.length) bits.push(`${done.length} done`);
  return bits.join(' · ');
}

export function subagentsFromListResult(result = {}) {
  if (Array.isArray(result?.subagents)) return result.subagents;
  if (Array.isArray(result?.children)) return result.children;
  if (Array.isArray(result)) return result;
  return [];
}

export function formatSubagentElapsed(startedAt, now = Date.now()) {
  const start = Number(startedAt);
  const total = Math.max(0, Math.floor((Number(now) - (Number.isFinite(start) ? start : Number(now))) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function subagentControlPayload(action = '', {
  sessionId = '',
  subagentId = '',
  text = '',
} = {}) {
  const payload = {
    session_id: String(sessionId || '').trim(),
    subagent_id: String(subagentId || '').trim(),
  };
  if (action === 'steer') payload.text = String(text || '').trim();
  return payload;
}
