import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('sidepanel exposes the real task-stack controls', async () => {
  const sidepanel = await read('extension/sidepanel.html');
  for (const source of [sidepanel]) {
    assert.match(source, /id="taskStack"/);
    assert.match(source, /id="taskStackToggle"/);
    assert.match(source, /id="taskStackSummary"/);
    assert.match(source, /id="taskStackProgress"/);
    assert.match(source, /id="taskStackList"/);
  }
});

test('the side panel derives tasks from todo tool events and syncs per-session storage', async () => {
  const sidepanel = await read('extension/sidepanel.js');
  for (const source of [sidepanel]) {
    assert.match(source, /taskStackFromToolEvent/);
    assert.match(source, /updateTaskStackStore/);
    assert.match(source, /hermesBrowserTaskStacks/);
    assert.match(source, /renderTaskStack/);
    assert.match(source, /captureTaskToolEvent/);
    assert.match(source, /taskStackToggle/);
  }
  assert.match(sidepanel, /captureTaskToolEvent\(tool\)/);
});

test('task-stack styling uses existing Hermes tokens and supports collapsed and expanded states', async () => {
  const sidepanelCss = await read('extension/sidepanel.css');
  for (const source of [sidepanelCss]) {
    assert.match(source, /\.task-stack/);
    assert.match(source, /\.task-stack-progress/);
    assert.match(source, /\.task-stack-item/);
    assert.match(source, /data-expanded/);
  }
});

test('task-stack lists use the sharp transparent-track Hermes scrollbar', async () => {
  const sidepanelCss = await read('extension/sidepanel.css');

  for (const source of [sidepanelCss]) {
    assert.match(source, /\.task-stack-list\s*\{[^}]*scrollbar-gutter:\s*stable;/s);
    assert.match(source, /\.task-stack-list::-webkit-scrollbar\s*\{[^}]*width:\s*8px;/s);
    assert.match(source, /\.task-stack-list::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*rgba\(var\(--hermes-fg-rgb\),\s*0?\.45\);[^}]*border:\s*1px solid var\(--hermes-line-strong\);/s);
    assert.doesNotMatch(source, /\.task-stack-list::-webkit-scrollbar-track/);
  }
});
