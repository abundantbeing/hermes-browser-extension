import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { installGroupLifecycleHarness } from './helpers/group-lifecycle-harness.mjs';

import {
  readRoomDisplayEvents,
  appendRoomDisplayEvent,
  clearRoomDisplayEvents,
} from '../extension/lib/group-member-models.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function fn(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const end = source.indexOf('\nfunction ', start + 10);
  return source.slice(start, end === -1 ? source.length : end);
}

// ---------------------------------------------------------------------------
// Pure: durable per-room display-event store
// ---------------------------------------------------------------------------

test('room display events round-trip per room and are immutable', () => {
  const empty = {};
  const a = { role: 'system', kind: 'room-event', content: 'Riku passed', ts: 1 };
  const written = appendRoomDisplayEvent(empty, 'room-1', a);
  assert.equal(Object.keys(empty).length, 0, 'the input store is never mutated');
  assert.deepEqual(readRoomDisplayEvents(written, 'room-1'), [a]);
  assert.deepEqual(readRoomDisplayEvents(written, 'room-2'), [], 'a different room has no leaked events');

  const b = { role: 'system', kind: 'room-event', content: 'Riku could not reply', ts: 2 };
  const written2 = appendRoomDisplayEvent(written, 'room-1', b);
  assert.deepEqual(readRoomDisplayEvents(written2, 'room-1').map((r) => r.ts), [1, 2]);
  assert.deepEqual(readRoomDisplayEvents(written, 'room-1').map((r) => r.ts), [1], 'append is copy-on-write');

  const cleared = clearRoomDisplayEvents(written2, 'room-1');
  assert.deepEqual(readRoomDisplayEvents(cleared, 'room-1'), []);
  assert.deepEqual(readRoomDisplayEvents(written2, 'room-1').map((r) => r.ts), [1, 2]);
});

test('room display events are capped per room and ignore a blank room id', () => {
  let store = {};
  for (let i = 0; i < 205; i += 1) {
    store = appendRoomDisplayEvent(store, 'room-1', { role: 'system', kind: 'room-event', content: `e${i}`, ts: i });
  }
  const list = readRoomDisplayEvents(store, 'room-1');
  assert.equal(list.length, 200, 'per-room history is bounded');
  assert.equal(list.at(-1).content, 'e204', 'newest events are retained');
  const blank = appendRoomDisplayEvent(store, '', { content: 'x' });
  assert.deepEqual(readRoomDisplayEvents(blank, ''), [], 'a blank room id is never stored');
});

test('readRoomDisplayEvents copies records so callers cannot mutate the store', () => {
  const store = appendRoomDisplayEvent({}, 'r', { role: 'system', kind: 'room-event', content: 'x', ts: 1 });
  const list = readRoomDisplayEvents(store, 'r');
  list[0].content = 'tampered';
  assert.equal(readRoomDisplayEvents(store, 'r')[0].content, 'x');
});

// ---------------------------------------------------------------------------
// Gap (High): fail-closed pre-turn pinned model validation
// ---------------------------------------------------------------------------

