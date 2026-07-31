export const DEFAULT_WAKE_WORD_PHRASE = 'hey hermes';
export const WAKE_TURN_TTL_MS = 2 * 60 * 1000;
export const WAKE_STORAGE_KEYS = Object.freeze({
  state: 'hermesBrowserWakeState',
  turn: 'hermesBrowserWakeTurn',
});
export const WAKE_MESSAGES = Object.freeze({
  configure: 'HERMES_WAKE_CONFIGURE',
  claimTurn: 'HERMES_WAKE_CLAIM_TURN',
  getState: 'HERMES_WAKE_GET_STATE',
  localDetected: 'HERMES_WAKE_LOCAL_DETECTED',
  localState: 'HERMES_WAKE_LOCAL_STATE',
  pauseLocal: 'HERMES_WAKE_LOCAL_PAUSE',
  resumeLocal: 'HERMES_WAKE_LOCAL_RESUME',
  setEnabled: 'HERMES_WAKE_SET_ENABLED',
  speak: 'HERMES_WAKE_SPEAK',
  turnReady: 'HERMES_WAKE_TURN_READY',
  turnReply: 'HERMES_WAKE_TURN_REPLY',
});

function booleanSetting(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizeWakePhrase(value = DEFAULT_WAKE_WORD_PHRASE) {
  const phrase = String(value || DEFAULT_WAKE_WORD_PHRASE)
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase()
    .slice(0, 64)
    .trim();
  return phrase || DEFAULT_WAKE_WORD_PHRASE;
}

export function normalizeWakeWordSettings(settings = {}) {
  return {
    enabled: Boolean(settings?.wakeWordEnabled),
    phrase: normalizeWakePhrase(settings?.wakeWordPhrase),
    preferNative: booleanSetting(settings?.wakeWordPreferNative, true),
    browserFallback: booleanSetting(settings?.wakeWordBrowserFallback, true),
    speakReplies: booleanSetting(settings?.wakeWordSpeakReplies, true),
  };
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchWakePhrase(transcript = '', phrase = DEFAULT_WAKE_WORD_PHRASE) {
  const normalizedTranscript = String(transcript || '').trim().toLocaleLowerCase();
  const normalizedPhrase = normalizeWakePhrase(phrase);
  if (!normalizedTranscript) return { matched: false, command: '' };
  const matcher = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegex(normalizedPhrase)}(?=$|[^\\p{L}\\p{N}])`, 'iu');
  const match = matcher.exec(normalizedTranscript);
  if (!match) return { matched: false, command: '' };
  const phraseStart = match.index + match[0].length - normalizedPhrase.length;
  const command = normalizedTranscript
    .slice(phraseStart + normalizedPhrase.length)
    .replace(/^[\s,.:;!?—–-]+/u, '')
    .trim();
  return { matched: true, command };
}

export function isLoopbackDashboardUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLocaleLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

export function normalizeWakeStatus(payload = {}) {
  return {
    enabled: Boolean(payload?.enabled),
    listening: Boolean(payload?.listening),
    available: Boolean(payload?.available),
    ownedByCaller: Boolean(payload?.owned_by_caller),
    ownerSurface: String(payload?.owner_surface || '').trim(),
    phrase: normalizeWakePhrase(payload?.phrase),
    provider: String(payload?.provider || '').trim().toLocaleLowerCase(),
    hint: String(payload?.hint || '').trim(),
    audioSilent: Boolean(payload?.audio_silent),
  };
}

export function wakeTurnIsFresh(turn = {}, now = Date.now()) {
  const createdAt = Number(turn?.createdAt);
  return Boolean(String(turn?.text || '').trim())
    && Number.isFinite(createdAt)
    && createdAt > Number(now) - WAKE_TURN_TTL_MS
    && createdAt <= Number(now) + 5000;
}
