import test from 'node:test';
import assert from 'node:assert/strict';
import { clearRewindRecovery, loadRewindRecovery, saveRewindRecovery } from '../extension/lib/rewind-recovery.mjs';

function memoryStorage() {
  const items = new Map();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
}

test('rewind recovery is scoped to profile and session and does not clear another chat', () => {
  const storage = memoryStorage();
  assert.equal(saveRewindRecovery(storage, { profile: 'work', sessionId: 'A', text: 'edited A', needsReload: true }), true);
  saveRewindRecovery(storage, { profile: 'work', sessionId: 'B', text: 'draft B' });
  assert.equal(loadRewindRecovery(storage, { profile: 'work', sessionId: 'A' }).text, 'edited A');
  assert.equal(loadRewindRecovery(storage, { profile: 'home', sessionId: 'A' }), null);
  clearRewindRecovery(storage, { profile: 'work', sessionId: 'A' });
  assert.equal(loadRewindRecovery(storage, { profile: 'work', sessionId: 'A' }), null);
  assert.equal(loadRewindRecovery(storage, { profile: 'work', sessionId: 'B' }).text, 'draft B');
});
