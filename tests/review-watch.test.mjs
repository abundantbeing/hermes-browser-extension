import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildReviewTargets,
  cwdGhBinaryRisk,
  githubToken,
  latestCommentId,
  newestExternalReply,
  postedCommentIdFromReviewText,
  resolveGhBinary,
  reviewTargetSignature,
  shouldReviewTarget,
  stateSeenCommentId,
  stateSignature,
} from '../scripts/hermes-review-watch.mjs';

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-review-watch-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('reviewTargetSignature tracks PR head sha and issue title/body without comment churn', () => {
  const pr = { kind: 'pull_request', number: 4, title: 'Remote gateway', body: 'body', headSha: 'abc123' };
  assert.equal(reviewTargetSignature(pr), reviewTargetSignature({ ...pr, updatedAt: 'later' }));
  assert.notEqual(reviewTargetSignature(pr), reviewTargetSignature({ ...pr, headSha: 'def456' }));

  const issue = { kind: 'issue', number: 9, title: 'Mic broken', body: 'steps' };
  assert.equal(reviewTargetSignature(issue), reviewTargetSignature({ ...issue, updatedAt: 'comment changed timestamp' }));
  assert.notEqual(reviewTargetSignature(issue), reviewTargetSignature({ ...issue, body: 'new steps' }));
});

test('shouldReviewTarget skips unchanged signatures and reviews changed ones', () => {
  const target = { kind: 'issue', number: 2, title: 'Bug', body: 'A' };
  const signature = reviewTargetSignature(target);
  assert.equal(shouldReviewTarget(target, {}), true);
  assert.equal(shouldReviewTarget(target, { 'issue:2': signature }), false);
  assert.equal(shouldReviewTarget({ ...target, body: 'B' }, { 'issue:2': signature }), true);

  // seenCommentId-era entries store an object; signature semantics must hold.
  const entry = { signature, seenCommentId: 12345 };
  assert.equal(stateSignature(entry), signature);
  assert.equal(stateSeenCommentId(entry), 12345);
  assert.equal(stateSeenCommentId(signature), 0, 'legacy string entries have no seen comment id');
  assert.equal(shouldReviewTarget(target, { 'issue:2': entry }), false);
  assert.equal(shouldReviewTarget({ ...target, body: 'B' }, { 'issue:2': entry }), true);
});

test('newestExternalReply only surfaces new human comments after the last processed review', () => {
  const comments = [
    { id: 100, body: '<!-- hermes-agent-review:issue -->\n## Hermes Agent Issue Triage\nreview', user: { login: 'abundantbeing' } },
    { id: 101, body: 'still seeing this on 0.3.2', user: { login: 'yottyan55' } },
    { id: 102, body: '<!-- hermes-agent-review:followup -->\nfollow-up', user: { login: 'abundantbeing' } },
    { id: 103, body: 'any update here?', user: { login: 'someone' } },
  ];
  assert.equal(latestCommentId(comments), 103);
  assert.equal(newestExternalReply(comments, 102)?.id, 103);
  assert.equal(newestExternalReply(comments, 103), null, 'nothing newer than the last processed comment');
  assert.equal(newestExternalReply(comments, 100)?.id, 103, 'newest external comment wins');
  assert.equal(newestExternalReply(comments.slice(0, 3), 100)?.id, 101, 'the reviewer\'s own follow-up never counts as a reply');
  assert.equal(newestExternalReply([], 0), null);
});

test('postedCommentIdFromReviewText detects a reviewer that posted the comment itself', () => {
  const narration = 'Posted: https://github.com/abundantbeing/hermes-browser-extension/issues/102#issuecomment-5634333469';
  assert.equal(postedCommentIdFromReviewText(narration), 5634333469);
  assert.equal(postedCommentIdFromReviewText('## Summary\nAll good.'), 0);
  assert.equal(postedCommentIdFromReviewText(''), 0);
});

