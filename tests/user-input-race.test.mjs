import assert from 'node:assert/strict';
import test from 'node:test';

import { createUserInputFetchGuard, userInputWriteIsOwned } from '../extension/lib/user-input-race.mjs';

test('allows a write only while its session and connection owner remain current', () => {
  assert.equal(userInputWriteIsOwned({
    requestedSessionId: 'session-a',
    activeSessionId: 'session-a',
    requestedOwner: 'connection-a',
    activeOwner: 'connection-a',
  }), true);
  assert.equal(userInputWriteIsOwned({
    requestedSessionId: 'session-a',
    activeSessionId: 'session-b',
    requestedOwner: 'connection-a',
    activeOwner: 'connection-a',
  }), false);
  assert.equal(userInputWriteIsOwned({
    requestedSessionId: 'session-a',
    activeSessionId: 'session-a',
    requestedOwner: 'connection-a',
    activeOwner: 'connection-b',
  }), false);
});

test('rejects an older same-session replay when a newer generation starts', () => {
  const guard = createUserInputFetchGuard();
  const oldToken = guard.begin('session-1', 'connection-a');
  const newToken = guard.begin('session-1', 'connection-a');

  assert.equal(guard.isCurrent(oldToken), false);
  assert.equal(guard.isCurrent(newToken), true);
});

test('keeps independent session generations isolated when another session changes', () => {
  const guard = createUserInputFetchGuard();
  const sessionAToken = guard.begin('session-a', 'connection-a');

  guard.invalidate('session-b', 'connection-a');

  assert.equal(guard.isCurrent(sessionAToken), true);

  guard.invalidate('session-a', 'connection-a');
  assert.equal(guard.isCurrent(sessionAToken), false);
});

test('rejects an older replay after a live update invalidates its session', () => {
  const guard = createUserInputFetchGuard();
  const replayToken = guard.begin('session-1', 'connection-a');

  guard.invalidate('session-1', 'connection-a');

  assert.equal(guard.isCurrent(replayToken), false);
});

test('rejects a response owned by an old WebSocket or gateway identity', () => {
  const guard = createUserInputFetchGuard();
  const oldToken = guard.begin('session-1', 'connection-a');
  const newToken = guard.begin('session-1', 'connection-b');

  assert.equal(guard.isCurrent(oldToken), false);
  assert.equal(guard.isCurrent(newToken), true);
});

test('commits only the newest deferred response under adversarial resolution order', async () => {
  const guard = createUserInputFetchGuard();
  const committed = [];
  let resolveOld;
  let resolveNew;
  const oldResponse = new Promise((resolve) => { resolveOld = resolve; });
  const newResponse = new Promise((resolve) => { resolveNew = resolve; });
  const oldToken = guard.begin('session-1', 'connection-a');
  const newToken = guard.begin('session-1', 'connection-a');

  resolveNew({ requests: ['new'] });
  const newest = await newResponse;
  if (guard.isCurrent(newToken)) committed.push(newest);

  resolveOld({ requests: ['old'] });
  const stale = await oldResponse;
  if (guard.isCurrent(oldToken)) committed.push(stale);

  assert.deepEqual(committed, [{ requests: ['new'] }]);
});
