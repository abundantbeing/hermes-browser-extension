#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  applyReviewLabels,
  buildHermesReviewPrompt,
  callHermesReview,
  deriveReviewLabels,
  fetchPullRequestDiff,
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

function githubToken(env = process.env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  try {
    if (process.platform === 'win32') {
      const cwd = process.cwd();
      const extensions = ['.exe', '.cmd', '.bat', '.lnk'];
      for (const ext of extensions) {
        if (fs.existsSync(path.join(cwd, `gh${ext}`))) {
          throw new Error('Refusing to execute gh from current working directory for security reasons.');
        }
      }
      if (fs.existsSync(path.join(cwd, 'gh'))) {
        throw new Error('Refusing to execute gh from current working directory for security reasons.');
      }
    }
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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

export function shouldReviewTarget(target, state = {}) {
  return state[stateKey(target)] !== reviewTargetSignature(target);
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
  const comment = `${formatReviewComment(target, review)}\n\nReviewed signature: \`${reviewTargetSignature(target)}\``;
  const result = await upsertReviewComment({ repo, target, token, body: comment });
  return { ...result, labels };
}

export async function runReviewWatch(rawEnv = process.env) {
  const env = reviewEnv(rawEnv);
  const repo = env.GITHUB_REPOSITORY || rawEnv.HERMES_REVIEW_REPO || DEFAULT_REPO;
  const token = githubToken(env);
  const stateFile = env.HERMES_REVIEW_STATE_FILE || DEFAULT_STATE_FILE;
  const maxTargets = Number(env.HERMES_REVIEW_MAX_TARGETS || 3);
  const dryRun = env.HERMES_REVIEW_DRY_RUN === '1' || process.argv.includes('--dry-run');

  if (!token) throw new Error('Missing GitHub token. Run gh auth login or set GITHUB_TOKEN.');
  if (!dryRun && !env.HERMES_REVIEW_API_KEY) throw new Error('Missing HERMES_REVIEW_API_KEY or API_SERVER_KEY in ~/.hermes/.env.');

  const state = loadState(stateFile);
  const targets = await listOpenTargets({ repo, token });
  const pending = targets.filter((target) => shouldReviewTarget(target, state)).slice(0, maxTargets);
  const completed = [];
  const failed = [];

  for (const target of pending) {
    try {
      const result = await reviewTarget({ repo, target, token, env, dryRun });
      completed.push({ target, result });
      if (!dryRun) state[stateKey(target)] = reviewTargetSignature(target);
    } catch (error) {
      failed.push({ target, error: error?.message || String(error) });
      console.error(`failed ${target.kind} #${target.number}: ${error?.message || String(error)}`);
    }
  }

  if (!dryRun && completed.length) saveState(stateFile, state);
  return { completed, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReviewWatch().then(({ completed, failed }) => {
    for (const item of completed) {
      const labelText = item.result.labels?.length ? ` labels=${item.result.labels.join(',')}` : '';
      console.log(`${item.result.action} ${item.target.kind} #${item.target.number}${labelText}`);
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
