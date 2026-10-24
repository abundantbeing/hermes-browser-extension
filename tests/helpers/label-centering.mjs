// How far a button's label sits from the middle of the button.
//
// `centeringOffsets` is the arithmetic (pure, testable without a browser).
// `LABEL_CENTERING_BROWSER_SOURCE` is the function to run in a real page (the
// preview browser, or CDP Runtime.evaluate): it measures the INK of the label,
// not its line box. A DOM Range gives the line box (the font's ascent and
// descent), which for a compressed display face sits off the visible capitals;
// canvas measureText gives the glyphs' real ascent and descent over the
// baseline, so the gaps above and below the visible letters can be compared.

export function centeringOffsets(button, ink) {
  const top = ink.top - button.top;
  const bottom = button.bottom - ink.bottom;
  const left = ink.left - button.left;
  const right = button.right - ink.right;
  return {
    top, bottom, left, right,
    vertical: top - bottom,
    horizontal: left - right,
  };
}

export function withinTolerance(offsets, tolerance = 1) {
  return Math.abs(offsets.vertical) <= tolerance * 2 && Math.abs(offsets.horizontal) <= tolerance * 2;
}

// Evaluated as `(${LABEL_CENTERING_BROWSER_SOURCE})(selectorOrElement)`.
// Reports the gaps between the button's padding box and the label's ink on
// every side; `vertical` and `horizontal` are top-minus-bottom and
// left-minus-right (0 is centred; the visible shift is half of it).
export const LABEL_CENTERING_BROWSER_SOURCE = `(target) => {
  const button = typeof target === 'string' ? document.querySelector(target) : target;
  if (!button) return null;
  const ctx = document.createElement('canvas').getContext('2d');
  const union = { top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity };
  const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
  let node;
  let measured = 0;
  const texts = [];
  while ((node = walker.nextNode())) {
    if (!node.nodeValue.trim()) continue;
    const owner = node.parentElement;
    if (!owner || owner.closest('[hidden]') || getComputedStyle(owner).display === 'none') continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()];
    if (!rects.length) continue;
    const line = rects.reduce((box, rect) => ({
      top: Math.min(box.top, rect.top), bottom: Math.max(box.bottom, rect.bottom),
      left: Math.min(box.left, rect.left), right: Math.max(box.right, rect.right),
    }), { top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity });
    const style = getComputedStyle(owner);
    const raw = node.nodeValue.trim();
    const text = style.textTransform === 'uppercase' ? raw.toUpperCase() : raw;
    ctx.font = style.fontStyle + ' ' + style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
    ctx.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
    const metrics = ctx.measureText(text);
    // The ink runs from the first line's cap or ascender top to the last line's
    // descender bottom (a wrapped label has several line rects).
    const firstTop = Math.min(...rects.map((rect) => rect.top));
    const lastTop = Math.max(...rects.map((rect) => rect.top));
    union.top = Math.min(union.top, firstTop + metrics.fontBoundingBoxAscent - metrics.actualBoundingBoxAscent);
    union.bottom = Math.max(union.bottom, lastTop + metrics.fontBoundingBoxAscent + metrics.actualBoundingBoxDescent);
    union.left = Math.min(union.left, line.left);
    union.right = Math.max(union.right, line.right);
    texts.push(raw);
    measured += 1;
  }
  if (!measured) return null;
  const box = button.getBoundingClientRect();
  const cs = getComputedStyle(button);
  const inner = {
    top: box.top + (parseFloat(cs.borderTopWidth) || 0), bottom: box.bottom - (parseFloat(cs.borderBottomWidth) || 0),
    left: box.left + (parseFloat(cs.borderLeftWidth) || 0), right: box.right - (parseFloat(cs.borderRightWidth) || 0),
  };
  const r1 = (value) => Math.round(value * 10) / 10;
  const gaps = { top: union.top - inner.top, bottom: inner.bottom - union.bottom, left: union.left - inner.left, right: inner.right - union.right };
  return {
    text: texts.join(' / '), font: cs.fontFamily.split(',')[0].replace(/"/g, ''), size: cs.fontSize,
    height: r1(box.height), width: r1(box.width),
    top: r1(gaps.top), bottom: r1(gaps.bottom), left: r1(gaps.left), right: r1(gaps.right),
    vertical: r1(gaps.top - gaps.bottom), horizontal: r1(gaps.left - gaps.right),
  };
}`;
