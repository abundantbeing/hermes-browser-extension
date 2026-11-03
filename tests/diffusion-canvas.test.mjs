import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createDiffusionCanvas, diffusionVariantForSeed } from '../extension/lib/diffusion-canvas.mjs';

test('diffusion canvas module exists for image-generation tool activity', () => {
  assert.ok(existsSync(new URL('../extension/lib/diffusion-canvas.mjs', import.meta.url)));
});

test('diffusion canvas supports lifecycle cleanup and reduced-motion rendering', () => {
  const source = readFileSync(new URL('../extension/lib/diffusion-canvas.mjs', import.meta.url), 'utf8');

  assert.match(source, /export function createDiffusionCanvas/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /cancelAnimationFrame/);
  assert.match(source, /prefers-reduced-motion/);
  assert.match(source, /ResizeObserver/);
  assert.match(source, /maxFps/);
  assert.match(source, /minimumFrameMs/);
  assert.match(source, /createRadialGradient/);
  assert.match(source, /setLineDash/);
  assert.match(source, /smoothstep/);
  assert.match(source, /start\(\)/);
  assert.match(source, /stop\(\)/);
});

test('unchanged renders do not reset the canvas backing store every frame', () => {
  let width = 0;
  let height = 0;
  let widthSets = 0;
  let heightSets = 0;
  const gradient = { addColorStop() {} };
  const context = new Proxy({}, {
    get(target, property) {
      if (property === 'createRadialGradient') return () => gradient;
      if (['setTransform', 'clearRect', 'fillRect', 'drawImage', 'strokeRect', 'setLineDash'].includes(property)) return () => {};
      return target[property];
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  });
  const canvas = {
    dataset: {},
    clientWidth: 320,
    clientHeight: 180,
    getBoundingClientRect: () => ({ width: 320, height: 180 }),
    getContext: () => context,
  };
  Object.defineProperties(canvas, {
    width: {
      get: () => width,
      set: (value) => { width = value; widthSets += 1; },
    },
    height: {
      get: () => height,
      set: (value) => { height = value; heightSets += 1; },
    },
  });

  const diffusion = createDiffusionCanvas(canvas, { seed: 'stable-resize' });
  diffusion.render(1000);
  diffusion.render(1016);
  diffusion.render(1032);

  assert.equal(widthSets, 1);
  assert.equal(heightSets, 1);
  diffusion.stop();
});

test('seeded diffusion variants are stable per generation and varied across generations', () => {
  const first = diffusionVariantForSeed('tool-call-alpha');
  assert.deepEqual(diffusionVariantForSeed('tool-call-alpha'), first);
  assert.notDeepEqual(diffusionVariantForSeed('tool-call-beta'), first);

  const variants = Array.from({ length: 16 }, (_, index) => diffusionVariantForSeed(`tool-${index}`));
  assert.ok(new Set(variants.map((variant) => variant.profile)).size >= 3);
  assert.ok(new Set(variants.map((variant) => variant.seed)).size === variants.length);
  for (const variant of variants) {
    assert.ok(variant.cellScale >= 0.82 && variant.cellScale <= 1.18);
    assert.ok(variant.timeOffset >= 0 && variant.timeOffset <= 19);
    assert.ok(variant.tempo >= 0.72 && variant.tempo <= 1.34);
    assert.ok([1, -1].includes(variant.motionDirection));
    assert.ok(variant.colorHold >= 0.035 && variant.colorHold <= 0.09);
    assert.ok(variant.colorCreepEnd >= 0.52 && variant.colorCreepEnd <= 0.7);
    assert.ok(variant.detailStart >= 0.14 && variant.detailStart <= 0.26);
    assert.ok(variant.colorSoftness >= 0.04 && variant.colorSoftness <= 0.1);
    assert.ok(Number.isInteger(variant.colorSourceCount));
    assert.ok(variant.colorSourceCount >= 3 && variant.colorSourceCount <= 5);
    assert.ok(variant.colorCreepEnd > variant.colorHold);
    assert.ok(variant.scan.duration >= 2.4 && variant.scan.duration <= 4.8);
    assert.ok(variant.scan.bandHeight >= 6 && variant.scan.bandHeight <= 12);
    assert.ok(variant.scan.dropoutTop >= 18 && variant.scan.dropoutTop <= 82);
  }
});

test('diffusion renderer has no targeting circles or crosshair geometry', () => {
  const source = readFileSync(new URL('../extension/lib/diffusion-canvas.mjs', import.meta.url), 'utf8');
  assert.match(source, /context\.drawImage/);
  assert.match(source, /dropoutPulse/);
  assert.doesNotMatch(source, /targetingGeometry/);
  assert.doesNotMatch(source, /context\.(?:arc|ellipse)\(/);
  assert.doesNotMatch(source, /crosshair|reticle/i);
});

test('image-aware diffusion reveal uses a randomized non-sequential cell mask', () => {
  const source = readFileSync(new URL('../extension/lib/diffusion-canvas.mjs', import.meta.url), 'utf8');
  assert.match(source, /revealImage/);
  assert.match(source, /revealProgress/);
  assert.match(source, /revealOrder/);
  assert.match(source, /revealRank/);
  assert.match(source, /context\.drawImage\(revealImage/);
  assert.match(source, /revealDuration/);
  assert.match(source, /colorProgress/);
  assert.match(source, /colorOrder/);
  assert.match(source, /ensureColorOrder/);
  assert.match(source, /colorSources/);
  assert.match(source, /nearestDistance/);
  assert.match(source, /colorRank/);
  assert.match(source, /colorPhase/);
  assert.match(source, /detailPhase/);
  assert.match(source, /detailRank/);
  assert.match(source, /detailGate/);
  assert.match(source, /rawDetailProgress/);
  assert.match(source, /localProgress\s*=\s*rawDetailProgress\s*\*\s*detailGate/);
  assert.match(source, /revealProgress\s*=\s*reduceMotion\s*\?\s*1\s*:\s*clamp\(revealElapsed\s*\/\s*variant\.revealDuration\)/);
  assert.match(source, /mosaicProgress/);
  assert.match(source, /imageSmoothingEnabled = false/);
  assert.match(source, /sampleSourceX/);
  assert.match(source, /sampleSourceY/);
  assert.match(source, /context\.drawImage\(revealImage, sampleSourceX, sampleSourceY, 1, 1/);
  assert.doesNotMatch(source, /getImageData|toDataURL|convertToBlob/);
  assert.doesNotMatch(source, /const colorProgress\s*=\s*smoothstep\(colorDelay/);
  assert.doesNotMatch(source, /revealProgress\s*=\s*reduceMotion\s*\?\s*1\s*:\s*smoothstep/);
  assert.doesNotMatch(source, /revealProgress\s*\*\s*(?:columns|rows|width|height)/);
});

test('sidepanel uses one persistent seeded diffusion placeholder per image call', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

  assert.match(source, /createDiffusionCanvas/);
  assert.match(source, /diffusionVariantForSeed/);
  assert.match(source, /imageGenerationPlaceholders/);
  assert.match(source, /placeholder\.dataset\.activityKey = key;/);
  assert.match(source, /imageVisualSeed/);
  assert.match(source, /crypto\?\.getRandomValues|crypto\.getRandomValues/);
  assert.doesNotMatch(source, /if \(activity\.activityId\) return String\(activity\.activityId\)/);
  assert.match(source, /function renderImageGenPlaceholder/);
  assert.match(source, /revealGeneratedImage/);
  assert.match(source, /generated-image-reveal-source/);
  assert.match(source, /image-gen-placeholder/);
  assert.match(source, /image-gen-phase-track/);
  assert.match(source, /image-gen-vhs/);
  assert.doesNotMatch(source, /image-gen-reticle|image-gen-scanline/);
  assert.match(source, /LATENT FIELD/);
  assert.match(source, /DENOISING/);
  assert.match(source, /RESOLVING/);
  assert.match(source, /FINALIZING/);
  assert.match(source, /root\._dispose/);
  assert.match(source, /placeholder\._dispose\?\.\(\);/);
});
