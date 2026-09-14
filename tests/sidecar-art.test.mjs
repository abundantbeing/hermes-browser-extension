import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { SIDECAR_ART, pickSidecarArt, sidecarArtCssValue } from '../extension/lib/sidecar-art.mjs';

const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
const js = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const dir = new URL('../extension/', import.meta.url);

test('every sidecar art entry ships and stays lean enough for the panel', () => {
  assert.equal(SIDECAR_ART.length, 7);
  let total = 0;
  for (const entry of SIDECAR_ART) {
    const size = statSync(new URL(entry, dir)).size;
    assert.ok(size > 0, entry + ' must not be empty');
    assert.ok(size <= 1_200_000, entry + ' should stay under 1.2MB, got ' + size);
    total += size;
  }
  assert.ok(total <= 4_000_000, 'rotation should stay under 4MB total, got ' + total);
});

test('the picker never repeats the previous choice and clamps injected randoms', () => {
  assert.equal(pickSidecarArt(0), SIDECAR_ART[0]);
  assert.equal(pickSidecarArt(0.999999), SIDECAR_ART[SIDECAR_ART.length - 1]);
  assert.equal(pickSidecarArt(-5), SIDECAR_ART[0]);
  assert.equal(pickSidecarArt(Number.NaN), SIDECAR_ART[0]);
  const second = pickSidecarArt(0, SIDECAR_ART[0]);
  assert.notEqual(second, SIDECAR_ART[0], 'immediate repeat must be avoided');
  assert.ok(SIDECAR_ART.includes(second));
});

test('the css value only accepts known art entries', () => {
  assert.equal(sidecarArtCssValue(SIDECAR_ART[2]), 'url("' + SIDECAR_ART[2] + '")');
  assert.equal(sidecarArtCssValue('assets/img/nope.png'), '');
  assert.equal(sidecarArtCssValue(''), '');
});

test('both sidecar surfaces read the shared art variable and the panel picks one per load', () => {
  const uses = css.match(/var\(--sidecar-art, url\("assets\/img\/hermes-browse\.webp"\)\) center \/ cover no-repeat/g) || [];
  assert.equal(uses.length, 2, 'card + settings hero both use the variable');
  assert.match(js, /import \{ pickSidecarArt, sidecarArtCssValue \} from '\.\/lib\/sidecar-art\.mjs';/);
  assert.match(js, /document\.documentElement\.style\.setProperty\('--sidecar-art', sidecarArtCssValue\(entry\)\);/);
  assert.match(js, /pickSidecarArt\(Math\.random, lastSidecarArt\)/);
  assert.match(js, /^applySidecarArt\(\);/m);
  // The mini badge image stays a fixed asset, untouched by the rotation.
  assert.match(readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8'), /class="release-sidecar-badge" src="assets\/img\/hermes-badge\.webp"/);
});
