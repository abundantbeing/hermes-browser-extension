/**
 * Update-flow contracts for the Hermes Browser side panel.
 *
 * Everything in this module is pure: no DOM, no browser globals, no network.
 * The side panel consumes these helpers so the four user-visible pieces of the
 * update path share one source of truth:
 *
 *   1. the loaded-vs-on-disk build identity that turns a rebuilt `dist/` into a
 *      "Reload now" offer (the panel never reloads itself),
 *   2. the honest in-place note plus the release-download fallback for a machine
 *      with no local checkout,
 *   3. the once-a-day silent auto-check window and its cached result,
 *   4. the prepared update prompt handed to the connected Hermes agent.
 *
 * The unit tests assert these rules without a browser, so the strings and the
 * window arithmetic the user sees are the ones tested here.
 */

/** Public repository. The in-place route needs a local checkout of it. */
export const HBE_REPO_URL = 'https://github.com/abundantbeing/hermes-browser-extension';

/** Fallback download for anyone without a local checkout (and for the agent when it finds none). */
export const HBE_RELEASES_URL = `${HBE_REPO_URL}/releases/latest`;

/** Label for the release-download fallback link. */
export const RELEASES_DOWNLOAD_LABEL = 'Download the latest release';

/** Label for the control that reloads the unpacked extension from disk. */
export const RELOAD_NOW_LABEL = 'Reload now';

/** The reload offer is persistent until the user presses it. */
export const RELOAD_PENDING_HEADLINE = 'A newer build is on disk';

/**
 * Silent automatic update check: at most one per 24 hours. The manual Check
 * button stays available and is never rate-limited by this window.
 */
export const UPDATE_AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Storage key holding the cached automatic check (result + timestamp). */
export const UPDATE_CHECK_CACHE_KEY = 'hermesBrowserUpdateCheck';

/**
 * The panel re-reads its own build-info.json (a tiny local file) on this
 * interval. One minute is the floor: the re-read is a local file, not a network
 * call, and it only ever offers a reload — it never reloads on its own.
 */
export const BUILD_RELOAD_WATCH_INTERVAL_MS = 60 * 1000;

/** One extra re-read shortly after boot catches a build that landed while the panel opened. */
export const BUILD_RELOAD_BOOT_RECHECK_MS = 5 * 1000;

/** Focus and visibilitychange fire together; keep the re-reads from stacking. */
export const BUILD_RELOAD_MIN_GAP_MS = 10 * 1000;

function text(value = '') {
  return String(value ?? '').trim();
}

function commitText(value = '') {
  return text(value).toLowerCase();
}

function pad(value = 0) {
  return String(value).padStart(2, '0');
}

/**
 * Reduce a stamped build-info.json payload to the identity fields that must
 * change for the running panel to be stale. Returns null when the payload
 * carries nothing comparable (a source-loaded dev copy without build metadata
 * never enters the reload-pending state).
 */
export function buildIdentityFromInfo(info = null) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  const identity = {
    version: text(info.version),
    commit: commitText(info.commit),
    shortCommit: text(info.shortCommit).toLowerCase(),
    builtAt: text(info.builtAt),
    dirty: Boolean(info.dirty),
  };
  if (!identity.shortCommit && identity.commit) identity.shortCommit = identity.commit.slice(0, 7);
  if (!identity.version && !identity.commit && !identity.shortCommit && !identity.builtAt) return null;
  return identity;
}

/**
 * True when the build on disk is no longer the one this panel booted from.
 * A rebuilt tree with the same commit still counts: its `builtAt` stamp moved.
 */
export function buildIdentityChanged(previous = null, next = null) {
  if (!previous || !next) return false;
  return previous.version !== next.version
    || previous.commit !== next.commit
    || previous.shortCommit !== next.shortCommit
    || previous.builtAt !== next.builtAt
    || Boolean(previous.dirty) !== Boolean(next.dirty);
}

/**
 * Render the build stamp in UTC so the notice reads the same everywhere and the
 * tests are timezone-independent. Returns '' for a missing or unparseable stamp.
 */
