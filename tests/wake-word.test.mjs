import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_WAKE_WORD_PHRASE,
  WAKE_TURN_TTL_MS,
  isLoopbackDashboardUrl,
  matchWakePhrase,
  normalizeWakeStatus,
  normalizeWakeWordSettings,
  wakeTurnIsFresh,
} from '../extension/lib/wake-word.mjs';

test('wake settings are disabled and local-only by default', () => {
  assert.deepEqual(normalizeWakeWordSettings({}), {
    enabled: false,
    phrase: DEFAULT_WAKE_WORD_PHRASE,
    preferNative: true,
    browserFallback: true,
    speakReplies: true,
  });
});

test('wake settings normalize booleans and a bounded phrase', () => {
  assert.deepEqual(normalizeWakeWordSettings({
    wakeWordEnabled: true,
    wakeWordPhrase: '  Hey Roxas  ',
    wakeWordPreferNative: false,
    wakeWordBrowserFallback: false,
    wakeWordSpeakReplies: false,
  }), {
    enabled: true,
    phrase: 'hey roxas',
    preferNative: false,
    browserFallback: false,
    speakReplies: false,
  });
  assert.equal(normalizeWakeWordSettings({ wakeWordPhrase: 'x'.repeat(200) }).phrase.length, 64);
});

test('wake phrase matching is boundary-safe and returns a trailing command', () => {
  assert.deepEqual(matchWakePhrase('Hey Hermes, summarize this page', 'hey hermes'), {
    matched: true,
    command: 'summarize this page',
  });
  assert.deepEqual(matchWakePhrase('well hey hermes', 'hey hermes'), {
    matched: true,
    command: '',
  });
  assert.deepEqual(matchWakePhrase('they hermes is not a wake phrase', 'hey hermes'), {
    matched: false,
    command: '',
  });
});

test('native wake is restricted to loopback dashboard origins', () => {
  assert.equal(isLoopbackDashboardUrl('http://127.0.0.1:9119'), true);
  assert.equal(isLoopbackDashboardUrl('http://localhost:9119/path'), true);
  assert.equal(isLoopbackDashboardUrl('https://127.0.0.1:9119'), true);
  assert.equal(isLoopbackDashboardUrl('https://cloud.example.com'), false);
  assert.equal(isLoopbackDashboardUrl('http://127.0.0.1.evil.example'), false);
});

test('wake status preserves backend ownership and remediation', () => {
  assert.deepEqual(normalizeWakeStatus({
    enabled: true,
    listening: false,
    available: true,
    owner_surface: 'tui',
    phrase: 'Hey Hermes',
    provider: 'openwakeword',
    hint: 'Already owned.',
  }), {
    enabled: true,
    listening: false,
    available: true,
    ownedByCaller: false,
    ownerSurface: 'tui',
    phrase: 'hey hermes',
    provider: 'openwakeword',
    hint: 'Already owned.',
    audioSilent: false,
  });
});

test('wake turns expire and cannot be replayed from storage', () => {
  const now = 10_000;
  assert.equal(wakeTurnIsFresh({ createdAt: now - WAKE_TURN_TTL_MS + 1, text: 'hello' }, now), true);
  assert.equal(wakeTurnIsFresh({ createdAt: now - WAKE_TURN_TTL_MS, text: 'hello' }, now), false);
  assert.equal(wakeTurnIsFresh({ createdAt: now, text: '' }, now), false);
});
