import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generatePullReview, renderPullReview, validateSuggestions, publishPullReview, REVIEW_REPO } from '../scripts/hermes-review-pipeline.mjs';
import { validateFindings } from '../scripts/hermes-review-context.mjs';
import { acquireReviewLock } from '../scripts/hermes-review-queue.mjs';

const sha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
function fixture() {
  return { repo: REVIEW_REPO, number: 42, title: 'fix: safety', body: 'intent', headSha: sha, baseSha,
    mergeable: true, mergeableState: 'clean',
    files: [{ filename: 'extension/safety.mjs', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-unsafe();\n+danger(input);' }],
    source: { 'extension/safety.mjs': 'danger(input);' }, related: [], repoContext: [], comments: [], inline: [], reviews: [], checks: [], statuses: [] };
}
const suggestion = { path: 'extension/safety.mjs', line: 1, title: 'Name the trust boundary explicitly', body: 'The executor now decides trust internally. Passing a resolved trust flag keeps callers from re-deriving policy and lets the test assert the boundary rather than the call order.' };
const reply = (extra = {}) => ({ text: JSON.stringify({ summary: 'Changes the input execution path.', findings: [], suggestions: [], limitations: ['Static analysis only.'], ...extra }), provider: 'openai-codex', model: 'gpt-6.1-sol-900k', fallback: false });

test('suggestions survive generation when they name a changed file', async () => {
  const result = await generatePullReview(fixture(), {}, { writer: async () => reply({ suggestions: [suggestion] }) });
  assert.deepEqual(result.suggestions.map((s) => s.title), [suggestion.title]);
  assert.match(result.body, /### Suggestions/);
  assert.match(result.body, /Name the trust boundary explicitly/);
  assert.match(result.body, /Non-blocking/);
});

test('suggestions outside the diff or with padding text are rejected, never published', async () => {
  const result = await generatePullReview(fixture(), {}, { writer: async () => reply({ suggestions: [
    { ...suggestion, path: 'extension/not-changed.mjs' },
    { ...suggestion, title: 'Fix', body: 'short' },
    ...Array.from({ length: 8 }, (_, i) => ({ ...suggestion, title: `Distinct improvement number ${i}`, line: i + 1 })),
  ] }) });
  assert.ok(result.suggestions.length <= 5);
  assert.ok(result.suggestions.every((s) => s.path === 'extension/safety.mjs'));
});

test('a regression in deleted code is reported from the base side instead of being dropped', async () => {
  const removed = { path: 'extension/safety.mjs', line: 1, severity: 'P1', title: 'Deleting the guard re-enables the unsafe path', body: 'The deleted guard was the only place that rejected a hostile input, so removing it lets the executor dispatch the value. Restore the guard or add an equivalent check with a rejection test.', evidence: 'unsafe();' };
  const accepted = validateFindings([removed], fixture().files);
  assert.equal(accepted.accepted.length, 1);
  assert.equal(accepted.accepted[0].anchor, 'removed');
  const result = await generatePullReview(fixture(), {}, { writer: async () => reply({ findings: [removed] }) });
  assert.equal(result.findings.length, 1);
  assert.match(result.body, /removed base line/);
  assert.match(result.body, new RegExp(`/blob/${baseSha}/`));
});

test('a confirmed finding that another reviewer already raised is still counted', () => {
  // Greptile raised the P2 first, so the finding is deduped and not reposted.
  // It is still a confirmed defect: the count must show it, and the body
  // must not claim that no P0-P2 defects were confirmed.
  const body = renderPullReview(fixture(), { findings: [], suggestions: [], calls: [], analyses: [{ packet: 1 }], manifest: [{ path: 'extension/safety.mjs', category: 'source', additions: 1, deletions: 1 }], coverage: { complete: true, sourceFiles: 1, totalFiles: 1, localesSummarized: 0, generatedSkipped: 0, assetsSkipped: 0, omitted: [] },
    repeated: [{ severity: 'P2', title: 'Ignore replies after their approval card has been replaced', existingUrl: 'https://github.com/o/r/pull/42#discussion_r1' }] });
  assert.match(body, /P2 findings \| 1 \|/, 'a deduped but confirmed P2 must still be counted');
  assert.doesNotMatch(body, /No confirmed P0.P2 defects/, 'the body must not claim no confirmed defects while a P2 is listed');
  assert.match(body, /No new findings to post\. 1 finding was confirmed but already raised by another reviewer/);
  assert.match(body, /Already raised by another reviewer, not reposted:/);
});

test('review art is embedded above the evidence without a caption', () => {
  const body = renderPullReview(fixture(), { findings: [], suggestions: [], repeated: [], calls: [], analyses: [{ packet: 1 }], manifest: [{ path: 'extension/safety.mjs', category: 'source', additions: 1, deletions: 1 }], coverage: { complete: true, sourceFiles: 1, totalFiles: 1, localesSummarized: 0, generatedSkipped: 0, assetsSkipped: 0, omitted: [] } }, { url: 'https://files.catbox.moe/example.png', model: 'fal-ai/gpt-image-2' });
  assert.match(body, /!\[PR #42 review art\]\(https:\/\/files\.catbox\.moe\/example\.png\)/);
  assert.ok(body.indexOf('review art') < body.indexOf('### At a glance'));
  assert.doesNotMatch(body, /Illustrative campaign art/);
  assert.doesNotMatch(body, /carries no engineering meaning/);
});

test('review art prefers hosts that keep the file, and reports the host lifetime', async () => {
  const art = await readFile(new URL('../scripts/hermes-review-art.py', import.meta.url), 'utf8');
  // A published review comment is read for months, so a host that expires the
  // file in hours must not be the first choice.
  const permanent = art.indexOf('(CATBOX, "permanent")');
  const medium = art.indexOf('(LITTERBOX, "72h")');
  const longest = art.indexOf('(UGUU, "30d")');
  assert.ok(permanent >= 0, 'the permanent host must be listed');
  assert.ok(medium > permanent, 'the permanent host must come before expiring hosts');
  assert.ok(longest > medium, 'hosts must be ordered by how long they keep the file');
  assert.match(art, /host_lifetime/, 'the result must report the host lifetime');
  // The upload must request the long retention, not the host default.
  assert.match(art, /time=30d/, 'the upload must ask the host for long retention');
});

test('a cached art URL with no recorded size is still verified against the hosted copy', async (t) => {
  const module = await import('../scripts/hermes-review-queue.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-art-nobytes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cacheFile = path.join(directory, 'art.json');
  // A cache written before byte sizes were recorded. The hosted body is
  // truncated, so reusing this URL would publish a broken image.
  fs.writeFileSync(cacheFile, JSON.stringify({ ok: true, url: 'https://example.invalid/art.png' }));
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, url: 'https://example.invalid/new.png', bytes: 10 }));
  const env = { HERMES_REVIEW_PYTHON: process.execPath, HERMES_REVIEW_ART: '1' };
  const result = await module.generateReviewArt(JSON.stringify({ kind: 'pull_request', number: 7 }), env, cacheFile);
  assert.ok(result === null || result.url !== 'https://example.invalid/art.png', 'a cache entry without a recorded size must not be trusted unverified');
  globalThis.fetch = original;
});

test('a cached art URL that no longer serves the full file is regenerated', async (t) => {
  const module = await import('../scripts/hermes-review-queue.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-art-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cacheFile = path.join(directory, 'art.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ ok: true, url: 'https://example.invalid/art.png', bytes: 2048 }));
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, url: 'https://example.invalid/new.png', bytes: 10 }));
  const env = { HERMES_REVIEW_PYTHON: process.execPath, HERMES_REVIEW_ART: '1' };
  const result = await module.generateReviewArt(JSON.stringify({ kind: 'pull_request', number: 7 }), env, cacheFile);
  assert.ok(result === null || result.url !== 'https://example.invalid/art.png', 'a truncated hosted copy must not be reused');
  globalThis.fetch = original;
});

