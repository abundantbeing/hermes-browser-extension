import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setImmediate } from 'node:timers';
import { JSDOM } from 'jsdom';
import { MODEL_REASONING_EFFORTS } from '../extension/lib/model-runtime-options.mjs';

const moduleUrl = new URL('../extension/lib/effort-control.mjs', import.meta.url);
const control = existsSync(moduleUrl) ? await import(moduleUrl.href) : {};

function setup(options = {}) {
  assert.equal(typeof control.createEffortControl, 'function', 'the shared native effort control must exist');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const { document } = dom.window;
  const buttons = document.createElement('div');
  buttons.className = 'model-effort-list';
  for (const option of MODEL_REASONING_EFFORTS) {
    const button = document.createElement('button');
    button.dataset.effort = option.value;
    button.textContent = option.label;
    buttons.append(button);
  }
  const commits = [];
  const root = control.createEffortControl({ documentRef: document, value: 'medium', buttons, onCommit: (value) => commits.push(value), ...options });
  document.body.append(root);
  const range = root.querySelector('input[type="range"]');
  return { dom, document, root, range, buttons, commits };
}

function event(context, name) {
  context.range.dispatchEvent(new context.dom.window.Event(name, { bubbles: true }));
}

function storage(initial = {}) {
  const data = { ...initial };
  const writes = [];
  const listeners = new Set();
  return {
    data, writes,
    local: {
      async get() { return { ...data }; },
      async set(patch) {
        writes.push(patch);
        const changes = Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { oldValue: data[key], newValue }]));
        Object.assign(data, patch);
        for (const listener of listeners) listener(changes, 'local');
      },
    },
    onChanged: { addListener(listener) { listeners.add(listener); } },
  };
}

const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); };

test('missing and invalid presentations default to slider', () => {
  assert.equal(typeof control.normalizeEffortPresentation, 'function');
  for (const value of [undefined, null, '', 'unknown', false, 'slider']) assert.equal(control.normalizeEffortPresentation(value), 'slider');
  assert.equal(control.normalizeEffortPresentation('buttons'), 'buttons');
});

test('native slider names all seven canonical effort levels', () => {
  for (const [index, option] of MODEL_REASONING_EFFORTS.entries()) {
    const ctx = setup({ value: option.value });
    assert.equal(ctx.range.min, '0');
    assert.equal(ctx.range.max, '6');
    assert.equal(ctx.range.step, '1');
    assert.equal(ctx.range.value, String(index));
    assert.equal(ctx.range.getAttribute('aria-valuetext'), option.label);
    assert.equal(ctx.root.querySelectorAll('.effort-control-stop').length, 7);
    assert.equal(ctx.buttons.hidden, true);
    assert.equal(ctx.root.dataset.effortPresentation, 'slider');
  }
});

test('input previews without committing or writing storage', async () => {
  const store = storage();
  const ctx = setup({ storage: store });
  await settle();
  ctx.range.value = '6';
  event(ctx, 'input');
  assert.equal(ctx.root.querySelector('.effort-control-value').textContent, 'Ultra');
  assert.equal(ctx.range.getAttribute('aria-valuetext'), 'Ultra');
  assert.equal(ctx.root.dataset.effortCharge, 'ultra');
  assert.deepEqual(ctx.commits, []);
  assert.deepEqual(store.writes, []);
});

test('change commits canonical values once and ignores the unchanged value', () => {
  const ctx = setup();
  for (const [index, option] of MODEL_REASONING_EFFORTS.entries()) {
    ctx.range.value = String(index);
    event(ctx, 'input');
    event(ctx, 'change');
    event(ctx, 'change');
    assert.equal(ctx.commits.at(-1), option.value);
  }
  assert.deepEqual(ctx.commits, MODEL_REASONING_EFFORTS.map((option) => option.value));
});

test('cancelled pointer previews revert without a commit', () => {
  const ctx = setup();
  event(ctx, 'pointerdown');
  ctx.range.value = '6';
  event(ctx, 'input');
  event(ctx, 'pointercancel');
  event(ctx, 'change');
  assert.equal(ctx.range.value, '2');
  assert.equal(ctx.range.getAttribute('aria-valuetext'), 'Medium');
  assert.deepEqual(ctx.commits, []);
});

test('Escape discards uncommitted preview without swallowing host close behavior', () => {
  const ctx = setup();
  ctx.range.value = '5';
  event(ctx, 'input');
  let propagated = false;
  ctx.document.body.addEventListener('keydown', () => { propagated = true; });
  ctx.range.dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(ctx.range.value, '2');
  assert.deepEqual(ctx.commits, []);
  assert.equal(propagated, true);
});