export function formatBuildTimestamp(builtAt = '') {
  const parsed = new Date(text(builtAt));
  if (Number.isNaN(parsed.getTime())) return '';
  return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())} `
    + `${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())} UTC`;
}

/** The persistent line shown when a newer build is sitting on disk. */
export function reloadPendingNotice(identity = null) {
  const builtAt = formatBuildTimestamp(identity?.builtAt);
  return builtAt
    ? `${RELOAD_PENDING_HEADLINE} (built ${builtAt}). ${RELOAD_NOW_LABEL} to run it.`
    : `${RELOAD_PENDING_HEADLINE}. ${RELOAD_NOW_LABEL} to run it.`;
}

/** Throttle rule for the button-driven re-reads (focus/visibility can double-fire). */
export function shouldRefreshBuildIdentity({
  lastCheckedAt = 0,
  now = Date.now(),
  minGapMs = BUILD_RELOAD_MIN_GAP_MS,
} = {}) {
  const last = Number(lastCheckedAt);
  if (!Number.isFinite(last) || last <= 0) return true;
  return Number(now) - last >= Math.max(0, Number(minGapMs) || 0);
}

/**
 * The 24h window rule. A missing, malformed, or stale cache entry means the
 * silent check may run; anything newer means it is skipped and the manual Check
 * button remains the only path.
 */
export function shouldAutoCheckUpdates({
  entry = null,
  now = Date.now(),
  intervalMs = UPDATE_AUTO_CHECK_INTERVAL_MS,
} = {}) {
  const checkedAt = Number(entry?.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return true;
  return Number(now) - checkedAt >= Math.max(0, Number(intervalMs) || 0);
}

/** What gets cached in extension storage: the result, its timestamp, and the distance from main. */
export function updateCheckCacheEntry({ review = null, checkedAt = Date.now() } = {}) {
  const stamp = Number(checkedAt);
  const rawCount = review?.commitCount;
  const commitCount = rawCount === null || rawCount === undefined || rawCount === '' ? NaN : Number(rawCount);
  return {
    checkedAt: Number.isFinite(stamp) && stamp > 0 ? stamp : Date.now(),
    available: Boolean(review?.available),
    commitCount: Number.isFinite(commitCount) ? Math.max(0, Math.trunc(commitCount)) : null,
    alignment: text(review?.alignment),
  };
}

/**
 * Data-attribute value that promotes the Update button to the primary action
 * once a check finds this build behind main. '' keeps the resting treatment.
 */
export function updateButtonEmphasis(review = null) {
  return review?.available ? 'primary' : '';
}

/** The dialog's install note. The in-place route is only honest for a local checkout. */
export function updateInstallNoteText({ available = false } = {}) {
  return available
    ? 'Update now starts a guarded Hermes agent turn. The in-place route needs a local checkout of this repository on this machine, so it stops on local changes and never clones one: build dist/, then press Reload now to run the new build.'
    : 'This check compares the loaded build metadata with the public Hermes Browser repository.';
}

/**
 * The prompt handed to the connected Hermes agent. It stops on a dirty checkout,
 * stops (with the releases URL) when no local checkout exists instead of cloning
 * one, and asks the user to press the panel's Reload now control rather than
 * depending on computer-use to reload the unpacked extension.
 */
export function buildUpdateAgentPrompt({ review = null } = {}) {
  const commitCount = Number(review?.commitCount);
  const counted = Number.isFinite(commitCount) && commitCount > 0 ? Math.trunc(commitCount) : null;
  const countLabel = counted === null ? 'new' : `${counted}`;
  const plural = counted === 1 ? '' : 's';
  return [
    `Update my Hermes Browser Extension from the official repository: ${HBE_REPO_URL}`,
    `The Browser update review reports ${countLabel} public commit${plural} available.`,
    'First locate the existing Hermes Browser Extension checkout that this user intends to update. This in-place update needs a local checkout of the repository on this machine.',
    `If no local checkout of this repository exists on this machine, stop and report that clearly with the download link ${HBE_RELEASES_URL}. Do not clone the repository, and do not install or update the extension any other way.`,
    'If the checkout has uncommitted changes, stop and report them. Do not discard, overwrite, commit, or push any local work.',
    'If it is clean, fetch and fast-forward the current branch from the official remote, install dependencies only if required, and run npm run build.',
    `After the build lands, my side panel shows a "${RELOAD_NOW_LABEL}" control because a newer build is on disk, and that control reloads the built files from disk. Ask me to press it instead of reloading the extension yourself.`,
    'Verify the extension build before reporting success.',
  ].join('\n\n');
}