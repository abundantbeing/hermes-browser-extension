// Two first-run decisions, one rule: setup shows for a new user, and the
// background art's first-run pool is chosen from storage alone. They share the
// flags; only setup also counts messages (which cannot be read before the first
// picture is drawn). This pins the relationship so it cannot drift unseen.

import assert from 'node:assert/strict';
import test from 'node:test';

import { isFirstRunStorage } from '../extension/lib/background-art.mjs';
import { shouldShowOnboarding } from '../extension/lib/response-presentation.mjs';

const keys = { completedKey: 'done', introSeenKey: 'seen' };

test('whenever setup shows, storage says first run (the setup pool is never missed)', () => {
  for (const completed of [false, true]) {
    for (const seen of [false, true]) {
      const stored = { done: completed, seen };
      const setupShows = shouldShowOnboarding({ completed, legacyIntroSeen: seen, messageCount: 0 });
      if (setupShows) assert.equal(isFirstRunStorage(stored, keys), true, JSON.stringify(stored));
      assert.equal(isFirstRunStorage(stored, keys), !completed && !seen, 'the same two flags decide it');
    }
  }
});

test('the only difference is the message count, which the first picture cannot wait for', () => {
  const stored = {};
  assert.equal(shouldShowOnboarding({ completed: false, legacyIntroSeen: false, messageCount: 12 }), false, 'a profile with messages never sees setup');
  assert.equal(isFirstRunStorage(stored, keys), true, 'but its first picture still comes from the setup pool (a subset of all of them), by design');
});
