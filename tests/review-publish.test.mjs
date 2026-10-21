import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePullReview, publishPullReview, renderPullReview, reviewList, REVIEW_REPO } from '../scripts/hermes-review-pipeline.mjs';
import { acquireReviewLock, saveReviewState } from '../scripts/hermes-review-queue.mjs';
import { buildReviewTargets, newestExternalReply } from '../scripts/hermes-review-watch.mjs';

const sha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
function fixture() {
  return { repo: REVIEW_REPO, number: 42, title: 'fix: safety', body: 'author claims tests passed', headSha: sha, baseSha,
    mergeable: null, mergeableState: 'unknown', files: [{ filename: 'extension/safety.mjs', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-safe();\n+danger(input);' }],
    source: { 'extension/safety.mjs': 'danger(input);' }, related: [], repoContext: [], comments: [], inline: [], reviews: [], checks: [], statuses: [] };
}
const finding = { path: 'extension/safety.mjs', line: 1, severity: 'P1', title: 'Validate untrusted input before execution', body: 'When an untrusted input arrives, the new executor dispatches it without checking consent. Reject it before dispatch and add a rejection regression test.', evidence: 'danger(input);' };
const response = (findings) => ({ text: JSON.stringify({ summary: 'Changes the input execution path.', findings, limitations: ['Static analysis only.'] }), provider: 'openai-codex', model: 'gpt-6.1-sol-900k', fallback: false });

test('saved review identity changes with head, base, intent, or approved routing', async () => {
  const module = await import('../scripts/hermes-review-pipeline.mjs');
  assert.equal(typeof module.reviewIdentity, 'function');
  const bundle = fixture();
  const key = module.reviewIdentity(bundle, {});
  assert.equal(module.reviewIdentity({ ...bundle, comments: [{ body: 'our newly posted summary' }] }, {}), key);
  assert.notEqual(module.reviewIdentity({ ...bundle, body: 'edited intent' }, {}), key);
  assert.notEqual(module.reviewIdentity({ ...bundle, baseSha: 'c'.repeat(40) }, {}), key);
  assert.notEqual(module.reviewIdentity(bundle, { HERMES_REVIEW_FALLBACK_REASONING_EFFORT: 'high' }), key);
});

test('a second review pass rejects a speculative first-pass candidate', async () => {
  const prompts = [];
  const result = await generatePullReview(fixture(), {}, { writer: async (prompt) => { prompts.push(prompt); return response(prompts.length === 1 ? [finding] : []); } });
  assert.equal(prompts.length, 2);
  assert.equal(result.findings.length, 0);
  assert.match(prompts[1], /DISPROVE/);
});

test('a Greptile finding on the same line does not suppress a different mechanism', async () => {
  const bundle = fixture();
  bundle.inline = [{ commit: sha, path: finding.path, line: 1, author: 'greptile-apps[bot]', body: 'The retry counter wraps at 65535 and breaks retry scheduling.', url: 'https://github.com/example' }];
  const result = await generatePullReview(bundle, {}, { writer: async () => response([finding]) });
  assert.equal(result.findings.length, 1, 'same line is not proof of duplicate mechanism');
});

test('summary includes the actual diff, commit link, runtime disclosure and honest verification', async () => {
  const bundle = fixture();
  const result = await generatePullReview(bundle, {}, { writer: async () => response([finding]) });
  assert.match(result.body, /### At a glance/);
  assert.match(result.body, /\| P1 findings \| 1 \|/);
  assert.match(result.body, /### Findings/);
  assert.match(result.body, /### Verification and limits/);
  assert.match(result.body, /```diff\n/);
  assert.match(result.body, /-safe\(\);/);
  assert.match(result.body, /\+danger\(input\);/);
  assert.match(result.body, /#L1/);
  assert.doesNotMatch(result.body, /via openai-codex/);
  assert.doesNotMatch(result.body, /Reviewer runtime/);
  assert.match(result.body, /were not run/);
  assert.match(result.body, /<details>/);
  assert.doesNotMatch(result.body, /Reviewed signature:/);
});

test('an unavailable implementation patch is called incomplete rather than approved', () => {
  const bundle = fixture();
  const body = renderPullReview(bundle, { findings: [], repeated: [], calls: [], analyses: [], manifest: [], coverage: { complete: false, sourceFiles: 1, localesSummarized: 0, generatedSkipped: 0, assetsSkipped: 0, omitted: ['extension/hidden.mjs'] } });
  assert.match(body, /No merge-readiness conclusion/);
  assert.match(body, /extension\/hidden\.mjs/);
});

test('immutable source retrieval handles GitHub large-file metadata without losing implementation context', async (t) => {
  const module = await import('../scripts/hermes-review-pipeline.mjs');
  assert.equal(typeof module.sourceAt, 'function');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    return Response.json(requests.length === 1
      ? { type: 'file', size: 1100000, encoding: 'none', content: '', sha }
      : { size: 1100000, encoding: 'base64', content: Buffer.from('actual large file context').toString('base64') });
  });
  assert.equal(await module.sourceAt(REVIEW_REPO, 'extension/sidepanel.js', sha, 'fixture'), 'actual large file context');
  assert.match(requests[1], /\/git\/blobs\//);
});

test('no automated reviewer gets treated as a human reply', () => {
  assert.equal(newestExternalReply([{ id: 123, body: 'new Greptile finding', user: { type: 'Bot', login: 'greptile-apps[bot]' } }], 100), null);
});

test('draft PRs never enter the polling review queue', () => {
  assert.deepEqual(buildReviewTargets({ prs: [{ number: 1, draft: true }, { number: 2, draft: false }] }).map((p) => p.number), [2]);
});

test('pagination reads beyond the first hundred comments', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(String(url)); return Response.json(calls.length === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 101 }]); });
  const rows = await reviewList(REVIEW_REPO, '/issues/42/comments', { token: 'fixture' });
  assert.equal(rows.length, 101);
  assert.match(calls[1], /page=2/);
});

test('declared file totals must match all paginated files', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([{ filename: 'one' }]));
  await assert.rejects(reviewList(REVIEW_REPO, '/pulls/42/files', { token: 'fixture', expected: 3 }), /incomplete/);
});

test('live process lock prevents overlapping runs and atomically persists state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-lock-'));
  try {
    const filename = path.join(dir, 'state.json');
    const release = acquireReviewLock(filename);
    assert.throws(() => acquireReviewLock(filename), /already running/);
    saveReviewState(filename, { 'pull_request:42': { signature: 'head' } });
    assert.equal(JSON.parse(fs.readFileSync(filename)).value, undefined);
    assert.equal(JSON.parse(fs.readFileSync(filename))['pull_request:42'].signature, 'head');
    release();
    assert.equal(fs.existsSync(`${filename}.lock`), false);
  } finally { fs.rmSync(dir, { force: true, recursive: true }); }
});

function githubStub(t, { moved = false, mismatch = false, spoof = false, failLabelReadOnce = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-publication-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journalFile = path.join(directory, 'journal.json');
  let labelReadFailed = false;
  const writes = [];
  const comments = spoof ? [{ id: 9, user: { login: 'contributor' }, body: '<!-- hermes-agent-review:pull_request -->' }] : [];
  const inlines = [];
  const labels = [{ name: 'human/keep' }];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const u = new URL(url), route = u.pathname.replace(`/repos/${REVIEW_REPO}`, ''), method = options.method || 'GET';
    const data = options.body ? JSON.parse(options.body) : null;
    if (method !== 'GET') writes.push({ route, method, data });
    if (route === '/pulls/42') return Response.json({ state: 'open', draft: false, head: { sha: moved ? 'c'.repeat(40) : sha }, base: { sha: baseSha }, labels });
    if (route === '/user') return Response.json({ login: 'operator' });
    if (route === '/issues/42') return Response.json({ state: 'open', labels });
    if (route === '/issues/42/comments') {
      if (method === 'GET') return Response.json(comments);
      const c = { id: 10, body: data.body, user: { login: 'operator' } }; comments.push(c); return Response.json(c);
    }
    if (route === '/issues/comments/10') {
      if (method === 'PATCH') comments.find((c) => c.id === 10).body = data.body;
      return Response.json({ ...comments.find((c) => c.id === 10), ...(mismatch ? { body: 'wrong' } : {}) });
    }
    if (route === '/pulls/42/comments') {
      if (method === 'GET') return Response.json(inlines);
      const c = { id: 20, ...data, user: { login: 'operator' } }; inlines.push(c); return Response.json(c);
    }
    if (route === '/pulls/comments/20') {
      if (method === 'PATCH') inlines[0].body = data.body;
      return Response.json(inlines[0]);
    }
    if (route === '/issues/42/labels') {
      if (method === 'POST') labels.push(...data.labels.map((name) => ({ name })));
      if (method === 'GET' && failLabelReadOnce && !labelReadFailed) { labelReadFailed = true; return Response.json({}, { status: 500 }); }
      return Response.json(labels);
    }
    if (route.startsWith('/issues/42/labels/') && method === 'DELETE') {
      const name = decodeURIComponent(route.split('/labels/')[1]);
      const at = labels.findIndex((l) => l.name === name);
      if (at >= 0) labels.splice(at, 1);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected GitHub request: ${method} ${route}`);
  });
  return { writes, comments, inlines, labels, journalFile };
}

test('partial label publication preserves ownership on retry and permits later type correction', async (t) => {
  const stub = githubStub(t, { failLabelReadOnce: true });
  const args = { repo: REVIEW_REPO, number: 42, token: 'fixture', journalFile: stub.journalFile, bundle: fixture(), result: await generated() };
  await assert.rejects(publishPullReview(args), /500/);
  const resumed = await publishPullReview(args);
  assert.ok(resumed.labels.includes('type/bug'), 'labels written before failed readback remain ours');
  await publishPullReview({ ...args, bundle: { ...fixture(), title: 'feat: controls' }, previousLabels: resumed.labels });
  assert.ok(!stub.labels.some((l) => l.name === 'type/bug'));
  assert.ok(stub.labels.some((l) => l.name === 'type/feature'));
  assert.ok(stub.labels.some((l) => l.name === 'human/keep'));
});

test('distinct defects on the same line share one stable inline thread', async (t) => {
  const stub = githubStub(t);
  const second = { ...finding, title: 'Preserve retry accounting', body: 'The new counter path overflows and replays the same action when the threshold is reached. Validate the boundary and add a retry regression.' };
  const result = await generatePullReview(fixture(), {}, { writer: async () => response([finding, second]) });
  const args = { repo: REVIEW_REPO, number: 42, token: 'fixture', journalFile: stub.journalFile, bundle: fixture(), result };
  await publishPullReview(args);
  assert.equal(stub.inlines.length, 1);
  assert.match(stub.inlines[0].body, /Validate untrusted/);
  assert.match(stub.inlines[0].body, /Preserve retry/);
  const reworded = { ...result, findings: result.findings.map((f) => ({ ...f, title: `Reworded: ${f.title}` })) };
  await publishPullReview({ ...args, result: reworded });
  assert.equal(stub.inlines.length, 1);
  assert.match(stub.inlines[0].body, /Reworded/);
});

test('issue label recovery uses the same journal and preserves human labels', async (t) => {
  const { reconcileReviewLabels } = await import('../scripts/hermes-review-pipeline.mjs');
  assert.equal(typeof reconcileReviewLabels, 'function');
  const stub = githubStub(t, { failLabelReadOnce: true });
  const args = { repo: REVIEW_REPO, number: 42, token: 'fixture', journalFile: stub.journalFile, desired: ['type/bug'] };
  await assert.rejects(reconcileReviewLabels(args), /500/);
  const owned = await reconcileReviewLabels(args);
  assert.deepEqual(owned, ['type/bug']);
  await reconcileReviewLabels({ ...args, desired: ['type/feature'], previousLabels: owned });
  assert.deepEqual(stub.labels.map((l) => l.name).sort(), ['human/keep', 'type/feature']);
});

async function generated() { return generatePullReview(fixture(), {}, { writer: async () => response([finding]) }); }

test('head movement prevents every external write', async (t) => {
  const stub = githubStub(t, { moved: true });
  await assert.rejects(publishPullReview({ repo: REVIEW_REPO, number: 42, token: 'fixture', journalFile: stub.journalFile, bundle: fixture(), result: await generated() }), /changed/);
  assert.equal(stub.writes.length, 0);
});

test('failed summary readback prevents inline comments and labels', async (t) => {
  const stub = githubStub(t, { mismatch: true });
  await assert.rejects(publishPullReview({ repo: REVIEW_REPO, number: 42, token: 'fixture', journalFile: stub.journalFile, bundle: fixture(), result: await generated() }), /readback/);
  assert.equal(stub.writes.length, 1);
  assert.equal(stub.writes[0].route, '/issues/42/comments');
});

test('publisher verifies inline evidence and labels after summary, then reruns without duplicate findings', async (t) => {
  const stub = githubStub(t, { spoof: true });
  const args = { repo: REVIEW_REPO, number: 42, token: 'fixture', journalFile: stub.journalFile, bundle: fixture(), result: await generated() };
  const first = await publishPullReview(args);
  assert.equal(first.action, 'created', 'a contributor marker cannot impersonate the reviewer');
  assert.equal(stub.writes[0].route, '/issues/42/comments');
  assert.equal(stub.inlines.length, 1);
  assert.equal(stub.inlines[0].side, 'RIGHT');
  assert.equal(stub.inlines[0].line, 1);
  assert.equal(stub.inlines[0].commit_id, sha);
  assert.ok(stub.labels.some((l) => l.name === 'human/keep'));
  await publishPullReview({ ...args, previousLabels: first.labels });
  assert.equal(stub.inlines.length, 1);
  assert.equal(stub.comments.filter((c) => c.user.login === 'operator').length, 1);
  assert.ok(!stub.writes.some((w) => ['APPROVE', 'REQUEST_CHANGES'].includes(w.data?.event)));
});
