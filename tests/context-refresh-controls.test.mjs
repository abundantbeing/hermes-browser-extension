import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUILTIN_COMMANDS, parseBrowserCommand } from '../extension/lib/commands.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('/refresh is one native command that every surface can run', () => {
  const refreshes = BUILTIN_COMMANDS.filter((command) => command.name === 'refresh');
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].kind, 'native');
  assert.equal(refreshes[0].surfaces, undefined);
  assert.equal(parseBrowserCommand('/refresh')?.command.action, 'refresh');
  assert.equal(parseBrowserCommand('/refresh')?.kind, 'native');
});

test('side panel /refresh runs the same refresh as the context popover action', () => {
  const source = read('extension/sidepanel.js');
  assert.match(source, /if \(action === 'refresh'\) \{[\s\S]{0,200}refreshContextFromUser\(\)/);
  assert.match(source, /els\.contextPageRefreshButton\?\.addEventListener\('click', \(\) => \{[\s\S]{0,200}refreshContextFromUser\(\)/);
});

test('full tab /refresh still refreshes synced sessions', () => {
  const app = read('extension/app.js');
  assert.match(app, /if \(action === 'refresh'\) \{\s*await loadApp\(\);/);
  assert.doesNotMatch(app, /refresh-sessions/);
});

test('the popover refresh action sits inside the context popover', () => {
  const html = read('extension/sidepanel.html');
  const popover = html.match(/<section id="contextPopover"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(popover, /id="contextPageRefreshButton"/);
  assert.match(popover, /data-icon="refresh"/);
});
