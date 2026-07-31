import assert from 'node:assert/strict';
import test from 'node:test';

import { createWakeTranscriptProcessor } from '../extension/lib/wake-recognition.mjs';

test('wake transcript processor emits an inline command after the phrase', () => {
  const processor = createWakeTranscriptProcessor({ phrase: 'hey hermes' });
  assert.deepEqual(processor.accept('Hey Hermes, open a new chat'), {
    type: 'command',
    command: 'open a new chat',
  });
});

test('phrase-only detection waits for the next utterance', () => {
  const processor = createWakeTranscriptProcessor({ phrase: 'hey hermes' });
  assert.deepEqual(processor.accept('hey hermes'), { type: 'wake', command: '' });
  assert.deepEqual(processor.accept('summarize this page'), { type: 'command', command: 'summarize this page' });
  assert.deepEqual(processor.accept('ordinary conversation'), { type: 'none', command: '' });
});

test('paused wake transcript processor ignores audio and resets waiting state', () => {
  const processor = createWakeTranscriptProcessor({ phrase: 'hey hermes' });
  processor.accept('hey hermes');
  processor.pause();
  assert.deepEqual(processor.accept('should not dispatch'), { type: 'none', command: '' });
  processor.resume();
  assert.deepEqual(processor.accept('should still not dispatch'), { type: 'none', command: '' });
});

test('awaiting-command state expires', () => {
  let now = 1_000;
  const processor = createWakeTranscriptProcessor({ phrase: 'hey hermes', now: () => now, commandWindowMs: 5_000 });
  assert.deepEqual(processor.accept('hey hermes'), { type: 'wake', command: '' });
  now += 5_001;
  assert.deepEqual(processor.accept('too late'), { type: 'none', command: '' });
});
