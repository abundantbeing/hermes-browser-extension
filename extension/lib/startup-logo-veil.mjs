// Hover veil for the startup logo. While the pointer is over it, the logo
// turns into a 1-bit Bayer dither in its own theme colour, the cursor burns a
// crisp hole through it, and the trail knits back into dither over `linger`.
// A 2D canvas at cell resolution; the frame loop runs only while something is
// moving and the canvas is released when the veil settles.

export const LOGO_VEIL_OPTIONS = Object.freeze({
  pixelSize: 2,
  revealRadius: 28,
  softness: 0.6,
  linger: 1000,
  fadeIn: 180,
  tone: 0.5,
  rim: 0.045,
});

export const BAYER_8 = Object.freeze((() => {
  let m = [0];
  for (let size = 1; size < 8; size *= 2) {
    const next = new Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const v = m[y * size + x] * 4;
        const w = size * 2;
        next[y * w + x] = v;
        next[y * w + x + size] = v + 2;
        next[(y + size) * w + x] = v + 3;
        next[(y + size) * w + x + size] = v + 1;
      }
    }
    m = next;
  }
  return m;
})());

export function bayerThreshold(x, y) {
  return (BAYER_8[(y & 7) * 8 + (x & 7)] + 0.5) / 64;
}

export const VEIL_CRISP = 0;
export const VEIL_INK = 1;
export const VEIL_GAP = 2;
export const VEIL_RIM = 3;

/**
 * One cell of the veil. `veil` is how far the veil is on (0-1), `heat` how
 * burnt through this cell is (0-1), `coverage` how much of the logo it holds.
 * A cell turns crisp once the veil left on it drops below its Bayer threshold,
 * so a soft heat edge dissolves through the dither instead of cutting a circle.
 */
export function veilCell({ veil, heat, coverage, threshold, tone = LOGO_VEIL_OPTIONS.tone, rim = LOGO_VEIL_OPTIONS.rim }) {
  const left = veil * (1 - heat);
  if (left <= threshold) return VEIL_CRISP;
  if (coverage <= 0) return VEIL_GAP;
  if (rim > 0 && heat > 0 && left - threshold < rim) return VEIL_RIM;
  return coverage * tone > threshold ? VEIL_INK : VEIL_GAP;
}

// Burn the cursor into the heat grid along the segment it travelled, so a
// fast swipe leaves a continuous trail rather than a row of dots.
export function stampTrail(heat, cols, rows, from, to, radius, softness) {
  const inner = radius * (1 - softness);
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(1, radius / 3)));
  for (let i = 0; i <= steps; i += 1) {
    const cx = from.x + ((to.x - from.x) * i) / steps;
    const cy = from.y + ((to.y - from.y) * i) / steps;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(cols - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(rows - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d >= radius) continue;
        const k = d <= inner ? 1 : 1 - (d - inner) / (radius - inner);
        const value = k * k * (3 - 2 * k);
        const at = y * cols + x;
        if (value > heat[at]) heat[at] = value;
      }
    }
  }
}

function rgbaOf(ctx, color) {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  return ctx.getImageData(0, 0, 1, 1).data;
}

/**
 * Wires the veil to `icon`, the masked logo element. Returns `rest()`, which
 * stops the loop and drops the canvas (call it when the screen hides).
 */
