import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { bindRowIdsFromHistory, rebindSurvivorRowIds } from '../extension/lib/message-rewind.mjs';
import { createPresenceState, reducePresence, presenceLine, presenceFrameText } from '../extension/lib/group-presence.mjs';
import { buildMessageRail } from '../extension/lib/message-actions.mjs';
import { needsReapply } from '../extension/lib/group-member-models.mjs';

const documentFor = () => parseHTML('<html><body></body></html>').document;

test('history binding reserves previously-bound ids even when the bound row follows an unbound row', () => {
  const records = [{ role: 'user', content: 'two' }, { role: 'user', content: 'two', rowId: 8 }];
  const out = bindRowIdsFromHistory(records, [{ role: 'user', content: 'two', row_id: 8 }]);
  assert.equal(out[0].rowId, undefined);
  assert.equal(out[1].rowId, 8);
  assert.equal(records[0].rowId, undefined);
});

test('malformed mapped survivor addresses clear old ids, preserving omitted ids without shared objects', () => {
  for (const invalid of ['bad', 0, -1, 1.5, null, undefined]) {
    const input = [{ role: 'user', rowId: 10 }, { role: 'assistant', rowId: 11 }];
    const out = rebindSurvivorRowIds(input, { survivor_row_id_map: { 10: invalid } });
    assert.equal('rowId' in out[0], false, `invalid survivor ${String(invalid)}`);
    assert.equal(out[1].rowId, 11);
    assert.notEqual(out[1], input[1]);
    assert.equal(input[0].rowId, 10);
  }
});

test('malformed array survivor addresses clear old ids rather than retaining stale truncation targets', () => {
  for (const invalid of ['bad', 0, -1, 1.5]) {
    const input = [{ role: 'user', rowId: 10 }, { role: 'user', rowId: 11 }];
    const out = rebindSurvivorRowIds(input, { survivor_user_row_ids: [55, invalid] });
    assert.equal(out[0].rowId, 55);
    assert.equal('rowId' in out[1], false);
    assert.equal(input[1].rowId, 11);
  }
});

const lineWords = (state) => presenceLine(state)?.frames.map((frame) => presenceFrameText(frame)) ?? null;
const memberState = (state, name) => state.members.find((entry) => entry.member === name)?.state;

test('presence never announces completion before the routed members start', () => {
  let state = reducePresence(createPresenceState(), { kind: 'turn_start', members: [{ member: 'A' }, { member: 'B' }] });
  assert.deepEqual(lineWords(state), ['A and B are working…']);
  state = reducePresence(state, { kind: 'reply', member: 'A' });
  assert.deepEqual(lineWords(state), ['Working…'], 'B is still due');
  assert.equal(presenceLine(state).frames[0].member.member, 'B');
});

test('presence never announces completion when a turn ends with members still queued', () => {
  let state = reducePresence(createPresenceState(), { kind: 'turn_start', members: [{ member: 'A' }, { member: 'B' }] });
  state = reducePresence(state, { kind: 'working', member: 'A' });
  state = reducePresence(state, { kind: 'reply', member: 'A' });
  // The runtime still emits `idle` after an abort breaks the member loop: the line goes away and
  // the queued member is never reported as replied.
  state = reducePresence(state, { kind: 'idle' });
  assert.equal(state.phase, 'done');
  assert.equal(presenceLine(state), null);
  assert.equal(memberState(state, 'B'), 'queued');
});

test('presence never claims a terminal outcome for a member that never ran', () => {
  const state = reducePresence(reducePresence(createPresenceState(), {
    kind: 'turn_start', members: [{ member: 'A' }, { member: 'B' }],
  }), { kind: 'idle' });
  assert.deepEqual(state.members.map((entry) => entry.state), ['queued', 'queued']);
  assert.equal(presenceLine(state), null);
});

test('an unknown activity kind never invents a member or reopens a finished turn', () => {
  let started = reducePresence(createPresenceState(), { kind: 'turn_start', members: [{ member: 'A' }] });
  started = reducePresence(started, { kind: 'working', member: 'A' });
  const done = reducePresence(started, { kind: 'reply', member: 'A' });
  done.phase = 'done';
  const afterUnknown = reducePresence(done, { kind: 'sync_failed', member: 'ghost', error: 'boom' });
  assert.deepEqual(afterUnknown.members, done.members, 'an unknown member is not added');
  assert.equal(afterUnknown.phase, 'done', 'an unknown kind does not reopen a finished turn');
  assert.equal(presenceLine(afterUnknown), null);
});

test('rails reject invalid date values without throwing or fabricating an epoch time', () => {
  for (const ts of [8.7e15, -8.7e15, 0, -1, NaN, Infinity, null]) {
    const rail = buildMessageRail({ document: documentFor(), role: 'user', ts });
    assert.equal(rail.querySelector('time'), null, `invalid timestamp ${String(ts)}`);
    assert.ok(rail.querySelector('.message-action-copy'));
  }
});

test('rails normalize Unix-second timestamps even when the caller passes legacy values', () => {
  const milliseconds = new Date('2026-09-30T07:42:08Z').getTime();
  const rail = buildMessageRail({ document: documentFor(), role: 'user', ts: milliseconds / 1000, now: milliseconds });
  assert.equal(rail.querySelector('time').getAttribute('datetime'), new Date(milliseconds).toISOString());
});

test('rails also reject invalid Date ranges when an injected clock cannot enforce the future cutoff', () => {
  for (const now of [NaN, Infinity]) {
    const rail = buildMessageRail({ document: documentFor(), role: 'user', ts: 8.7e15, now });
    assert.equal(rail.querySelector('time'), null);
  }
});

test('an explicit provider pin triggers reapply for a mismatched or unreadable live provider', () => {
  const binding = { model: 'same-model', provider: 'provider-a' };
  assert.equal(needsReapply({ binding, statusModel: { model: 'same-model', provider: 'provider-b' } }), true);
  assert.equal(needsReapply({ binding, statusModel: { model: 'same-model' } }), true);
  assert.equal(needsReapply({ binding, statusModel: { model: 'same-model', provider: 'provider-a' } }), false);
  assert.equal(needsReapply({ binding: { model: 'same-model' }, statusModel: { model: 'same-model', provider: 'provider-b' } }), false);
  assert.equal(needsReapply({ binding, statusModel: null }), false);
});

test('failed copy feedback resets after exactly the same delay as success feedback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rail = buildMessageRail({ document: documentFor(), role: 'user', onCopy: () => false });
  const copy = rail.querySelector('.message-action-copy');
  copy.click();
  await Promise.resolve();
  assert.equal(copy.getAttribute('aria-label'), 'Copy failed');
  t.mock.timers.tick(1599);
  assert.equal(copy.getAttribute('aria-label'), 'Copy failed');
  t.mock.timers.tick(1);
  assert.equal(copy.getAttribute('aria-label'), 'Copy message');
  assert.equal(copy.classList.contains('is-copy-failed'), false);
});
