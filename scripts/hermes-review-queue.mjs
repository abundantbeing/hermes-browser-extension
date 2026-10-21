import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { callNativeReview, reviewChildEnv } from './hermes-review-client.mjs';
import { buildHermesReviewPrompt, buildFollowUpReviewPrompt, deriveReviewLabels, formatFollowUpComment, formatReviewComment } from './hermes-review-github-event.mjs';
import { assertReviewRepo, collectPullReview, generatePullReview, publishPullReview, reconcileReviewLabels, renderPullReview, reviewGithub, reviewIdentity, reviewList, readReviewArtifact, saveReviewArtifact, PR_MARKER } from './hermes-review-pipeline.mjs';

export function reviewArtRequest(bundle, result, env) {
  return JSON.stringify({ kind: 'pull_request', number: bundle.number, title: bundle.title, body: bundle.body || '',
    headSha: bundle.headSha, paths: result.manifest.map((f) => f.path), directory: env.HERMES_REVIEW_ART_DIR || '' });
}

export function localFileSize(filename) {
  try {
    const stat = fs.statSync(filename);
    return stat.isFile() ? stat.size : -1;
  } catch {
    return -1;
  }
}

// The hosts hermes-review-art.py uploads to. Only these are ever fetched, so a
// URL that reaches this module from anywhere else cannot make the watcher
// request an arbitrary host.
const ART_HOSTS = new Set(['catbox.moe', 'files.catbox.moe', 'litter.catbox.moe', 'litterbox.catbox.moe', 'uguu.se', 'a.uguu.se']);

export function isArtHostUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ART_HOSTS.has(parsed.hostname);
  } catch { return false; }
}

export async function hostedFileSize(url) {
  // A host can accept an upload and still serve a truncated body, which renders
  // as a broken image. The served length is the only honest check.
  if (!isArtHostUrl(url)) return -1;
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(45000) });
    if (!response.ok) return -1;
    const body = await response.arrayBuffer();
    return body.byteLength;
  } catch { return -1; }
}

export async function generateReviewArt(request, env, cacheFile, { spawnChild = spawn } = {}) {
  // Art is decoration for the review, never a reason to withhold or fail it.
  if (!env.HERMES_REVIEW_PYTHON || env.HERMES_REVIEW_ART === '0') return null;
  if (cacheFile && fs.existsSync(cacheFile)) {
    const cached = readReviewArtifact(cacheFile);
    if (cached?.ok && cached.url) {
      // A cache entry without a recorded size cannot be trusted: the host may
      // have stored a truncated body, and the served length is the only check
      // that proves the image still renders. Verify against the local file.
      const expected = Number.isSafeInteger(cached.bytes)
        ? cached.bytes
        : (cached.file ? localFileSize(cached.file) : -1);
      if (expected > 0) {
        const served = await hostedFileSize(cached.url);
        if (served === expected) return cached;
      }
      // The hosted copy is truncated or gone: drop the cache and regenerate.
      try { fs.unlinkSync(cacheFile); } catch { /* a stale cache is not fatal */ }
    }
  }
  return new Promise((resolve) => {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hermes-review-art.py');
    const child = spawnChild(env.HERMES_REVIEW_PYTHON, [script], { env: reviewChildEnv(env), windowsHide: true });
    let out = '';
    const done = (value) => { child.removeAllListeners(); resolve(value); };
    const timer = setTimeout(() => { child.kill(); done(null); }, 420000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => { clearTimeout(timer); done(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try { const parsed = JSON.parse(out.trim().split('\n').pop()); if (parsed?.ok && parsed.url) { if (cacheFile) writeArtifact(cacheFile, JSON.stringify(parsed)); return done(parsed); } done(null); }
      catch { done(null); }
    });
    child.stdin.end(request);
  });
}

function writeArtifact(filename, content) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, filename);
}

export function saveReviewState(filename, state) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporary, filename);
}

