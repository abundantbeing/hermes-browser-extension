import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyTurnRecovery,
  latestAssistantAfterUser,
} from '../extension/lib/turn-recovery.mjs';

test('accepted stream failures recover instead of retrying the turn', () => {
  assert.equal(classifyTurnRecovery({ requestAccepted: true }), 'recover');
  assert.equal(classifyTurnRecovery(new Error('socket closed')), 'recover');
});

test('explicitly rejected stream routes may use the non-stream fallback', () => {
  assert.equal(classifyTurnRecovery({ fallbackSafe: true }), 'fallback');
  assert.equal(classifyTurnRecovery({ fallbackSafe: true, requestAccepted: true }), 'recover');
});

test('recovery selects the assistant after the latest matching user turn', () => {
  const rows = [
    { role: 'user', content: 'older prompt' },
    { role: 'assistant', content: 'older answer' },
    { role: 'user', content: 'same prompt' },
    { role: 'user', content: 'same prompt' },
    { role: 'assistant', content: 'new answer' },
  ];

  assert.equal(latestAssistantAfterUser(rows, 'same prompt'), 'new answer');
});

test('recovery does not return an assistant from before the matching user turn', () => {
  const rows = [
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'new prompt' },
  ];

  assert.equal(latestAssistantAfterUser(rows, 'new prompt'), '');
});
