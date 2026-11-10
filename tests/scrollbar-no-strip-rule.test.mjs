import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Hard rule: a scrollbar floats over what it scrolls (lib/overlay-scrollbar.mjs). No area keeps an empty
// strip beside its content for one, the gap that sat beside the model search.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'vendor' || name === 'locales' || name === '_locales' ? [] : sources(full);
    return /\.(css|html|js|mjs)$/.test(name) ? [full] : [];
  });
}

test('no area in the extension keeps a strip beside its content for a scrollbar', () => {
  const found = sources(path.join(root, 'extension'))
    .filter((file) => /scrollbar-gutter\s*:\s*stable/.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(root, file).split(path.sep).join('/'));
  assert.deepEqual(found, [], `use attachOverlayScrollbar instead: ${found.join(', ')}`);
});

const SIDE_PANEL_AREAS = ['.app-scroll', '.settings-dialog', '.add-connection-body', '.browser-control-dialog', '.tool-call-list', '.task-stack-list', '.subagent-stack-stream', '.bot-mode-cron-list', '.marketplace-theme-results', '.branded-select-list'];

test('the side panel gives every one of its vertical scroll areas the floating thumb', () => {
  const source = read('extension/sidepanel.js');
  const listed = /const OVERLAY_SCROLL_AREAS = '([^']+)';/.exec(source)?.[1].split(',').map((selector) => selector.trim()) || [];
  assert.deepEqual(listed, SIDE_PANEL_AREAS);
  assert.match(source, /installOverlayScrollbars\(document\.body, OVERLAY_SCROLL_AREAS\)/);
  assert.match(source, /mountOverlayScrollbars\(\);\nawait initI18n\(\);/, 'installed before the panel renders');
});

// A sticky box only moves within its own grid cell, and in a flex row it would take a column: an area
// with the floating thumb is a block or a flex column.
test('no area with the floating thumb is a grid or a flex row', () => {
  const css = `${read('extension/sidepanel.css')}\n${read('extension/lib/branded-select.css')}`;
  for (const selector of SIDE_PANEL_AREAS) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    const rules = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((match) => match[1]);
    assert.ok(rules.length, `${selector} has a rule`);
    for (const rule of rules) {
      assert.doesNotMatch(rule, /display:\s*(?:inline-)?grid/, `${selector} is not a grid`);
      if (/display:\s*flex/.test(rule)) assert.match(rule, /flex-direction:\s*column/, `${selector} is a flex column`);
    }
  }
  const assist = /style\.textContent = `([\s\S]*?)`;/.exec(read('extension/content-inline-helper.js'))[1];
  assert.match(assist, /\.dd-list \{[^}]*display:flex; flex-direction:column;/);
});
