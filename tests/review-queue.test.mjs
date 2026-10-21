import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { runReviewWatch, buildReviewTargets, reviewTargetSignature } from '../scripts/hermes-review-watch.mjs';

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-queue-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('a dead art URL in a published review is detected and re-hosted', async (t) => {
  const module = await import('../scripts/hermes-review-queue.mjs');
  const dead = 'https://expired.example/gone.png';
  const comment = { id: 77, user: { login: 'reviewer' }, body: `<!-- hermes-agent-review:pull_request -->\n![PR #42 review art](${dead})\n\ntext` };
  const patched = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url).pathname;
    if (init?.method === 'PATCH') { patched.push(JSON.parse(init.body).body); return Response.json({ ...comment, body: JSON.parse(init.body).body }); }
    if (path.endsWith('/user')) return Response.json({ login: 'reviewer' });
    if (path.includes('/issues/42/comments')) return Response.json([comment]);
    if (path.includes('/issues/comments/77')) return Response.json({ ...comment, body: patched[patched.length - 1] || comment.body });
    // The hosted image host serves nothing: the copy is gone.
    if (url === dead) return new Response(null, { status: 404 });
    return Response.json([]);
  });
  const result = await module.repairReviewArt({
    repo: 'abundantbeing/hermes-browser-extension',
    target: { kind: 'pull_request', number: 42, title: 't', body: 'b', headSha: 'a'.repeat(40) },
    token: 'fixture', env: { HERMES_REVIEW_ART: '0' },
  });
  // With art disabled there is nothing to re-host, so the repair declines
  // rather than editing the comment with a broken link.
  assert.equal(result, null);
  assert.equal(patched.length, 0, 'the comment must not be edited when no replacement art exists');
});

test('the art child never inherits GitHub or runtime credentials', async () => {
  const module = await import('../scripts/hermes-review-queue.mjs');
  const spawned = [];
  const spawnChild = (command, args, options) => {
    spawned.push(options.env);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => {};
    queueMicrotask(() => child.emit('close', 1));
    return child;
  };
  const env = {
    HERMES_REVIEW_PYTHON: process.execPath, HERMES_REVIEW_ART: '1', HERMES_REVIEW_RUNTIME_ROOT: 'runtime',
    GITHUB_TOKEN: 'leak-github', GH_TOKEN: 'leak-gh', HERMES_REVIEW_API_KEY: 'leak-review', API_SERVER_KEY: 'leak-api', PYTHONHOME: 'leak-home', PYTHONPATH: 'leak-path',
  };
  await module.generateReviewArt(JSON.stringify({ kind: 'pull_request', number: 7 }), env, undefined, { spawnChild });
  assert.equal(spawned.length, 1);
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'HERMES_REVIEW_API_KEY', 'API_SERVER_KEY', 'PYTHONHOME', 'PYTHONPATH']) {
    assert.equal(key in spawned[0], false, `${key} reached the art child`);
  }
  assert.equal(spawned[0].HERMES_REVIEW_RUNTIME_ROOT, 'runtime');
});

test('a comment-supplied art URL is never fetched or edited', async (t) => {
  const module = await import('../scripts/hermes-review-queue.mjs');
  const directory = temporary(t);
  const headSha = 'a'.repeat(40);
  const attacker = 'https://attacker.example/beacon.png';
  const comment = { id: 78, user: { login: 'reviewer' }, body: `<!-- hermes-agent-review:pull_request -->\n![PR #42 review art](${attacker})\n\nmodel text` };
  // The watcher's own record of what it published. The comment never carried it.
  fs.writeFileSync(path.join(directory, `art-42-${headSha}.json`), JSON.stringify({ ok: true, url: 'https://files.catbox.moe/published.png', bytes: 100, file: path.join(directory, 'missing.png') }));
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    fetched.push(String(url));
    const route = new URL(url).pathname;
    if (init?.method === 'PATCH') throw new Error('the comment must not be edited');
    if (route.endsWith('/user')) return Response.json({ login: 'reviewer' });
    if (route.includes('/issues/42/comments')) return Response.json([comment]);
    return new Response('x', { status: 200 });
  });
  const result = await module.repairReviewArt({
    repo: 'abundantbeing/hermes-browser-extension',
    target: { kind: 'pull_request', number: 42, title: 't', body: 'b', headSha },
    token: 'fixture', env: { HERMES_REVIEW_ART: '1', HERMES_REVIEW_PYTHON: process.execPath, HERMES_REVIEW_ARTIFACT_DIR: directory },
  });
  assert.equal(result, null);
  assert.equal(fetched.some((url) => url.startsWith(attacker)), false, 'a URL parsed from comment text must never be fetched');
  assert.equal(await module.hostedFileSize(attacker), -1, 'hosts outside the art uploader allowlist are never fetched');
  assert.equal(fetched.some((url) => url.startsWith(attacker)), false);
});

