import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('the side panel publishes the chat layout on the root element', () => {
  const panel = read('extension/sidepanel.js');
  assert.match(panel, /document\.documentElement\.dataset\.messageLayout = messageLayout/);
  assert.match(panel, /document\.documentElement\.dataset\.responseStyle = responseStyle/);
  assert.match(panel, /function applyAppearanceSettings\(\)[\s\S]*?applyResponsePresentation\(\);\n\}/);
});

test('bubbles both sides keeps a tailed bubble for each role', () => {
  const css = read('extension/sidepanel.css');
  assert.match(css, /\.message\.user \{ align-self: flex-end; border-radius: 18px 18px 4px 18px;/);
  assert.match(css, /\.message\.assistant \{ align-self: flex-start; border-radius: 18px 18px 18px 4px;/);
});

test('user bubble only drops the Hermes bubble but keeps the user bubble and group rooms', () => {
  const css = read('extension/sidepanel.css');
  const rule = css.match(/html\[data-message-layout="user-bubble"\] \.message-row:not\(\.room-message\) > \.message\.assistant \{[^}]*\}/)?.[0] || '';
  assert.ok(rule, 'panel rule exists');
  for (const declaration of ['background: transparent', 'border-color: transparent', 'box-shadow: none', 'backdrop-filter: none', 'width: 100%']) {
    assert.ok(rule.includes(declaration), declaration);
  }
  assert.doesNotMatch(css, /data-message-layout="user-bubble"\][^{]*\.message\.user/);
});
