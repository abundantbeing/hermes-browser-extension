import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const js = readFileSync('extension/sidepanel.js', 'utf8');

test('room-member model picker starts on the provider the bot already uses', () => {
  const open = js.match(/function openRoomMemberModelMenu[\s\S]*?\n\}\n/)?.[0] || '';
  assert.match(open, /modelForMemberRead\(/, 'resolves the bot model from its binding or last confirmed read');
  assert.match(open, /roomMemberModelReads\.get\(/, 'falls back to the last confirmed status read');
  assert.match(open, /alignRoomPickerToMemberProvider/, 'reads the live model when nothing is cached');
  const target = js.match(/function modelForSelectionTarget[\s\S]*?\n\}\n/)?.[0] || '';
  assert.match(target, /roomModelPickTarget\?\.model/, 'room-member target resolves to the bot model, not the first catalog entry');
  assert.match(js, /roomMemberModelReads\.set\(roomMemberReadKey\(roomId, member\.name\)/, 'popover status reads are remembered');
});
