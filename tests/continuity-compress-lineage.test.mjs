// D10: compression and the durable session key.
//
// Authority (session.mutate compress): the durable key never rotates. Pinned here with the contract
// evidence so nobody "fixes" it. Legacy dashboard socket (session.compress / automatic compression):
// the gateway moves the live runtime's session_key to the successor, so the panel must adopt it or
// the roster stops matching the viewed session.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  compressionSuccessor, createSessionLineage, rosterSuccessor,
} from '../extension/lib/session-lineage.mjs';
import { renameSessionContextEntry } from '../extension/lib/session-context-store.mjs';
import { sessionLiveRoster } from '../extension/lib/live-session-attach.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const lines = source.split('\n');
function functionSource(name) {
  const start = lines.findIndex((line) => new RegExp(`^(async )?function ${name}[(]`).test(line));
  assert.ok(start >= 0, `${name} exists`);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end += 1;
  return lines.slice(start, end + 1).join('\n');
}

// ---------- pure ----------

test('a legacy session.compress result names the successor in info.stored_session_id', () => {
  assert.equal(compressionSuccessor({ status: 'compressed', info: { stored_session_id: 'S1-child' } }, 'S1'), 'S1-child');
  assert.equal(compressionSuccessor({ info: { stored_session_id: 'S1' } }, 'S1'), '', 'an unchanged key is not a successor');
  assert.equal(compressionSuccessor({ status: 'compressed' }, 'S1'), '');
  assert.equal(compressionSuccessor(null, 'S1'), '');
});

test('the legacy roster row for the open runtime reveals a rotated key, an authority row never does', () => {
  const legacy = { sessions: [{ id: 'live-7', session_key: 'S1-child', status: 'working' }] };
  assert.equal(rosterSuccessor(legacy, { liveId: 'live-7', storedId: 'S1' }), 'S1-child');
  assert.equal(rosterSuccessor(legacy, { liveId: 'live-7', storedId: 'S1-child' }), '', 'already adopted');
  assert.equal(rosterSuccessor(legacy, { liveId: 'live-8', storedId: 'S1' }), '', 'another runtime is not this session');
  const authority = { sessions: [{ id: 'S1', session_key: 'S1', status: 'working' }] };
  assert.equal(rosterSuccessor(authority, { liveId: 'S1', storedId: 'S1', authority: true }), '');
  // even a payload that would look like a rotation is ignored on an authority socket
  assert.equal(rosterSuccessor(legacy, { liveId: 'live-7', storedId: 'S1', authority: true }), '');
});

test('without lineage the viewed session stops matching the roster; with the adopted key it matches', () => {
  const payload = { sessions: [{ id: 'live-7', session_key: 'S1-child', status: 'working' }] };
  assert.equal(sessionLiveRoster(payload, ['S1']).get('S1'), undefined, 'the old key no longer matches (the bug)');
  assert.equal(sessionLiveRoster(payload, ['S1-child']).get('S1-child')?.live, true, 'the adopted key matches');
});

test('lineage resolves to the tip, is bounded, and cannot loop', () => {
  const lineage = createSessionLineage({ max: 3 });
  assert.equal(lineage.adopt('A', 'B'), true);
  assert.equal(lineage.adopt('B', 'C'), true);
  assert.equal(lineage.resolve('A'), 'C');
  assert.equal(lineage.adopt('C', 'A'), false, 'a loop is refused');
  assert.equal(lineage.resolve('A'), 'C');
  assert.equal(lineage.adopt('X', 'X'), false);
  lineage.adopt('D', 'E');
  lineage.adopt('F', 'G');
  assert.ok(lineage.size <= 3, 'bounded');
  assert.equal(lineage.resolve('unrelated'), 'unrelated');
});

test('the context entry follows the lineage once and is not duplicated', () => {
  const store = { version: 1, entries: { S1: { updatedAt: 1 } } };
  const renamed = renameSessionContextEntry(store, 'S1', 'S1-child');
  assert.deepEqual(Object.keys(renamed.entries), ['S1-child']);
  assert.equal(renameSessionContextEntry(renamed, 'S1', 'S1-child'), renamed, 'a second adoption changes nothing');
});

// ---------- authority: nothing to adopt (evidence is in session-lineage.mjs and session-compact.mjs) ----------

