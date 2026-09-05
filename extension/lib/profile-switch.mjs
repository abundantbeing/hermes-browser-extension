const DEFAULT_HANDOFF_MAX_CHARS = 24_000;
const MIN_HANDOFF_MAX_CHARS = 160;

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function profileLabel(profile = '') {
  const value = clean(profile);
  if (!value) return 'Default profile';
  if (value.toLowerCase() === 'namine') return 'Naminé';
  if (value.toLowerCase() === 'riku') return 'Riku';
  if (value.toLowerCase() === 'roxas' || value.toLowerCase() === 'default') return 'Roxas';
  return value;
}

function meaningfulMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => ['user', 'assistant'].includes(String(message?.role || '').toLowerCase()))
    .map((message) => ({
      role: String(message.role).toLowerCase() === 'assistant' ? 'HERMES' : 'USER',
      content: clean(message.content),
    }))
    .filter((message) => message.content);
}

function maxLength(value, fallback = DEFAULT_HANDOFF_MAX_CHARS) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(MIN_HANDOFF_MAX_CHARS, parsed);
}

export function shouldPromptForProfileSwitch({ currentProfile = '', nextProfile = '', messages = [] } = {}) {
  return clean(currentProfile) !== clean(nextProfile) && meaningfulMessages(messages).length > 0;
}

export function buildProfileContextHandoff({
  fromProfile = '',
  sessionId = '',
  messages = [],
  maxChars = DEFAULT_HANDOFF_MAX_CHARS,
} = {}) {
  const limit = maxLength(maxChars);
  const header = [
    '[Hermes profile handoff · reference context only]',
    `Previous profile: ${profileLabel(fromProfile)}`,
    `Previous Hermes Browser session: ${clean(sessionId) || 'unknown'}`,
    'Note for the agent: Continue conversation using this background. Answer directly without saying "handoff received":',
  ].join('\n');
  const footer = '[End prior-session context]';
  const rows = meaningfulMessages(messages).map((message) => `${message.role}: ${message.content}`);
  const full = `${header}\n${rows.join('\n')}\n${footer}`;
  if (full.length <= limit) return full;

  const omission = '[Earlier context omitted to stay within the handoff limit.]';
  const prefix = `${header}\n${omission}\n`;
  const suffix = `\n${footer}`;
  const budget = Math.max(0, limit - prefix.length - suffix.length);
  const selected = [];
  let used = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const separator = selected.length ? 1 : 0;
    if (used + row.length + separator > budget) {
      if (!selected.length && budget > 0) selected.unshift(row.slice(-budget));
      break;
    }
    selected.unshift(row);
    used += row.length + separator;
  }
  return `${prefix}${selected.join('\n')}${suffix}`.slice(0, limit);
}

export function profileContextHandoffForSession(settings = {}, sessionId = '') {
  const targetSessionId = clean(sessionId);
  const boundSessionId = clean(settings?.pendingProfileContextHandoffSessionId);
  const handoff = clean(settings?.pendingProfileContextHandoff);
  return targetSessionId && boundSessionId === targetSessionId ? handoff : '';
}
