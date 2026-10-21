import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as context from '../scripts/hermes-review-context.mjs';
import * as pipeline from '../scripts/hermes-review-pipeline.mjs';
import * as queue from '../scripts/hermes-review-queue.mjs';
import { buildReviewTargets, reviewTargetSignature, shouldReviewTarget } from '../scripts/hermes-review-watch.mjs';

const sha = 'a'.repeat(40);

test('increment/decrement code inside a hunk is not mistaken for diff headers', () => {
  const patch = '@@ -1,2 +1,3 @@\n---counter;\n+++counter;\n+run();\n keep();';
  assert.equal(context.addedPatchLines(patch).get(1), '++counter;');
  assert.equal(context.addedPatchLines(patch).get(2), 'run();');
  assert.equal(typeof context.countPatchChanges, 'function');
  assert.deepEqual(context.countPatchChanges(patch), { additions: 2, deletions: 1 });
  const packets = context.packReviewFiles([{ filename: 'extension/a.mjs', patch }]).packets.join('\n');
  assert.match(packets, /R1 \| \+\+\+counter;/);
  assert.match(packets, /R2 \| \+run\(\);/);
});

test('PR base ref and SHA are retained and change review eligibility', () => {
  const base = { ref: 'main', sha: 'b'.repeat(40) };
  const target = buildReviewTargets({ prs: [{ number: 42, title: 'fix', head: { sha }, base }] })[0];
  assert.equal(target.baseRef, 'main');
  assert.equal(target.baseSha, base.sha);
  const state = { 'pull_request:42': { signature: reviewTargetSignature(target) } };
  assert.equal(shouldReviewTarget({ ...target, baseRef: 'release' }, state), true);
  assert.equal(shouldReviewTarget({ ...target, baseSha: 'c'.repeat(40) }, state), true);
});

test('a failed old target cannot permanently starve untouched targets', () => {
  assert.equal(typeof queue.selectReviewTargets, 'function');
  const targets = [{ kind: 'issue', number: 1, title: 'first' }, { kind: 'issue', number: 2, title: 'second' }];
  const state = { 'issue:1': { lastAttemptAt: 100, attemptSignature: reviewTargetSignature(targets[0]), retryAfter: 10000 } };
  const selected = queue.selectReviewTargets(targets, state, { now: 200, limit: 1, signature: reviewTargetSignature, shouldReview: shouldReviewTarget });
  assert.equal(selected[0].number, 2);
  const later = queue.selectReviewTargets(targets, state, { now: 20000, limit: 1, signature: reviewTargetSignature, shouldReview: shouldReviewTarget });
  assert.equal(later[0].number, 2, 'untouched targets remain ahead of repeated failed attempts');
});

test('lock release cannot delete a replacement owner lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-owner-'));
  try {
    const filename = path.join(dir, 'ledger.json');
    const release = queue.acquireReviewLock(filename);
    fs.writeFileSync(`${filename}.lock`, JSON.stringify({ pid: process.pid, token: 'replacement-owner' }));
    release();
    assert.equal(fs.existsSync(`${filename}.lock`), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inline thread identity survives rewording of the same line finding', () => {
  const first = { path: 'extension/a.mjs', line: 12, title: 'First wording' };
  assert.equal(pipeline.findingFingerprint(sha, first), pipeline.findingFingerprint(sha, { ...first, title: 'Different wording' }));
  assert.notEqual(pipeline.findingFingerprint(sha, first), pipeline.findingFingerprint(sha, { ...first, line: 13 }));
});

test('prototype-like filenames never resolve inherited source objects', () => {
  assert.equal(typeof pipeline.sourceText, 'function');
  assert.equal(pipeline.sourceText({}, '__proto__'), '');
  assert.equal(pipeline.sourceText({}, 'constructor'), '');
  const source = Object.create(null);
  source.__proto__ = 'actual source';
  assert.equal(pipeline.sourceText(source, '__proto__'), 'actual source');
});

test('malformed disposable artifacts are quarantined and regenerated, not treated as ledger corruption', () => {
  assert.equal(typeof pipeline.readReviewArtifact, 'function');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-artifact-'));
  try {
    const filename = path.join(dir, 'partial.json');
    fs.writeFileSync(filename, '{"result":');
    assert.equal(pipeline.readReviewArtifact(filename), null);
    assert.equal(fs.existsSync(filename), false);
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('partial.json.corrupt-')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