export function acquireReviewLock(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const lock = `${filename}.lock`;
  const token = crypto.randomUUID();
  const create = () => {
    const fd = fs.openSync(lock, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, started: new Date().toISOString() })); }
    finally { fs.closeSync(fd); }
  };
  try { create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const guard = `${lock}.reclaim`;
    let fd;
    try { fd = fs.openSync(guard, 'wx'); }
    catch (guardError) {
      if (guardError.code !== 'EEXIST') throw guardError;
      // A reclaimer may itself have died between creating the guard and removing
      // the stale lock. Reclaim the guard only when its owner is provably gone.
      let guardOwner = null;
      try { guardOwner = JSON.parse(fs.readFileSync(guard, 'utf8')); } catch { /* incomplete guard */ }
      let guardAlive = false;
      if (Number.isSafeInteger(guardOwner?.pid) && guardOwner.pid > 0) {
        try { process.kill(guardOwner.pid, 0); guardAlive = true; } catch (probe) { guardAlive = probe.code !== 'ESRCH'; }
      }
      if (guardAlive) throw new Error('Review lock recovery is already in progress; refusing concurrent run');
      fs.unlinkSync(guard);
      fd = fs.openSync(guard, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, started: new Date().toISOString() }));
    }
    let failure = null;
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, started: new Date().toISOString() }));
      // Re-read only after taking the recovery guard. A competitor may already
      // have replaced the stale owner while we were waiting to reach this code.
      const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Review lock owner invalid');
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Review watcher is already running');
      fs.unlinkSync(lock);
      create();
    } catch (error) { failure = error; }
    finally {
      // Cleanup never masks the real failure: a throw here would replace the
      // original error and hide why the run was refused.
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try { fs.unlinkSync(guard); } catch (e) { if (e.code !== 'ENOENT' && !failure) failure = e; }
    }
    if (failure) throw failure;
  }
  return () => {
    try {
      const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (owner.token === token && owner.pid === process.pid) fs.unlinkSync(lock);
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  };
}

export function selectReviewTargets(targets, state, { now = Date.now(), limit, signature, shouldReview }) {
  return targets.filter((t) => shouldReview(t, state)).filter((t) => {
    const entry = state[`${t.kind}:${t.number}`];
    return entry?.attemptSignature !== signature(t) || !entry?.retryAfter || entry.retryAfter <= now;
  }).sort((a, b) => {
    const age = (t) => { const entry = state[`${t.kind}:${t.number}`]; return entry?.attemptSignature === signature(t) ? entry.lastAttemptAt || 0 : 0; };
    return age(a) - age(b);
  }).slice(0, limit);
}

async function writeTextComment({ repo, target, token, body, reply }) {
  const user = await reviewGithub(repo, '/user', { token });
  const current = await reviewGithub(repo, `/issues/${target.number}`, { token });
  if (current.state !== 'open') throw new Error('Target closed before publication');
  const comments = await reviewList(repo, `/issues/${target.number}/comments`, { token });
  const marker = reply ? `<!-- hermes-agent-review:reply=${reply.id} -->` : `<!-- hermes-agent-review:${target.kind} -->`;
  const owned = comments.filter((c) => c.user?.login === user.login && c.body?.includes(marker)).sort((a, b) => a.id - b.id)[0];
  if (reply && owned) return { action: 'existing', id: owned.id, labels: [] };
  const completeBody = reply ? `${marker}\n${body}` : body;
  const written = await reviewGithub(repo, owned ? `/issues/comments/${owned.id}` : `/issues/${target.number}/comments`, { token, method: owned ? 'PATCH' : 'POST', body: { body: completeBody } });
  const read = await reviewGithub(repo, `/issues/comments/${written.id}`, { token });
  if (read.body !== completeBody) throw new Error('Review comment failed readback verification');
  return { action: owned ? 'updated' : 'created', id: read.id, labels: [] };
}

