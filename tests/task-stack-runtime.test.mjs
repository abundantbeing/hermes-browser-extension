import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('sidepanel and full view expose the same real task-stack controls', async () => {
  const [sidepanel, app] = await Promise.all([
    read('extension/sidepanel.html'),
    read('extension/app.html'),
  ]);
  for (const source of [sidepanel, app]) {
    assert.match(source, /id="taskStack"/);
    assert.match(source, /id="taskStackToggle"/);
    assert.match(source, /id="taskStackSummary"/);
    assert.match(source, /id="taskStackProgress"/);
    assert.match(source, /id="taskStackList"/);
  }
});

test('both runtimes derive tasks from todo tool events and sync per-session storage', async () => {
  const [sidepanel, app] = await Promise.all([
    read('extension/sidepanel.js'),
    read('extension/app.js'),
  ]);
  for (const source of [sidepanel, app]) {
    assert.match(source, /taskStackFromToolEvent/);
    assert.match(source, /updateTaskStackStore/);
    assert.match(source, /hermesBrowserTaskStacks/);
    assert.match(source, /renderTaskStack/);
    assert.match(source, /captureTaskToolEvent/);
    assert.match(source, /taskStackToggle/);
  }
  assert.match(sidepanel, /captureTaskToolEvent\(tool\)/);
  assert.match(app, /captureTaskToolEvent\(event\)/);
});

test('task-stack styling uses existing Hermes tokens and supports collapsed and expanded states', async () => {
  const [sidepanelCss, appCss] = await Promise.all([
    read('extension/sidepanel.css'),
    read('extension/app.css'),
  ]);
  for (const source of [sidepanelCss, appCss]) {
    assert.match(source, /\.task-stack/);
    assert.match(source, /\.task-stack-progress/);
    assert.match(source, /\.task-stack-item/);
    assert.match(source, /data-expanded/);
  }
});

test('task-stack lists use the sharp transparent-track Hermes scrollbar on both surfaces', async () => {
  const [sidepanelCss, appCss] = await Promise.all([
    read('extension/sidepanel.css'),
    read('extension/app.css'),
  ]);

  for (const source of [sidepanelCss, appCss]) {
    assert.match(source, /\.task-stack-list\s*\{[^}]*scrollbar-gutter:\s*stable;/s);
    assert.match(source, /\.task-stack-list::-webkit-scrollbar\s*\{[^}]*width:\s*8px;/s);
    assert.match(source, /\.task-stack-list::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*rgba\(var\(--hermes-fg-rgb\),\s*0?\.45\);[^}]*border:\s*1px solid var\(--hermes-line-strong\);/s);
    assert.doesNotMatch(source, /\.task-stack-list::-webkit-scrollbar-track/);
  }
});
