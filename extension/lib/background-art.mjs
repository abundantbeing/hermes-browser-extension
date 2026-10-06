export const ORIGINAL_BACKGROUND_ART = 'assets/img/hermes-browser-enter-gate-ink.png';
export const BACKGROUND_ART_STORAGE_KEY = 'hermesBrowserBackgroundArt';

export const BACKGROUND_ART = Object.freeze([
  ORIGINAL_BACKGROUND_ART,
  'assets/img/background-art/01-living-browser-gate-ink.webp',
  'assets/img/background-art/02-memory-orrery-ink.webp',
  'assets/img/background-art/03-first-contact-ink.webp',
  'assets/img/background-art/04-network-crossing-ink.webp',
  'assets/img/background-art/05-messenger-axis-ink.webp',
  'assets/img/background-art/06-winged-passage-ink.webp',
  'assets/img/background-art/07-clockwork-dispatch-ink.webp',
  'assets/img/background-art/08-contained-cosmos-ink.webp',
  'assets/img/background-art/09-winged-dispatch-ink.webp',
  'assets/img/background-art/10-recursive-presence-ink.webp',
  'assets/img/background-art/stack-graf10-ink.webp',
  'assets/img/background-art/stack-graf13-ink.webp',
  'assets/img/background-art/stack-graf14-ink.webp',
  'assets/img/background-art/stack-graf12-ink.webp',
]);

export function pickBackgroundArt(random = Math.random, previous = '') {
  const pool = BACKGROUND_ART.filter((entry) => entry !== previous);
  const value = Number(typeof random === 'function' ? random() : random);
  const index = Number.isFinite(value)
    ? Math.min(pool.length - 1, Math.max(0, Math.floor(value * pool.length)))
    : 0;
  return pool[index];
}

export function backgroundArtCssValue(entry = '') {
  return BACKGROUND_ART.includes(entry) ? `url("${entry}")` : '';
}

export function createBackgroundArtRotation({
  root,
  document,
  storage,
  random = Math.random,
  locks = globalThis.navigator?.locks,
}) {
  let current = '';
  let hidden = document.visibilityState === 'hidden';
  let pending = Promise.resolve('');

  async function chooseAndApply() {
    let previous = current;
    try {
      const saved = await storage?.get(BACKGROUND_ART_STORAGE_KEY);
      if (BACKGROUND_ART.includes(saved?.[BACKGROUND_ART_STORAGE_KEY])) {
        previous = saved[BACKGROUND_ART_STORAGE_KEY];
      }
    } catch {
      // Artwork must not block startup when optional storage is unavailable.
    }
    current = pickBackgroundArt(random, previous);
    root.style.setProperty('--background-art', backgroundArtCssValue(current));
    try {
      await storage?.set({ [BACKGROUND_ART_STORAGE_KEY]: current });
    } catch {
      // The current page can still avoid repeats without persisted state.
    }
    return current;
  }

  function rotate() {
    pending = pending.then(() => (
      typeof locks?.request === 'function'
        ? locks.request('hermes-background-art', chooseAndApply)
        : chooseAndApply()
    )).catch(() => current);
    return pending;
  }

  function onVisibilityChange() {
    const wasHidden = hidden;
    hidden = document.visibilityState === 'hidden';
    return wasHidden && !hidden ? rotate() : pending;
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  const ready = hidden ? pending : rotate();
  return {
    ready,
    dispose() {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