test('at a glance renders counted bars rather than a bare sentence', () => {
  const body = renderPullReview(fixture(), { findings: [{ severity: 'P1', path: 'extension/safety.mjs', line: 1, title: 'T', body: 'B', evidence: 'danger(input);', anchor: 'added' }], suggestions: [], repeated: [], calls: [{ model: 'm', provider: 'p' }], analyses: [1], manifest: [], coverage: { complete: true, sourceFiles: 1, totalFiles: 1, localesSummarized: 0, generatedSkipped: 0, assetsSkipped: 0, omitted: [] } });
  assert.match(body, /\| P1 findings \| 1 \| █/);
  assert.match(body, /\| P0 findings \| 0 \| · \|/);
});

test('a reclaimer that died leaves the review lock recoverable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-guard-'));
  try {
    const filename = path.join(dir, 'state.json');
    fs.writeFileSync(`${filename}.lock`, JSON.stringify({ pid: 999999, token: 'dead' }));
    fs.writeFileSync(`${filename}.lock.reclaim`, JSON.stringify({ pid: 999998, token: 'dead-reclaimer' }));
    const release = acquireReviewLock(filename);
    release();
    assert.equal(fs.existsSync(`${filename}.lock`), false);
    assert.equal(fs.existsSync(`${filename}.lock.reclaim`), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('publisher never posts an inline comment for a base-side finding', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-base-side-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journalFile = path.join(directory, 'journal.json');
  const inlines = [];
  const comments = [];
  const liveLabels = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const route = new URL(url).pathname.replace(`/repos/${REVIEW_REPO}`, '');
    const data = options.body ? JSON.parse(options.body) : null;
    const method = options.method || 'GET';
    if (route === '/pulls/42') return Response.json({ state: 'open', draft: false, head: { sha }, base: { sha: baseSha }, labels: liveLabels });
    if (route === '/user') return Response.json({ login: 'operator' });
    if (route === '/issues/42/comments') { if (method === 'GET') return Response.json(comments); const c = { id: 10, body: data.body, user: { login: 'operator' }, html_url: 'u' }; comments.push(c); return Response.json(c); }
    if (route === '/issues/comments/10') return Response.json(comments[0]);
    if (route === '/pulls/42/comments') { if (method === 'GET') return Response.json(inlines); return Response.json({ id: 20, ...data }); }
    if (route === '/issues/42') return Response.json({ state: 'open', labels: liveLabels });
    if (route === '/issues/42/labels') {
      if (method === 'POST') liveLabels.push(...data.labels.map((name) => ({ name })));
      return Response.json(liveLabels);
    }
    throw new Error(`Unexpected GitHub request: ${method} ${route}`);
  });
  const removed = { path: 'extension/safety.mjs', line: 1, severity: 'P1', title: 'Deleting the guard re-enables the unsafe path', body: 'The deleted guard was the only place that rejected a hostile input, so removing it lets the executor dispatch the value. Restore the guard or add an equivalent check with a rejection test.', evidence: 'unsafe();', anchor: 'removed' };
  const result = { findings: [removed], suggestions: [], repeated: [], calls: [{ model: 'm', provider: 'p' }], analyses: [1], manifest: [], coverage: { complete: true, sourceFiles: 1, totalFiles: 1, localesSummarized: 0, generatedSkipped: 0, assetsSkipped: 0, omitted: [] }, body: 'summary body' };
  await publishPullReview({ repo: REVIEW_REPO, number: 42, token: 'fixture', bundle: fixture(), result, journalFile });
  assert.equal(inlines.length, 0);
  assert.equal(comments.length, 1);
});