export function createLogoVeil(icon, options = {}) {
  const doc = icon?.ownerDocument;
  const view = doc?.defaultView;
  if (!view?.requestAnimationFrame || typeof view.HTMLCanvasElement !== 'function') return { rest() {} };
  const opts = { ...LOGO_VEIL_OPTIONS, ...options };
  const images = new Map();
  let canvas = null;
  let state = null;
  let frame = 0;
  let hovering = false;
  let pointer = null;
  let moved = 0;

  const reducedMotion = () => Boolean(view.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  // The CSS entrance owns the logo until it lands.
  const entranceDone = () => (icon.getAnimations?.() || []).every((a) => a.playState === 'finished');
  const logoUrl = () => /url\(["']?([^"')]+)["']?\)/.exec(view.getComputedStyle(icon).maskImage || view.getComputedStyle(icon).webkitMaskImage || '')?.[1] || '';

  const loadImage = (url) => {
    let entry = images.get(url);
    if (!entry) {
      const image = new view.Image();
      entry = new Promise((resolve, reject) => {
        image.onload = () => resolve(image);
        image.onerror = reject;
      });
      entry.catch(() => images.delete(url));
      image.src = url;
      images.set(url, entry);
    }
    return entry;
  };

  const prepare = (image) => {
    const width = icon.offsetWidth;
    const height = icon.offsetHeight;
    if (!width || !height) return null;
    const dpr = Math.max(1, Math.min(3, view.devicePixelRatio || 1));
    const cols = Math.ceil(width / opts.pixelSize);
    const rows = Math.ceil(height / opts.pixelSize);
    if (!canvas) {
      canvas = doc.createElement('canvas');
      canvas.className = 'startup-logo-veil';
      canvas.setAttribute('aria-hidden', 'true');
      icon.after(canvas);
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const make = (w, h) => { const c = doc.createElement('canvas'); c.width = w; c.height = h; return c; };
    // Logo coverage per cell, from a smoothed downscale of its alpha.
    const coverageCanvas = make(cols, rows);
    const coverageCtx = coverageCanvas.getContext('2d', { willReadFrequently: true });
    coverageCtx.imageSmoothingQuality = 'high';
    coverageCtx.drawImage(image, 0, 0, cols, rows);
    const alpha = coverageCtx.getImageData(0, 0, cols, rows).data;
    const coverage = new Float32Array(cols * rows);
    for (let i = 0; i < coverage.length; i += 1) coverage[i] = alpha[i * 4 + 3] / 255;
    // Ink and rim come from the theme as it is painted right now.
    const style = view.getComputedStyle(icon);
    const ink = style.backgroundColor;
    const rimColor = style.getPropertyValue('--startup-line').trim() || ink;
    const probe = make(1, 1).getContext('2d', { willReadFrequently: true });
    // The crisp logo in its theme colour, at full resolution.
    const inked = make(canvas.width, canvas.height);
    const inkedCtx = inked.getContext('2d');
    inkedCtx.fillStyle = ink;
    inkedCtx.fillRect(0, 0, inked.width, inked.height);
    inkedCtx.globalCompositeOperation = 'destination-in';
    inkedCtx.drawImage(image, 0, 0, inked.width, inked.height);
    const cells = make(cols, rows);
    const crisp = make(cols, rows);
    const scratch = make(canvas.width, canvas.height);
    return {
      cols,
      rows,
      coverage,
      ink: rgbaOf(probe, ink),
      rim: rgbaOf(probe, rimColor),
      heat: new Float32Array(cols * rows),
      veil: 0,
      last: 0,
      inked,
      cells,
      cellsCtx: cells.getContext('2d'),
      cellData: new view.ImageData(cols, rows),
      crisp,
      crispCtx: crisp.getContext('2d'),
      crispData: new view.ImageData(cols, rows),
      scratch,
      scratchCtx: scratch.getContext('2d'),
      ctx: canvas.getContext('2d'),
    };
  };

  const draw = (s) => {
    const { cols, rows, coverage, heat, cellData, crispData, ink, rim } = s;
    const cell = cellData.data;
    const keep = crispData.data;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const at = y * cols + x;
        const kind = veilCell({ veil: s.veil, heat: heat[at], coverage: coverage[at], threshold: bayerThreshold(x, y), tone: opts.tone, rim: opts.rim });
        const p = at * 4;
        const color = kind === VEIL_INK ? ink : kind === VEIL_RIM ? rim : null;
        cell[p] = color ? color[0] : 0;
        cell[p + 1] = color ? color[1] : 0;
        cell[p + 2] = color ? color[2] : 0;
        cell[p + 3] = color ? 255 : 0;
        keep[p + 3] = kind === VEIL_CRISP ? 255 : 0;
      }
    }
    s.cellsCtx.putImageData(cellData, 0, 0);
    s.crispCtx.putImageData(crispData, 0, 0);
    const { ctx, scratchCtx, scratch } = s;
    const w = scratch.width;
    const h = scratch.height;
    // Crisp logo, cut to the cells the veil has left.
    scratchCtx.globalCompositeOperation = 'copy';
    scratchCtx.drawImage(s.inked, 0, 0);
    scratchCtx.globalCompositeOperation = 'destination-in';
    scratchCtx.imageSmoothingEnabled = false;
    scratchCtx.drawImage(s.crisp, 0, 0, w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(scratch, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(s.cells, 0, 0, w, h);
  };

  const rest = () => {
    view.cancelAnimationFrame(frame);
    frame = 0;
    hovering = false;
    pointer = null;
    state = null;
    icon.classList.remove('is-veiled');
    if (canvas) {
      canvas.remove();
      canvas = null;
    }
  };

  const tick = (now) => {
    frame = 0;
    const s = state;
    if (!s) return;
    const dt = s.last ? Math.min(64, now - s.last) : 16;
    s.last = now;
    const target = hovering ? 1 : 0;
    const rate = hovering ? opts.fadeIn : opts.linger;
    s.veil = target > s.veil ? Math.min(1, s.veil + dt / rate) : Math.max(0, s.veil - dt / rate);
    let warm = false;
    const decay = dt / opts.linger;
    for (let i = 0; i < s.heat.length; i += 1) {
      if (s.heat[i] > 0) {
        s.heat[i] = Math.max(0, s.heat[i] - decay);
        if (s.heat[i] > 0) warm = true;
      }
    }
    // The hole under a resting cursor stays open; only the trail knits back.
    if (hovering && pointer) stampTrail(s.heat, s.cols, s.rows, pointer, pointer, opts.revealRadius / opts.pixelSize, opts.softness);
    if (!hovering && s.veil <= 0) {
      rest();
      return;
    }
    icon.classList.add('is-veiled');
    draw(s);
    // Once the trail has knitted back under a still pointer, nothing changes
    // until it moves again, so the loop sleeps.
    const settled = s.veil === target && (!warm || (hovering && now - moved > opts.linger));
    if (settled) s.last = 0;
    else frame = view.requestAnimationFrame(tick);
  };

  const wake = () => {
    if (!frame && state) frame = view.requestAnimationFrame(tick);
  };

  const cellPoint = (event) => {
    const box = icon.getBoundingClientRect();
    return { x: (event.clientX - box.left) / opts.pixelSize, y: (event.clientY - box.top) / opts.pixelSize };
  };

  const burn = (event) => {
    if (!state) return;
    const point = cellPoint(event);
    stampTrail(state.heat, state.cols, state.rows, pointer || point, point, opts.revealRadius / opts.pixelSize, opts.softness);
    pointer = point;
    moved = view.performance.now();
    wake();
  };

  // A pointer already resting on the logo when the entrance lands starts the
  // veil on its next move.
  const start = (event) => {
    if (reducedMotion() || !entranceDone()) return;
    hovering = true;
    if (state) {
      burn(event);
      return;
    }
    const url = logoUrl();
    if (!url) return;
    loadImage(url).then((image) => {
      if (!hovering || state) return;
      state = prepare(image);
      if (state) burn(event);
    }, () => {});
  };
  icon.addEventListener('pointerenter', start);
  icon.addEventListener('pointermove', (event) => {
    if (hovering) burn(event);
    else start(event);
  });
  icon.addEventListener('pointerleave', () => {
    if (!hovering) return;
    hovering = false;
    pointer = null;
    wake();
  });

  return { rest };
}
