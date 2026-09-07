import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MAX_INLINE_SCREENSHOT_CHARS } from '../extension/lib/screenshot-limits.mjs';
import {
  ANNOTATION_CROP_PAD_CSS_PX,
  captureAnnotationCrop,
  cropRectForScreenshot,
} from '../extension/lib/page-annotation-capture.mjs';

test('screenshot limit is the existing inline PNG budget', () => {
  assert.equal(MAX_INLINE_SCREENSHOT_CHARS, 1_500_000);
});

test('browser-control adapters import the shared screenshot limit', () => {
  const adapters = readFileSync(new URL('../extension/lib/browser-control-browser-adapters.mjs', import.meta.url), 'utf8');
  const executor = readFileSync(new URL('../extension/lib/browser-control-executor.mjs', import.meta.url), 'utf8');
  assert.match(adapters, /import\s*\{\s*MAX_INLINE_SCREENSHOT_CHARS\s*\}\s*from\s*'\.\/screenshot-limits\.mjs'/);
  assert.match(executor, /import\s*\{\s*MAX_INLINE_SCREENSHOT_CHARS\s*\}\s*from\s*'\.\/screenshot-limits\.mjs'/);
  assert.doesNotMatch(adapters, /const MAX_INLINE_SCREENSHOT_CHARS = 1_500_000/);
  assert.doesNotMatch(executor, /const MAX_INLINE_SCREENSHOT_CHARS = 1_500_000/);
});

test('crop pad matches desktop annotation crop padding', () => {
  assert.equal(ANNOTATION_CROP_PAD_CSS_PX, 12);
});

test('cropRectForScreenshot pads 12 CSS pixels and maps device pixels once', () => {
  const crop = cropRectForScreenshot(
    { x: 100, y: 80, width: 40, height: 20 },
    { width: 800, height: 600, devicePixelRatio: 2 },
    { width: 1600, height: 1200 },
  );
  assert.deepEqual(crop, { x: 176, y: 136, width: 128, height: 88 });
});

test('cropRectForScreenshot clamps at viewport edges', () => {
  const crop = cropRectForScreenshot(
    { x: 2, y: 4, width: 10, height: 10 },
    { width: 100, height: 80, devicePixelRatio: 1 },
    { width: 100, height: 80 },
  );
  assert.deepEqual(crop, { x: 0, y: 0, width: 24, height: 26 });
});

test('cropRectForScreenshot ignores page scroll because rects are viewport-relative', () => {
  const crop = cropRectForScreenshot(
    { x: 50, y: 60, width: 20, height: 20 },
    { width: 400, height: 300, devicePixelRatio: 1, scrollX: 120, scrollY: 80 },
    { width: 400, height: 300 },
  );
  assert.deepEqual(crop, { x: 38, y: 48, width: 44, height: 44 });
});

test('cropRectForScreenshot rejects zero-area and non-finite rectangles', () => {
  assert.equal(cropRectForScreenshot({ x: 10, y: 10, width: 0, height: 12 }, { width: 100, height: 100 }, { width: 100, height: 100 }), null);
  assert.equal(cropRectForScreenshot({ x: Number.NaN, y: 10, width: 12, height: 12 }, { width: 100, height: 100 }, { width: 100, height: 100 }), null);
});

test('captureAnnotationCrop uses injected cropper and bounds PNG size', async () => {
  const dataUrl = `data:image/png;base64,${'A'.repeat(24)}`;
  const result = await captureAnnotationCrop({
    captureVisibleTab: async () => dataUrl,
    tab: { windowId: 1, active: true, id: 9 },
    rect: { x: 10, y: 10, width: 20, height: 20 },
    viewport: { width: 100, height: 100, devicePixelRatio: 1 },
    cropImage: async () => dataUrl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dataUrl, dataUrl);
});

test('captureAnnotationCrop reports oversized crops instead of passing them through', async () => {
  const huge = `data:image/png;base64,${'A'.repeat(MAX_INLINE_SCREENSHOT_CHARS)}`;
  const result = await captureAnnotationCrop({
    captureVisibleTab: async () => huge,
    tab: { windowId: 1, active: true, id: 9 },
    rect: { x: 10, y: 10, width: 20, height: 20 },
    viewport: { width: 100, height: 100, devicePixelRatio: 1 },
    cropImage: async () => huge,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'annotation_crop_too_large');
});

test('captureAnnotationCrop aborts before cropping', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await captureAnnotationCrop({
    captureVisibleTab: async () => {
      throw new Error('should not capture');
    },
    tab: { windowId: 1, active: true, id: 9 },
    rect: { x: 10, y: 10, width: 20, height: 20 },
    viewport: { width: 100, height: 100, devicePixelRatio: 1 },
    signal: controller.signal,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'annotation_capture_cancelled');
});
