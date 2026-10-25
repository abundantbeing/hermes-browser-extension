export const ORIGINAL_BACKGROUND_ART = 'assets/img/hermes-browser-enter-gate-ink.png';
export const BACKGROUND_ART_STORAGE_KEY = 'hermesBrowserBackgroundArt';
// How many recent picks a newly opened panel avoids, so panels open side by
// side in different tabs show different artwork.
export const BACKGROUND_ART_RECENT_LIMIT = 5;

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

// The four backgrounds the user picked as the extension's main ones, in their
// order. They are drawn noticeably more often than the rest, in normal use and
// in first-run setup.
export const MAIN_BACKGROUND_ART = Object.freeze([
  'assets/img/background-art/05-messenger-axis-ink.webp',
  'assets/img/background-art/04-network-crossing-ink.webp',
  'assets/img/background-art/03-first-contact-ink.webp',
  'assets/img/background-art/10-recursive-presence-ink.webp',
]);

// First-run setup (the welcome through Connect, and the Settings "run setup
// again" flow) shows only these seven: the four main ones, then three more.
export const ONBOARDING_BACKGROUND_ART = Object.freeze([
  ...MAIN_BACKGROUND_ART,
  'assets/img/background-art/09-winged-dispatch-ink.webp',
  'assets/img/background-art/02-memory-orrery-ink.webp',
  'assets/img/background-art/01-living-browser-gate-ink.webp',
]);

// How many times more likely a main background is than any other.
export const MAIN_BACKGROUND_WEIGHT = 3;
export const OTHER_BACKGROUND_WEIGHT = 1;

export const BACKGROUND_ART_WEIGHTS = Object.freeze(Object.fromEntries(
  BACKGROUND_ART.map((entry) => [entry, MAIN_BACKGROUND_ART.includes(entry) ? MAIN_BACKGROUND_WEIGHT : OTHER_BACKGROUND_WEIGHT]),
));

/** Recent picks, newest first. Accepts the older single-string storage value. */
export function recentBackgroundArt(saved) {
  const list = Array.isArray(saved) ? saved : [saved];
  return [...new Set(list.filter((entry) => BACKGROUND_ART.includes(entry)))].slice(0, BACKGROUND_ART_RECENT_LIMIT);
}

/**
 * A weighted random entry from `pool` (the whole list by default) that avoids
 * `previous` (one entry or a list of recent ones, newest first). Deterministic
 * for a given random() value, so tests can pin it. Recent picks are avoided as
 * far as the pool allows: never more than half of it, newest first, so a small
 * pool (the seven setup images) keeps its main ones in play, and the pool never
 * runs empty.
 */
export function pickBackgroundArt(random = Math.random, previous = '', { pool = BACKGROUND_ART, weights = BACKGROUND_ART_WEIGHTS } = {}) {
  const list = pool.filter((entry) => BACKGROUND_ART.includes(entry));
  const source = list.length ? list : BACKGROUND_ART;
  const recent = (Array.isArray(previous) ? previous : [previous]).filter((entry) => source.includes(entry));
  const avoid = new Set(recent.slice(0, Math.max(1, Math.floor(source.length / 2))));
  let candidates = source.filter((entry) => !avoid.has(entry));
  if (!candidates.length) candidates = source;
  const weightOf = (entry) => {
    const weight = Number(weights?.[entry]);
    return Number.isFinite(weight) && weight > 0 ? weight : OTHER_BACKGROUND_WEIGHT;
  };
  const total = candidates.reduce((sum, entry) => sum + weightOf(entry), 0);
  const value = Number(typeof random === 'function' ? random() : random);
  const target = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) * total : 0;
  let passed = 0;
  for (const entry of candidates) {
    passed += weightOf(entry);
    if (target < passed) return entry;
  }
  return candidates.at(-1);
}

/** Setup's pool: only its seven images, whose main four carry the same weight. */
export function pickOnboardingBackgroundArt(random = Math.random, previous = '') {
  return pickBackgroundArt(random, previous, { pool: ONBOARDING_BACKGROUND_ART });
}

/**
 * Is this a first run, going by what is stored? Only an absent completed flag
 * with no legacy intro-seen flag counts; anything else (a returning user, an
 * unreadable store) uses the normal pool.
 *
 * This is deliberately the flags of shouldShowOnboarding (response-presentation)
 * without its message count: the panel picks its first picture before any
 * conversation is loaded (the messages sit under a key that depends on the
 * session and window scope), and the art layer stays hidden until it has
 * picked. So a profile with stored messages but neither flag (older than both
 * flags) never sees setup yet draws its first picture from the setup's seven.
 * That pool is a subset of the full one, so nothing wrong can show; the other
 * way round cannot happen: whenever setup does show, this is true.
 */
export function isFirstRunStorage(stored = {}, { completedKey, introSeenKey } = {}) {
  return stored?.[completedKey] !== true && stored?.[introSeenKey] !== true;
}

export function backgroundArtCssValue(entry = '') {
  return BACKGROUND_ART.includes(entry) ? `url("${entry}")` : '';
}

/**
 * One artwork per open panel. Each panel picks once when it opens and keeps
 * that picture until it closes: switching tabs, or hiding and showing the
 * panel, never changes it. The pick avoids the last few used, so panels open
 * in separate tabs at the same time get different pictures.
 */
export function createBackgroundArtRotation({
  root,
  storage,
  random = Math.random,
  locks = globalThis.navigator?.locks,
  // Async: is this a first run? Decided from storage before the first picture
  // is chosen, so a first-run user never sees an image outside setup's seven.
  firstRun = async () => false,
}) {
  let current = '';

  function apply(entry) {
    current = entry;
    root.style.setProperty('--background-art', backgroundArtCssValue(current));
    // The setup's and the startup screen's art stay hidden until this is set.
    if (root.dataset) root.dataset.backgroundArtReady = 'true';
  }

  async function chooseAndApply() {
    let recent = [];
    try {
      const saved = await storage?.get(BACKGROUND_ART_STORAGE_KEY);
      recent = recentBackgroundArt(saved?.[BACKGROUND_ART_STORAGE_KEY]);
    } catch {
      // Artwork must not block startup when optional storage is unavailable.
    }
    let onboarding = false;
    try {
      onboarding = Boolean(await firstRun());
    } catch {
      onboarding = false;
    }
    apply(onboarding ? pickOnboardingBackgroundArt(random, recent) : pickBackgroundArt(random, recent));
    try {
      await storage?.set({ [BACKGROUND_ART_STORAGE_KEY]: [current, ...recent].slice(0, BACKGROUND_ART_RECENT_LIMIT) });
    } catch {
      // The panel keeps its pick even when the choice cannot be remembered.
    }
    return current;
  }

  // The lock serializes panels opening at the same moment, so each one sees
  // the others' picks before choosing.
  const ready = Promise.resolve()
    .then(() => (typeof locks?.request === 'function'
      ? locks.request('hermes-background-art', chooseAndApply)
      : chooseAndApply()))
    .catch(() => current);
  return {
    ready,
    // Setup is opening (a rerun from Settings, for one): if the picture on screen
    // is not one of setup's seven, swap to one of them now. Otherwise keep it.
    // When setup ends nothing changes: the picture stays until the next open.
    async ensureOnboardingArt() {
      await ready;
      if (ONBOARDING_BACKGROUND_ART.includes(current)) return current;
      apply(pickOnboardingBackgroundArt(random, [current]));
      return current;
    },
    get current() { return current; },
    dispose() {},
  };
}
