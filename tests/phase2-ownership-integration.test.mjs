import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const panelHtml = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const ownershipPolicy = readFileSync(new URL('../extension/lib/session-ownership.mjs', import.meta.url), 'utf8');

test('Side Panel uses the shared ownership policy before sending', () => {
  for (const source of [panel]) {
    assert.match(source, /session-ownership\.mjs/);
    assert.match(source, /approvedForeignSessionIds/);
    assert.match(source, /requiresSessionOwnershipConfirmation\(\{/);
    assert.match(source, /sessionOwnershipNotice\(\{/);
  }
  const panelSender = panel.match(/async function askHermes\([\s\S]*?\n\}/)?.[0] || '';
  const contextMenuSender = panel.match(/async function executeContextMenuRequest\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(panelSender.indexOf('guardForeignSessionSend(') < panelSender.indexOf('autoTitleForCurrentTurn'));
  assert.doesNotMatch(contextMenuSender, /approvedForeignSessionIds\.add/);
});

test('the ownership warning exposes its notice and detail', () => {
  assert.match(panelHtml, /id="sessionOwnershipNotice"/);
  assert.match(panelHtml, /id="sessionOwnershipDetail"/);
  assert.match(ownershipPolicy, /can overwrite or reorder each other’s updates/);
});

test('ownership copy reports message blast radius without a 100-message gate', () => {
  assert.match(ownershipPolicy, /messageCount/);
  assert.match(ownershipPolicy, /notice|detail/);
  assert.doesNotMatch(ownershipPolicy, />=\s*100|>\s*100|100-message|message_count\s*>/);
});
