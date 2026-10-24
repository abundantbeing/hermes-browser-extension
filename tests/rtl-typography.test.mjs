// Right-to-left (Arabic): nothing in the panel spaces letters apart or forces
// capitals, and the first-screen intro banner is mirrored with the real artwork's
// right-aligned variant, with nothing overlapping.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import { RTL_BLOCK_END, RTL_BLOCK_START, RTL_DECLARATIONS, rtlSelector, trackedSelectors } from './helpers/rtl-tracking.mjs';
import { PANEL_STYLESHEETS, expectedBlock, withoutRtlBlock } from './helpers/write-rtl-tracking.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const css = read('extension/sidepanel.css');
const html = read('extension/sidepanel.html');

test('every rule that spaces or capitalises letters has its right-to-left twin, and the block is current', () => {
  const start = css.indexOf(RTL_BLOCK_START);
  const end = css.indexOf(RTL_BLOCK_END);
  assert.ok(start > 0 && end > start, 'the generated block is at the end of sidepanel.css');
  assert.equal(css.slice(start, end + RTL_BLOCK_END.length) + '\n', expectedBlock(), 'regenerate with: node tests/helpers/write-rtl-tracking.mjs');
  const texts = PANEL_STYLESHEETS.map((file) => withoutRtlBlock(read(file)));
  const selectors = trackedSelectors(texts);
  assert.ok(selectors.length > 200, `${selectors.length} tracked selectors found`);
  for (const selector of selectors) assert.ok(css.includes(rtlSelector(selector)), `no RTL override for ${selector}`);
});

test('the override switches both off and wins over theme and font-profile rules', () => {
  const block = css.slice(css.indexOf(RTL_BLOCK_START));
  assert.ok(block.includes(RTL_DECLARATIONS.split('\n')[0].trim()));
  assert.match(block, /letter-spacing: 0 !important;/);
  assert.match(block, /text-transform: none !important;/);
  assert.match(block, /html\[dir="rtl"\] \.intro,/, 'the intro line');
  assert.match(block, /html\[dir="rtl"\] \.hero-copy \.eyebrow/, 'the eyebrow');
  assert.match(block, /html\[dir="rtl"\]\[data-hermes-font-profile="signature"\] \.hero-copy \.eyebrow/, 'the font-profile variant of it');
  assert.match(block, /html\[dir="rtl"\] \.release-sidecar-copy > p:last-child/, 'the Settings banner copy');
  // Latin styling is untouched: the originals still track and capitalise.
  assert.match(css, /\.intro \{[^}]*letter-spacing: 0\.08em;[^}]*text-transform: uppercase;/s);
});

test('the right-aligned wordmark is the same artwork with only the shorter line moved', () => {
  const left = read('extension/assets/img/hermes-browser-logo-left.svg');
  const right = read('extension/assets/img/hermes-browser-logo-right.svg');
  const paths = (svg) => [...svg.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(paths(right).length, 14);
  assert.deepEqual(paths(right), paths(left), 'not one path was redrawn');
  assert.match(left, /<g id="HERMES">/);
  assert.match(right, /<g id="HERMES" transform="translate\(323\.87 0\)">/);
  assert.match(right, /<g id="BROWSER">/);
  assert.match(right, /viewBox="0 0 2918\.77 1206\.98"/);
  assert.match(right, /<svg id="Layer_1"/, 'the same #Layer_1 convention');
  assert.doesNotMatch(right, /fill=/, 'no fixed fill: the theme tints it through currentColor');
  // 2918.77 (BROWSER) - 2594.90 (HERMES) = 323.87: both lines end flush on the right.
  assert.equal((2918.77 - 2594.90).toFixed(2), '323.87');
});

test('the banner carries both wordmarks and shows the right one for the direction', () => {
  const { document } = parseHTML(html);
  for (const [scope, cls] of [['#browserIntroHero', 'hero-wordmark'], ['.release-sidecar', 'release-sidecar-wordmark']]) {
    const marks = [...document.querySelector(scope).querySelectorAll(`svg.${cls}`)];
    assert.equal(marks.length, 2);
    assert.equal(marks[0].querySelector('use').getAttribute('href'), 'assets/img/hermes-browser-logo-left.svg#Layer_1');
    assert.equal(marks[1].querySelector('use').getAttribute('href'), 'assets/img/hermes-browser-logo-right.svg#Layer_1');
    for (const mark of marks) {
      assert.equal(mark.getAttribute('role'), 'img');
      assert.equal(mark.getAttribute('aria-label'), 'Hermes Browser');
      assert.equal(mark.getAttribute('data-i18n-aria-label'), 'ui.hermes.browser');
    }
  }
  assert.match(css, /\.hero-wordmark-rtl,\s*\.release-sidecar-wordmark-rtl \{ display: none; \}/);
  assert.match(css, /html\[dir="rtl"\] \.hero-wordmark-ltr,\s*html\[dir="rtl"\] \.release-sidecar-wordmark-ltr \{ display: none; \}/);
  assert.match(css, /html\[dir="rtl"\] \.hero-wordmark-rtl,\s*html\[dir="rtl"\] \.release-sidecar-wordmark-rtl \{ display: block; \}/);
});

test('the banner is laid out with logical properties: picture and dismiss on the end side, copy clear of them', () => {
  assert.match(css, /\.hero-dismiss \{[^}]*inset-inline-end: 8px;/s);
  assert.doesNotMatch(css.match(/\.hero-dismiss \{[^}]*\}/s)[0], /\bright:/);
  assert.match(css, /\.hero-badge \{[^}]*inset-inline-end: 10px;/s);
  assert.doesNotMatch(css.match(/\.hero-badge \{[^}]*\}/s)[0], /\bright:/);
  assert.match(css, /\.release-sidecar-badge \{[^}]*inset-inline-end: 10px;/s);
  assert.match(css, /\.hero-copy \{[^}]*max-width: 100%; margin-inline-end: 56px;/s);
  assert.match(css, /\.release-sidecar-copy \{[^}]*max-width: 100%; margin-inline-end: 52px;/s);
  assert.match(css, /\.hero-wordmark \{[^}]*width: min\(205px, 100%\);/s);
  assert.match(css, /linear-gradient\(var\(--hero-fade-dir, 90deg\)/);
  assert.match(css, /html\[dir="rtl"\] \.hero-card,\s*html\[dir="rtl"\] \.release-sidecar \{ --hero-fade-dir: 270deg; \}/, 'the fade runs the other way');
  assert.match(css, /html\[dir="rtl"\] \.hero-copy \.eyebrow,\s*html\[dir="rtl"\] \.release-sidecar-copy \.eyebrow \{ white-space: normal; \}/, 'a longer translated eyebrow wraps instead of being clipped');
});