test('base-aware ledger migration preserves old review receipts without posting historical reviews', async (t) => {
  const directory = temporary(t);
  const filename = path.join(directory, 'ledger.json');
  const pr = { number: 42, title: 'fix', body: 'intent', user: { login: 'author' }, head: { sha: 'a'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40) } };
  const target = buildReviewTargets({ prs: [pr] })[0];
  const legacy = { ...target }; delete legacy.baseRef; delete legacy.baseSha;
  fs.writeFileSync(filename, JSON.stringify({ 'pull_request:42': { signature: reviewTargetSignature(legacy), commentId: 123, seenCommentId: 456, managedLabels: ['type/bug'] } }));
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.method, 'GET');
    return Response.json(new URL(url).pathname.endsWith('/pulls') ? [pr] : []);
  });
  const result = await runReviewWatch({ GITHUB_TOKEN: 'fixture', HERMES_REVIEW_PYTHON: process.execPath, HERMES_REVIEW_STATE_FILE: filename, HERMES_REVIEW_MAX_TARGETS: '0', HERMES_REVIEW_MAX_FOLLOW_UPS: '0' });
  assert.deepEqual(result, { completed: [], failed: [], followUps: [], repairedArt: [] });
  const saved = JSON.parse(fs.readFileSync(filename, 'utf8'))['pull_request:42'];
  assert.equal(saved.signature, reviewTargetSignature(target));
  assert.equal(saved.commentId, 123);
  assert.equal(saved.seenCommentId, 456);
  assert.deepEqual(saved.managedLabels, ['type/bug']);
});

test('simultaneous processes recovering a dead owner cannot overlap their critical sections', async (t) => {
  const directory = temporary(t);
  const filename = path.join(directory, 'ledger.json');
  const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(dead.status, 0);
  // spawnSync does not expose a PID. Obtain one explicitly and await its exit.
  const departed = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => departed.once('exit', resolve));
  fs.writeFileSync(`${filename}.lock`, JSON.stringify({ pid: departed.pid, token: 'departed' }));
  const moduleURL = new URL('../scripts/hermes-review-queue.mjs', import.meta.url).href;
  const code = `
    import fs from 'node:fs';
    import { acquireReviewLock } from ${JSON.stringify(moduleURL)};
    const filename = ${JSON.stringify(filename)};
    process.on('message', async () => {
      let release;
      try { release = acquireReviewLock(filename); }
      catch { process.send({ denied: true }); process.disconnect(); return; }
      try {
        const fd = fs.openSync(filename + '.critical', 'wx'); fs.closeSync(fd);
        await new Promise((resolve) => setTimeout(resolve, 120));
        fs.unlinkSync(filename + '.critical'); release();
        process.send({ granted: true }); process.disconnect();
      } catch (error) { console.error(error.message); process.exit(1); }
    });
    process.send({ ready: true });
  `;
  const children = [0, 1, 2, 3].map(() => spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  const records = [];
  const exits = children.map((child) => new Promise((resolve) => child.on('exit', (status) => resolve(status))));
  await Promise.all(children.map((child) => new Promise((resolve) => child.on('message', (message) => { if (message.ready) resolve(); else records.push(message); }))));
  children.forEach((child) => child.send('start'));
  assert.ok((await Promise.all(exits)).every((status) => status === 0));
  assert.ok(records.some((r) => r.granted));
  assert.equal(fs.existsSync(`${filename}.lock`), false);
});