export async function reviewQueueTarget({ repo, target, token, env, dryRun, previousLabels = [] }) {
  assertReviewRepo(repo);
  if (target.kind === 'pull_request') {
    const bundle = await collectPullReview({ repo, number: target.number, token, expectedHead: target.headSha });
    if (dryRun) return { action: 'dry-run', bundle, labels: [] };
    let result;
    const artifact = env.HERMES_REVIEW_ARTIFACT_DIR ? path.join(env.HERMES_REVIEW_ARTIFACT_DIR, `${target.number}-${bundle.headSha}.json`) : '';
    if (artifact && fs.existsSync(artifact)) {
      const saved = readReviewArtifact(artifact);
      if (saved?.result?.inputKey === reviewIdentity(bundle, env)) {
        result = saved.result;
        result.body = renderPullReview(bundle, result);
      }
    }
    if (!result) result = await generatePullReview(bundle, env);
    const art = await generateReviewArt(reviewArtRequest(bundle, result, env), env, path.join(env.HERMES_REVIEW_ARTIFACT_DIR, `art-${bundle.number}-${bundle.headSha}.json`));
    if (art) result.body = renderPullReview(bundle, result, art);
    saveReviewArtifact(env.HERMES_REVIEW_ARTIFACT_DIR, target.number, bundle, result);
    return publishPullReview({ repo, number: target.number, token, bundle, result, previousLabels, journalFile: path.join(env.HERMES_REVIEW_ARTIFACT_DIR, `publication-${target.number}.json`) });
  }
  const comments = await reviewList(repo, `/issues/${target.number}/comments`, { token });
  const prompt = buildHermesReviewPrompt({ target, repo, title: target.title, author: target.author, body: target.body, url: target.url })
    + `\nUNTRUSTED_PRIOR_DISCUSSION\n${JSON.stringify(comments.slice(-15).map((c) => ({ author: c.user?.login, body: String(c.body || '').slice(0, 2500) })))}`;
  if (dryRun) return { action: 'dry-run', body: prompt, labels: [] };
  const response = await callNativeReview(prompt, env);
  const art = await generateReviewArt(JSON.stringify({ kind: target.kind, number: target.number, title: target.title, body: target.body, headSha: String(target.number), paths: [], directory: env.HERMES_REVIEW_ART_DIR || '' }), env, path.join(env.HERMES_REVIEW_ARTIFACT_DIR, `art-${target.number}-${target.kind}.json`));
  const artMarkdown = art?.url ? `![${target.kind === 'pull_request' ? 'PR' : 'Issue'} #${target.number} illustration](${art.url})\n\n` : '';
  const body = formatReviewComment(target, `${artMarkdown}${response.text}`);
  const result = await writeTextComment({ repo, target, token, body });
  const proposed = deriveReviewLabels(target);
  const type = proposed.includes('type/bug') ? 'type/bug' : proposed.find((s) => s.startsWith('type/'));
  const labels = [type, ...proposed.filter((s) => s.startsWith('comp/')).slice(0, 2)].filter(Boolean);
  const ownedLabels = await reconcileReviewLabels({ repo, number: target.number, token, desired: labels, previousLabels, journalFile: path.join(env.HERMES_REVIEW_ARTIFACT_DIR, `publication-${target.number}.json`) });
  return { ...result, labels: ownedLabels };
}

export async function reviewQueueFollowUp({ repo, target, token, env, reply, comments }) {
  let context = { previousReviews: comments.filter((c) => c.body?.includes('hermes-agent-review')).map((c) => ({ id: c.id, body: c.body })).slice(-3) };
  if (target.kind === 'pull_request') {
    const bundle = await collectPullReview({ repo, number: target.number, token, expectedHead: target.headSha });
    context = { ...context, head: bundle.headSha, base: bundle.baseSha, checks: bundle.checks, files: bundle.files.map((f) => ({ path: f.filename, patch: f.patch?.slice(0, 10000) })) };
  }
  const prompt = buildFollowUpReviewPrompt({ target, repo, title: target.title, body: target.body, reply, url: target.url })
    + `\nUNTRUSTED_REVIEW_CONTEXT\n${JSON.stringify(context).slice(0, 130000)}\nRespond to the human comment only. Other automated reviewers are context, not participants to reply to. Context can be partial; do not make a merge-readiness claim.`;
  const response = await callNativeReview(prompt, env);
  const body = formatFollowUpComment(target, reply, response.text);
  return writeTextComment({ repo, target, token, body, reply });
}

