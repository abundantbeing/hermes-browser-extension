import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  BUILD_RELOAD_BOOT_RECHECK_MS,
  BUILD_RELOAD_MIN_GAP_MS,
  BUILD_RELOAD_WATCH_INTERVAL_MS,
  HBE_RELEASES_URL,
  RELEASES_DOWNLOAD_LABEL,
  RELOAD_NOW_LABEL,
  UPDATE_AUTO_CHECK_INTERVAL_MS,
  UPDATE_CHECK_CACHE_KEY,
  buildIdentityChanged,
  buildIdentityFromInfo,
  buildUpdateAgentPrompt,
  formatBuildTimestamp,
  reloadPendingNotice,
  shouldAutoCheckUpdates,
  shouldRefreshBuildIdentity,
  updateButtonEmphasis,
  updateCheckCacheEntry,
  updateInstallNoteText,
} from '../extension/lib/update-flow.mjs';

const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const sidepanelHtml = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const sidepanelCss = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
const updateFlowSource = readFileSync(new URL('../extension/lib/update-flow.mjs', import.meta.url), 'utf8');

const ISO_BUILD = '2026-09-16T07:32:00.000Z';

// One macrotask turn: enough for the panel slice's awaited local re-read to settle.
function flushTasks() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function buildInfo(overrides = {}) {
  return {
    name: 'hermes-browser-extension',
    version: '0.3.2',
    commit: SHA_A,
    shortCommit: 'aaaaaaa',
    branch: 'main',
    dirty: false,
    builtAt: ISO_BUILD,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants: the releases fallback and the two windows are the contract.
// ---------------------------------------------------------------------------
test('the update flow pins the releases fallback and both windows', () => {
  assert.equal(HBE_RELEASES_URL, 'https://github.com/abundantbeing/hermes-browser-extension/releases/latest');
  assert.equal(RELEASES_DOWNLOAD_LABEL, 'Download the latest release');
  assert.equal(RELOAD_NOW_LABEL, 'Reload now');
  assert.equal(UPDATE_AUTO_CHECK_INTERVAL_MS, 24 * 60 * 60 * 1000);
  assert.equal(UPDATE_CHECK_CACHE_KEY, 'hermesBrowserUpdateCheck');
  assert.equal(BUILD_RELOAD_WATCH_INTERVAL_MS, 60 * 1000);
  assert.ok(BUILD_RELOAD_BOOT_RECHECK_MS < BUILD_RELOAD_WATCH_INTERVAL_MS);
  assert.ok(BUILD_RELOAD_MIN_GAP_MS <= BUILD_RELOAD_WATCH_INTERVAL_MS);
});

// ---------------------------------------------------------------------------
// buildIdentityFromInfo / buildIdentityChanged
// ---------------------------------------------------------------------------
test('buildIdentityFromInfo keeps only the comparable fields and derives the short commit', () => {
  const identity = buildIdentityFromInfo(buildInfo({ commit: SHA_B.toUpperCase(), shortCommit: '' }));
  assert.deepEqual(identity, {
    version: '0.3.2',
    commit: SHA_B,
    shortCommit: 'bbbbbbb',
    builtAt: ISO_BUILD,
    dirty: false,
  });
});

test('buildIdentityFromInfo refuses payloads with nothing comparable', () => {
  assert.equal(buildIdentityFromInfo(null), null);
  assert.equal(buildIdentityFromInfo(undefined), null);
  assert.equal(buildIdentityFromInfo('build-info.json'), null);
  assert.equal(buildIdentityFromInfo([]), null);
  assert.equal(buildIdentityFromInfo({ version: '', commit: '', shortCommit: '', builtAt: '' }), null);
});

test('buildIdentityChanged treats a rebuilt tree with the same commit as a new build', () => {
  const boot = buildIdentityFromInfo(buildInfo());
  assert.equal(buildIdentityChanged(boot, buildIdentityFromInfo(buildInfo())), false);
  assert.equal(
    buildIdentityChanged(boot, buildIdentityFromInfo(buildInfo({ builtAt: '2026-09-16T09:00:00.000Z' }))),
    true,
    'a rebuild stamps a new builtAt even when HEAD did not move',
  );
});

test('buildIdentityChanged sees commit, version, short commit, and dirty flips', () => {
  const boot = buildIdentityFromInfo(buildInfo());
  assert.equal(buildIdentityChanged(boot, buildIdentityFromInfo(buildInfo({ commit: SHA_B, shortCommit: 'bbbbbbb' }))), true);
  assert.equal(buildIdentityChanged(boot, buildIdentityFromInfo(buildInfo({ version: '0.3.3' }))), true);
  assert.equal(buildIdentityChanged(boot, buildIdentityFromInfo(buildInfo({ shortCommit: 'ccccccc' }))), true);
  assert.equal(buildIdentityChanged(boot, buildIdentityFromInfo(buildInfo({ dirty: true }))), true);
});

test('buildIdentityChanged never claims a change it cannot prove', () => {
  const boot = buildIdentityFromInfo(buildInfo());
  assert.equal(buildIdentityChanged(null, boot), false);
  assert.equal(buildIdentityChanged(boot, null), false);
  assert.equal(buildIdentityChanged(null, null), false);
});

// ---------------------------------------------------------------------------
// The reload-pending line
// ---------------------------------------------------------------------------
test('formatBuildTimestamp renders a stable UTC stamp and refuses junk', () => {
  assert.equal(formatBuildTimestamp(ISO_BUILD), '2026-09-16 07:32 UTC');
  assert.equal(formatBuildTimestamp(''), '');
  assert.equal(formatBuildTimestamp('not a date'), '');
  assert.equal(formatBuildTimestamp(undefined), '');
});

test('reloadPendingNotice names the build time and the control that runs it', () => {
  const notice = reloadPendingNotice(buildIdentityFromInfo(buildInfo()));
  assert.match(notice, /^A newer build is on disk \(built 2026-09-16 07:32 UTC\)\./);
  assert.match(notice, /Reload now to run it\./);
  const noStamp = reloadPendingNotice({ version: '0.3.2' });
  assert.equal(noStamp, 'A newer build is on disk. Reload now to run it.');
});

// ---------------------------------------------------------------------------
// Window rules
// ---------------------------------------------------------------------------
test('shouldRefreshBuildIdentity allows the first read and blocks a fresh repeat', () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldRefreshBuildIdentity({ lastCheckedAt: 0, now }), true);
  assert.equal(shouldRefreshBuildIdentity({ lastCheckedAt: now - 1_000, now }), false);
  assert.equal(shouldRefreshBuildIdentity({ lastCheckedAt: now - BUILD_RELOAD_MIN_GAP_MS, now }), true);
  assert.equal(shouldRefreshBuildIdentity({ lastCheckedAt: now - 60_000, now, minGapMs: 5_000 }), true);
});

