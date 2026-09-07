import { MAX_INLINE_SCREENSHOT_CHARS } from './screenshot-limits.mjs';

export const ANNOTATION_CROP_PAD_CSS_PX = 12;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function cropRectForScreenshot(rect, viewport, imageSize, pad = ANNOTATION_CROP_PAD_CSS_PX) {
  const x = finiteNumber(rect?.x);
  const y = finiteNumber(rect?.y);
  const width = finiteNumber(rect?.width);
  const height = finiteNumber(rect?.height);
  const viewWidth = finiteNumber(viewport?.width);
  const viewHeight = finiteNumber(viewport?.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (viewWidth === null || viewHeight === null || width <= 0 || height <= 0) return null;
  const dpr = finiteNumber(viewport?.devicePixelRatio) || 1;
  const padding = Number.isFinite(Number(pad)) ? Number(pad) : ANNOTATION_CROP_PAD_CSS_PX;
  const left = Math.max(0, x - padding);
  const top = Math.max(0, y - padding);
  const right = Math.min(viewWidth, x + width + padding);
  const bottom = Math.min(viewHeight, y + height + padding);
  if (right <= left || bottom <= top) return null;
  const crop = {
    x: Math.round(left * dpr),
    y: Math.round(top * dpr),
    width: Math.round((right - left) * dpr),
    height: Math.round((bottom - top) * dpr),
  };
  const imageWidth = finiteNumber(imageSize?.width);
  const imageHeight = finiteNumber(imageSize?.height);
  if (imageWidth !== null) crop.width = Math.min(crop.width, Math.max(0, imageWidth - crop.x));
  if (imageHeight !== null) crop.height = Math.min(crop.height, Math.max(0, imageHeight - crop.y));
  if (crop.width <= 0 || crop.height <= 0) return null;
  return crop;
}

function aborted(signal) {
  return Boolean(signal?.aborted);
}

export async function captureAnnotationCrop({
  captureVisibleTab,
  tab,
  rect,
  viewport,
  signal,
  cropImage,
} = {}) {
  if (aborted(signal)) return { ok: false, reason: 'annotation_capture_cancelled' };
  if (!tab?.active) return { ok: false, reason: 'annotation_tab_not_visible' };
  if (typeof captureVisibleTab !== 'function') return { ok: false, reason: 'annotation_capture_unavailable' };
  const crop = cropRectForScreenshot(rect, viewport, {
    width: Number(viewport?.width) * (Number(viewport?.devicePixelRatio) || 1),
    height: Number(viewport?.height) * (Number(viewport?.devicePixelRatio) || 1),
  });
  if (!crop) return { ok: false, reason: 'annotation_invalid_rect' };
  let dataUrl;
  try {
    dataUrl = await captureVisibleTab(tab);
  } catch (error) {
    if (aborted(signal) || error?.name === 'AbortError') return { ok: false, reason: 'annotation_capture_cancelled' };
    return { ok: false, reason: 'annotation_capture_failed', error: error?.message || String(error) };
  }
  if (aborted(signal)) return { ok: false, reason: 'annotation_capture_cancelled' };
  let cropped = dataUrl;
  if (typeof cropImage === 'function') {
    try {
      cropped = await cropImage(dataUrl, crop, { signal });
    } catch (error) {
      if (aborted(signal) || error?.name === 'AbortError') return { ok: false, reason: 'annotation_capture_cancelled' };
      return { ok: false, reason: 'annotation_crop_failed', error: error?.message || String(error) };
    }
  }
  const value = String(cropped || '');
  if (!value.startsWith('data:image/png;base64,') || value.length > MAX_INLINE_SCREENSHOT_CHARS) {
    return { ok: false, reason: 'annotation_crop_too_large' };
  }
  return { ok: true, dataUrl: value, crop };
}
