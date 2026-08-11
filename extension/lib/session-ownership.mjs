export const SESSION_SURFACE_SOURCES = Object.freeze({
  SIDE_PANEL: 'hermes_browser',
  FULL_TAB: 'hermes_web',
});

function clean(value = '') {
  return String(value || '').trim();
}

function normalized(value = '') {
  return clean(value).toLowerCase();
}

function sessionObject(session) {
  return session && typeof session === 'object' ? session : {};
}

export function sessionMessageCount(session = {}) {
  const value = sessionObject(session);
  const direct = [value.message_count, value.messageCount, value.messages_count]
    .map(Number)
    .find((value) => Number.isInteger(value) && value >= 0);
  if (direct !== undefined) return direct;
  if (Array.isArray(value.messages)) return value.messages.length;
  return null;
}

export function foreignSessionSourceLabel(session = {}) {
  const value = sessionObject(session);
  const source = normalized(value.source);
  const label = clean(value.sourceLabel || value.source);
  const known = {
    api: 'API',
    api_server: 'API',
    cli: 'CLI',
    dashboard: 'Dashboard',
    hermes_browser: 'Hermes Browser Extension',
    hermes_web: 'Hermes Web',
    webui: 'Hermes Web',
  };
  return known[source] || label || 'another Hermes surface';
}

export function sessionOwnedBySurface(session = {}, expectedSource = '') {
  const value = sessionObject(session);
  const sessionId = normalized(value.id);
  const source = normalized(value.source);
  const expected = normalized(expectedSource);
  if (!sessionId || !expected) return false;
  if (source === expected) return true;
  if (expected === SESSION_SURFACE_SOURCES.SIDE_PANEL) {
    return sessionId === 'hermes-browser-extension' || sessionId.startsWith('hermes-browser-extension-');
  }
  if (expected === SESSION_SURFACE_SOURCES.FULL_TAB) {
    return sessionId.startsWith('hermes-web-');
  }
  return false;
}

export function requiresSessionOwnershipConfirmation({
  session = {},
  expectedSource = '',
  approvedSessionIds = [],
} = {}) {
  const value = sessionObject(session);
  const sessionId = clean(value.id);
  if (!sessionId || sessionOwnedBySurface(value, expectedSource)) return false;
  if (approvedSessionIds instanceof Set) return !approvedSessionIds.has(sessionId);
  return !Array.from(approvedSessionIds || []).some((id) => clean(id) === sessionId);
}

export function sessionOwnershipNotice({ session = {}, expectedSource = '' } = {}) {
  const sourceLabel = foreignSessionSourceLabel(session);
  const count = sessionMessageCount(session);
  const countDetail = count === null
    ? 'Its message count is unavailable.'
    : count === 1
      ? 'It already contains 1 message.'
      : `It already contains ${count} messages.`;
  const newChatLabel = normalized(expectedSource) === SESSION_SURFACE_SOURCES.FULL_TAB
    ? 'New Hermes Web chat'
    : 'New Browser chat';
  return Object.freeze({
    sourceLabel,
    messageCount: count,
    title: `${sourceLabel} session selected`,
    detail: `${countDetail} Two Browser surfaces writing the same session can overwrite or reorder transcript updates. Start a new chat, or continue here intentionally.`,
    newChatLabel,
    continueLabel: `Continue in ${sourceLabel}`,
  });
}