test('shouldAutoCheckUpdates runs once a day and only once a day', () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldAutoCheckUpdates({ entry: null, now }), true, 'no cache means the silent check may run');
  assert.equal(shouldAutoCheckUpdates({ entry: {}, now }), true);
  assert.equal(shouldAutoCheckUpdates({ entry: { checkedAt: 'yesterday' }, now }), true);
  assert.equal(
    shouldAutoCheckUpdates({ entry: { checkedAt: now - 60 * 60 * 1000 }, now }),
    false,
    'a cache entry from an hour ago suppresses the silent check',
  );
  assert.equal(shouldAutoCheckUpdates({ entry: { checkedAt: now - UPDATE_AUTO_CHECK_INTERVAL_MS }, now }), true);
  assert.equal(shouldAutoCheckUpdates({ entry: { checkedAt: now + 60_000 }, now }), false, 'a future stamp is not a re-run excuse');
  assert.equal(shouldAutoCheckUpdates({ entry: { checkedAt: now - 30 * 60 * 1000 }, now, intervalMs: 60_000 }), true);
});

test('updateCheckCacheEntry stores the result, the distance from main, and the stamp', () => {
  const entry = updateCheckCacheEntry({
    review: { available: true, commitCount: 4, alignment: 'main-ahead' },
    checkedAt: 1_800_000_000_000,
  });
  assert.deepEqual(entry, { checkedAt: 1_800_000_000_000, available: true, commitCount: 4, alignment: 'main-ahead' });
  const unknown = updateCheckCacheEntry({ review: { available: false, commitCount: null } });
  assert.equal(unknown.commitCount, null);
  assert.equal(unknown.available, false);
  assert.equal(Number.isFinite(unknown.checkedAt), true);
  const fallbackStamp = updateCheckCacheEntry({ review: null, checkedAt: 0 });
  assert.equal(Number.isFinite(fallbackStamp.checkedAt), true);
});

