import { DEFAULT_WAKE_WORD_PHRASE, matchWakePhrase, normalizeWakePhrase } from './wake-word.mjs';

export function createWakeTranscriptProcessor({
  phrase = DEFAULT_WAKE_WORD_PHRASE,
  commandWindowMs = 12_000,
  now = () => Date.now(),
} = {}) {
  let paused = false;
  let awaitingCommandUntil = 0;
  let wakePhrase = normalizeWakePhrase(phrase);

  return {
    accept(transcript = '') {
      if (paused) return { type: 'none', command: '' };
      const text = String(transcript || '').trim();
      if (!text) return { type: 'none', command: '' };
      const currentTime = Number(now());
      if (awaitingCommandUntil > currentTime) {
        awaitingCommandUntil = 0;
        return { type: 'command', command: text };
      }
      awaitingCommandUntil = 0;
      const match = matchWakePhrase(text, wakePhrase);
      if (!match.matched) return { type: 'none', command: '' };
      if (match.command) return { type: 'command', command: match.command };
      awaitingCommandUntil = currentTime + Math.max(1000, Number(commandWindowMs) || 12_000);
      return { type: 'wake', command: '' };
    },
    pause() {
      paused = true;
      awaitingCommandUntil = 0;
    },
    resume() {
      paused = false;
      awaitingCommandUntil = 0;
    },
    setPhrase(nextPhrase = DEFAULT_WAKE_WORD_PHRASE) {
      wakePhrase = normalizeWakePhrase(nextPhrase);
      awaitingCommandUntil = 0;
    },
    state() {
      return { paused, awaitingCommand: awaitingCommandUntil > Number(now()), phrase: wakePhrase };
    },
  };
}
