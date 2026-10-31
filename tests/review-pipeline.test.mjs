import test from 'node:test';
import assert from 'node:assert/strict';
import { callHermesReview, deriveReviewLabels } from '../scripts/hermes-review-github-event.mjs';

const repo = 'abundantbeing/hermes-browser-extension';

test('review HTTP request pins provider, reasoning, and verifies the served runtime', async (t) => {
  let sent;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent = JSON.parse(options.body);
    return Response.json({ runtime: { model: 'gpt-6.1-sol-900k', provider: 'openai-codex' }, choices: [{ message: { content: 'review' }, finish_reason: 'stop' }] });
  });
  const review = await callHermesReview('review', { HERMES_REVIEW_GATEWAY_URL: 'http://127.0.0.1:8642', HERMES_REVIEW_API_KEY: 'fixture', HERMES_REVIEW_MODEL: 'gpt-6.1-sol-900k', HERMES_REVIEW_PROVIDER: 'openai-codex', HERMES_REVIEW_REASONING_EFFORT: 'xhigh' });
  assert.equal(review, 'review');
  assert.equal(sent.provider, 'openai-codex');
  assert.deepEqual(sent.model_options, { reasoning_effort: 'xhigh' });
});

test('PR labels follow files rather than incidental checklist vocabulary', () => {
  const labels = deriveReviewLabels({ kind: 'pull_request', title: 'docs: add optional provider', body: 'model gateway build tests error settings', labels: [], files: [{ filename: 'guides/provider.md', changes: 20 }] });
  assert.deepEqual(labels, ['comp/docs', 'type/docs']);
});

test('test-only PR has one type and no guessed priority', () => {
  assert.deepEqual(deriveReviewLabels({ kind: 'pull_request', title: 'test: regression', body: 'feature bug fix', files: [{ filename: 'tests/controller.test.mjs' }], labels: [] }), ['type/test']);
});

test('runtime component labels are bounded to the two most changed components', () => {
  const labels = deriveReviewLabels({ kind: 'pull_request', title: 'fix: controls', labels: [], files: [
    { filename: 'extension/sidepanel.js', changes: 500 }, { filename: 'extension/lib/browser-control-safety.mjs', changes: 300 }, { filename: 'extension/background.js', changes: 1 },
  ] });
  assert.equal(labels.filter((s) => s.startsWith('type/')).length, 1);
  assert.ok(labels.filter((s) => s.startsWith('comp/')).length <= 2);
  assert.ok(!labels.some((s) => /^p[0-3]$/.test(s)));
});

// Dynamic import leaves a readable assertion while the new module is absent.
async function pipeline() { return import('../scripts/hermes-review-pipeline.mjs').catch(() => ({})); }

test('pipeline refuses repositories outside the HBE allowlist', async () => {
  const p = await pipeline();
  assert.equal(typeof p.assertReviewRepo, 'function', 'pipeline must enforce the HBE repository boundary');
  assert.doesNotThrow(() => p.assertReviewRepo(repo));
  assert.throws(() => p.assertReviewRepo('NousResearch/hermes-agent'), /not authorized/);
});

test('locale-heavy PR packets preserve runtime and test patches with explicit coverage', async () => {
  const p = await pipeline();
  assert.equal(typeof p.packReviewFiles, 'function', 'pipeline must pack every source patch, not a leading slice');
  const files = Array.from({ length: 42 }, (_, i) => ({ filename: `_locales/${i}/messages.json`, patch: `@@ -1 +1 @@\n-{"k":"old"}\n+{"k":"new"}`, changes: 2 }));
  files.push({ filename: 'extension/lib/browser-control-safety.mjs', patch: '@@ -1 +1 @@\n-old()\n+newSafety()', changes: 2 });
  files.push({ filename: 'tests/safety.test.mjs', patch: '@@ -1 +1 @@\n-old()\n+assertSafety()', changes: 2 });
  const packed = p.packReviewFiles(files, { maxChars: 3000 });
  assert.equal(packed.manifest.length, 44);
  assert.match(packed.packets.join('\n'), /newSafety\(\)/);
  assert.match(packed.packets.join('\n'), /assertSafety\(\)/);
  assert.equal(packed.coverage.localesSummarized, 42);
  assert.equal(packed.coverage.sourceFiles, 2);
  assert.deepEqual(packed.coverage.omitted, []);
});

test('browser locale mirrors do not crowd runtime patches out of review packets', async () => {
  const p = await pipeline();
  const packed = p.packReviewFiles([
    { filename: 'extension/_locales/fr/messages.json', patch: '@@ -1 +1 @@\n-{"k":"old"}\n+{"k":"new"}', changes: 2 },
    { filename: 'extension/a.mjs', patch: '@@ -1 +1 @@\n-safe();\n+danger();', changes: 2 },
  ]);
  assert.equal(packed.coverage.localesSummarized, 1);
  assert.equal(packed.coverage.sourceFiles, 1);
  assert.doesNotMatch(packed.packets.join('\n'), /FILE "extension\/_locales/);
});

test('executable changes inside translation modules remain reviewable code', async () => {
  const p = await pipeline();
  const packed = p.packReviewFiles([{ filename: 'extension/lib/locales/fr.mjs', patch: '@@ -1 +1,2 @@\n export default {};\n+fetch(userData);', changes: 1 }]);
  assert.match(packed.packets.join('\n'), /fetch\(userData\)/);
  assert.equal(packed.coverage.localesSummarized, 0);
});

test('large source files are split without silently dropping their final changes', async () => {
  const p = await pipeline();
  assert.equal(typeof p.packReviewFiles, 'function');
  const patch = '@@ -0,0 +1,400 @@\n' + Array.from({ length: 400 }, (_, i) => `+const value${i} = '${'v'.repeat(40)}';`).join('\n');
  const packed = p.packReviewFiles([{ filename: 'extension/large.mjs', patch, changes: 400 }], { maxChars: 3000 });
  assert.ok(packed.packets.length > 1);
  assert.ok(packed.packets.every((s) => s.length <= 3000));
  assert.match(packed.packets.join('\n'), /value399/);
});

test('missing patches cannot produce a complete review verdict', async () => {
  const p = await pipeline();
  assert.equal(typeof p.packReviewFiles, 'function');
  const packed = p.packReviewFiles([{ filename: 'extension/hidden.mjs', changes: 5 }]);
  assert.deepEqual(packed.coverage.omitted, ['extension/hidden.mjs']);
  assert.equal(packed.coverage.complete, false);
});

test('only findings anchored to actual added lines and exact evidence survive validation', async () => {
  const p = await pipeline();
  assert.equal(typeof p.validateFindings, 'function');
  const files = [{ filename: 'extension/a.mjs', patch: '@@ -1,2 +1,2 @@\n old();\n-safe();\n+danger(input);' }];
  const valid = { path: 'extension/a.mjs', line: 2, severity: 'P1', title: 'Reject untrusted commands', body: 'An untrusted input reaches the command executor without validation.', evidence: 'danger(input);' };
  const result = p.validateFindings([valid, { ...valid, path: 'missing.mjs' }, { ...valid, line: 1 }, { ...valid, evidence: 'fabricated()' }], files);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 3);
});

test('partial model streams are rejected instead of posted', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('data: {"choices":[{"delta":{"content":"unfinished"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(callHermesReview('review', { HERMES_REVIEW_GATEWAY_URL: 'http://localhost', HERMES_REVIEW_API_KEY: 'fixture' }), /incomplete|ended|runtime/i);
});
