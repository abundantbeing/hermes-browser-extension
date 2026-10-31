// Animated petdex avatars for Bot Mode.
//
// Mirrors the desktop PetSprite: the avatar plays the pet's idle row (row 0 of
// the 8×9 sheet), PET_IDLE_FRAMES frames over PET_LOOP_MS, and stops at the
// first blank padding cell so short rows never flash empty. The remote sheet is
// ~2MB and the extension CSP only allows `self`, `data:` and `blob:` images, so
// the sheet is fetched, its idle row is baked into a small strip PNG data URL,
// and CSS steps through that strip. No JS runs per frame.

import { PET_FRAME_W, PET_FRAME_H } from './pet-avatar.mjs';

export const PET_IDLE_FRAMES = 6;
export const PET_LOOP_MS = 1100;
export const PET_STRIP_EDGE = 96;
const PET_BLANK_ALPHA = 8;
const PET_STRIP_CACHE_MAX = 96;

// Animate only when the user opted in and the OS has not asked for less motion.
export function petAnimationAllowed({ animateAvatars = false, reducedMotion = false } = {}) {
  return animateAvatars === true && reducedMotion !== true;
}

// Frames to play: the leading run of cells with visible pixels, capped at
// PET_IDLE_FRAMES. Input is the max alpha of each cell in row order.
export function realFrameCount(maxAlphas, limit = PET_IDLE_FRAMES) {
  let count = 0;
  for (const alpha of Array.isArray(maxAlphas) ? maxAlphas.slice(0, limit) : []) {
    if (!(Number(alpha) > PET_BLANK_ALPHA)) break;
    count += 1;
  }
  return count;
}

// CSS variables for the strip animation. The strip is always PET_IDLE_FRAMES
// cells wide, so frame i sits at i / (PET_IDLE_FRAMES - 1) of the background
// travel; `steps(n, jump-none)` lands on exactly those n positions. Fewer than
// two real frames is a still image, so there is nothing to animate.
export function petStripCssVars(frames) {
  const count = Math.min(Math.floor(Number(frames) || 0), PET_IDLE_FRAMES);
  if (count < 2) return null;
  const end = ((count - 1) / (PET_IDLE_FRAMES - 1)) * 100;
  return { '--pet-steps': String(count), '--pet-end': `${Number(end.toFixed(4))}%` };
}

// Fit one 192×208 frame inside a square cell without stretching it.
export function petFrameFit(edge = PET_STRIP_EDGE) {
  const drawW = Math.round((edge * PET_FRAME_W) / PET_FRAME_H);
  return { dx: Math.floor((edge - drawW) / 2), dy: 0, dw: drawW, dh: edge };
}

// Small insertion-ordered cache of in-flight/finished strip jobs. Failures are
// dropped so a later render retries.
export function createPetStripCache(load, max = PET_STRIP_CACHE_MAX) {
  const jobs = new Map();
  return async function stripFor(spriteUrl) {
    if (!spriteUrl) return null;
    let job = jobs.get(spriteUrl);
    if (!job) {
      job = Promise.resolve().then(() => load(spriteUrl)).catch(() => null);
      jobs.set(spriteUrl, job);
      while (jobs.size > max) jobs.delete(jobs.keys().next().value);
    }
    const strip = await job;
    if (!strip && jobs.get(spriteUrl) === job) jobs.delete(spriteUrl);
    return strip;
  };
}

// Fetch a spritesheet and bake its idle row into { url, frames }. Crops during
// decode (like petFrameIcon) so the full 1536×1872 sheet is never materialized.
export async function loadPetIdleStrip(spriteUrl, fetchFn = globalThis.fetch?.bind(globalThis)) {
  if (!spriteUrl || !fetchFn) return null;
  const response = await fetchFn(spriteUrl, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) return null;
  const blob = await response.blob();
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, 0, 0, PET_FRAME_W * PET_IDLE_FRAMES, PET_FRAME_H);
  } catch {
    bitmap = await createImageBitmap(blob);
  }
  try {
    const edge = PET_STRIP_EDGE;
    const canvas = document.createElement('canvas');
    canvas.width = edge * PET_IDLE_FRAMES;
    canvas.height = edge;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    const fit = petFrameFit(edge);
    for (let index = 0; index < PET_IDLE_FRAMES; index += 1) {
      context.drawImage(bitmap, index * PET_FRAME_W, 0, PET_FRAME_W, PET_FRAME_H, index * edge + fit.dx, fit.dy, fit.dw, fit.dh);
    }
    const maxAlphas = [];
    for (let index = 0; index < PET_IDLE_FRAMES; index += 1) {
      const pixels = context.getImageData(index * edge, 0, edge, edge).data;
      let max = 0;
      for (let offset = 3; offset < pixels.length && max < 255; offset += 4) {
        if (pixels[offset] > max) max = pixels[offset];
      }
      maxAlphas.push(max);
    }
    const frames = realFrameCount(maxAlphas);
    return frames ? { url: canvas.toDataURL('image/png'), frames } : null;
  } finally {
    bitmap.close?.();
  }
}
