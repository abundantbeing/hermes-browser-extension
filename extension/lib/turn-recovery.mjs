export function classifyTurnRecovery(error = {}) {
  if (error?.requestAccepted || !error?.fallbackSafe) return 'recover';
  return 'fallback';
}

function recoveryErrorText(value = '') {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object') {
    return String(value?.error?.message || value?.error || value?.message || '');
  }
  return String(value || '');
}

export function sessionContextFailureRecovery(error = {}, capabilities = {}) {
  const text = recoveryErrorText(error).replace(/\s+/g, ' ').trim().toLowerCase();
  const contextExceeded = /context length exceeded|request payload too large|context window exceeded/.test(text);
  const compressionExhausted = /max(?:imum)? compression attempts|compression failed after/.test(text);
  if (!contextExceeded || !compressionExhausted) return null;
  return {
    kind: 'compression-exhausted',
    action: capabilities?.sessionCompress ? 'compact' : 'new-session',
    preserveDraft: true,
    retryTurn: false,
    gatewayStatus: 'degraded',
  };
}

export function latestAssistantAfterUser(rows = [], userContent = '') {
  const target = String(userContent || '');
  if (!target || !Array.isArray(rows)) return '';

  let latestUserIndex = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.role === 'user' && String(row.content || '') === target) {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return '';

  for (let index = latestUserIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.role !== 'assistant') continue;
    const content = String(row.content || '').trim();
    if (content) return content;
  }
  return '';
}
