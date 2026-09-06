import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  normalizeUserInputRequest,
  pendingUserInputRecords,
  userInputAnswerPayload,
} from '../extension/lib/user-input.mjs';

test('normalizes the native Hermes request contract and prefers live session identity', () => {
  const request = normalizeUserInputRequest({
    request_id: 'request-1',
    session_id: 'stored-session',
    turn_id: 'turn-1',
    context: '<not markup>',
    questions: [{
      id: 'choice',
      text: 'Pick one',
      options: ['a', 'b'],
      allow_free_text: false,
      default: 'a',
    }],
  }, 'live-session');

  assert.deepEqual(request, {
    context: '<not markup>',
    expiresAt: 0,
    questions: [{
      allowFreeText: false,
      defaultValue: 'a',
      id: 'choice',
      options: ['a', 'b'],
      text: 'Pick one',
    }],
    requestId: 'request-1',
    sessionId: 'live-session',
    status: 'pending',
    turnId: 'turn-1',
  });
});

test('filters malformed and terminal pending rows during replay', () => {
  const rows = pendingUserInputRecords({
    requests: [
      { request_id: 'pending', session_id: 'stored', questions: [{ id: 'q', text: 'Question' }] },
      { request_id: 'answered', session_id: 'stored', status: 'answered', questions: [{ id: 'q', text: 'Question' }] },
      { request_id: 'malformed', session_id: 'stored', questions: [] },
    ],
  }, 'live');

  assert.deepEqual(rows.map((row) => row.requestId), ['pending']);
  assert.equal(rows[0].sessionId, 'live');
});

test('builds a session-scoped structured answer payload', () => {
  const request = normalizeUserInputRequest({
    request_id: 'request-1',
    session_id: 'session-1',
    turn_id: 'turn-1',
    questions: [
      { id: 'choice', text: 'Pick one', options: ['a', 'b'] },
      { id: 'reason', text: 'Why?', allow_free_text: true },
    ],
  });

  assert.deepEqual(userInputAnswerPayload(request, { choice: 'a', reason: 'Because' }), {
    answers: { choice: 'a', reason: 'Because' },
    request_id: 'request-1',
    session_id: 'session-1',
    turn_id: 'turn-1',
  });
  assert.throws(() => userInputAnswerPayload(request, { choice: 'a' }), /Answer required: Why/);
});

test('mounts request stacks in the composer docks instead of content scrollers', () => {
  const extensionRoot = new URL('../extension/', import.meta.url);
  const surfaces = [
    ['sidepanel.html', 'class="bottom-dock"'],
    ['app.html', 'class="fulltab-composer-wrap"'],
  ];

  for (const [fileName, dockMarker] of surfaces) {
    let html;
    if (fileName === 'sidepanel.html') {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository test fixture.
      html = readFileSync(new URL('sidepanel.html', extensionRoot), 'utf8');
    } else {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository test fixture.
      html = readFileSync(new URL('app.html', extensionRoot), 'utf8');
    }
    const requestPosition = html.indexOf('id="userInputRequests"');
    const dockPosition = html.indexOf(dockMarker);

    assert.ok(requestPosition >= 0, `${fileName} should expose a user-input request mount`);
    assert.ok(dockPosition >= 0, `${fileName} should expose its composer dock`);
    assert.ok(
      requestPosition > dockPosition,
      `${fileName} should mount requests after the composer dock opens`,
    );
  }
});
