import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const common = await readFile(new URL('../extension/lib/common.mjs', import.meta.url), 'utf8');
const enLocale = await readFile(new URL('../extension/lib/locales/en.mjs', import.meta.url), 'utf8');

function fn(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const end = source.indexOf('\nfunction ', start + 10);
  return source.slice(start, end === -1 ? source.length : end);
}

test('the room member popover is bound, toggled from the room header, and dismissible', () => {
  for (const id of ['roomMemberPopover', 'roomMemberPopoverList', 'roomMemberPopoverTitle']) {
    assert.ok(source.includes(`$('#${id}')`), `${id} is bound`);
    assert.ok(html.includes(`id="${id}"`), `${id} exists in the markup`);
  }
  assert.match(source, /function toggleRoomPopover\(/);
  assert.match(source, /function closeRoomPopover\(/);
  assert.match(source, /function renderRoomPopover\(/);
  // The room header click must open the popover, not the 1:1 profile menu.
  const indicator = source.slice(
    source.indexOf("els.activeProfileIndicator?.addEventListener('click'"),
    source.indexOf("els.botModeSheetSaveButton?.addEventListener"),
  );
  assert.match(indicator, /toggleRoomPopover\(\)/, 'the room header opens the room popover');
  assert.match(indicator, /closeProfileSwitchMenu\(\)/, 'the room header never opens the 1:1 menu');
  // Outside click and Escape must close it.
  assert.match(source, /#roomMemberPopover/, 'the outside-click closer includes the popover');
  assert.match(source, /closeRoomPopover\(\)[^]*Escape|key === 'Escape'[\s\S]{0,400}closeRoomPopover\(\)/, 'Escape closes the popover');
});

test('the popover reads each member model in parallel and never blocks opening', () => {
  const body = fn('renderRoomPopover');
  const row = fn('roomMemberRow');
  assert.match(body, /readMemberModel\(/, 'each row reads the member model through the runtime');
  assert.match(body, /Promise\.all/, 'independent status reads run in parallel');
  assert.match(row, /setAttribute\('role',\s*'listitem'\)/, 'rows are list items inside the list container');
  assert.match(row, /ui\.room\.checking/, 'a row shows the checking state before its read resolves');
  // A bound member is marked, and a mid-turn member cannot be changed.
  assert.match(row, /readRoomModelBinding\(/, 'the dot comes from the stored room binding');
  assert.match(row, /room-member-dot/, 'a bound member shows the dot');
  assert.match(fn('setRoomMemberModel'), /setMemberModel\(roomId, member/);
  assert.match(fn('resetRoomMemberModel'), /resetMemberModel\(roomId, member/);
});

test('a model pick in room-member mode switches that room member only', () => {
  assert.match(source, /modelSelectionTarget === 'room-member'/, 'the shared model menu has a room-member mode');
  assert.match(source, /function setModelSelectionTarget\(/);
  const target = fn('setModelSelectionTarget');
  assert.match(target, /room-member/, 'setModelSelectionTarget accepts the room-member target');
  assert.match(source, /setRoomMemberModel\(/, 'a room-member pick routes to a room switch');
  const pick = fn('setRoomMemberModel');
  assert.match(pick, /setMemberModel\(roomId, member/, 'the pick calls the runtime room switch, not applySelectedModel');
  assert.doesNotMatch(pick, /applySelectedModel\(/, 'a room pick must never change the 1:1 chat model');
  assert.match(pick, /state === 'confirm'/, 'a gateway confirmation request is surfaced, not assumed applied');
  assert.match(pick, /result\?\.state !== 'ok'/, 'an unverified switch is never reported as done');
  const okBranch = pick.slice(pick.indexOf("state !== 'ok'"));
  assert.match(okBranch, /ui\.room\.member\.now\.uses/, 'only the verified branch claims the member now uses the model');
  assert.doesNotMatch(okBranch.slice(0, okBranch.indexOf('ui.room.member.now.uses')), /ui\.room\.member\.now\.uses/, 'the unverified branch must return before any success claim');
  assert.match(pick, /writeRoomModelBinding\(/, 'a verified pick is persisted as the room binding');
});

test('room bindings are persisted in settings and the runtime re-applies them per attempt', () => {
  assert.match(common, /groupRoomModelBindings:\s*\{\}/, 'the bindings store has a default');
  assert.match(source, /writeRoomModelBinding\(/);
  assert.match(fn('persistRoomModelBindings'), /hermesBrowserSettings: settings/, 'the binding write is persisted');
  // B3.3 Outcome R: re-apply before every submission attempt via the hook.
  assert.match(source, /needsReapply\(/, 'the panel decides whether a binding must be re-applied');
  assert.match(source, /beforeMemberTurn:/, 'the room runtime receives the beforeMemberTurn hook');
  const hook = fn('applyRoomMemberModelBeforeTurn');
  assert.match(hook, /needsReapply\(/, 'the hook checks the binding before the turn');
  assert.match(hook, /setMemberModel\(/, 'the hook re-sends the session-scoped switch');
  assert.match(hook, /result\?\.state !== 'ok'/, 'the hook only continues on a verified switch');
  assert.match(hook, /throw error/, 'an unverified binding fails the member turn instead of answering on the wrong model');
  const runtime = source.slice(source.indexOf('const runtimeHooks = {'), source.indexOf('activeGroupRuntime = groupRuntime;'));
  assert.match(runtime, /beforeMemberTurn:/, 'the hook is wired into the room runtime');
  assert.match(runtime, /applyRoomMemberModelBeforeTurn\(/, 'the runtime hook calls the re-apply guard');
  assert.match(runtime, /createBotGroupRuntime\(\{ client: connection\.client, \.\.\.runtimeHooks \}\)/, 'the client-driven runtime gets every hook');
});

test('room member identity is applied in the popover rows and locales carry the strings', () => {
  const row = fn('roomMemberRow');
  assert.match(row, /roomIdentityForMember\(/, 'rows use the same identity colors as the bubbles');
  assert.match(row, /--bot-ink/, 'the row name reads the member ink color');
  for (const key of [
    'ui.room.bots.title',
    'ui.room.model.note',
    'ui.room.checking',
    'ui.room.unknown',
    'ui.room.profile.default',
    'ui.room.busy',
    'ui.room.reset.default',
    'ui.room.member.now.uses',
    'ui.room.member.default.restored',
  ]) assert.ok(enLocale.includes(key), `${key} exists in the English catalog`);
});
