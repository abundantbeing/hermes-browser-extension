import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const read = (relative) => readFileSync(new URL(`../extension/${relative}`, import.meta.url), 'utf8');
const html = read('sidepanel.html');
const css = read('sidepanel.css');
const svg = read('assets/img/nous-strip-mark.svg');
const about = new JSDOM(html).window.document.getElementById('settingsPane-about');

test('the Nous strip is one vector with three framed cards, drawn as a mask', () => {
  assert.match(svg, /viewBox="0 0 204 84"/);
  for (const id of ['orb-hand', 'nous-badge', 'hermes-wing-card']) assert.match(svg, new RegExp(`<g id="${id}"`), `${id} card is missing`);
  assert.doesNotMatch(svg, /<image\b|data:image|\.png/, 'the strip is vector art, not the low-res PNG');
  // A mask reads alpha only, so no brand colours belong in the file.
  assert.doesNotMatch(svg, /#(?!000\b|000000\b)[0-9a-f]{3,6}\b/i);
});

test('the strip sits under the About heading and in Support diagnostics, labelled for screen readers', () => {
  const strips = [...about.querySelectorAll('.nous-strip')];
  assert.equal(strips.length, 2);
  const [banner, support] = strips;
  assert.ok(banner.classList.contains('nous-strip-banner'));
  assert.equal(banner.previousElementSibling.classList.contains('settings-pane-bar'), true, 'banner follows the pane heading');
  assert.ok(support.classList.contains('nous-strip-support'));
  assert.ok(support.closest('.support-diagnostics'));
  for (const strip of strips) {
    assert.equal(strip.getAttribute('role'), 'img');
    assert.equal(strip.getAttribute('aria-label'), 'Nous Research');
    assert.equal(strip.tagName, 'SPAN', 'brand art is a mask, not a UI icon <svg>');
  }
});

test('the strip takes the theme colour like the top-bar wing mark', () => {
  const rule = css.match(/\.nous-strip\s*\{[^}]*\}/)?.[0] || '';
  assert.match(rule, /background:\s*var\(--hermes-brand-mark,\s*var\(--hermes-fg\)\)/);
  assert.match(rule, /mask:\s*url\("assets\/img\/nous-strip-mark\.svg"\)/);
  assert.match(rule, /-webkit-mask:\s*url\("assets\/img\/nous-strip-mark\.svg"\)/);
  assert.match(css, /\.nous-strip-banner\s*\{[^}]*--nous-strip-height/);
  assert.match(css, /\.nous-strip-support\s*\{[^}]*margin:[^;}]*auto/);
});
