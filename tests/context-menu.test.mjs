import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_MENU_MAX_ITEMS,
  CONTEXT_MENU_MAX_PROMPT_LENGTH,
  CONTEXT_MENU_MAX_TITLE_LENGTH,
  DEFAULT_CONTEXT_MENU_ITEMS,
  cloneDefaultContextMenuItems,
  normalizeContextMenuItem,
  normalizeContextMenuItems,
} from '../extension/lib/common.mjs';

test('context menu: missing settings fall back to deep-cloned defaults', () => {
  const items = normalizeContextMenuItems(undefined);
  assert.equal(items.length, DEFAULT_CONTEXT_MENU_ITEMS.length);
  items[0].contexts.push('page');
  items[0].title = 'changed';
  assert.deepEqual(DEFAULT_CONTEXT_MENU_ITEMS[0].contexts, ['selection'], 'defaults must not be mutated by fallback copies');
  assert.equal(DEFAULT_CONTEXT_MENU_ITEMS[0].title, 'Ask Hermes about this selection');
});

test('context menu: an explicit empty list stays empty', () => {
  assert.deepEqual(normalizeContextMenuItems([]), []);
});

test('context menu: clearing the final title yields an empty list, not the defaults', () => {
  const items = normalizeContextMenuItems([{ id: 'a', title: '   ', contexts: ['selection'] }]);
  assert.deepEqual(items, []);
});

test('context menu: an entirely invalid list yields an empty list, not the defaults', () => {
  const items = normalizeContextMenuItems([{ id: 'a', title: '', contexts: ['selection'] }]);
  assert.deepEqual(items, []);
});

test('context menu: disabled-only lists are preserved', () => {
  const items = normalizeContextMenuItems([{ id: 'a', title: 'A', contexts: ['selection'], enabled: false }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].enabled, false);
});

test('context menu: blank titles are dropped', () => {
  const items = normalizeContextMenuItems([
    { id: 'a', title: '   ', contexts: ['selection'] },
    { id: 'b', title: 'Real', contexts: ['selection'] },
  ]);
  assert.deepEqual(items.map((item) => item.id), ['b']);
});

test('context menu: items with zero valid contexts are dropped', () => {
  const items = normalizeContextMenuItems([
    { id: 'a', title: 'A', contexts: [] },
    { id: 'b', title: 'B', contexts: ['nonsense'] },
    { id: 'c', title: 'C', contexts: ['selection'] },
  ]);
  assert.deepEqual(items.map((item) => item.id), ['c']);
});

test('context menu: duplicate item ids are deduplicated keeping the first', () => {
  const items = normalizeContextMenuItems([
    { id: 'a', title: 'First', contexts: ['selection'] },
    { id: 'a', title: 'Second', contexts: ['page'] },
    { id: 'b', title: 'B', contexts: ['selection'] },
  ]);
  assert.deepEqual(items.map((item) => item.title), ['First', 'B']);
});

test('context menu: duplicate contexts are deduplicated', () => {
  const item = normalizeContextMenuItem({ id: 'a', title: 'A', contexts: ['selection', 'selection', 'editable'] });
  assert.deepEqual(item.contexts, ['selection', 'editable']);
});

test('context menu: unknown inline actions are rejected', () => {
  assert.equal(normalizeContextMenuItem({ id: 'a', title: 'A', contexts: ['editable'], inlineAction: 'teleport' }), null);
});

test('context menu: allowlisted inline actions are accepted', () => {
  const item = normalizeContextMenuItem({ id: 'a', title: 'A', contexts: ['editable'], inlineAction: 'improve' });
  assert.equal(item.inlineAction, 'improve');
  assert.deepEqual(item.contexts, ['editable']);
});

test('context menu: prompt items are restricted to selection and editable contexts', () => {
  const item = normalizeContextMenuItem({ id: 'a', title: 'A', contexts: ['page', 'link', 'selection'], prompt: 'Ask' });
  assert.deepEqual(item.contexts, ['selection']);
  const pageOnly = normalizeContextMenuItem({ id: 'b', title: 'B', contexts: ['page'], prompt: 'Ask' });
  assert.equal(pageOnly, null);
});

test('context menu: inline items are restricted to editable contexts', () => {
  const item = normalizeContextMenuItem({ id: 'a', title: 'A', contexts: ['selection', 'editable', 'image'], inlineAction: 'improve' });
  assert.deepEqual(item.contexts, ['editable']);
  const nonEditable = normalizeContextMenuItem({ id: 'b', title: 'B', contexts: ['selection'], inlineAction: 'improve' });
  assert.equal(nonEditable, null);
});

test('context menu: the default open item normalizes as an explicit open action', () => {
  const item = normalizeContextMenuItem(DEFAULT_CONTEXT_MENU_ITEMS[5]);
  assert.equal(item.open, true);
  assert.deepEqual(item.contexts, ['page', 'link', 'image', 'video', 'audio']);
});

test('context menu: explicit open flag and open mode are honored for custom ids', () => {
  const flagged = normalizeContextMenuItem({ id: 'custom-open', title: 'Open', contexts: ['page'], open: true });
  assert.equal(flagged.open, true);
  const byMode = normalizeContextMenuItem({ id: 'custom-open-2', title: 'Open', contexts: ['page'], mode: 'open' });
  assert.equal(byMode.open, true);
});

test('context menu: item count is bounded', () => {
  const many = Array.from({ length: CONTEXT_MENU_MAX_ITEMS + 5 }, (_, i) => ({ id: `item-${i}`, title: `Item ${i}`, contexts: ['selection'] }));
  const items = normalizeContextMenuItems(many);
  assert.equal(items.length, CONTEXT_MENU_MAX_ITEMS);
});

test('context menu: overlong titles and prompts are truncated', () => {
  const item = normalizeContextMenuItem({
    id: 'a',
    title: 'x'.repeat(CONTEXT_MENU_MAX_TITLE_LENGTH + 20),
    contexts: ['selection'],
    prompt: 'p'.repeat(CONTEXT_MENU_MAX_PROMPT_LENGTH + 20),
  });
  assert.equal(item.title.length, CONTEXT_MENU_MAX_TITLE_LENGTH);
  assert.equal(item.prompt.length, CONTEXT_MENU_MAX_PROMPT_LENGTH);
});

test('context menu: non-array garbage falls back to defaults', () => {
  for (const garbage of [null, 'text', { id: 'a' }, 42]) {
    const items = normalizeContextMenuItems(garbage);
    assert.equal(items.length, DEFAULT_CONTEXT_MENU_ITEMS.length);
  }
});

test('context menu: invalid entries are dropped while valid entries survive', () => {
  const items = normalizeContextMenuItems([
    null,
    'text',
    { id: 'a', title: 'A', contexts: ['selection'] },
    { id: '', title: 'No id', contexts: ['selection'] },
  ]);
  assert.deepEqual(items.map((item) => item.id), ['a']);
});

test('context menu: cloneDefaultContextMenuItems produces independent nested arrays', () => {
  const first = cloneDefaultContextMenuItems();
  const second = cloneDefaultContextMenuItems();
  first[0].contexts.push('editable');
  assert.deepEqual(second[0].contexts, ['selection']);
  assert.deepEqual(DEFAULT_CONTEXT_MENU_ITEMS[0].contexts, ['selection']);
});
