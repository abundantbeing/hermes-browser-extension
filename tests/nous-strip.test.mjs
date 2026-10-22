import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const read = (relative) => readFileSync(new URL(`../extension/${relative}`, import.meta.url), 'utf8');
const html = read('sidepanel.html');
const css = read('sidepanel.css');
const document = new JSDOM(html).window.document;
const about = document.getElementById('settingsPane-about');
const home = document.getElementById('settingsCategoryHome');

test('the Nous strip is the supplied three-card artwork, white on transparent, unmodified', () => {
  const file = new URL('../extension/assets/img/nous-boxes.png', import.meta.url);
  assert.ok(existsSync(file), 'nous-boxes.png ships with the extension');
  const png = readFileSync(file);
  assert.equal(png.readUInt32BE(16), 197);
  assert.equal(png.readUInt32BE(20), 78);
  assert.equal(png[25], 6, 'RGBA, so the transparent background can be a mask');
  assert.ok(png.length < 20_000, 'small enough to ship');
  assert.equal(existsSync(new URL('../extension/assets/img/nous-strip-mark.svg', import.meta.url)), false, 'the hand-drawn stand-in is gone');
});

test('the strip is above Hermes compatibility in About & Diagnostics and under its card on the categories page', () => {
  const strips = [...document.querySelectorAll('.nous-strip')];
  assert.equal(strips.length, 2);
  const pane = about.querySelector('.nous-strip-pane');
  assert.ok(pane, 'strip in the About pane');
  assert.equal(pane.nextElementSibling?.id, 'compatibilityPanel', 'directly above Hermes compatibility');
  assert.equal(pane.previousElementSibling.classList.contains('settings-pane-bar'), true, 'after the pane heading');
  assert.equal(about.querySelector('.support-diagnostics .nous-strip'), null, 'not inside the Support diagnostics card');
  assert.equal(about.lastElementChild.classList.contains('support-diagnostics'), true, 'nothing after the Support diagnostics card');

  const homeStrip = home.querySelector('.nous-strip-home');
  assert.ok(homeStrip, 'strip on the categories page');
  const grid = home.querySelector('.settings-category-grid');
  assert.equal(homeStrip.previousElementSibling, grid, 'directly after the category cards');
  assert.equal(grid.lastElementChild.dataset.settingsCategory, 'about', 'About & Diagnostics is the last card it sits under');
  assert.equal(homeStrip.closest('nav'), home, 'it hides with the categories page');

  for (const strip of strips) {
    assert.equal(strip.tagName, 'SPAN', 'brand art is a mask, not a UI icon <svg>');
    assert.equal(strip.getAttribute('role'), 'img');
    assert.equal(strip.getAttribute('aria-label'), 'Nous Research');
  }
});

test('the strip takes the theme colour like the top-bar wing mark, centred and quiet', () => {
  const rule = css.match(/\.nous-strip\s*\{[^}]*\}/)?.[0] || '';
  assert.match(rule, /background:\s*var\(--hermes-brand-mark,\s*var\(--hermes-fg\)\)/);
  assert.match(rule, /mask:\s*url\("assets\/img\/nous-boxes\.png"\) center/);
  assert.match(rule, /-webkit-mask:\s*url\("assets\/img\/nous-boxes\.png"\)/);
  assert.match(rule, /margin:[^;]*auto/);
  const height = Number(rule.match(/height:\s*(\d+)px/)?.[1]);
  assert.ok(height >= 40 && height <= 56, `strip height ${height}px should stay between 40 and 56`);
  assert.doesNotMatch(css, /nous-strip-mark\.svg/);
});
