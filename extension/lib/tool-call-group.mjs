import { sanitizeToolPreview } from './common.mjs';
import { isReasoningPseudoTool } from './turn-activity.mjs';

// Compact classic faces stay inline inside the existing thinking card.
export const CLASSIC_THINKING_FACES = Object.freeze([
  '(o_o)', '(¬_¬)', '(•_•)', '(°_°)', '(¬‿¬)', '(◔_◔)', '(⊙_⊙)', '(^_^)',
]);
export function classicThinkingFace(step = 0) {
  return CLASSIC_THINKING_FACES[Math.abs(Math.floor(Number(step) || 0)) % CLASSIC_THINKING_FACES.length];
}

export function mergeToolCallActivity(calls = [], activity = {}) {
  const id = activity.activityId || activity.tool_call_id || '';
  const name = activity.rawName || activity.tool_name || activity.name || 'Hermes tool';
  // Hermes sends a model step's reasoning as a "_thinking" progress row; it is
  // shown as reasoning, never counted as a tool.
  if (isReasoningPseudoTool(name)) return calls;
  const next = [...calls];
  let index = id ? next.findIndex(call => (call.activityId || call.tool_call_id) === id) : -1;
  const done = ['completed', 'failed', 'done', 'error'].includes(activity.status) || activity.type === 'tool.complete';
  if (index < 0 && done) {
    index = next.findLastIndex(call => (call.rawName || call.tool_name || call.name) === name && !['completed', 'failed', 'done', 'error'].includes(call.status));
  }
  const entry = { ...activity, rawName: name, status: done ? (activity.status || 'completed') : 'progress' };
  if (index >= 0) next[index] = { ...next[index], ...entry, preview: entry.preview || next[index].preview };
  else next.push(entry);
  return next;
}

export function groupToolHistoryMessages(messages = []) {
  const output = [];
  let group = null;
  for (const message of messages) {
    if (message.role === 'user') group = null;
    if (!message.toolActivity) { output.push(message); continue; }
    if (!group) { group = { role: 'tool-group', calls: [] }; output.push(group); }
    group.calls.push(message.toolActivity);
  }
  return output;
}

export function createToolCallGroup({ document, calls = [], running = false, open = false, translate = value => value, formatCountLabel = null } = {}) {
  const root = document.createElement('details');
  root.className = 'tool-call-group';
  root.open = open;
  const summary = document.createElement('summary');
  const title = document.createElement('span');
  title.className = 'tool-call-group-title';
  const state = document.createElement('span');
  state.className = 'tool-call-group-state';
  summary.append(title, state);
  const list = document.createElement('ol');
  list.className = 'tool-call-list';
  root.append(summary, list);
  updateToolCallGroup(root, { calls, running, translate, formatCountLabel });
  return root;
}

// The turn's length beside the tool count ("Used 3 tools · 14s"): live while
// it runs, final once it ends. '' removes it. Kept apart from
// updateToolCallGroup so a tick never touches the list.
export function setToolCallGroupTime(root, label = '') {
  const summary = root?.querySelector?.(':scope > summary');
  if (!summary) return;
  let time = summary.querySelector('.tool-call-group-time');
  if (!label) {
    time?.remove();
    return;
  }
  if (!time) {
    time = root.ownerDocument.createElement('span');
    time.className = 'tool-call-group-time';
    summary.querySelector('.tool-call-group-title')?.after(time);
  }
  if (time.textContent !== label) time.textContent = label;
}

// Update existing disclosure nodes. Never replace them on a tool event or
// snapshot: open state, pointer interaction and native scroll belong to the user.
export function updateToolCallGroup(root, { calls = [], running = false, translate = value => value, formatCountLabel = null } = {}) {
  const document = root.ownerDocument;
  root.dataset.running = String(running);
  root.querySelector('.tool-call-group-title').textContent = formatCountLabel
    ? formatCountLabel(running ? 'live_tools.using_count' : 'live_tools.used_count', { count: calls.length })
    : `${translate(running ? 'Using' : 'Used')} ${calls.length} ${translate(calls.length === 1 ? 'tool' : 'tools')}`;
  const names = [...new Set(calls.map(call => call.rawName || call.tool_name || call.name || 'Hermes tool'))];
  root.querySelector('.tool-call-group-state').textContent = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
  const list = root.querySelector('.tool-call-list');
  const previousScroll = list.scrollTop;
  const entries = [...list.children];
  calls.forEach((call, index) => {
    let item = entries[index];
    if (!item) {
      item = document.createElement('li');
      const detail = document.createElement('details');
      detail.className = 'tool-call-entry';
      const header = document.createElement('summary');
      const name = document.createElement('span');
      name.className = 'tool-call-name';
      const status = document.createElement('span');
      status.className = 'tool-call-status';
      header.append(name, status);
      detail.append(header);
      item.append(detail);
      list.append(item);
    }
    const name = call.rawName || call.tool_name || call.name || 'Hermes tool';
    const label = translate(['completed', 'done'].includes(call.status) ? 'Completed' : ['failed', 'error'].includes(call.status) ? 'Failed' : running ? 'Running' : 'Completed');
    const nameNode = item.querySelector('.tool-call-name');
    const statusNode = item.querySelector('.tool-call-status');
    if (nameNode.textContent !== name) nameNode.textContent = name;
    if (statusNode.textContent !== label) statusNode.textContent = label;
    const preview = sanitizeToolPreview(call.preview || call.details || '', 4000);
    if (preview) {
      let pre = item.querySelector('pre');
      if (!pre) { pre = document.createElement('pre'); item.querySelector('details').append(pre); }
      if (pre.textContent !== preview) pre.textContent = preview;
    }
  });
  entries.slice(calls.length).forEach(item => item.remove());
  list.scrollTop = previousScroll;
}
