import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (file) => readFile(new URL(file, root), 'utf8');

test('right-click tasks do not force chat-only so browser context attaches per the user setting', async () => {
  const source = await read('extension/sidepanel.js');
  const execute = source.match(/async function executeContextMenuRequest\(request, requestedRoute\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(execute, 'executeContextMenuRequest must exist');
  // forceChatOnly must NOT appear in the askHermes call — its presence forced
  // refreshContext() to skip, nulled the browser context, and showed
  // "Chat only — no browser context attached" for every right-click task.
  const askCall = execute.match(/await askHermes\(userText, \[\], \{[\s\S]*?\}\)/)?.[0] || '';
  assert.ok(askCall, 'executeContextMenuRequest must call askHermes');
  assert.doesNotMatch(askCall, /forceChatOnly/, 'right-click tasks must not force chat-only');
});

test('right-click tasks use contextMenuPromptText for the user message (no separate page-text capture)', async () => {
  const source = await read('extension/sidepanel.js');
  // The old contextMenuPageText helper is gone — page content now arrives
  // through refreshContext → browser_context, not folded into the prompt.
  assert.doesNotMatch(source, /async function contextMenuPageText/);
  const execute = source.match(/async function executeContextMenuRequest\(request, requestedRoute\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(execute, /contextMenuPromptText\(request\)/);
});

test('getPageContext honors the control-panel contextDepth setting so right-click context inherits it', async () => {
  const [source, common] = await Promise.all([
    read('extension/sidepanel.js'),
    read('extension/lib/common.mjs'),
  ]);
  assert.match(common, /contextDepth: 'normal'/);
  // getPageContext reads the depth from settings, not from the options object,
  // so refreshContext → getPageContext inherits the control-panel choice.
  assert.match(source, /const requestOptions = \{\s*depth: settings\.contextDepth,/);
  assert.match(source, /contextDepthInput: \$\(['"]#contextDepthInput['"]\)/);
});

test('right-click new sessions are titled from the task text at creation', async () => {
  const source = await read('extension/sidepanel.js');
  const execute = source.match(/async function executeContextMenuRequest\(request, requestedRoute\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(execute, /const draftTitle = autoSessionTitleFromText\(userText\) \|\| makeBrowserSessionTitle\(\);/);
  assert.match(execute, /beginHermesBrowserDraft\(\{ title: draftTitle, focus: false \}\)/);
});

test('title-at-creation keeps the post-turn auto-title from double-renaming', async () => {
  const source = await read('extension/sidepanel.js');
  // The derived title is non-default, so autoTitleForCurrentTurn (which skips
  // when the current title is not a default browser title) yields nothing and
  // the session is named exactly once, at birth.
  const autoTitle = source.match(/function autoTitleForCurrentTurn\(userText = ''\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(autoTitle, /if \(!isDefaultBrowserSessionTitle\(currentTitle\)\) return '';/);
  assert.match(autoTitle, /return autoSessionTitleFromText\(userText\);/);
});
