#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { hermesHomePath } from './hermes-home.mjs';

import { runReviewQueue } from './hermes-review-queue.mjs';

const DEFAULT_STATE_FILE = hermesHomePath('hermes-browser-review-state.json');

function normalizedExecutableExtensions(command, { platform = process.platform, pathext = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1' } = {}) {
  if (platform !== 'win32' || path.extname(command)) return [''];
  const entries = String(pathext || '')
    .split(';')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => entry.startsWith('.') ? entry : `.${entry}`);
  return ['', ...entries, '.exe', '.com', '.cmd', '.bat', '.ps1', '.lnk'];
}

function uniqueCaseInsensitive(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = String(value || '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pathInsideOrEqual(child, parent, platform = process.platform) {
  const normalizedChild = path.resolve(child);
  const normalizedParent = path.resolve(parent);
  const childKey = platform === 'win32' ? normalizedChild.toLowerCase() : normalizedChild;
  const parentKey = platform === 'win32' ? normalizedParent.toLowerCase() : normalizedParent;
  const relative = path.relative(parentKey, childKey);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function cwdGhBinaryRisk({
  cwd = process.cwd(),
  platform = process.platform,
  pathext = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1',
  existsSync = fs.existsSync,
} = {}) {
  if (platform !== 'win32') return { blocked: false };
  const extensions = uniqueCaseInsensitive(normalizedExecutableExtensions('gh', { platform, pathext }));
  for (const ext of extensions) {
    const candidate = path.join(cwd, `gh${ext}`);
    if (existsSync(candidate)) return { blocked: true, path: candidate, reason: 'cwd-gh-binary' };
  }
  return { blocked: false };
}

export function resolveGhBinary({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  pathext = env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1',
  pathValue = env.PATH || '',
  existsSync = fs.existsSync,
  realpathSyncFn = fs.realpathSync.native || fs.realpathSync,
} = {}) {
  if (platform !== 'win32') return { ok: true, path: 'gh' };
  const cwdRisk = cwdGhBinaryRisk({ cwd, platform, pathext, existsSync });
  if (cwdRisk.blocked) return { ok: false, blocked: true, reason: cwdRisk.reason, path: cwdRisk.path };

  const extensions = uniqueCaseInsensitive(normalizedExecutableExtensions('gh', { platform, pathext }));
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  for (const rawEntry of String(pathValue || '').split(delimiter)) {
    const entry = rawEntry.trim();
    if (!entry || !path.isAbsolute(entry)) {
      return { ok: false, blocked: true, reason: 'unsafe-path-entry', pathEntry: rawEntry };
    }
    for (const ext of extensions) {
      const candidate = path.join(entry, `gh${ext}`);
      if (!existsSync(candidate)) continue;
      let realCandidate;
      try {
        realCandidate = realpathSyncFn(candidate);
      } catch {
        realCandidate = candidate;
      }
      if (pathInsideOrEqual(realCandidate, cwd, platform)) {
        return { ok: false, blocked: true, reason: 'resolved-gh-under-cwd', path: realCandidate };
      }
      return { ok: true, path: realCandidate };
    }
  }
  return { ok: false, reason: 'gh-not-found' };
}

export function githubToken(env = process.env, options = {}) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  const resolvedGh = resolveGhBinary({ env, ...options });
  if (resolvedGh.blocked) {
    throw new Error(`Refusing to execute gh: ${resolvedGh.reason}`);
  }
  if (!resolvedGh.ok) return '';
  try {
    const execFileSyncFn = options.execFileSyncFn || execFileSync;
    return execFileSyncFn(resolvedGh.path, ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function stateKey(target) {
  return `${target.kind}:${target.number}`;
}

export function reviewTargetSignature(target = {}) {
  const stable = {
    kind: target.kind,
    number: Number(target.number || 0),
    title: target.title || '',
    body: target.body || '',
    headSha: target.kind === 'pull_request' ? target.headSha || '' : '',
    ...(target.kind === 'pull_request' && (target.baseRef || target.baseSha) ? { baseRef: target.baseRef || '', baseSha: target.baseSha || '' } : {}),
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function stateSignature(entry) {
  return typeof entry === 'string' ? entry : (entry?.signature || '');
}

export function stateSeenCommentId(entry) {
  return entry && typeof entry === 'object' ? Number(entry.seenCommentId || 0) : 0;
}

export function shouldReviewTarget(target, state = {}) {
  return stateSignature(state[stateKey(target)]) !== reviewTargetSignature(target);
}

// The reviewer contract is writer-only, but a model that ignores it can post
// the review itself and then quote the comment link in its answer. Detect that
// link so the pipeline never posts a second review on top of it.
export function postedCommentIdFromReviewText(reviewText = '') {
  const match = String(reviewText || '').match(/#issuecomment-(\d+)/);
  return match ? Number(match[1]) : 0;
}

export function latestCommentId(comments = []) {
  return (Array.isArray(comments) ? comments : [])
    .reduce((max, comment) => Math.max(max, Number(comment?.id || 0)), 0);
}

// "Someone replied to our review": a comment newer than everything we have
// already processed, from anyone other than the reviewer itself.
export function newestExternalReply(comments = [], seenCommentId = 0) {
  const seen = Number(seenCommentId || 0);
  const replies = (Array.isArray(comments) ? comments : [])
    .filter((comment) => Number(comment?.id || 0) > seen)
    .filter((comment) => comment?.user?.type !== 'Bot' && !String(comment?.user?.login || '').endsWith('[bot]'))
    .filter((comment) => !String(comment?.body || '').includes('hermes-agent-review'));
  return replies.sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
}

export function buildReviewTargets({ prs = [], issues = [] } = {}) {
  const prTargets = prs.filter((pr) => !pr.draft).map((pr) => ({
    kind: 'pull_request',
    number: Number(pr.number || 0),
    title: pr.title || '',
    body: pr.body || '',
    url: pr.html_url || '',
    author: pr.user?.login || '',
    headSha: pr.head?.sha || '',
    baseRef: pr.base?.ref || '',
    baseSha: pr.base?.sha || '',
    labels: Array.isArray(pr.labels) ? pr.labels : [],
  })).filter((target) => target.number);

  const issueTargets = issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      kind: 'issue',
      number: Number(issue.number || 0),
      title: issue.title || '',
      body: issue.body || '',
      url: issue.html_url || '',
      author: issue.user?.login || '',
      labels: Array.isArray(issue.labels) ? issue.labels : [],
    }))
    .filter((target) => target.number);

  return [...prTargets, ...issueTargets];
}

export async function runReviewWatch(rawEnv = process.env) {
  return runReviewQueue(rawEnv, {
    githubToken, buildReviewTargets, shouldReviewTarget, reviewTargetSignature,
    latestCommentId, stateSeenCommentId, stateSignature, newestExternalReply,
    defaultStateFile: DEFAULT_STATE_FILE,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReviewWatch().then(({ completed, failed, followUps = [] }) => {
    for (const item of completed) {
      const labelText = item.result.labels?.length ? ` labels=${item.result.labels.join(',')}` : '';
      console.log(`${item.result.action} ${item.target.kind} #${item.target.number}${labelText}`);
    }
    for (const item of followUps) {
      const author = item.reply?.user?.login || 'unknown';
      console.log(`${item.result.action} follow-up ${item.target.kind} #${item.target.number} (reply from @${author})`);
    }
    if (failed.length) {
      console.error(`Hermes review failed for ${failed.length} target${failed.length === 1 ? '' : 's'}.`);
      process.exitCode = 1;
    }
  }).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