export async function repairReviewArt({ repo, target, token, env }) {
  // Re-host the review art when the published image is no longer served.
  //
  // The image in a published review lives on a third-party host. When that host
  // expires or truncates the file, the review still renders but the image is
  // broken, and nothing would ever notice because the pull request head rarely
  // moves again. This finds the review comment, checks the hosted copy, and
  // replaces it with a fresh upload when the copy is gone.
  const comments = await reviewList(repo, `/issues/${target.number}/comments`, { token });
  const user = await reviewGithub(repo, '/user', { token });
  const owned = comments.filter((c) => c.user?.login === user.login && (c.body || '').includes(PR_MARKER));
  const comment = owned.sort((a, b) => b.id - a.id)[0];
  if (!comment) return null;
  // The URL to check comes from the art record this watcher wrote when it
  // generated the image, never from the comment text: comment bodies carry
  // model output. The comment must still contain that exact URL to be edited.
  const artifactDir = env.HERMES_REVIEW_ARTIFACT_DIR || '';
  const cached = artifactDir ? path.join(artifactDir, `art-${target.number}-${target.headSha}.json`) : '';
  const record = cached && fs.existsSync(cached) ? readReviewArtifact(cached) : null;
  const current = record?.ok && record.url ? record.url : '';
  if (!current || !(comment.body || '').includes(current)) return null;
  if (await hostedFileSize(current) > 0) return null;

  // The local source is what the generator produced. Upload it again and point
  // the comment at the new copy.
  const local = record.file && fs.existsSync(record.file) ? record.file : '';
  if (!local) return null;
  const art = await generateReviewArt(
    JSON.stringify({ kind: target.kind, number: target.number, title: target.title, body: target.body, headSha: target.headSha, paths: [], directory: env.HERMES_REVIEW_ART_DIR || '' }),
    env, path.join(artifactDir, `art-${target.number}-${target.headSha}.json`));
  if (!art?.url) return null;
  const body = comment.body.replace(current, art.url);
  await reviewGithub(repo, `/issues/comments/${comment.id}`, { token, method: 'PATCH', body: { body } });
  const read = await reviewGithub(repo, `/issues/comments/${comment.id}`, { token });
  if (!read?.body?.includes(art.url)) throw new Error('Art repair readback mismatch');
  return { number: target.number, from: current, to: art.url, lifetime: art.host_lifetime || 'unknown' };
}

