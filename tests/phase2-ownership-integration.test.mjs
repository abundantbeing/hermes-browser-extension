import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const panelHtml = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const web = readFileSync(new URL('../extension/app.js', import.meta.url), 'utf8');
const webHtml = readFileSync(new URL('../extension/app.html', import.meta.url), 'utf8');
const webCss = readFileSync(new URL('../extension/app.css', import.meta.url), 'utf8');
const ownershipPolicy = readFileSync(new URL('../extension/lib/session-ownership.mjs', import.meta.url), 'utf8');

test('Side Panel and Hermes Web use the shared ownership policy before sending', () => {
  for (const source of [panel, web]) {
    assert.match(source, /session-ownership\.mjs/);
    assert.match(source, /approvedForeignSessionIds/);
    assert.match(source, /requiresSessionOwnershipConfirmation\(\{/);
    assert.match(source, /sessionOwnershipNotice\(\{/);
  }
  const panelSender = panel.match(/async function askHermes\([\s\S]*?\n\}/)?.[0] || '';
  const webSender = web.match(/async function sendPrompt\([\s\S]*?\n\}/)?.[0] || '';
  const contextMenuSender = panel.match(/async function executeContextMenuRequest\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(panelSender.indexOf('guardForeignSessionSend(') < panelSender.indexOf('autoTitleForCurrentTurn'));
  assert.ok(webSender.indexOf('guardForeignSessionSend(') < webSender.indexOf('setSending(true)'));
  assert.doesNotMatch(contextMenuSender, /approvedForeignSessionIds\.add/);
});

test('both ownership warnings expose safe-new-chat and explicit-continue actions', () => {
  assert.match(panelHtml, /id="sessionOwnershipNotice"/);
  assert.match(panelHtml, /id="sessionOwnershipDetail"/);
  assert.match(ownershipPolicy, /overwrite or reorder transcript updates/);

  assert.match(webHtml, /id="webSessionOwnershipNotice"/);
  assert.match(webHtml, /id="webSessionOwnershipDetail"/);
  assert.match(webHtml, /data-web-session-ownership-action="new-web"/);
  assert.match(webHtml, /data-web-session-ownership-action="continue"/);
  assert.match(webCss, /\.web-session-ownership-notice/);
  assert.match(web, /await beginHermesWebDraft/);
  assert.match(web, /approvedForeignSessionIds\.add/);
});

test('ownership copy reports message blast radius without a 100-message gate', () => {
  assert.match(ownershipPolicy, /messageCount/);
  assert.match(ownershipPolicy, /notice|detail/);
  assert.doesNotMatch(ownershipPolicy, />=\s*100|>\s*100|100-message|message_count\s*>/);
});