// ---------------------------------------------------------------------------
// Update button emphasis and the honest install note
// ---------------------------------------------------------------------------
test('updateButtonEmphasis promotes the Update button only for an available update', () => {
  assert.equal(updateButtonEmphasis({ available: true }), 'primary');
  assert.equal(updateButtonEmphasis({ available: false }), '');
  assert.equal(updateButtonEmphasis(null), '');
  assert.equal(updateButtonEmphasis(undefined), '');
});

test('the install note names the local-checkout requirement instead of hiding it', () => {
  const available = updateInstallNoteText({ available: true });
  assert.match(available, /needs a local checkout of this repository/);
  assert.match(available, /Reload now/);
  assert.doesNotMatch(available, /computer-use/);
  assert.match(updateInstallNoteText({ available: false }), /public Hermes Browser repository/);
});

// ---------------------------------------------------------------------------
// The prepared update prompt
// ---------------------------------------------------------------------------
test('the prepared update prompt stops without cloning when no checkout exists', () => {
  const prompt = buildUpdateAgentPrompt({ review: { commitCount: 3 } });
  assert.match(prompt, /3 public commits available/);
  assert.match(prompt, /If no local checkout of this repository exists on this machine, stop and report that clearly/);
  assert.ok(prompt.includes(HBE_RELEASES_URL), 'the no-checkout stop must hand over the release download');
  assert.match(prompt, /Do not clone the repository/);
});

test('the prepared update prompt keeps the dirty stop, the build, and the honest reload path', () => {
  const prompt = buildUpdateAgentPrompt({ review: { commitCount: 1 } });
  assert.match(prompt, /1 public commit available/, 'a single commit is singular');
  assert.match(prompt, /If the checkout has uncommitted changes, stop and report them/);
  assert.match(prompt, /run npm run build/);
  assert.match(prompt, /Verify the extension build before reporting success/);
  assert.ok(prompt.includes(RELOAD_NOW_LABEL), 'the reload handoff points at the panel control');
  assert.doesNotMatch(prompt, /computer-use/i, 'the reload must not depend on computer-use');
  assert.doesNotMatch(prompt, /chrome:\/\/extensions/);
});

test('the prepared update prompt keeps its shape for an unverifiable count', () => {
  const prompt = buildUpdateAgentPrompt({ review: {} });
  assert.match(prompt, /reports new public commits available/);
  assert.ok(prompt.startsWith('Update my Hermes Browser Extension from the official repository: https://github.com/abundantbeing/hermes-browser-extension'));
  assert.ok(prompt.includes('\n\n'), 'the prompt stays paragraph-separated');
});

