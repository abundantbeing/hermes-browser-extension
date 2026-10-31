import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPresenceState,
  reducePresence,
  presenceLine,
  presenceFrameText,
  failureReason,
} from '../extension/lib/group-presence.mjs';

const entry = (state, name) => state.members.find((m) => m.member === name);

test('createPresenceState: empty idle state', () => {
  assert.deepEqual(createPresenceState(), { members: [], order: [], phase: 'idle' });
});

test('turn_start creates every member queued in order and flips phase to running', () => {
  const s = reducePresence(createPresenceState(), {
    kind: 'turn_start',
    members: [{ member: 'Roxas', roleLabel: 'Roxas' }, { member: 'Luxord', roleLabel: 'Luxord' }],
  }, { now: 1 });
  assert.equal(s.phase, 'running');
  assert.deepEqual(s.order, ['Roxas', 'Luxord']);
  assert.deepEqual(s.members.map((m) => m.state), ['queued', 'queued']);
  assert.equal(entry(s, 'Luxord').roleLabel, 'Luxord');
});

test('working, typing, tool_start, tool_complete transition the member', () => {
  let s = reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'Roxas' }],
  }, { now: 1 });
  s = reducePresence(s, { kind: 'working', member: 'Roxas' }, { now: 2 });
  assert.equal(entry(s, 'Roxas').state, 'working');
  s = reducePresence(s, { kind: 'typing', member: 'Roxas', text: 'hel' }, { now: 3 });
  assert.equal(entry(s, 'Roxas').state, 'typing');
  assert.equal(entry(s, 'Roxas').text, 'hel');
  s = reducePresence(s, { kind: 'tool_start', member: 'Roxas', tool: 'web_search' }, { now: 4 });
  assert.equal(entry(s, 'Roxas').state, 'tool');
  assert.equal(entry(s, 'Roxas').tool, 'web_search');
  s = reducePresence(s, { kind: 'tool_complete', member: 'Roxas', tool: 'web_search' }, { now: 5 });
  assert.equal(entry(s, 'Roxas').state, 'typing');
});

test('tool_complete returns to working when the member never produced text', () => {
  let s = reducePresence(createPresenceState(), { kind: 'turn_start', members: [{ member: 'X' }] }, { now: 1 });
  s = reducePresence(s, { kind: 'working', member: 'X' }, { now: 2 });
  s = reducePresence(s, { kind: 'tool_start', member: 'X', tool: 't' }, { now: 3 });
  s = reducePresence(s, { kind: 'tool_complete', member: 'X' }, { now: 4 });
  assert.equal(entry(s, 'X').state, 'working');
});

test('reply clears text; pass and failed record terminal state', () => {
  let s = reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'A' }, { member: 'B' }, { member: 'C' }],
  }, { now: 1 });
  s = reducePresence(s, { kind: 'typing', member: 'A', text: 'hi' }, { now: 2 });
  s = reducePresence(s, { kind: 'reply', member: 'A' }, { now: 3 });
  assert.equal(entry(s, 'A').state, 'replied');
  assert.equal(entry(s, 'A').text, '');
  s = reducePresence(s, { kind: 'pass', member: 'B' }, { now: 4 });
  assert.equal(entry(s, 'B').state, 'passed');
  s = reducePresence(s, { kind: 'failed', member: 'C', error: 'boom' }, { now: 5 });
  assert.equal(entry(s, 'C').state, 'failed');
  assert.equal(entry(s, 'C').error, 'boom');
});

test('idle marks the phase done and keeps final member states', () => {
  let s = reducePresence(createPresenceState(), { kind: 'turn_start', members: [{ member: 'A' }] }, { now: 1 });
  s = reducePresence(s, { kind: 'reply', member: 'A' }, { now: 2 });
  s = reducePresence(s, { kind: 'idle' }, { now: 3 });
  assert.equal(s.phase, 'done');
  assert.equal(entry(s, 'A').state, 'replied');
});

