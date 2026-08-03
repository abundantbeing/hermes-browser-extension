import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

import { cloneDefaultContextMenuConfig as defaultContextMenuConfig } from '../extension/lib/context-menu-config.mjs';
import { createContextMenuEditor } from '../extension/lib/context-menu-editor.mjs';

function harness({ translate = (_key, fallback) => fallback } = {}) {
  const { document, Event } = parseHTML('<!doctype html><html><body><div id="editor"></div></body></html>');
  const mutations = [];
  const editor = createContextMenuEditor({
    root: document.getElementById('editor'),
    config: defaultContextMenuConfig(),
    translate,
    createId: () => 'custom-action',
    mutate: async (mutation) => {
      mutations.push(mutation);
      return defaultContextMenuConfig();
    },
  });
  return { document, Event, editor, mutations };
}

test('shared editor renders aligned Hermes switches, icon controls, and context cards', () => {
  const { document } = harness();
  const cards = document.querySelectorAll('.context-menu-editor-card');
  assert.equal(cards.length, 6);
  assert.equal(document.querySelectorAll('.context-menu-editor-card-toggle').length, 6);
  assert.equal(document.querySelectorAll('.context-menu-editor-card-body:not([hidden])').length, 1);
  assert.equal(cards[1].querySelector('.context-menu-editor-controls').hidden, true);
  const first = cards[0];
  assert.ok(first.querySelector('.context-menu-editor-card-header > .context-menu-enabled-control.hermes-switch'));
  assert.ok(first.querySelector('.hermes-switch-input[type="checkbox"]'));
  assert.equal(first.querySelectorAll('.context-menu-icon-button').length, 3);
  assert.equal(first.querySelectorAll('.context-menu-context-option').length, 7);
  for (const option of first.querySelectorAll('.context-menu-context-option')) {
    assert.ok(option.matches('label'));
    assert.ok(option.querySelector('.context-menu-context-input[type="checkbox"]'));
    assert.ok(option.querySelector('.context-menu-context-label'));
  }
  assert.ok(document.querySelector('.context-menu-editor-add.button-secondary'));
  assert.ok(document.querySelector('.context-menu-editor-restore.button-ghost'));
});

test('shared editor emits targeted mutations instead of whole-settings snapshots', async () => {
  const { document, Event, mutations } = harness();
  const title = document.querySelector('[data-item-id="hermes-browser-ask-selection"] [data-field="title"]');
  title.value = 'Ask Roxas';
  title.dispatchEvent(new Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(mutations[0], {
    type: 'update',
    id: 'hermes-browser-ask-selection',
    patch: { title: 'Ask Roxas', titleKey: '' },
  });
});

test('shared editor blocks empty prompt updates with a row-level localized error', async () => {
  const { document, Event, mutations } = harness();
  const prompt = document.querySelector('[data-item-id="hermes-browser-ask-selection"] [data-field="prompt"]');
  prompt.value = '   ';
  prompt.dispatchEvent(new Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(mutations.length, 0);
  const error = document.querySelector('[data-item-id="hermes-browser-ask-selection"] .context-menu-editor-error');
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /Prompt is required/);
});

test('shared editor rerenders application-owned copy when the locale changes', () => {
  const { document, editor } = harness();
  editor.setTranslator((key, fallback) => ({
    'ui.context.menu.editor.add': '添加操作',
    'ui.context.menu.editor.restore': '恢复默认值',
    'ui.context.menu.editor.enabled': '已启用',
  }[key] || fallback));
  assert.equal(document.querySelector('.context-menu-editor-add').textContent, '添加操作');
  assert.equal(document.querySelector('.context-menu-editor-restore').textContent, '恢复默认值');
  assert.equal(document.querySelector('.context-menu-enabled-label').textContent, '已启用');
});

test('shared editor preserves an intentional empty configuration and offers recovery actions', () => {
  const { document, editor } = harness();
  editor.setConfig({ version: 1, revision: 9, items: [] });
  assert.equal(document.querySelectorAll('.context-menu-editor-card').length, 0);
  assert.equal(document.querySelector('.context-menu-editor-empty').hidden, false);
  assert.ok(document.querySelector('.context-menu-editor-add'));
  assert.ok(document.querySelector('.context-menu-editor-restore'));
});

test('shared editor keeps only one action expanded at a time', () => {
  const { document, Event } = harness();
  const toggles = document.querySelectorAll('.context-menu-editor-card-toggle');
  toggles[1].dispatchEvent(new Event('click'));
  const bodies = document.querySelectorAll('.context-menu-editor-card-body');
  assert.equal(bodies[0].hidden, true);
  assert.equal(bodies[1].hidden, false);
  assert.equal(document.querySelectorAll('.context-menu-editor-card-body:not([hidden])').length, 1);
});

test('shared editor move controls emit the controller offset contract', async () => {
  const { document, Event, mutations } = harness();
  document.querySelector('[data-item-id="hermes-browser-ask-selection"] .context-menu-icon-button:not(:disabled)')
    .dispatchEvent(new Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(mutations[0], {
    type: 'move',
    id: 'hermes-browser-ask-selection',
    offset: 1,
  });
});
