export function classifyTurnRecovery(error = {}) {
  if (error?.requestAccepted || !error?.fallbackSafe) return 'recover';
  return 'fallback';
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