test('an event for an unknown member adds it on the fly as working', () => {
  const s = reducePresence(createPresenceState(), { kind: 'working', member: 'Ghost', roleLabel: 'Ghost' }, { now: 1 });
  assert.equal(entry(s, 'Ghost').state, 'working');
  assert.equal(s.phase, 'running');
  assert.deepEqual(s.order, ['Ghost']);
});

test('a late typing event does not resurrect a replied member', () => {
  let s = reducePresence(createPresenceState(), { kind: 'turn_start', members: [{ member: 'A' }] }, { now: 1 });
  s = reducePresence(s, { kind: 'reply', member: 'A' }, { now: 2 });
  s = reducePresence(s, { kind: 'typing', member: 'A', text: 'late' }, { now: 3 });
  assert.equal(entry(s, 'A').state, 'replied');
  assert.equal(entry(s, 'A').text, '');
});

test('a member working again after it answered is reopened for a later round', () => {
  let s = reducePresence(createPresenceState(), { kind: 'turn_start', members: [{ member: 'A' }, { member: 'B' }] }, { now: 1 });
  s = reducePresence(s, { kind: 'pass', member: 'A' }, { now: 2 });
  s = reducePresence(s, { kind: 'reply', member: 'B' }, { now: 3 });
  s = reducePresence(s, { kind: 'working', member: 'A' }, { now: 4 });
  assert.equal(entry(s, 'A').state, 'working', 'a bot mentioned into another round is working again');
  assert.equal(entry(s, 'B').state, 'replied');
  assert.equal(s.phase, 'running');
});

const frameWords = (state) => presenceLine(state).frames.map((frame) => (
  frame.kind === 'member' ? `${frame.member.member} · ${presenceFrameText(frame)}` : presenceFrameText(frame)));

test('presenceLine names everyone still due, then each member answering now', () => {
  let s = reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'Roxas' }, { member: 'Riku' }, { member: 'Saix' }, { member: 'Luxord' }],
  }, { now: 1 });
  assert.deepEqual(frameWords(s), ['Roxas, Riku, and 2 more are working…'], 'nobody started yet: the group line alone');
  s = reducePresence(s, { kind: 'working', member: 'Roxas' }, { now: 2 });
  assert.deepEqual(frameWords(s), ['Roxas, Riku, and 2 more are working…', 'Roxas · Working…']);
  s = reducePresence(s, { kind: 'reply', member: 'Roxas' }, { now: 3 });
  s = reducePresence(s, { kind: 'tool_start', member: 'Riku', tool: 'web_search' }, { now: 4 });
  assert.deepEqual(frameWords(s), ['Riku, Saix, and Luxord are working…', 'Riku · Using web_search…']);
  s = reducePresence(s, { kind: 'pass', member: 'Riku' }, { now: 5 });
  s = reducePresence(s, { kind: 'typing', member: 'Saix', text: 'Board' }, { now: 6 });
  assert.deepEqual(frameWords(s), ['Saix and Luxord are working…', 'Saix · Typing…']);
  s = reducePresence(s, { kind: 'reply', member: 'Saix' }, { now: 7 });
  assert.deepEqual(frameWords(s), ['Luxord · Working…'], 'the last one due is a member line, never a group of one');
});

test('presenceLine keeps the line up between rounds and drops it when the turn ends', () => {
  let s = reducePresence(createPresenceState(), { kind: 'turn_start', members: [{ member: 'A' }, { member: 'B' }] }, { now: 1 });
  s = reducePresence(s, { kind: 'reply', member: 'A' }, { now: 2 });
  s = reducePresence(s, { kind: 'pass', member: 'B' }, { now: 3 });
  assert.deepEqual(frameWords(s), ['Wrapping up…'], 'Hermes may still give a mentioned bot another round');
  s = reducePresence(s, { kind: 'working', member: 'B' }, { now: 4 });
  assert.deepEqual(frameWords(s), ['B · Working…']);
  s = reducePresence(s, { kind: 'reply', member: 'B' }, { now: 5 });
  s = reducePresence(s, { kind: 'idle' }, { now: 6 });
  assert.equal(presenceLine(s), null);
  assert.equal(presenceLine(createPresenceState()), null);
});

