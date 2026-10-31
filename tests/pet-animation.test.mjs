import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PET_IDLE_FRAMES,
  PET_LOOP_MS,
  createPetStripCache,
  petAnimationAllowed,
  petFrameFit,
  petStripCssVars,
  realFrameCount,
} from '../extension/lib/pet-animation.mjs';

test('avatars animate only with the setting on and no reduced-motion request', () => {
  assert.equal(petAnimationAllowed({ animateAvatars: true, reducedMotion: false }), true);
  assert.equal(petAnimationAllowed({ animateAvatars: false, reducedMotion: false }), false);
  assert.equal(petAnimationAllowed({ animateAvatars: true, reducedMotion: true }), false);
  assert.equal(petAnimationAllowed({ animateAvatars: 'on' }), false);
  assert.equal(petAnimationAllowed(), false);
});

test('desktop timing is six idle frames over 1100ms', () => {
  assert.equal(PET_IDLE_FRAMES, 6);
  assert.equal(PET_LOOP_MS, 1100);
});

test('real frame count stops at the first blank padding cell', () => {
  assert.equal(realFrameCount([255, 255, 255, 255, 255, 255]), 6);
  assert.equal(realFrameCount([200, 200, 200, 0, 0, 0]), 3);
  assert.equal(realFrameCount([200, 8, 200, 200, 200, 200]), 1);
  assert.equal(realFrameCount([0, 200, 200]), 0);
  assert.equal(realFrameCount([255, 255, 255, 255, 255, 255, 255, 255]), 6);
  assert.equal(realFrameCount(undefined), 0);
});

test('strip css lands every step exactly on a cell', () => {
  assert.deepEqual(petStripCssVars(6), { '--pet-steps': '6', '--pet-end': '100%' });
  assert.deepEqual(petStripCssVars(3), { '--pet-steps': '3', '--pet-end': '40%' });
  assert.deepEqual(petStripCssVars(2), { '--pet-steps': '2', '--pet-end': '20%' });
  assert.equal(petStripCssVars(1), null);
  assert.equal(petStripCssVars(0), null);
  assert.equal(petStripCssVars(NaN), null);
  assert.equal(petStripCssVars(9)['--pet-steps'], '6');
  // Frame k of n sits at k/(cols-1) of the travel: the n steps of jump-none are
  // evenly spaced over 0..end, so step k is k * end/(n-1) = k/(cols-1).
  for (let n = 2; n <= PET_IDLE_FRAMES; n += 1) {
    const end = parseFloat(petStripCssVars(n)['--pet-end']);
    for (let k = 0; k < n; k += 1) {
      assert.ok(Math.abs((end * k) / (n - 1) - (k * 100) / (PET_IDLE_FRAMES - 1)) < 1e-6);
    }
  }
});

test('a frame is fitted into a square cell without stretching', () => {
  const fit = petFrameFit(96);
  assert.equal(fit.dh, 96);
  assert.equal(fit.dw, 89);
  assert.equal(fit.dx, 3);
  assert.ok(fit.dx * 2 + fit.dw <= 96);
});

test('strip cache shares one job per sheet, retries failures, and stays bounded', async () => {
  let calls = 0;
  const stripFor = createPetStripCache(async (url) => {
    calls += 1;
    return url === 'bad' ? null : { url: `data:${url}`, frames: 6 };
  }, 2);
  const [one, two] = await Promise.all([stripFor('a'), stripFor('a')]);
  assert.equal(one, two);
  assert.equal(calls, 1);
  assert.equal(await stripFor(''), null);
  assert.equal(await stripFor('bad'), null);
  assert.equal(await stripFor('bad'), null);
  assert.equal(calls, 3);
  await stripFor('b');
  await stripFor('c');
  await stripFor('a');
  assert.equal(calls, 6);
});

test('strip cache turns a loader error into a miss', async () => {
  const stripFor = createPetStripCache(async () => { throw new Error('offline'); });
  assert.equal(await stripFor('a'), null);
});

test('side panel css steps the strip, pauses off screen, and stops for reduced motion', () => {
  const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
  assert.match(css, /\.bot-mode-pet-live\.is-animated\s*\{[^}]*animation:\s*petdex-idle 1\.1s steps\(var\(--pet-steps, 6\), jump-none\) infinite/);
  assert.match(css, /\.bot-mode-pet-live\.is-paused\s*\{\s*animation-play-state:\s*paused/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.bot-mode-pet-live\.is-animated\s*\{\s*animation:\s*none/);
  assert.doesNotMatch(css, /800% 900%/);
});

test('side panel renders the pet from a data url, never the remote sheet', () => {
  const js = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /backgroundImage = `url\("\$\{(?:livePet|pet)\.spritesheetUrl\}"\)`/);
  assert.match(js, /petAnimationAllowed\(\{/);
});
