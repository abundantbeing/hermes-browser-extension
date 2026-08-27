const CONTROL_EVENT_PATTERN = /(^|\.)control(\.|$)|browser\.control/i;
const PREVIEW_LIMIT = 240;

export const BROWSER_RUNTIME_EVENT_NAMES = Object.freeze({
  runStarted: 'run.started',
  runCompleted: 'run.completed',
  assistantDelta: 'assistant.delta',
  assistantCompleted: 'assistant.completed',
  toolStarted: 'tool.started',
  toolProgress: 'tool.progress',
  toolFinished: 'tool.finished',
  approvalRequested: 'approval.requested',
  approvalResolved: 'approval.resolved',
  steerAccepted: 'steer.accepted',
  steerQueued: 'steer.queued',
  sessionReset: 'session.reset',
  subagentFinished: 'subagent.finished',
});

export const TOOL_EVENT_NAME_ALIASES = Object.freeze({
  'hermes.tool.progress': 'tool.progress',
  'tool.call.started': 'tool.started',
  'tool.call.progress': 'tool.progress',
  'tool.call.completed': 'tool.finished',
  'tool.call.finished': 'tool.finished',
  'tool.call.error': 'tool.finished',
});

const EVENT_NAME_SET = new Set(Object.values(BROWSER_RUNTIME_EVENT_NAMES));

export function browserRuntimeEventName(name = '') {
  const raw = String(name || '').trim();
  if (!raw || CONTROL_EVENT_PATTERN.test(raw)) return 'runtime.unknown';
  if (BROWSER_RUNTIME_EVENT_NAMES[raw]) return BROWSER_RUNTIME_EVENT_NAMES[raw];
  const alias = TOOL_EVENT_NAME_ALIASES[raw] || raw;
  return EVENT_NAME_SET.has(alias) ? alias : 'runtime.unknown';
}

function assistantTextFromRunCompleted(data = {}, finalizedText = '') {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const assistantParts = [];
  for (const message of messages) {
    const content = message?.role === 'assistant' && message.content ? String(message.content).trim() : '';
    if (content && !assistantParts.includes(content)) assistantParts.push(content);
  }
  if (!assistantParts.length && data.content) assistantParts.push(String(data.content).trim());
  if (finalizedText) {
    const intermediateParts = assistantParts.slice(0, -1);
    const prefix = intermediateParts.join('\n\n');
    if (!prefix || String(finalizedText).startsWith(`${prefix}\n\n`)) return String(finalizedText);
    return `${prefix}\n\n${finalizedText}`;
  }
  return assistantParts.join('\n\n');
}

// Reconcile safety: strip prior-turn bubbles from a server reconcile payload.
// Empty result falls back to the raw payload so a genuine reply is never lost.
export function filterKnownAssistantReconcileParts(reconciledText = '', knownAssistantTexts = []) {
  const raw = String(reconciledText || '');
  if (!raw || !Array.isArray(knownAssistantTexts) || knownAssistantTexts.length === 0) return raw;
  const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const known = new Set(knownAssistantTexts.map(norm).filter(Boolean));
  if (!known.size) return raw;
  const parts = raw.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const kept = parts.filter((part) => {
    if (!known.has(norm(part))) return true;
    return parts.length === 1;
  });
  if (!kept.length) return raw;
  return kept.join('\n\n');
}
export function reduceAssistantStreamText(state = {}, event = {}, knownAssistantTexts = []) {
  const current = {
    text: String(state.text || ''),
    finalized: Boolean(state.finalized),
  };
  const type = String(event.type || event.name || '').trim();
  const data = event.data && typeof event.data === 'object' ? event.data : event;
  if (type === BROWSER_RUNTIME_EVENT_NAMES.assistantDelta && data.delta && !current.finalized) {
    return { ...current, text: `${current.text}${data.delta}` };
  }
  if (type === BROWSER_RUNTIME_EVENT_NAMES.assistantCompleted && data.content) {
    return { text: filterKnownAssistantReconcileParts(String(data.content), knownAssistantTexts), finalized: true };
  }
  if (type === BROWSER_RUNTIME_EVENT_NAMES.runCompleted) {
    // Defensive reconcile: a degraded server transcript can defeat turn-start
    // detection and fold PRIOR turns into run.completed.messages. Drop parts
    // this panel already rendered; current-turn segments survive.
    // Refs: Firefox stacked-replies session 4d0c24 (2026-08-27).
    const reconciled = filterKnownAssistantReconcileParts(
      assistantTextFromRunCompleted(data, current.finalized ? current.text : ''),
      knownAssistantTexts,
    );
    return reconciled ? { ...current, text: reconciled } : current;
  }
  return current;
}

function redactEventPreview(value = '') {
  return String(value || '')
    .replace(/Authorization:\s*Bearer\s+[^\n]+/gi, 'Authorization: Bearer [REDACTED_BEARER]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED_BEARER]')
    .replace(/(api[_-]?key|token|password|secret)=([^\s&]+)/gi, '$1=[REDACTED]')
    .replace(/Cookie:\s*[^\n]+/gi, 'Cookie: [REDACTED]')
    .replace(/Authorization:\s*(?!Bearer \[REDACTED_BEARER\])[^\n]+/gi, 'Authorization: [REDACTED]')
    .slice(0, PREVIEW_LIMIT);
}

function toolStatusForEvent(name = '', data = {}) {
  const explicit = String(data.status || data.state || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (name === BROWSER_RUNTIME_EVENT_NAMES.toolStarted) return 'started';
  if (name === BROWSER_RUNTIME_EVENT_NAMES.toolFinished) return 'completed';
  return 'progress';
}

function normalizeToolEventName(name = '', status = '') {
  if (name === BROWSER_RUNTIME_EVENT_NAMES.toolProgress) {
    if (/^(started|running|begin|pending)$/i.test(status)) return BROWSER_RUNTIME_EVENT_NAMES.toolStarted;
    if (/^(completed|finished|done|success|error|failed)$/i.test(status)) return BROWSER_RUNTIME_EVENT_NAMES.toolFinished;
  }
  return name;
}

export function normalizeBrowserRuntimeEvent(event = {}) {
  const rawType = String(event.type || event.event || event.name || '').trim();
  const data = event.data && typeof event.data === 'object' ? event.data : event;
  const aliased = TOOL_EVENT_NAME_ALIASES[rawType] || rawType;
  const baseName = browserRuntimeEventName(aliased);
  if (baseName === 'runtime.unknown') {
    return {
      name: 'runtime.unknown',
      rawName: rawType,
      data,
      preview: redactEventPreview(data.preview || data.message || ''),
    };
  }

  const status = toolStatusForEvent(baseName, data);
  const name = normalizeToolEventName(baseName, status);
  const toolName = String(data.tool_name || data.toolName || data.name || data.rawName || '').trim();
  return {
    name,
    rawName: rawType,
    status,
    toolName,
    data,
    preview: redactEventPreview(data.preview || data.detail || data.message || data.input || data.output || ''),
  };
}
