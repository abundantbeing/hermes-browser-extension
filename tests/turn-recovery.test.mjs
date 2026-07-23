import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as turnRecovery from '../extension/lib/turn-recovery.mjs';

const {
  classifyTurnRecovery,
  latestAssistantAfterUser,
} = turnRecovery;

const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../extension/app.js', import.meta.url), 'utf8');

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

test('compression exhaustion preserves the draft and compacts once without replaying an accepted turn', () => {
  assert.equal(typeof turnRecovery.sessionContextFailureRecovery, 'function');
  assert.deepEqual(turnRecovery.sessionContextFailureRecovery(
    new Error('Context length exceeded: request payload too large, and context compression failed after max compression attempts.'),
    { sessionCompress: true },
  ), {
    kind: 'compression-exhausted',
    action: 'compact',
    preserveDraft: true,
    retryTurn: false,
    gatewayStatus: 'degraded',
  });
});

test('compression exhaustion never claims a compact action when Hermes does not advertise the route', () => {
  assert.equal(typeof turnRecovery.sessionContextFailureRecovery, 'function');
  assert.deepEqual(turnRecovery.sessionContextFailureRecovery(
    'request payload too large; max compression attempts reached',
    { sessionCompress: false },
  ), {
    kind: 'compression-exhausted',
    action: 'new-session',
    preserveDraft: true,
    retryTurn: false,
    gatewayStatus: 'degraded',
  });
  assert.equal(turnRecovery.sessionContextFailureRecovery('401 Unauthorized', { sessionCompress: true }), null);
});

test('side panel wires compression exhaustion into bounded compact-or-new-session recovery', () => {
  assert.match(sidepanelSource, /sessionContextFailureRecovery\(error, gatewayCapabilities\)/);
  assert.match(sidepanelSource, /sessionContextFailureRecovery\(streamError, gatewayCapabilities\)[\s\S]{0,120}throw streamError/);
  assert.match(sidepanelSource, /await compactCurrentSessionContext\(\{[\s\S]{0,160}automaticRecovery:\s*true/);
  assert.match(sidepanelSource, /retryTurn/);
});

test('Hermes Web preserves the failed draft and uses the same acknowledged context recovery contract', () => {
  assert.match(appSource, /sessionContextFailureRecovery\(error, gatewayCapabilities\)/);
  assert.match(appSource, /await compactActiveSessionContext\(\{[\s\S]{0,160}automaticRecovery:\s*true/);
  assert.match(appSource, /retryTurn/);
});