test('detached range cannot commit into another active picker', () => {
  const ctx = setup();
  ctx.root.remove();
  ctx.range.value = '6';
  event(ctx, 'change');
  assert.deepEqual(ctx.commits, []);
});

test('Buttons restores the original grid without changing effort or runtime settings', async () => {
  const store = storage({ hermesBrowserSettings: { reasoningEffort: 'xhigh', model: 'qa-model' } });
  const ctx = setup({ value: 'xhigh', storage: store });
  await settle();
  ctx.root.querySelector('[data-effort-view="buttons"]').click();
  await settle();
  assert.equal(ctx.root.dataset.effortPresentation, 'buttons');
  assert.equal(ctx.buttons.hidden, false);
  assert.equal(ctx.root.querySelector('.effort-control-slider').hidden, true);
  assert.equal(ctx.buttons.querySelectorAll('[data-effort]').length, 7);
  assert.deepEqual(ctx.commits, []);
  assert.deepEqual(store.data.hermesBrowserSettings, { reasoningEffort: 'xhigh', model: 'qa-model' });
  assert.deepEqual(store.writes, [{ [control.EFFORT_PRESENTATION_STORAGE_KEY]: 'buttons' }]);
  const second = setup({ storage: store });
  await settle();
  assert.equal(second.root.dataset.effortPresentation, 'buttons');
});

test('stored Buttons preference hydrates and external changes update connected controls', async () => {
  assert.equal(typeof control.EFFORT_PRESENTATION_STORAGE_KEY, 'string');
  const store = storage({ [control.EFFORT_PRESENTATION_STORAGE_KEY]: 'buttons' });
  const first = setup({ storage: store });
  const second = setup({ storage: store });
  await settle();
  assert.equal(first.root.dataset.effortPresentation, 'buttons');
  assert.equal(second.root.dataset.effortPresentation, 'buttons');
  await store.local.set({ [control.EFFORT_PRESENTATION_STORAGE_KEY]: 'slider' });
  assert.equal(first.root.dataset.effortPresentation, 'slider');
  assert.equal(second.root.dataset.effortPresentation, 'slider');
});

test('failed preference save rolls back the display and reports failure', async () => {
  const store = storage();
  store.local.set = async () => { throw new Error('storage unavailable'); };
  const errors = [];
  const ctx = setup({ storage: store, onError: (error) => errors.push(error.message) });
  await settle();
  ctx.root.querySelector('[data-effort-view="buttons"]').click();
  await settle();
  assert.equal(ctx.root.dataset.effortPresentation, 'slider');
  assert.deepEqual(ctx.commits, []);
  assert.deepEqual(errors, ['storage unavailable']);
});

test('translated labels and disabled state remain accessible', () => {
  const ctx = setup({ disabled: true, translate: (value) => `localized ${value}` });
  assert.equal(ctx.range.disabled, true);
  assert.equal(ctx.range.getAttribute('aria-valuetext'), 'localized Medium');
  ctx.range.value = '6';
  event(ctx, 'change');
  assert.deepEqual(ctx.commits, []);
});

test('both existing picker surfaces mount the shared native control and stylesheet', () => {
  for (const surface of ['sidepanel', 'app']) {
    const js = readFileSync(new URL(`../extension/${surface}.js`, import.meta.url), 'utf8');
    const html = readFileSync(new URL(`../extension/${surface}.html`, import.meta.url), 'utf8');
    assert.ok(/import\s*\{[^}]*\bcreateEffortControl\b[^}]*\}\s*from\s*['"]\.\/lib\/effort-control\.mjs['"]/.test(js), `${surface} imports the shared effort control`);
    assert.ok(/createEffortControl\(/.test(js), `${surface} mounts the shared effort control`);
    assert.ok(/href="lib\/effort-control\.css"/.test(html), `${surface} loads the shared effort styles`);
  }
});

test('Max and Ultra have continuous bar-charge and particle motion, not only an entry burst', () => {
  const css = readFileSync(new URL('../extension/lib/effort-control.css', import.meta.url), 'utf8');
  assert.ok(/animation:\s*effort-bar-charge[^;]*infinite/.test(css), 'the filled track continuously charges');
  assert.ok(/animation:\s*effort-bar-flow[^;]*infinite/.test(css), 'energy continuously travels along the track');
  assert.ok(/animation:\s*effort-charge-spark[^;]*infinite/.test(css), 'Max particles persist');
  assert.ok(/animation:\s*effort-ultra-spark[^;]*infinite/.test(css), 'Ultra particles persist');
  const ctx = setup({ value: 'ultra' });
  assert.ok(ctx.root.querySelectorAll('.effort-control-spark').length >= 40, 'Ultra can use a denser particle field');
});
