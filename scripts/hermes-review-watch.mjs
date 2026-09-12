#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  applyReviewLabels,
  buildFollowUpReviewPrompt,
  buildHermesReviewPrompt,
  callHermesReview,
  deriveReviewLabels,
  fetchPullRequestDiff,
  formatFollowUpComment,
  formatReviewComment,
  githubFetch,
  upsertReviewComment,
} from './hermes-review-github-event.mjs';

const DEFAULT_REPO = 'abundantbeing/hermes-browser-extension';
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8642';
const DEFAULT_STATE_FILE = path.join(os.homedir(), '.hermes', 'hermes-browser-review-state.json');

function readEnvFileValue(name) {
  const envPath = path.join(os.homedir(), '.hermes', '.env');
  if (!fs.existsSync(envPath)) return '';
  const match = fs.readFileSync(envPath, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
  return match?.[1]?.trim() || '';
}

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

function reviewEnv(env = process.env) {
  return {
    ...env,
    HERMES_REVIEW_GATEWAY_URL: env.HERMES_REVIEW_GATEWAY_URL || DEFAULT_GATEWAY_URL,
    HERMES_REVIEW_API_KEY: env.HERMES_REVIEW_API_KEY || readEnvFileValue('API_SERVER_KEY'),
  };
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
    .filter((comment) => !String(comment?.body || '').includes('hermes-agent-review'));
  return replies.sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
}

export function buildReviewTargets({ prs = [], issues = [] } = {}) {
  const prTargets = prs.map((pr) => ({
    kind: 'pull_request',
    number: Number(pr.number || 0),
    title: pr.title || '',
    body: pr.body || '',
    url: pr.html_url || '',
    author: pr.user?.login || '',
    headSha: pr.head?.sha || '',
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

function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

async function listOpenTargets({ repo, token }) {
  const [prs, issues] = await Promise.all([
    githubFetch(`/repos/${repo}/pulls?state=open&per_page=20&sort=updated&direction=desc`, { token }),
    githubFetch(`/repos/${repo}/issues?state=open&per_page=20&sort=updated&direction=desc`, { token }),
  ]);
  return buildReviewTargets({ prs: Array.isArray(prs) ? prs : [], issues: Array.isArray(issues) ? issues : [] });
}

async function reviewTarget({ repo, target, token, env, dryRun = false }) {
  const diff = target.kind === 'pull_request'
    ? await fetchPullRequestDiff({ repo, number: target.number, token })
    : '';
  const labels = deriveReviewLabels(target, diff);
  const prompt = buildHermesReviewPrompt({
    target,
    repo,
    title: target.title,
    author: target.author,
    body: target.body,
    diff,
    url: target.url,
  });
  if (dryRun) {
    return { action: 'dry-run', body: prompt, labels };
  }
  await applyReviewLabels({ repo, target, token, labels });
  const review = await callHermesReview(prompt, env);
  const agentPostedId = postedCommentIdFromReviewText(review);
  if (agentPostedId) {
    // The reviewer ignored its writer-only contract and posted the comment
    // itself; skip the pipeline post so the target never gets two reviews.
    return { action: 'skipped-agent-posted', id: agentPostedId, labels };
  }
  const comment = `${formatReviewComment(target, review)}\n\nReviewed signature: \`${reviewTargetSignature(target)}\``;
  const result = await upsertReviewComment({ repo, target, token, body: comment });
  return { ...result, labels };
}

async function followUpTarget({ repo, target, token, env, reply }) {
  const prompt = buildFollowUpReviewPrompt({
    target,
    repo,
    title: target.title,
    body: target.body,
    reply,
    url: target.url,
  });
  const review = await callHermesReview(prompt, env);
  const body = formatFollowUpComment(target, reply, review);
  const created = await githubFetch(`/repos/${repo}/issues/${target.number}/comments`, {
    method: 'POST',
    token,
    body: { body },
  });
  return { action: 'created', id: created.id };
}

export async function runReviewWatch(rawEnv = process.env) {
  const env = reviewEnv(rawEnv);
  const repo = env.GITHUB_REPOSITORY || rawEnv.HERMES_REVIEW_REPO || DEFAULT_REPO;
  const token = githubToken(env);
  const stateFile = env.HERMES_REVIEW_STATE_FILE || DEFAULT_STATE_FILE;
  const maxTargets = Number(env.HERMES_REVIEW_MAX_TARGETS || 3);
  const maxFollowUps = Number(env.HERMES_REVIEW_MAX_FOLLOW_UPS || 2);
  const dryRun = env.HERMES_REVIEW_DRY_RUN === '1' || process.argv.includes('--dry-run');

  if (!token) throw new Error('Missing GitHub token. Run gh auth login or set GITHUB_TOKEN.');
  if (!dryRun && !env.HERMES_REVIEW_API_KEY) throw new Error('Missing HERMES_REVIEW_API_KEY or API_SERVER_KEY in ~/.hermes/.env.');

  const state = loadState(stateFile);
  const targets = await listOpenTargets({ repo, token });
  const pending = targets.filter((target) => shouldReviewTarget(target, state)).slice(0, maxTargets);
  const completed = [];
  const followUps = [];
  const failed = [];
  let dirty = false;

  const fetchComments = (number) => githubFetch(`/repos/${repo}/issues/${number}/comments?per_page=100`, { token });

  for (const target of pending) {
    try {
      const result = await reviewTarget({ repo, target, token, env, dryRun });
      completed.push({ target, result });
      if (!dryRun) {
        const comments = await fetchComments(target.number).catch(() => []);
        state[stateKey(target)] = {
          signature: reviewTargetSignature(target),
          seenCommentId: latestCommentId(comments),
        };
        dirty = true;
      }
    } catch (error) {
      failed.push({ target, error: error?.message || String(error) });
      console.error(`failed ${target.kind} #${target.number}: ${error?.message || String(error)}`);
    }
  }

  // One review per target; a follow-up only when someone replies to it. Targets
  // reviewed before the seenCommentId era are baselined once without answering
  // older comments.
  if (!dryRun) {
    const reviewedKeys = new Set(pending.map((target) => stateKey(target)));
    for (const target of targets) {
      if (followUps.length >= maxFollowUps) break;
      if (reviewedKeys.has(stateKey(target))) continue;
      const entry = state[stateKey(target)];
      if (entry === undefined) continue;
      try {
        const comments = await fetchComments(target.number);
        const seen = stateSeenCommentId(entry);
        if (!seen) {
          state[stateKey(target)] = {
            signature: stateSignature(entry),
            seenCommentId: latestCommentId(comments),
          };
          dirty = true;
          continue;
        }
        const reply = newestExternalReply(comments, seen);
        if (!reply) continue;
        const result = await followUpTarget({ repo, target, token, env, reply });
        followUps.push({ target, reply, result });
        state[stateKey(target)] = {
          signature: stateSignature(entry),
          seenCommentId: Math.max(latestCommentId(comments), Number(result.id || 0)),
        };
        dirty = true;
      } catch (error) {
        failed.push({ target, error: error?.message || String(error) });
        console.error(`failed follow-up ${target.kind} #${target.number}: ${error?.message || String(error)}`);
      }
    }
  }

  if (!dryRun && dirty) saveState(stateFile, state);
  return { completed, failed, followUps };
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
