import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (file) => readFile(new URL(file, root), 'utf8');

test('right-click page contexts capture the page text through the existing context pipeline', async () => {
  const source = await read('extension/sidepanel.js');
  assert.match(source, /async function contextMenuPageText\(request = \{\}\)/);
  assert.match(source, /if \(!request\.pageUrl \|\| request\.selection \|\| !Number\.isFinite\(request\.tabId\)\) return '';/);
  assert.match(source, /const tab = await chrome\.tabs\.get\(request\.tabId\)\.catch\(\(\) => null\);/);
  assert.match(source, /const pageContext = await getPageContext\(tab, \{\}\)/);
  assert.match(source, /if \(!pageContext\?\.ok \|\| !pageContext\.text\) return '';/);
});

test('captured page text is folded into the task and failure degrades to URL-only', async () => {
  const source = await read('extension/sidepanel.js');
  const execute = source.match(/async function executeContextMenuRequest\(request, requestedRoute\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(execute, /const capturedPageText = await contextMenuPageText\(request\);/);
  assert.match(execute, /const baseText = contextMenuPromptText\(request\);/);
  assert.match(execute, /const userText = capturedPageText \? `\$\{baseText\}\\n\\n\$\{capturedPageText\}` : baseText;/);
  assert.match(execute, /if \(!userText\) return false;/);
});

test('capture honors the control-panel contextDepth setting used by getPageContext', async () => {
  const [source, common] = await Promise.all([
    read('extension/sidepanel.js'),
    read('extension/lib/common.mjs'),
  ]);
  assert.match(common, /contextDepth: 'normal'/);
  // getPageContext reads the depth from settings, not from the options object,
  // so the right-click capture inherits the control-panel choice for free.
  assert.match(source, /const requestOptions = \{\s*depth: settings\.contextDepth,/);
  assert.match(source, /contextDepthInput: \$\(['"]#contextDepthInput['"]\)/);
});

test('right-click new sessions are titled from the task text at creation', async () => {
  const source = await read('extension/sidepanel.js');
  const execute = source.match(/async function executeContextMenuRequest\(request, requestedRoute\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(execute, /const draftTitle = autoSessionTitleFromText\(baseText\) \|\| makeBrowserSessionTitle\(\);/);
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
