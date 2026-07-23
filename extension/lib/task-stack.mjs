export const TASK_STATUSES = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

const MAX_TASKS = 100;
const MAX_TASK_CONTENT = 300;
const MAX_TASK_ID = 120;
const MAX_STORED_SESSIONS = 50;

function compact(value = '', limit = MAX_TASK_CONTENT) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, limit);
}

function normalizedStatus(value = '') {
  const status = String(value || '').trim().toLowerCase().replace(/[ -]+/g, '_');
  if (['completed', 'complete', 'done', 'success', 'succeeded'].includes(status)) return TASK_STATUSES.COMPLETED;
  if (['in_progress', 'working', 'active', 'running', 'started'].includes(status)) return TASK_STATUSES.IN_PROGRESS;
  if (['cancelled', 'canceled', 'skipped'].includes(status)) return TASK_STATUSES.CANCELLED;
  return TASK_STATUSES.PENDING;
}

export function normalizeTaskStack(value = []) {
  if (!Array.isArray(value)) return [];
  const tasks = [];
  let hasActive = false;
  for (const raw of value.slice(0, MAX_TASKS)) {
    if (!raw || typeof raw !== 'object') continue;
    const content = compact(raw.content || raw.text || raw.title || raw.task);
    if (!content) continue;
    const id = compact(raw.id || raw.task_id || raw.taskId || `task-${tasks.length + 1}`, MAX_TASK_ID);
    let status = normalizedStatus(raw.status || raw.state);
    if (status === TASK_STATUSES.IN_PROGRESS) {
      if (hasActive) status = TASK_STATUSES.PENDING;
      else hasActive = true;
    }
    tasks.push(Object.freeze({ id, content, status }));
  }
  return tasks;
}

function parseJsonValue(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || !['{', '['].includes(text[0])) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function todosFromCandidate(candidate) {
  const parsed = parseJsonValue(candidate);
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return null;
  if (Array.isArray(parsed.todos)) return parsed.todos;
  if (Array.isArray(parsed.tasks)) return parsed.tasks;
  return null;
}

function eventToolName(event = {}, data = {}) {
  return compact(
    event.toolName
      || event.tool_name
      || event.name === 'todo' && event.name
      || data.toolName
      || data.tool_name
      || data.name
      || data.rawName
      || '',
    120,
  ).toLowerCase();
}

export function taskStackFromToolEvent(event = {}) {
  if (!event || typeof event !== 'object') return null;
  const data = event.data && typeof event.data === 'object' ? event.data : event;
  const toolName = eventToolName(event, data);
  if (!(toolName === 'todo' || toolName.endsWith('/todo') || toolName.endsWith(':todo'))) return null;
  const candidates = [
    data.input,
    data.arguments,
    data.args,
    data.output,
    data.result,
    data.payload,
    event.input,
    event.output,
    event.result,
    data,
    event,
  ];
  for (const candidate of candidates) {
    const todos = todosFromCandidate(candidate);
    if (todos) return normalizeTaskStack(todos);
  }
  return null;
}

export function taskStackProgress(tasks = []) {
  const normalized = Array.isArray(tasks) ? tasks : [];
  const progress = {
    total: normalized.length,
    completed: 0,
    active: 0,
    pending: 0,
    cancelled: 0,
    percent: 0,
  };
  for (const task of normalized) {
    const status = normalizedStatus(task?.status);
    if (status === TASK_STATUSES.COMPLETED) progress.completed += 1;
    else if (status === TASK_STATUSES.IN_PROGRESS) progress.active += 1;
    else if (status === TASK_STATUSES.CANCELLED) progress.cancelled += 1;
    else progress.pending += 1;
  }
  progress.percent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  return progress;
}

export function updateTaskStackStore(store = {}, sessionId = '', tasks = [], options = {}) {
  const cleanSessionId = compact(sessionId, 200);
  if (!cleanSessionId) return { ...(store || {}) };
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const maxSessions = Math.max(1, Number(options.maxSessions || MAX_STORED_SESSIONS));
  const normalizedTasks = normalizeTaskStack(tasks);
  const next = { ...(store && typeof store === 'object' ? store : {}) };
  const hasActiveWork = normalizedTasks.some((task) => (
    task.status === TASK_STATUSES.PENDING || task.status === TASK_STATUSES.IN_PROGRESS
  ));
  if (hasActiveWork) {
    next[cleanSessionId] = {
      tasks: normalizedTasks,
      updatedAt: now,
    };
  } else {
    delete next[cleanSessionId];
  }
  const ordered = Object.entries(next)
    .sort((left, right) => Number(right[1]?.updatedAt || 0) - Number(left[1]?.updatedAt || 0))
    .slice(0, maxSessions);
  return Object.fromEntries(ordered);
}