test('the authority compaction path never renames the durable session', () => {
  const body = functionSource('compactCanonicalSessionContext');
  assert.doesNotMatch(body, /adoptSessionSuccessor|renameSessionContextEntry/);
  assert.doesNotMatch(body, /settings = \{ \.\.\.settings, sessionId/);
});

// ---------- the panel ----------

function adoptHarness({ sending = false, attach = null } = {}) {
  const saved = [];
  const bound = [];
  const context = vm.createContext({
    settings: { sessionId: 'S1', remoteDashboardSession: { storedSessionId: 'S1', gatewayUrl: 'http://gw' } },
    sessionContextStore: { version: 1, entries: { S1: { updatedAt: 1 } } },
    renameSessionContextEntry,
    sessionLineage: createSessionLineage(),
    promptController: { bindSession: (live, stored) => bound.push([live, stored]) },
    rememberLiveSessionAlias() {},
    browserApi: { storage: { local: { set: async (value) => { saved.push(value); } } } },
    queuedTurn: { sessionId: 'S1', text: 'later' },
    sending, liveAttach: attach,
    scheduleSessionContextPersist() {},
    updateSessionLabel() {},
    saveSessionBindingForActiveScope: async () => {},
    availableSessions: [],
    activeSessionRuntime: { sessionId: 'S1' },
  });
  vm.runInContext(functionSource('adoptSessionSuccessor'), context);
  return { context, saved, bound, connection: { wsSessionId: 'live-7', wsStoredSessionId: 'S1', client: { readyPayload: {} } } };
}

test('adopting the successor moves the durable identity everywhere the panel keeps it', async () => {
  const { context, saved, bound, connection } = adoptHarness();
  const adopted = await vm.runInContext('adoptSessionSuccessor', context)('S1', 'S1-child', connection);
  assert.equal(adopted, true);
  assert.equal(vm.runInContext('settings.sessionId', context), 'S1-child');
  assert.equal(vm.runInContext('settings.remoteDashboardSession.storedSessionId', context), 'S1-child');
  assert.equal(connection.wsStoredSessionId, 'S1-child');
  assert.deepEqual(Object.keys(vm.runInContext('sessionContextStore.entries', context)), ['S1-child']);
  assert.equal(vm.runInContext('queuedTurn.sessionId', context), 'S1-child', 'a held draft follows its session');
  assert.deepEqual(bound, [['live-7', 'S1-child']]);
  assert.equal(vm.runInContext('sessionLineage.resolve("S1")', context), 'S1-child', 'the parent id still resolves for history lookups');
  assert.equal(saved.at(-1).hermesBrowserSettings.sessionId, 'S1-child');
});

test('the same successor adopted twice changes nothing the second time', async () => {
  const { context, connection } = adoptHarness();
  const adopt = vm.runInContext('adoptSessionSuccessor', context);
  assert.equal(await adopt('S1', 'S1-child', connection), true);
  assert.equal(await adopt('S1', 'S1-child', connection), false);
  assert.equal(Object.keys(vm.runInContext('sessionContextStore.entries', context)).length, 1);
});

test('a session that is no longer the viewed one is not renamed under the person', async () => {
  const { context, connection } = adoptHarness();
  vm.runInContext('settings.sessionId = "OTHER"', context);
  assert.equal(await vm.runInContext('adoptSessionSuccessor', context)('S1', 'S1-child', connection), false);
  assert.equal(vm.runInContext('settings.sessionId', context), 'OTHER');
});

test('the manual compress path on a legacy socket adopts the successor the result names', () => {
  const body = functionSource('compactDashboardSessionContext');
  assert.match(body, /compressionSuccessor\(/);
  assert.match(body, /adoptSessionSuccessor\(/);
});

test('the roster poll adopts a rotated key, only when no turn is in flight on this view', () => {
  const body = functionSource('refreshLiveSessionRoster');
  assert.match(body, /rosterSuccessor\(/);
  assert.match(body, /adoptSessionSuccessor\(/);
  const at = body.indexOf('rosterSuccessor(');
  assert.match(body.slice(at - 200, at + 600), /!sending/);
  assert.match(body.slice(at - 200, at + 600), /!liveAttach/);
});

test('opening a session by its pre-compression id opens the successor', () => {
  const body = functionSource('openHermesSession');
  assert.match(body, /sessionLineage\.resolve\(/);
});
