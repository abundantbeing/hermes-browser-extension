import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const read = (file) => readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8');

test('context status owns a full row and both actions share the following row', () => {
  const { document } = new JSDOM(read('sidepanel.html')).window;
  const status = document.querySelector('#contextControlStatus');
  const refresh = document.querySelector('#contextPageRefreshButton');
  const compact = document.querySelector('#contextCompactButton');
  assert.equal(refresh.parentElement, compact.parentElement);
  assert.ok(refresh.parentElement.classList.contains('context-control-actions'));
  assert.equal(status.nextElementSibling, refresh.parentElement);
  assert.equal(compact.getAttribute('aria-describedby'), 'contextControlStatus');
});

test('both refresh icons spin only while busy and honor reduced motion', () => {
  const { document } = new JSDOM(read('sidepanel.html')).window;
  for (const id of ['contextPageRefreshButton', 'contextRefreshButton']) {
    assert.ok(document.querySelector(`#${id} .refresh-glyph`));
  }
  const css = read('sidepanel.css');
  const motion = css.match(/@media \(prefers-reduced-motion: no-preference\) \{[^}]*context-usage-segment[^}]*\}[\s\S]*?\n\}/)?.[0] || '';
  assert.match(motion, /\[aria-busy="true"\] \.refresh-glyph/);
  assert.match(motion, /animation: context-refresh-spin/);
  assert.match(css, /@keyframes context-refresh-spin/);
});