test('a finding ships with a concrete fix, verification and proposed change', async () => {
  const finding = { path: 'extension/safety.mjs', line: 1, severity: 'P1', title: 'Assist ownership check no longer recognizes retained chats',
    body: 'The new source label is api_server, so the ownership helper that used to match hermes-assist prefixes no longer matches a retained Assist chat and the first follow-up is blocked behind a warning.',
    evidence: 'danger(input);',
    fix: 'Teach isHermesBrowserOwnedSession and sessionOwnedBySurface to also accept the hermes-assist- id prefix, so retained Assist chats stay Browser-owned.',
    verification: 'Add a test that reopens a retained Assist chat and sends a follow-up without the Continue in API warning.',
    patch: '-const owned = source === HERMES_ASSIST_SOURCE;\n+const owned = source === HERMES_ASSIST_SOURCE || id.startsWith(\'hermes-assist-\');' };
  const result = await generatePullReview(fixture(), {}, { writer: async () => reply({ findings: [finding] }) });
  assert.equal(result.findings.length, 1);
  assert.match(result.body, /\*\*Fix\*\*/);
  assert.match(result.body, /\*\*How to verify\*\*/);
  assert.match(result.body, /\*\*Proposed change\*\*/);
  assert.match(result.body, /isHermesBrowserOwnedSession/);
  assert.match(result.body, /\*\*What happens\*\*/);
});