export async function runReviewQueue(env, helpers) {
  const repo = env.GITHUB_REPOSITORY || env.HERMES_REVIEW_REPO || 'abundantbeing/hermes-browser-extension';
  assertReviewRepo(repo);
  const dryRun = env.HERMES_REVIEW_DRY_RUN === '1' || process.argv.includes('--dry-run');
  const filename = env.HERMES_REVIEW_STATE_FILE || helpers.defaultStateFile;
  env = { ...env, HERMES_REVIEW_ARTIFACT_DIR: env.HERMES_REVIEW_ARTIFACT_DIR || path.join(path.dirname(filename), 'hbe-review-artifacts') };
  const token = helpers.githubToken(env);
  if (!token) throw new Error('Missing GitHub token');
  if (!dryRun && !env.HERMES_REVIEW_PYTHON) throw new Error('No-tools review writer is required for live reviews');
  const unlock = acquireReviewLock(filename);
  const completed = [], failed = [], followUps = [], repairedArt = [];
  try {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Review state unreadable; refusing to reset deduplication'); }
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Review ledger must be an object');
    const [prs, issues] = await Promise.all([
      reviewList(repo, '/pulls?state=open&sort=created&direction=asc', { token }),
      reviewList(repo, '/issues?state=open&sort=created&direction=asc', { token }),
    ]);
    let targets = helpers.buildReviewTargets({ prs: prs.filter((p) => !p.draft), issues });
    if (env.HERMES_REVIEW_EVENT_TARGET) {
      if (!/^(issue|pull_request):[1-9][0-9]*$/.test(env.HERMES_REVIEW_EVENT_TARGET)) throw new Error('Invalid event review target');
      targets = targets.filter((t) => `${t.kind}:${t.number}` === env.HERMES_REVIEW_EVENT_TARGET);
    }
    const maxTargets = Number(env.HERMES_REVIEW_MAX_TARGETS || 1);
    const maxFollowUps = Number(env.HERMES_REVIEW_MAX_FOLLOW_UPS || 2);
    if (!Number.isSafeInteger(maxTargets) || maxTargets < 0 || maxTargets > 10 || !Number.isSafeInteger(maxFollowUps) || maxFollowUps < 0 || maxFollowUps > 10) throw new Error('Invalid review work limit');
    // Preserve existing reviews during the base-aware identity migration.
    // Current base becomes the baseline; subsequent head/base/intent changes trigger review.
    let migrated = false;
    for (const target of targets) {
      const key = `${target.kind}:${target.number}`;
      const entry = state[key];
      if (!entry || target.kind !== 'pull_request') continue;
      const legacy = { ...target }; delete legacy.baseRef; delete legacy.baseSha;
      if (helpers.stateSignature(entry) === helpers.reviewTargetSignature(legacy) && helpers.reviewTargetSignature(legacy) !== helpers.reviewTargetSignature(target)) {
        state[key] = { ...(typeof entry === 'object' ? entry : {}), signature: helpers.reviewTargetSignature(target), baseRef: target.baseRef, baseSha: target.baseSha };
        migrated = true;
      }
    }
    if (migrated && !dryRun) saveReviewState(filename, state);
    const pending = selectReviewTargets(targets, state, { limit: maxTargets, signature: helpers.reviewTargetSignature, shouldReview: helpers.shouldReviewTarget });
    const attempted = new Set();
    for (const target of pending) {
      const key = `${target.kind}:${target.number}`;
      attempted.add(key);
      try {
        // Freeze human reply watermark before model work. Replies arriving during the
        // review are preserved for the next tick instead of silently marked consumed.
        const before = await reviewList(repo, `/issues/${target.number}/comments`, { token });
        const result = await reviewQueueTarget({ repo, target, token, env, dryRun, previousLabels: state[key]?.managedLabels || [] });
        if (!dryRun) {
          state[key] = { signature: helpers.reviewTargetSignature(target), seenCommentId: Math.max(1, helpers.latestCommentId(before)), commentId: result.id, managedLabels: result.labels || [], pipelineVersion: 2 };
          saveReviewState(filename, state);
        }
        completed.push({ target, result });
      } catch (error) {
        failed.push({ target, error: error.message });
        if (!dryRun) {
          const entry = state[key];
          const retryCount = (Number(entry?.retryCount) || 0) + 1;
          state[key] = { ...(typeof entry === 'object' ? entry : { signature: entry || '' }), retryCount, lastAttemptAt: Date.now(), attemptSignature: helpers.reviewTargetSignature(target), retryAfter: Date.now() + Math.min(6, 2 ** Math.min(retryCount, 3)) * 3600000 };
          saveReviewState(filename, state);
        }
      }
    }
    if (!dryRun) for (const target of targets) {
      if (followUps.length >= maxFollowUps) break;
      const key = `${target.kind}:${target.number}`;
      if (attempted.has(key) || state[key] === undefined) continue;
      try {
        const comments = await reviewList(repo, `/issues/${target.number}/comments`, { token });
        const entry = state[key];
        const seen = helpers.stateSeenCommentId(entry);
        if (!seen) {
          state[key] = { ...(typeof entry === 'object' ? entry : {}), signature: helpers.stateSignature(entry), seenCommentId: helpers.latestCommentId(comments) };
          saveReviewState(filename, state);
          continue;
        }
        const reply = helpers.newestExternalReply(comments, seen);
        if (!reply) continue;
        const result = await reviewQueueFollowUp({ repo, target, token, env, reply, comments });
        state[key] = { ...entry, seenCommentId: reply.id };
        saveReviewState(filename, state);
        followUps.push({ target, reply, result });
      } catch (error) { failed.push({ target, error: error.message }); }
    }
    if (!dryRun) {
      // A published review points at a hosted image. That host can expire or
      // truncate the file long after the review was posted, and the head may
      // never move again, so nothing would ever notice. Check the art on
      // already-reviewed targets and re-host it when the hosted copy is gone.
      for (const target of targets) {
        if (target.kind !== 'pull_request' || attempted.has(`${target.kind}:${target.number}`)) continue;
        try {
          const repaired = await repairReviewArt({ repo, target, token, env });
          if (repaired) repairedArt.push(repaired);
        } catch (error) { failed.push({ target, error: `art repair: ${error.message}` }); }
      }
    }
    return { completed, failed, followUps, repairedArt };
  } finally { unlock(); }
}