test('buildReviewTargets normalizes PR and issue API payloads', () => {
  const targets = buildReviewTargets({
    prs: [{ number: 1, title: 'PR', body: '', html_url: 'https://x/pr/1', user: { login: 'alice' }, head: { sha: 'sha1' } }],
    issues: [
      { number: 2, title: 'Issue', body: 'body', html_url: 'https://x/issues/2', user: { login: 'bob' } },
      { number: 3, title: 'Backed PR', pull_request: { url: 'https://api/pr/3' } },
    ],
  });
  assert.deepEqual(targets.map((target) => `${target.kind}:${target.number}`), ['pull_request:1', 'issue:2']);
  assert.equal(targets[0].headSha, 'sha1');
  assert.equal(targets[1].author, 'bob');
});


test('cwdGhBinaryRisk blocks Windows gh executables planted in the current directory', () => withTempDir((dir) => {
  for (const file of ['gh', 'gh.exe', 'gh.com', 'gh.cmd', 'gh.bat', 'gh.ps1', 'gh.lnk']) {
    fs.writeFileSync(path.join(dir, file), 'not the real gh');
    const risk = cwdGhBinaryRisk({ cwd: dir, platform: 'win32', pathext: '.COM;.EXE;.BAT;.CMD;.PS1;.LNK' });
    assert.equal(risk.blocked, true);
    assert.match(risk.path, /gh(\.|$)/i);
    fs.rmSync(path.join(dir, file), { force: true });
  }
}));

test('cwdGhBinaryRisk does not block non-Windows platforms', () => withTempDir((dir) => {
  fs.writeFileSync(path.join(dir, 'gh.exe'), 'not the real gh');
  assert.deepEqual(cwdGhBinaryRisk({ cwd: dir, platform: 'linux' }), { blocked: false });
}));

test('resolveGhBinary honors Windows PATHEXT order and returns an absolute path', () => withTempDir((dir) => withTempDir((cwd) => {
  fs.writeFileSync(path.join(dir, 'gh.exe'), 'real gh exe');
  fs.writeFileSync(path.join(dir, 'gh.com'), 'real gh com');
  const resolved = resolveGhBinary({ cwd, platform: 'win32', pathValue: dir, pathext: '.COM;.EXE' });
  assert.equal(resolved.ok, true);
  assert.equal(path.basename(resolved.path).toLowerCase(), 'gh.com');
})));

test('resolveGhBinary rejects unsafe Windows PATH entries before running gh', () => withTempDir((dir) => {
  fs.writeFileSync(path.join(dir, 'gh.exe'), 'real gh exe');
  const resolved = resolveGhBinary({ cwd: os.tmpdir(), platform: 'win32', pathValue: `.;${dir}`, pathext: '.EXE' });
  assert.equal(resolved.blocked, true);
  assert.equal(resolved.reason, 'unsafe-path-entry');
}));

test('resolveGhBinary rejects symlinked gh paths that resolve under the current directory', () => withTempDir((dir) => {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh.exe'), 'real gh exe');
  const resolved = resolveGhBinary({
    cwd: dir,
    platform: 'win32',
    pathValue: bin,
    pathext: '.EXE',
    realpathSyncFn: () => path.join(dir, 'gh.exe'),
  });
  assert.equal(resolved.blocked, true);
  assert.equal(resolved.reason, 'resolved-gh-under-cwd');
}));

test('githubToken executes the resolved gh path instead of a bare command', () => withTempDir((dir) => withTempDir((cwd) => {
  fs.writeFileSync(path.join(dir, 'gh.exe'), 'real gh exe');
  let executedPath = '';
  const token = githubToken({}, {
    cwd,
    platform: 'win32',
    pathValue: dir,
    pathext: '.EXE',
    execFileSyncFn: (command) => {
      executedPath = command;
      return 'token-from-gh\n';
    },
  });
  assert.equal(token, 'token-from-gh');
  assert.equal(path.basename(executedPath).toLowerCase(), 'gh.exe');
  assert.notEqual(executedPath, 'gh');
})));

test('githubToken refuses to execute gh when the current directory is risky', () => withTempDir((dir) => {
  fs.writeFileSync(path.join(dir, 'gh.cmd'), 'not the real gh');
  assert.throws(() => githubToken({}, {
    cwd: dir,
    platform: 'win32',
    pathValue: os.tmpdir(),
    execFileSyncFn: () => {
      throw new Error('should not execute planted gh');
    },
  }), /Refusing to execute gh/);
}));