test('a finding with no fix gets a dedicated remediation pass before publication', async () => {
  const bare = { path: 'extension/safety.mjs', line: 1, severity: 'P1', title: 'Ownership helper no longer recognizes retained chats',
    body: 'The ownership helper no longer matches the id prefix that retained Assist chats use, so the first follow-up is blocked behind a warning.',
    evidence: 'danger(input);' };
  let seen = 0;
  const result = await generatePullReview(fixture(), {}, { writer: async (prompt) => {
    seen += 1;
    if (seen === 1) return reply({ findings: [bare] });
    if (seen === 2) return reply({ findings: [bare] });
    return { text: JSON.stringify({ fixes: [{ path: bare.path, line: bare.line, title: bare.title,
      fix: 'Accept the hermes-assist- id prefix in isHermesBrowserOwnedSession so retained Assist chats stay Browser-owned.',
      verification: 'Reopen a retained Assist chat and send a follow-up; the warning must not appear.',
      patch: '-const owned = id.startsWith(\'hermes-assist-\');' }] }), provider: 'openai-codex', model: 'gpt-6.1-sol-900k', fallback: false };
  } });
  assert.equal(result.findings.length, 1);
  assert.ok(result.findings[0].fix, 'the remediation pass must supply a fix');
  assert.match(result.body, /\*\*Fix\*\*/);
  assert.match(result.body, /isHermesBrowserOwnedSession/);
});

test('a clean pass discloses other reviewers findings instead of reading as a clean bill of health', async () => {
  const bundle = fixture();
  bundle.inline = [{ id: 4314652650, author: 'greptile-apps[bot]', path: 'extension/safety.mjs', line: 1, commit: sha,
    body: 'Assist chats look foreign', url: 'https://github.com/example/pull/42#discussion_r4314652650' }];
  const body = renderPullReview(bundle, { findings: [], suggestions: [], repeated: [], calls: [], analyses: [{ packet: 1 }], manifest: [], coverage: { complete: true, sourceFiles: 1, totalFiles: 1, localesSummarized: 0, generatedSkipped: 0, assetsSkipped: 0, omitted: [] } });
  assert.match(body, /No confirmed P0.P2 defects/);
  assert.match(body, /greptile-apps\[bot\]/);
  assert.match(body, /not confirmed or contradicted by this pass/);
});

test('other reviewers findings are not listed when this pass confirmed its own', () => {
  const bundle = fixture();
  bundle.inline = [{ id: 1, author: 'greptile-apps[bot]', path: 'extension/safety.mjs', line: 1, commit: sha, body: 'x', url: 'u' }];
  const body = renderPullReview(bundle, { findings: [{ path: 'extension/safety.mjs', line: 1, severity: 'P1', title: 'A confirmed finding here', body: 'The ownership helper no longer matches the prefix that retained chats use, so the follow-up is blocked.', evidence: 'danger(input);', anchor: 'added' }], suggestions: [], repeated: [], calls: [], analyses: [{ packet: 1 }], manifest: [], coverage: { complete: true, sourceFiles: 1, totalFiles: 1, localesSummarized: 0, generatedSkipped: 0, assetsSkipped: 0, omitted: [] } });
  assert.doesNotMatch(body, /not confirmed or contradicted by this pass/);
});

test('another reviewers finding against an earlier commit is disclosed as addressed, not as open', () => {
  const bundle = fixture();
  bundle.inline = [{ id: 4314652650, author: 'greptile-apps[bot]', path: 'extension/safety.mjs', line: 1,
    commit: sha, originalCommit: 'c'.repeat(40), body: 'Assist chats look foreign', url: 'https://github.com/example/pull/42#discussion_r4314652650' }];
  const body = renderPullReview(bundle, { findings: [], suggestions: [], repeated: [], calls: [], analyses: [{ packet: 1 }], manifest: [], coverage: { complete: true, sourceFiles: 1, totalFiles: 1, localesSummarized: 0, generatedSkipped: 0, assetsSkipped: 0, omitted: [] } });
  assert.match(body, /raised against an earlier commit in this PR/);
  assert.match(body, /did not reproduce it against/);
  assert.doesNotMatch(body, /were not confirmed or contradicted by this pass/);
});

test('another reviewers finding on the current head is disclosed as still open', () => {
  const bundle = fixture();
  bundle.inline = [{ id: 1, author: 'greptile-apps[bot]', path: 'extension/safety.mjs', line: 1,
    commit: sha, originalCommit: sha, body: 'Ownership check is stale', url: 'https://github.com/example/pull/42#discussion_r1' }];
  const body = renderPullReview(bundle, { findings: [], suggestions: [], repeated: [], calls: [], analyses: [{ packet: 1 }], manifest: [], coverage: { complete: true, sourceFiles: 1, totalFiles: 1, localesSummarized: 0, generatedSkipped: 0, assetsSkipped: 0, omitted: [] } });
  assert.match(body, /were not confirmed or contradicted by this pass/);
  assert.doesNotMatch(body, /raised against an earlier commit/);
});