test('the pre-turn model guard fails closed when a binding cannot be verified', () => {
  const hook = fn('applyRoomMemberModelBeforeTurn');
  assert.match(hook, /readMemberModel\(/, 'the hook reads the live model');
  // A binding that exists but whose live model cannot be read must not let the
  // turn proceed on an unverified model.
  assert.match(hook, /read\?\.state !== 'ok'/, 'an unreadable live model is detected');
  assert.match(hook, /room-model-unverified/, 'the unverified read fails the turn with a typed error');
  assert.match(hook, /throw error/, 'the hook throws instead of silently answering on the wrong model');
  assert.match(hook, /needsReapply\(/, 'only a verified mismatch is re-applied');
  assert.match(hook, /result\?\.state !== 'ok'/, 'an unverified switch still fails the turn');
});

// ---------------------------------------------------------------------------
// Gap (Medium): confirmation/retry for Change and Reset
// ---------------------------------------------------------------------------

test('a confirmation-required Change names the model and retries with confirm:true', () => {
  const pick = fn('setRoomMemberModel');
  assert.match(pick, /\{ confirm = false \} = \{\}/, 'the pick accepts a confirm flag');
  assert.match(pick, /state === 'confirm'/, 'the confirm-required state is handled');
  assert.match(pick, /openRoomModelConfirm\(/, 'a named confirmation is opened, not a bare warning');
  assert.match(pick, /confirm: true/, 'the retry re-calls the runtime switch with confirm:true');
  assert.match(pick, /setMemberModel\(roomId, member, \{[\s\S]*?confirm,/, 'the confirm flag reaches the runtime');
  const dialog = fn('openRoomModelConfirm');
  assert.match(dialog, /detail\.provider|provider/, 'the confirmation names the provider');
  assert.match(dialog, /ui\.confirm/, 'the confirmation has an explicit confirm action');
  assert.match(dialog, /ui\.cancel/, 'the confirmation can be cancelled');
});

test('a confirmation-required Reset names the profile default and retries with confirm:true', () => {
  const reset = fn('resetRoomMemberModel');
  assert.match(reset, /\{ confirm = false \} = \{\}/, 'reset accepts a confirm flag');
  assert.match(reset, /state === 'confirm'/, 'the confirm-required state is handled');
  assert.match(reset, /openRoomModelConfirm\(/, 'a named confirmation is opened');
  assert.match(reset, /resetMemberModel\(roomId, member, \{ confirm \}\)/, 'the confirm flag reaches the runtime');
  assert.match(reset, /confirm: true/, 'the retry re-calls reset with confirm:true');
});

// ---------------------------------------------------------------------------
// Gap (Medium): persisted display-only model change/reset notices
// ---------------------------------------------------------------------------

test('a verified Change and Reset append a persisted display-only room-event line', () => {
  for (const name of ['setRoomMemberModel', 'resetRoomMemberModel']) {
    const body = fn(name);
    assert.match(body, /appendRoomEventLine\(/, `${name} appends a transcript line`);
  }
  const change = fn('setRoomMemberModel');
  assert.match(change, /ui\.room\.member\.now\.uses/, 'the change line names the model');
  const reset = fn('resetRoomMemberModel');
  assert.match(reset, /ui\.room\.member\.default\.restored/, 'the reset line restores-to-default wording');
  const line = fn('appendRoomEventLine');
  assert.match(line, /kind: 'room-event'/, 'the notice is a display-only room-event row');
  assert.match(line, /recordRoomDisplayEvent\(/, 'the notice is persisted durably');
  assert.match(line, /persist: false/, 'the notice is never written as a real message');
});

// ---------------------------------------------------------------------------
// Reliability rider: durable failure/pass history across a room reopen
// ---------------------------------------------------------------------------

test('failure/pass notices are persisted and restored on room reopen', () => {
  const activity = fn('updateActiveGroupActivity');
  assert.match(activity, /recordRoomDisplayEvent\(record\)/, 'a pass/failure row is persisted as it is shown');
  // The reopen path must hydrate the durable rows instead of dropping them.
  const open = fn('openBotGroupChat');
  assert.match(open, /readRoomDisplayEvents\(/, 'a reopened room restores its durable display rows');
  assert.doesNotMatch(open, /activeGroupDisplayEvents = \[\];/, 'a reopen must not wipe durable history');
  assert.match(source, /hermesBrowserRoomEvents/, 'the durable store has its own storage key');
});

test('reopening a room merges durable display rows back into the transcript', async () => {
  const start = source.indexOf('async function openBotGroupChat(');
  const end = source.indexOf('\n// Group projections are read from the connected verified roster', start);
  assert.notEqual(start, -1);
  const openSource = source.slice(start, end);
  const row = { id: 'room-1', roomId: 'room-1', displayName: 'Room One', messages: [] };
  const context = {
    isRemoteMode: () => false,
    isRemoteWsMode: () => false,
    sending: false,
    activeRunControl: null,
    markRunTerminal: (control) => control,
    activeGroupGeneration: 0,
    activeGroupProjection: null,
    activeGroupRuntime: null,
    activeGroupMessages: [],
    activeGroupPresence: { phase: 'idle' },
    activeGroupLiveMessage: null,
    activeGroupDisplayEvents: [],
    roomEventStore: { 'room-1': [{ role: 'system', kind: 'room-event', content: 'Roxas passed', ts: 5 }] },
    readRoomDisplayEvents,
    activeGroupThreadId: '',
    activeGroupPendingNewThread: false,
    activeGroupExpandedThreads: new Set(),
    activeGroupTypingMembers: new Map(),
    activeGroupAbortController: null,
    activeConversationTransport: 'rest',
    botHistoryVisibleCount: 0,
    BOT_HISTORY_PAGE_SIZE: 40,
    messages: [],
    document: { body: { classList: { add() {} } } },
    els: { botModePanel: {}, botModeButton: { setAttribute() {} }, input: { focus() {} } },
    ensureActiveDashboardWsConnection: async () => ({ baseUrl: 'http://dash', client: {} }),
    persistActiveGroupProjection: async () => {},
    groupProjectionMessagesForDisplay: () => [{ role: 'user', content: 'hi', ts: 1 }],
    groupRuntimeMembers: () => [{ name: 'alpha' }],
    groupProjectionEntryFromDisplayMessage: (message) => ({ ...message }),
    updateActiveGroupActivity() {},
    captureTaskToolEvent: async () => {},
    resetActiveGroupTypingIndicator() {},
    renderGroupThreadStrip() {},
    renderMessagesFromStorage() {},
    updateSessionLabel() {},
    renderActiveProfileIndicator() {},
    setStatus() {},
    createBotGroupRuntime: () => ({ prepare: async () => ({ ok: true, failures: [] }) }),
  };
  vm.createContext(context);
  installGroupLifecycleHarness(context, source);
  vm.runInContext(`${openSource}\nthis.open = openBotGroupChat;`, context);
  await context.open(row);
  assert.deepEqual(
    Array.from(context.activeGroupMessages, (message) => message.content),
    ['hi', 'Roxas passed'],
    'the durable failure row is restored into the reopened transcript',
  );
});

// ---------------------------------------------------------------------------
// Gap (Low): the member list shows the confirmed provider
// ---------------------------------------------------------------------------

test('the member list label includes the confirmed provider', () => {
  const popover = fn('renderRoomPopover');
  assert.match(popover, /read\.provider/, 'the row label surfaces the confirmed provider');
});
