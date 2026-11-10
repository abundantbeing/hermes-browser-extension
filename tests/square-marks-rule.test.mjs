import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Hard rule: a choice is marked with a square (a filled square inside a square), a yes/no choice is the
// square switch. Never a circle, never a tick glyph. A window outside .settings-dialog uses the same classes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

function rules(css) {
  return [...css.matchAll(/(?:^|[}\n])\s*([^{}@][^{}]*)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2] }));
}

const MARK_SELECTOR = /conn-mode-check|settings-choice-mark|settings-switch(?!-input)|add-connection-check/;

test('no mark that shows a choice is a circle', () => {
  const circles = rules(read('extension/sidepanel.css'))
    .filter(({ selector, body }) => MARK_SELECTOR.test(selector) && /border-radius:\s*(?:50%|100%|999\d*px)/.test(body))
    .map(({ selector }) => selector);
  assert.deepEqual(circles, []);
});

test('no mark that shows a choice is a tick', () => {
  const ticks = rules(read('extension/sidepanel.css'))
    .filter(({ selector, body }) => MARK_SELECTOR.test(selector)
      && (/content:\s*["'](?:\\2713|\\2714|✓|✔)/.test(body) || /rotate\(-?45deg\)/.test(body) || /border-block-end|border-bottom/.test(body)))
    .map(({ selector }) => selector);
  assert.deepEqual(ticks, []);
});

test('the connection-mode mark is the 17px square with the 7px square inside, wherever the card sits', () => {
  const list = rules(read('extension/sidepanel.css'));
  const base = list.find(({ selector }) => selector === '.conn-mode-check');
  assert.ok(base, 'one base rule for the mark');
  assert.match(base.body, /inline-size:\s*17px/);
  assert.match(base.body, /border-radius:\s*0/);
  const inner = list.find(({ selector }) => /conn-mode-check::after/.test(selector) && /aria-checked/.test(selector));
  assert.match(inner.body, /content:\s*""/);
  assert.match(inner.body, /inline-size:\s*7px/);
  assert.equal(list.filter(({ selector }) => selector === '.conn-mode-check').length, 1, 'the mark is defined once');
});

test('the Add window takes its yes/no choice from the extension switch, not a native checkbox', () => {
  const html = read('extension/sidepanel.html');
  const dialog = /<section id="addConnectionDialog"[\s\S]*?<\/section>\s*<section id="profileSwitchDialog"/.exec(html)?.[0] || '';
  assert.ok(dialog.length > 1000, 'found the window markup');
  const boxes = [...dialog.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) => match[0]);
  assert.ok(boxes.length >= 1);
  for (const box of boxes) assert.match(box, /class="settings-switch-input"/);
  assert.match(dialog, /<span class="settings-switch" aria-hidden="true"><\/span>/);
});

test('settings choice and toggle cards also style inside the Add window', () => {
  const css = read('extension/sidepanel.css');
  for (const klass of ['settings-toggle-card', 'settings-choice-card', 'conn-mode-card']) {
    assert.match(css, new RegExp(`:is\\(\\.settings-dialog, \\.add-connection-card\\) \\.${klass}\\b`), `${klass} reaches the Add window`);
  }
});
