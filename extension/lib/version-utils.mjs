// Version and update utilities extracted from common.mjs — 2026-08-12 module split

export function normalizeExtensionVersion(runtimeManifest = {}, fallbackLabel = '') {
  const manifestVersion = String(runtimeManifest?.version || '').trim();
  if (manifestVersion) return manifestVersion;
  const fallbackVersion = String(fallbackLabel || '').trim().replace(/^v/i, '').trim();
  return fallbackVersion || '0.0.0';
}

export function compareVersionStrings(a = '0.0.0', b = '0.0.0') {
  const parse = (value) => String(value || '0.0.0')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff > 0) return 1;
    if (diff < 0) return -1;
  }
  return 0;
}

export function isNewerVersion(candidate = '0.0.0', current = '0.0.0') {
  return compareVersionStrings(candidate, current) > 0;
}

export function normalizeGitCommit(value = '') {
  const commit = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(commit) ? commit : '';
}

export function sourceBlobMapsMatch(buildSourceBlobs = null, mainSourceBlobs = null) {
  const entries = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.entries(value)
      .map(([filePath, sha]) => [
        String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '').trim(),
        String(sha || '').trim().toLowerCase(),
      ])
      .filter(([filePath, sha]) => filePath && /^[0-9a-f]{40}$/.test(sha))
      .sort(([left], [right]) => left.localeCompare(right));
  };
  const buildEntries = entries(buildSourceBlobs);
  const mainEntries = entries(mainSourceBlobs);
  if (!buildEntries.length || buildEntries.length !== mainEntries.length) return false;
  return buildEntries.every(([filePath, sha], index) => (
    mainEntries[index]?.[0] === filePath && mainEntries[index]?.[1] === sha
  ));
}

export function shortGitCommit(value = '') {
  const commit = normalizeGitCommit(value);
  return commit ? commit.slice(0, 7) : '';
}

function commitsWord(count = 0) {
  return `${count} commit${count === 1 ? '' : 's'}`;
}

export function formatUpdateStatus({
  latestVersion = '0.0.0',
  currentVersion = '0.0.0',
  currentCommit = '',
  latestCommit = '',
  commitsBehind = null,
  commitsAhead = 0,
  alignment = '',
  buildDirty = false,
  sourceMatchesMain = false,
} = {}) {
  const latest = String(latestVersion || '').trim().replace(/^v/i, '') || '0.0.0';
  const current = String(currentVersion || '').trim().replace(/^v/i, '') || '0.0.0';
  const currentSha = normalizeGitCommit(currentCommit);
  const latestSha = normalizeGitCommit(latestCommit);
  const currentShort = shortGitCommit(currentSha);
  const latestShort = shortGitCommit(latestSha);
  const hasCommitComparison = commitsBehind !== null && typeof commitsBehind !== 'undefined' && commitsBehind !== '';
  const behind = hasCommitComparison && Number.isFinite(Number(commitsBehind))
    ? Math.max(0, Number.parseInt(commitsBehind, 10) || 0)
    : null;
  const ahead = Number.isFinite(Number(commitsAhead)) ? Math.max(0, Number.parseInt(commitsAhead, 10) || 0) : 0;
  const alignmentState = String(alignment || '').trim().toLowerCase();
  const versionComparison = compareVersionStrings(latest, current);
  const updateInstructions = 'Pull latest, run npm run build, then reload the unpacked dist/ folder.';
  const rebuildInstructions = 'Run npm run build, then reload the unpacked dist/ folder.';
  const dirtyNote = buildDirty ? ' Local source had uncommitted changes when this build was made.' : '';

  if (versionComparison > 0) {
    const commitNote = behind && currentShort && latestShort
      ? ` Main is ${commitsWord(behind)} ahead (${currentShort} → ${latestShort}).`
      : '';
    return `Update available: v${latest}.${commitNote} ${updateInstructions}`.replace(/\s+/g, ' ').trim();
  }
  if (versionComparison < 0) {
    return `This build is ahead of the public package version: v${current} installed, v${latest} on GitHub.${dirtyNote}`.trim();
  }

  if (sourceMatchesMain) {
    return `You're up to date on v${current} (main ${latestShort || 'current'}). Loaded extension files exactly match GitHub main.`;
  }
  if (currentSha && latestSha && currentSha === latestSha) {
    return `You're up to date on v${current} (main ${currentShort}).${dirtyNote}`.trim();
  }
  if (alignmentState === 'custom' || (buildDirty && behind === null)) {
    return `v${current} custom local build loaded. Its exact commit distance from GitHub main cannot be verified. ${rebuildInstructions}`;
  }
  if (behind !== null && behind > 0 && ahead > 0 && currentShort && latestShort) {
    return `This build diverged from GitHub main: main has ${commitsWord(behind)} not in the loaded build, and the build has ${commitsWord(ahead)} not on main (${currentShort} ↔ ${latestShort}). Pull or reconcile the checkout, run npm run build, then reload dist/.`;
  }
  if (behind !== null && behind > 0 && currentShort && latestShort) {
    return `Source update available: v${current} installed at ${currentShort}, main is ${latestShort} — ${commitsWord(behind)} ahead. ${updateInstructions}${dirtyNote}`.trim();
  }
  if (behind === 0 && ahead > 0 && currentShort && latestShort) {
    return `This build is ${commitsWord(ahead)} ahead of GitHub main (${currentShort} vs ${latestShort}). No main commits are missing.`;
  }
  if (behind === 0 && currentShort && latestShort) {
    return `You're up to date on v${current} (main ${latestShort}).${dirtyNote}`.trim();
  }
  if (!currentSha) {
    return `v${current} installed and v${latest} latest. Build commit is unknown, so commit alignment cannot be verified. ${rebuildInstructions}`;
  }
  return `v${current} installed and v${latest} latest. Could not verify commit alignment against GitHub main. ${rebuildInstructions}${dirtyNote}`.trim();
}

export function shouldShowBrowserIntro({ seen = false, connected = false, messageCount = 0 } = {}) {
  return !seen && connected && Number(messageCount || 0) === 0;
}

function updateChangeCategory(message = '') {
  const type = String(message || '').trim().match(/^([a-z]+)(?:\([^)]*\))?!?:\s*/i)?.[1]?.toLowerCase() || '';
  if (type === 'fix') return 'FIXED';
  if (type === 'perf') return 'FASTER';
  if (type === 'feat') return 'NEW';
  return 'IMPROVED';
}

function updateChangeTitle(message = '') {
  const clean = String(message || '')
    .split('\n')[0]
    .replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, '')
    .trim();
  if (!clean) return 'Internal Browser update';
  return `${clean.charAt(0).toUpperCase()}${clean.slice(1)}`;
}