test('presenceLine counts a failed member as done, and frames use display names', () => {
  let s = reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'default', roleLabel: 'Roxas' }, { member: 'riku', roleLabel: 'Riku' }],
  }, { now: 1 });
  s = reducePresence(s, { kind: 'failed', member: 'default', error: 'boom' }, { now: 2 });
  const [frame] = presenceLine(s).frames;
  assert.equal(frame.kind, 'member');
  assert.equal(frame.member.member, 'riku');
  s = reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'default', roleLabel: 'Roxas' }, { member: 'riku', roleLabel: 'Riku' }],
  }, { now: 1 });
  assert.equal(presenceFrameText(presenceLine(s).frames[0]), 'Roxas and Riku are working…');
});

test('failureReason maps usage and rate limit signals to one actionable line', () => {
  for (const raw of [
    'HTTP 429 Too Many Requests',
    'rate limit exceeded',
    'usage_limit_reached',
    'quota exhausted',
    'status 402',
    'insufficient credits',
  ]) {
    assert.equal(failureReason(raw), 'Usage limit reached, try again later', raw);
  }
});

test('failureReason falls back to a generic line and stays translatable', () => {
  assert.equal(failureReason(''), 'Something went wrong');
  assert.equal(failureReason('socket closed unexpectedly'), 'Something went wrong');
  const translate = (tpl) => `[${tpl}]`;
  assert.equal(failureReason('429', { translate }), '[Usage limit reached, try again later]');
  assert.equal(failureReason('boom', { translate }), '[Something went wrong]');
});

test('presenceFrameText is translatable via injected translate', () => {
  const translate = (tpl) => `[${tpl}]`;
  assert.equal(presenceFrameText({ kind: 'member', member: { member: 'Luxord', state: 'typing' } }, { translate }), '[Typing…]');
  assert.equal(presenceFrameText({ kind: 'wrapping' }, { translate }), '[Wrapping up…]');
  assert.equal(presenceFrameText({ kind: 'group', members: [{ member: 'A' }, { member: 'B' }] }, { translate }), '[A and B are working…]');
});

test('reducePresence never mutates the input state', () => {
  const before = reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'A' }],
  }, { now: 1 });
  const snapshot = JSON.parse(JSON.stringify(before));
  reducePresence(before, { kind: 'typing', member: 'A', text: 'x' }, { now: 2 });
  assert.deepEqual(before, snapshot);
});

test('retry reopens only the failed member and clears its reason', () => {
  let s = reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'A' }, { member: 'B' }, { member: 'C' }],
  }, { now: 1 });
  s = reducePresence(s, { kind: 'reply', member: 'A' }, { now: 2 });
  s = reducePresence(s, { kind: 'failed', member: 'B', error: 'boom' }, { now: 3 });
  s = reducePresence(s, { kind: 'failed', member: 'C', error: 'crash' }, { now: 4 });
  s = reducePresence(s, { kind: 'idle' }, { now: 5 });
  assert.equal(s.phase, 'done');

  s = reducePresence(s, { kind: 'retry', member: 'B' }, { now: 6 });
  assert.equal(s.phase, 'running', 'a retry reopens the running phase');
  assert.equal(entry(s, 'B').state, 'queued');
  assert.equal(entry(s, 'B').error, '', 'the stale reason is cleared');
  assert.equal(entry(s, 'A').state, 'replied', 'other terminal members are untouched');
  assert.equal(entry(s, 'C').state, 'failed', 'another failed member is untouched');
  assert.deepEqual(s.order, ['A', 'B', 'C'], 'room order is preserved');
});

test('retry lets a queued member accept the following working frame', () => {
  let s = reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'A' }, { member: 'B' }],
  }, { now: 1 });
  s = reducePresence(s, { kind: 'failed', member: 'A', error: 'boom' }, { now: 2 });
  s = reducePresence(s, { kind: 'retry', member: 'A' }, { now: 3 });
  s = reducePresence(s, { kind: 'working', member: 'A' }, { now: 4 });
  assert.equal(entry(s, 'A').state, 'working', 'the retried member moves off failed');
});