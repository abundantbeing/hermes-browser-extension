// The signature display font is compressed: it only reads in capitals, so every heading in the
// Add, Options and Delete windows copies how Settings sets its own (tracked caps, never mixed case).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = (await readFile(new URL('../extension/sidepanel.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

function rules(selectorPattern) {
  const found = [];
  for (const match of css.matchAll(/(^|\n)([^{}\n@][^{}]*)\{([^{}]*)\}/g)) {
    if (selectorPattern.test(match[2].trim())) found.push({ selector: match[2].trim(), body: match[3] });
  }
  return found;
}

const declared = (body, property) => body.match(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`))?.[1]?.trim();

test('group headings in the connection windows are tracked caps in the body font, like Settings groups', () => {
  const [rule] = rules(/^\.add-connection-group h3$/);
  assert.ok(rule, 'the group heading rule exists');
  assert.equal(declared(rule.body, 'text-transform'), 'uppercase');
  assert.equal(declared(rule.body, 'font-family'), 'var(--hermes-font-mono)');
  assert.ok(parseFloat(declared(rule.body, 'letter-spacing')) >= 0.1, 'spaced out, not squeezed');
  assert.doesNotMatch(rule.body, /font-display/, 'never the compressed display font at this size');
});

test('window titles use the display font only in capitals, with the same spacing as Settings titles', () => {
  const [rule] = rules(/^\.add-connection-card \.add-connection-heading h2$/);
  assert.ok(rule, 'the window title rule exists');
  assert.equal(declared(rule.body, 'font-family'), 'var(--hermes-font-display)');
  assert.equal(declared(rule.body, 'text-transform'), 'uppercase');
  assert.equal(declared(rule.body, 'font-synthesis'), 'none');
  assert.ok(parseFloat(declared(rule.body, 'letter-spacing')) >= 0.03);
  const settings = rules(/^\.settings-pane-title$/)[0];
  assert.equal(declared(rule.body, 'font-size'), declared(settings.body, 'font-size'), 'same size as a Settings title');
});

test('nothing in the connection windows sets the display font without capitals', () => {
  for (const rule of rules(/add-connection|delete-connection/)) {
    if (!/font-display/.test(rule.body)) continue;
    assert.equal(declared(rule.body, 'text-transform'), 'uppercase', `${rule.selector} uses the display font in mixed case`);
  }
});

test('the right-to-left twins of these headings drop the letter spacing', () => {
  for (const selector of ['.add-connection-card .add-connection-heading h2', '.add-connection-group h3']) {
    const twin = rules(/^html\[dir="rtl"\]/).find((rule) => rule.selector.split(',').map((part) => part.trim()).includes(`html[dir="rtl"] ${selector}`));
    assert.ok(twin, `${selector} has an RTL twin`);
    assert.match(twin.body, /letter-spacing:\s*0/);
  }
});
