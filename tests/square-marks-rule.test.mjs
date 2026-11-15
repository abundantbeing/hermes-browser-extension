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

// Each checkbox in `html` that is not a square switch: a native box, or an input whose own
// enclosing <label> (still open where the input sits) has no square switch in it.
function brokenSwitches(html) {
  const broken = [];
  for (const match of html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)) {
    const box = match[0];
    const at = match.index;
    if (!/class="settings-switch-input"/.test(box)) { broken.push(box); continue; }
    const open = html.lastIndexOf('<label', at);
    const closedBefore = html.lastIndexOf('</label>', at);
    const close = html.indexOf('</label>', at);
    if (open < 0 || closedBefore > open || close < 0
      || !/<span class="settings-switch" aria-hidden="true"><\/span>/.test(html.slice(open, close))) broken.push(box);
  }
  return broken;
}

test('the switch guard catches a native box and an input moved out of its switch label', () => {
  const card = (inner) => `<label class="settings-toggle-card"><span>Copy</span>${inner}</label>`;
  const input = '<input id="x" class="settings-switch-input" type="checkbox" />';
  const sw = '<span class="settings-switch" aria-hidden="true"></span>';
  assert.deepEqual(brokenSwitches(card(input + sw)), []);
  assert.equal(brokenSwitches(card('<input id="x" type="checkbox">')).length, 1);
  assert.equal(brokenSwitches(card(sw) + input).length, 1, 'an input right after a closed label has no switch');
  assert.equal(brokenSwitches(card(sw) + `<div>${input}</div><label>${sw}</label>`).length, 1, 'outside any label');
});

test('every yes/no choice in Settings is the square switch, never a native checkbox', () => {
  const html = read('extension/sidepanel.html');
  const start = html.indexOf('<section id="settingsDialog"');
  assert.ok(start > 0, 'found the Settings window');
  const tags = /<\/?section\b/g;
  tags.lastIndex = start;
  let depth = 0;
  let end = -1;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[0] === '<section' ? 1 : -1;
    if (depth === 0) { end = match.index; break; }
  }
  const settings = html.slice(start, end);
  assert.ok([...settings.matchAll(/type="checkbox"/g)].length >= 10, 'found the Settings switches');
  assert.deepEqual(brokenSwitches(settings), []);
});

test('settings choice and toggle cards also style inside the Add window', () => {
  const css = read('extension/sidepanel.css');
  for (const klass of ['settings-toggle-card', 'settings-choice-card', 'conn-mode-card']) {
    assert.match(css, new RegExp(`:is\\(\\.settings-dialog, \\.add-connection-card\\) \\.${klass}\\b`), `${klass} reaches the Add window`);
  }
});