// ---------------------------------------------------------------------------
// Executed panel slice: baseline capture, change detection, and the wiring
// ---------------------------------------------------------------------------
function updateFlowHarness() {
  const start = sidepanelSource.indexOf('let loadedBuildIdentity = null;');
  const end = sidepanelSource.indexOf('\nfunction updateConnectionPrompt() {', start);
  assert.ok(start >= 0 && end > start, 'the update-flow block must exist in sidepanel.js');
  const slice = sidepanelSource.slice(start, end);

  const state = {
    diskInfo: buildInfo(),
    reads: 0,
    reloads: 0,
    toasts: [],
    checkCalls: [],
    stored: {},
    pendingHidden: true,
    pendingText: '',
    timers: [],
    intervals: [],
    listeners: {},
  };

  // eslint-disable-next-line no-new-func
  const factory = new Function('deps', `
    const {
      loadExtensionBuildInfo, els, translateUiText, showOperationToast, browserApi, checkForUpdates,
      buildIdentityFromInfo, buildIdentityChanged, shouldRefreshBuildIdentity, shouldAutoCheckUpdates,
      reloadPendingNotice, updateCheckCacheEntry, updateButtonEmphasis, UPDATE_CHECK_CACHE_KEY,
      HBE_RELEASES_URL, RELEASES_DOWNLOAD_LABEL, RELOAD_NOW_LABEL, BUILD_RELOAD_WATCH_INTERVAL_MS,
      BUILD_RELOAD_BOOT_RECHECK_MS, window, document, console,
    } = deps;
    ${slice}
    return {
      checkLoadedBuildIdentity,
      initializeUpdateFlow,
      recheckBuildIdentityAfterUpdateTurn,
      reloadBrowserRuntimeForNewBuild,
      runAutomaticUpdateCheck,
      setUpdateTurnAwaitingBuild(value) { updateTurnAwaitingBuild = value; },
      getUpdateTurnAwaitingBuild() { return updateTurnAwaitingBuild; },
      getLoadedBuildIdentity() { return loadedBuildIdentity; },
    };
  `);

  const api = factory({
    loadExtensionBuildInfo: async () => {
      state.reads += 1;
      return state.diskInfo;
    },
    els: {
      get updateReloadPending() {
        return {
          set hidden(value) { state.pendingHidden = value; },
          get hidden() { return state.pendingHidden; },
        };
      },
      get updateReloadPendingText() {
        return { set textContent(value) { state.pendingText = value; } };
      },
      updateReleaseLink: undefined,
      reloadBuildButton: undefined,
    },
    translateUiText: (value) => value,
    showOperationToast: (toast) => { state.toasts.push(toast); },
    browserApi: {
      runtime: { reload: () => { state.reloads += 1; } },
      storage: {
        local: {
          get: async () => state.stored,
          set: async (payload) => { Object.assign(state.stored, payload); },
        },
      },
    },
    checkForUpdates: async (options) => {
      state.checkCalls.push(options);
      return { available: true, commitCount: 2, alignment: 'main-ahead' };
    },
    buildIdentityFromInfo,
    buildIdentityChanged,
    shouldRefreshBuildIdentity,
    shouldAutoCheckUpdates,
    reloadPendingNotice,
    updateCheckCacheEntry,
    updateButtonEmphasis,
    UPDATE_CHECK_CACHE_KEY,
    HBE_RELEASES_URL,
    RELEASES_DOWNLOAD_LABEL,
    RELOAD_NOW_LABEL,
    BUILD_RELOAD_WATCH_INTERVAL_MS,
    BUILD_RELOAD_BOOT_RECHECK_MS,
    window: {
      setTimeout: (fn, ms) => { state.timers.push({ fn, ms }); return state.timers.length; },
      setInterval: (fn, ms) => { state.intervals.push({ fn, ms }); return state.intervals.length; },
      addEventListener: (type, fn) => { (state.listeners[type] ||= []).push(fn); },
    },
    document: {
      visibilityState: 'visible',
      addEventListener: (type, fn) => { (state.listeners[type] ||= []).push(fn); },
    },
    console: { info: () => {}, warn: () => {} },
  });

  return { api, state };
}

test('the panel captures the loaded build at boot and only offers Reload for a real change', async () => {
  const { api, state } = updateFlowHarness();

  assert.equal(await api.checkLoadedBuildIdentity({ reason: 'boot', force: true }), false);
  assert.equal(state.reads, 1, 'the boot read establishes the baseline');
  assert.equal(state.pendingHidden, true, 'a first read never claims a stale build');

  state.diskInfo = buildInfo({ builtAt: '2026-09-16T09:00:00.000Z' });
  assert.equal(await api.checkLoadedBuildIdentity({ reason: 'focus', force: true }), true);
  assert.equal(state.pendingHidden, false);
  assert.match(state.pendingText, /^A newer build is on disk \(built 2026-09-16 09:00 UTC\)\. Reload now to run it\.$/);
  assert.equal(state.reloads, 0, 'detecting a new build must never reload the extension');

  assert.equal(await api.checkLoadedBuildIdentity({ reason: 'interval' }), false, 'the throttled interval read is skipped');
  assert.equal(state.reads, 2);
});

