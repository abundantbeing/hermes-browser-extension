import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');

test('the production status uses the working line and failure notices, not removed typing ids', () => {
  for (const id of ['groupPresence', 'groupWorkingLine', 'groupWorkingAvatars', 'groupWorkingText', 'groupWorkingStatus']) {
    assert.ok(source.includes(`$('#${id}')`), id);
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.doesNotMatch(source, /\$\('#groupTyping(?:Indicator|Avatars|Text)'\)/);
  assert.doesNotMatch(source, /groupPresenceChips|groupPresenceStatus/);
});
test('a reader at the bottom sees all of the working line when it appears', () => {
  const body = source.slice(source.indexOf('function renderGroupWorkingLine()'), source.indexOf('function showGroupWorkingFrame('));
  // Measured after the line takes room, the reader would already be off the bottom.
  const measured = body.indexOf('isMessageStreamNearBottom()');
  assert.ok(measured > 0 && measured < body.indexOf('els.groupWorkingLine.hidden = false'), 'near-bottom is measured before the line shows');
  assert.match(body, /if \(follow\) scrollMessageStreamToBottom\(\{ force: true \}\)/);
});
test('production activity uses the shared reducer for ordered queue and terminal states', () => {
  assert.match(source, /import\s*\{[^}]*reducePresence[^}]*presenceLine[^}]*presenceFrameText[^}]*\}\s*from\s*['"]\.\/lib\/group-presence\.mjs/);
  assert.match(source, /activeGroupPresence\s*=\s*reducePresence\(activeGroupPresence, activity\)/);
  assert.match(source, /updateActiveGroupActivity\(\{ kind: 'reply'/);
});
test('room identity headers use stable speaker keys and per-room colors', () => {
  assert.match(source, /assignRoomIdentities\(/);
  assert.match(source, /function applyRoomMessageIdentity/);
  assert.match(source, /record\.speaker/);
  for (const name of ['--bot-ink', '--bot-bar', '--bot-tint']) assert.ok(source.includes(name));
  assert.match(source, /applyRoomMessageIdentity\(node, record\)/);
});
test('room live bubble is streaming and local events cannot enter the projection', () => {
  assert.match(source, /activeGroupLiveMessage/);
  assert.match(source, /streaming: true, speaker: activity\.member/);
  assert.match(source, /kind: 'room-event'/);
  assert.match(source, /result\.messages\.map\(groupProjectionEntryFromDisplayMessage\)\.filter\(Boolean\)/);
});
