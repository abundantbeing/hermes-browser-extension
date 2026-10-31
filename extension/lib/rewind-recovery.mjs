export const REWIND_RECOVERY_PREFIX = 'hermesBrowserRewindRecovery';

export function rewindRecoveryKey(profile = '', sessionId = '') {
  return `${REWIND_RECOVERY_PREFIX}:${String(profile || '').trim() || 'default'}:${String(sessionId || '').trim()}`;
}

export function saveRewindRecovery(storage, { profile = '', sessionId = '', text = '', needsReload = false } = {}) {
  const sid = String(sessionId || '').trim();
  const body = String(text || '');
  if (!sid || !body.trim() || !storage?.setItem) return false;
  storage.setItem(rewindRecoveryKey(profile, sid), JSON.stringify({
    sessionId: sid,
    profile: String(profile || '').trim() || 'default',
    text: body,
    needsReload: needsReload === true,
    savedAt: Date.now(),
  }));
  return true;
}

export function loadRewindRecovery(storage, { profile = '', sessionId = '' } = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid || !storage?.getItem) return null;
  try {
    const parsed = JSON.parse(storage.getItem(rewindRecoveryKey(profile, sid)) || 'null');
    if (!parsed || parsed.sessionId !== sid || !String(parsed.text || '').trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearRewindRecovery(storage, { profile = '', sessionId = '' } = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid || !storage?.removeItem) return false;
  storage.removeItem(rewindRecoveryKey(profile, sid));
  return true;
}