test('the throttle lets the boot re-check, focus, and the interval through at their own cadence', async () => {
  const { api, state } = updateFlowHarness();
  await api.initializeUpdateFlow();
  await flushTasks();

  assert.equal(state.intervals.length, 1);
  assert.equal(state.intervals[0].ms, BUILD_RELOAD_WATCH_INTERVAL_MS);
  assert.equal(state.timers.length, 1);
  assert.equal(state.timers[0].ms, BUILD_RELOAD_BOOT_RECHECK_MS);
  assert.equal(state.listeners.focus?.length, 1, 'the panel re-reads when it regains focus');
  assert.equal(state.listeners.visibilitychange?.length, 1);

  const readsAfterBoot = state.reads;
  state.diskInfo = buildInfo({ commit: SHA_B, shortCommit: 'bbbbbbb' });
  state.timers[0].fn();
  await flushTasks();
  assert.equal(state.reads, readsAfterBoot + 1, 'the boot re-check re-reads build-info.json');
  assert.equal(state.pendingHidden, false);

  const reloadsAfterDetection = state.reloads;
  state.listeners.focus[0]();
  await flushTasks();
  assert.equal(state.reloads, reloadsAfterDetection, 'a focus re-read still never reloads');
});

test('the reload control is the only thing that calls runtime.reload', async () => {
  const { api, state } = updateFlowHarness();
  await api.checkLoadedBuildIdentity({ force: true });
  api.reloadBrowserRuntimeForNewBuild();
  assert.equal(state.reloads, 1);
  assert.equal(state.toasts.length, 0);
  assert.equal((sidepanelSource.match(/runtime\.reload\(/g) || []).length, 1, 'exactly one reload call site');
});

test('a failed build-info read stays silent instead of claiming a change', async () => {
  const { api, state } = updateFlowHarness();
  await api.checkLoadedBuildIdentity({ force: true });
  const original = state.diskInfo;
  state.diskInfo = null;
  assert.equal(await api.checkLoadedBuildIdentity({ force: true }), false);
  assert.equal(state.pendingHidden, true);
  state.diskInfo = original;
});

test('an update turn re-checks the build identity when it settles', async () => {
  const { api, state } = updateFlowHarness();
  await api.checkLoadedBuildIdentity({ force: true });

  api.setUpdateTurnAwaitingBuild(true);
  state.diskInfo = buildInfo({ builtAt: '2026-09-16T10:15:00.000Z' });
  api.recheckBuildIdentityAfterUpdateTurn();
  await flushTasks();
  assert.equal(state.pendingHidden, false);
  assert.equal(api.getUpdateTurnAwaitingBuild(), false, 'a detected build clears the pending re-check');

  state.diskInfo = buildInfo({ builtAt: '2026-09-16T10:20:00.000Z' });
  api.setUpdateTurnAwaitingBuild(true);
  const before = state.reads;
  api.recheckBuildIdentityAfterUpdateTurn();
  await flushTasks();
  assert.equal(state.reads, before + 1, 'a settling update turn forces the re-read even inside the throttle window');
});

test('the silent auto-check runs behind the 24h window, caches its result, and never toasts', async () => {
  const { api, state } = updateFlowHarness();
  await api.runAutomaticUpdateCheck();

  assert.deepEqual(state.checkCalls, [{ silent: true }], 'the automatic path must not open a dialog');
  assert.equal(state.toasts.length, 0, 'the automatic path must not toast');
  assert.equal(state.stored[UPDATE_CHECK_CACHE_KEY]?.available, true);
  assert.equal(state.stored[UPDATE_CHECK_CACHE_KEY]?.commitCount, 2);
  assert.equal(state.stored[UPDATE_CHECK_CACHE_KEY]?.alignment, 'main-ahead');

  state.checkCalls.length = 0;
  await api.runAutomaticUpdateCheck();
  assert.equal(state.checkCalls.length, 0, 'a cached result inside the window suppresses the next run');
});

// ---------------------------------------------------------------------------
// Wiring in the panel source
// ---------------------------------------------------------------------------
test('the side panel consumes the shared update-flow module instead of local copies', () => {
  assert.match(sidepanelSource, /from '\.\/lib\/update-flow\.mjs'/);
  for (const helper of [
    'buildIdentityFromInfo',
    'buildIdentityChanged',
    'reloadPendingNotice',
    'shouldAutoCheckUpdates',
    'shouldRefreshBuildIdentity',
    'updateButtonEmphasis',
    'updateCheckCacheEntry',
    'updateInstallNoteText',
    'buildUpdateAgentPrompt',
  ]) {
    assert.match(sidepanelSource, new RegExp(`\\b${helper}\\b`), `sidepanel.js must use ${helper}`);
  }
  assert.doesNotMatch(
    sidepanelSource,
    /'Update my Hermes Browser Extension from the official repository/,
    'the prepared prompt must come from the module, not a local copy',
  );
  assert.doesNotMatch(sidepanelSource, /reload through computer-use/);
});

test('the reload loop is wired to boot, focus, an interval, and the settling update turn', () => {
  assert.match(sidepanelSource, /async function checkLoadedBuildIdentity\(/);
  assert.match(sidepanelSource, /loadExtensionBuildInfo\(\)\.catch\(\(\) => null\)/, 'the re-read is the no-store build-info read');
  assert.match(sidepanelSource, /loadedBuildIdentity = nextIdentity/, 'the first read is the baseline');
  assert.match(sidepanelSource, /checkLoadedBuildIdentity\(\{ reason: 'boot', force: true \}\)/);
  assert.match(sidepanelSource, /checkLoadedBuildIdentity\(\{ reason: 'boot-recheck', force: true \}\)/);
  assert.match(sidepanelSource, /window\.setInterval\(\(\) => \{ void checkLoadedBuildIdentity\(\{ reason: 'interval' \}\); \}, BUILD_RELOAD_WATCH_INTERVAL_MS\)/);
  assert.match(sidepanelSource, /window\.addEventListener\('focus', \(\) => \{ void checkLoadedBuildIdentity\(\{ reason: 'focus' \}\); \}\)/);
  assert.match(sidepanelSource, /reason: 'update-turn', force: true/);
  assert.match(sidepanelSource, /updateTurnAwaitingBuild = true/);
  assert.ok(
    (sidepanelSource.match(/recheckBuildIdentityAfterUpdateTurn\(\)/g) || []).length >= 3,
    'the update-turn re-check runs from the launcher and both turn-settle paths',
  );
  assert.match(sidepanelSource, /void initializeUpdateFlow\(\);/);
  assert.doesNotMatch(sidepanelSource, /await initializeUpdateFlow\(\)/, 'the update watch must not block boot');
});

test('the update launcher hands the agent the module prompt and arms the post-turn re-check', () => {
  const launcher = sidepanelSource.match(/function launchBrowserUpdateWithHermes\(\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(launcher, /buildUpdateAgentPrompt\(\{ review \}\)/);
  assert.match(launcher, /updateTurnAwaitingBuild = true/);
  assert.match(launcher, /els\.composer\.requestSubmit\(\)/);
  assert.match(launcher, /showOperationToast\(/);
});

test('the reload control is bound to the click, not to a timer', () => {
  const handler = sidepanelSource.match(/function reloadBrowserRuntimeForNewBuild\(\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(handler, /browserApi\?\.runtime/);
  assert.match(handler, /runtime\.reload\(\)/);
  assert.match(handler, /Load-unpacked reloads re-read the files from disk/);
  assert.match(sidepanelSource, /els\.reloadBuildButton\?\.addEventListener\('click', reloadBrowserRuntimeForNewBuild\)/);
});

test('the update card and dialog expose the pending line, the reload button, and the releases link', () => {
  assert.match(sidepanelHtml, /id="updateReloadPending"[^>]*hidden/);
  assert.match(sidepanelHtml, /id="updateReloadPendingText"[^>]*>A newer build is on disk\. Reload to run it\.</);
  assert.match(sidepanelHtml, /id="reloadBuildButton"[^>]*>Reload now</);
  assert.match(sidepanelHtml, /id="updateReleaseLink"[^>]*href="https:\/\/github\.com\/abundantbeing\/hermes-browser-extension\/releases\/latest"/);
  assert.match(sidepanelHtml, /id="updateReleaseLink"[^>]*rel="noreferrer noopener"/);
  assert.match(sidepanelSource, /els\.updateReleaseLink\.href = HBE_RELEASES_URL/);
  assert.match(sidepanelSource, /els\.updateReloadPending\.hidden = false/);
  assert.match(sidepanelSource, /updateInstallNoteText\(\{ available: Boolean\(review\.available\) \}\)/);
  assert.match(sidepanelSource, /els\.reviewUpdateButton\.setAttribute\('data-update-action', emphasis\)/);
  assert.match(sidepanelSource, /renderUpdateActionEmphasis\(latestUpdateReview\)/);
  assert.match(sidepanelSource, /shouldAutoCheckUpdates\(\{ entry: cached \}\)/);
  assert.match(sidepanelSource, /await browserApi\.storage\.local\.get\(\[UPDATE_CHECK_CACHE_KEY\]\)/);
  assert.match(sidepanelSource, /browserApi\.storage\.local\.set\(\{ \[UPDATE_CHECK_CACHE_KEY\]: updateCheckCacheEntry\(\{ review \}\) \}\)/);
  assert.match(sidepanelSource, /checkForUpdates\(\{ silent: true \}\)/);
});

test('the manual check keeps its honest error text and lazy buttons while the silent path stays quiet', () => {
  const check = sidepanelSource.match(/async function checkForUpdates\([^)]*\)[\s\S]*?\n\}/)?.[0] || '';
  assert.match(check, /Open \$\{REPO_URL\} for manual update instructions\./);
  assert.match(check, /if \(!silent\) \{/, 'the silent path skips the button churn');
  assert.match(check, /renderVersionInfo\(status\)/);
  assert.match(check, /sourceBlobMapsMatch/);
  assert.match(check, /buildInfo\?\.dirty/);
  assert.doesNotMatch(check, /showOperationToast\(/);
});

test('the new controls are styled with theme tokens and the standardised hover boundary', () => {
  assert.match(sidepanelCss, /\.update-reload-pending\s*\{[^}]*border:\s*1px dashed var\(--hermes-line-strong\)/s);
  assert.match(sidepanelCss, /\.update-reload-pending\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(sidepanelCss, /\.update-reload-pending-text\s*\{[^}]*color:\s*var\(--hermes-ink\)/s);
  assert.match(sidepanelCss, /#reviewUpdateButton\[data-update-action="primary"\]\s*\{[^}]*background:\s*var\(--hermes-primary-bg, var\(--hermes-ink\)\)/s);
  assert.match(sidepanelCss, /#reviewUpdateButton\[data-update-action="primary"\]:hover[\s\S]*?border-color:\s*var\(--hermes-primary-bg, var\(--hermes-ink\)\)/);
  assert.match(sidepanelCss, /\.update-release-link:hover,\s*\.update-release-link:focus-visible\s*\{[^}]*border:\s*1px solid var\(--hermes-primary-fg, var\(--hermes-paper\)\)/s);
  const newRules = sidepanelCss.slice(sidepanelCss.indexOf('.update-release-link'), sidepanelCss.indexOf('.operation-toast {'));
  assert.doesNotMatch(newRules, /#fff\b|255,\s*255,\s*255/i, 'no hardcoded white in the new controls');
});

test('the module itself stays pure: no DOM, no browser globals, no fetch', () => {
  const codeOnly = updateFlowSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(codeOnly, /\bdocument\.|\bwindow\.|globalThis\.|chrome\b|browserApi|\bfetch\(|\bsetTimeout\(|\bsetInterval\(/);
  assert.doesNotMatch(codeOnly, /^\s*import\s/m, 'the module has no imports of its own');
});
