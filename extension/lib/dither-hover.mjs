// The setup buttons' hover and focus effect: a fine ordered-dither fill that
// starts under the pointer (or at the inline-start edge for keyboard focus),
// tears sideways in a few short glitch frames, and settles into the same colours
// the button's static hover style paints (its pair inverted). It is a canvas laid
// over the button for the length of the effect only: one requestAnimationFrame
// loop with time-based progress, torn down when it settles or the pointer is
// gone. Nothing runs while idle.
//
// Everything that decides what a frame looks like is a pure function of progress
// (thresholdFor, ease, glitchPlan, glitchAt), so tests and filmstrips can ask for
// any frame. Pixels are 2px cells. Only the button's own colours are used.

export const CELL = 2;
export const IN_MS = 420;
export const OUT_MS = 180;

// 4x4 Bayer matrix, scaled to (0, 1), computed once.
export const BAYER4 = Object.freeze([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => (value + 0.5) / 16));
export const bayer = (cx, cy) => BAYER4[(cy & 3) * 4 + (cx & 3)];

// Ease-out: the fill starts at once under the cursor and settles gently.
export const ease = (p) => 1 - (1 - Math.min(1, Math.max(0, p))) ** 3;

// The threshold at which a cell turns on: nearer the origin and lower in the
// Bayer matrix comes first. A cell is on when its threshold is below the eased
// progress (scaled just past 1 so the last cell is on at p = 1).
export function thresholdFor(cx, cy, cols, rows, origin) {
  const ox = origin.x / CELL;
  const oy = origin.y / CELL;
  const far = Math.max(
    Math.hypot(ox, (oy) * 1.8),
    Math.hypot(cols - ox, oy * 1.8),
    Math.hypot(ox, (rows - oy) * 1.8),
    Math.hypot(cols - ox, (rows - oy) * 1.8),
  ) || 1;
  const d = Math.hypot(cx + 0.5 - ox, (cy + 0.5 - oy) * 1.8) / far;
  return d * 0.78 + bayer(cx, cy) * 0.22;
}

export function cellOn(threshold, progress) {
  return threshold < ease(progress) * 1.02;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The glitch frames for one hover, seeded so each hover tears a little
// differently and a test can replay any of them. Windows are short (about 25ms
// at the default length, one or two frames). Within a window every band slips
// the same way (a tear, not a jitter) by 1-3px, biased toward 2.
export function glitchPlan(seed, { quiet = false } = {}) {
  const centres = quiet ? [0.42, 0.66] : [0.3, 0.42, 0.54, 0.66];
  const next = rng(seed);
  return centres.map((at, index) => {
    const count = quiet ? 2 : 2 + (next() < 0.5 ? 1 : 0);
    const sign = next() < 0.5 ? -1 : 1;
    const bands = [];
    for (let i = 0; i < count; i += 1) {
      const height = 0.14 + next() * 0.14;
      const magnitude = [1, 2, 2, 3][Math.floor(next() * 4)];
      bands.push({ y: next() * (1 - height), height, dx: sign * magnitude });
    }
    return {
      at,
      half: 0.03,
      bands,
      split: !quiet && index % 2 === 0,
      scanlines: !quiet && index === 1,
    };
  });
}

export function glitchAt(plan, progress) {
  return plan.find((window) => Math.abs(progress - window.at) <= window.half) || null;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function canvasOf(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function drawLabel(ctx, spec, color, dx = 0) {
  if (!spec.text) return;
  ctx.save();
  ctx.font = spec.font;
  ctx.letterSpacing = spec.letterSpacing;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  ctx.fillText(spec.text, spec.tx + dx, spec.baseline);
  ctx.restore();
}

function drawFace(ctx, spec, hovered) {
  ctx.fillStyle = hovered ? spec.hoverBg : spec.restBg;
  ctx.fillRect(0, 0, spec.w, spec.h);
  ctx.strokeStyle = hovered ? spec.hoverBorder : spec.restBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, spec.w - 1, spec.h - 1);
  drawLabel(ctx, spec, hovered ? spec.hoverFg : spec.restFg);
}

// Everything a button needs, built once on enter and reused every frame.
export function createRenderer(spec) {
  const s = spec.dpr;
  const cols = Math.ceil(spec.w / CELL);
  const rows = Math.ceil(spec.h / CELL);
  const make = (hovered) => {
    const canvas = canvasOf(spec.w * s, spec.h * s);
    const ctx = canvas.getContext('2d');
    ctx.scale(s, s);
    drawFace(ctx, spec, hovered);
    return canvas;
  };
  const rest = make(false);
  const hover = make(true);
  const maskCanvas = canvasOf(cols, rows);
  const maskCtx = maskCanvas.getContext('2d');
  const mask = maskCtx.createImageData(cols, rows);
  for (let i = 3; i < mask.data.length; i += 4) mask.data[i] = 0;
  const layer = canvasOf(spec.w * s, spec.h * s);
  const layerCtx = layer.getContext('2d');
  const snap = canvasOf(spec.w * s, spec.h * s);
  const snapCtx = snap.getContext('2d');
  const thresholds = new Float32Array(cols * rows);
  let plan = [];
  // Per hover: where the fill starts and how this hover tears. No allocation.
  function prepare(origin, seed) {
    for (let cy = 0; cy < rows; cy += 1) {
      for (let cx = 0; cx < cols; cx += 1) thresholds[cy * cols + cx] = thresholdFor(cx, cy, cols, rows, origin);
    }
    plan = glitchPlan(seed, { quiet: spec.quiet });
  }
  prepare(spec.origin, spec.seed);

  function frame(canvas, progress, { glitch = true } = {}) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    if (progress >= 1) { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(hover, 0, 0); return; }
    if (progress <= 0) { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(rest, 0, 0); return; }
    const eased = ease(progress) * 1.02;
    const data = mask.data;
    for (let i = 0; i < thresholds.length; i += 1) data[i * 4 + 3] = thresholds[i] < eased ? 255 : 0;
    maskCtx.putImageData(mask, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(rest, 0, 0);
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    layerCtx.imageSmoothingEnabled = false;
    layerCtx.globalCompositeOperation = 'copy';
    layerCtx.drawImage(maskCanvas, 0, 0, cols, rows, 0, 0, layer.width, layer.height);
    layerCtx.globalCompositeOperation = 'source-in';
    layerCtx.drawImage(hover, 0, 0);
    layerCtx.globalCompositeOperation = 'source-over';
    ctx.drawImage(layer, 0, 0);
    const g = glitch ? glitchAt(plan, progress) : null;
    if (!g) return;
    snapCtx.setTransform(1, 0, 0, 1, 0, 0);
    snapCtx.globalCompositeOperation = 'copy';
    snapCtx.drawImage(canvas, 0, 0);
    for (const band of g.bands) {
      const y = Math.round(band.y * spec.h) * s;
      const h = Math.max(1, Math.round(band.height * spec.h)) * s;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y, canvas.width, h);
      ctx.clip();
      ctx.drawImage(snap, 0, y, canvas.width, h, band.dx * s, y, canvas.width, h);
      ctx.restore();
    }
    ctx.save();
    ctx.setTransform(s, 0, 0, s, 0, 0);
    if (g.split) {
      ctx.globalAlpha = 0.85;
      drawLabel(ctx, spec, spec.restFg, -2);
      drawLabel(ctx, spec, spec.hoverFg, 2);
    }
    if (g.scanlines) {
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = spec.restBg;
      for (let y = 0; y < spec.h; y += 2) ctx.fillRect(0, y, spec.w, 1);
    }
    ctx.restore();
  }

  return { frame, prepare, cols, rows, get plan() { return plan; } };
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

const REDUCED = '(prefers-reduced-motion: reduce)';
const FORCED = '(forced-colors: active)';
const CAN_HOVER = '(hover: hover)';

function specFor(button, origin, quiet, seed) {
  // At enter the button is already in its hover state, so its computed colours
  // are the hover face; the resting face is the same pair the other way round.
  const style = getComputedStyle(button);
  const rect = button.getBoundingClientRect();
  const hoverBg = style.backgroundColor;
  const hoverFg = style.color;
  const hoverBorder = style.borderTopColor;
  const node = [...button.childNodes].flatMap((child) => (child.nodeType === 3 ? [child] : [...child.childNodes].filter((n) => n.nodeType === 3))).find((n) => n.nodeValue.trim());
  let text = '';
  let tx = 0;
  let baseline = 0;
  let font = '';
  let letterSpacing = '0px';
  if (node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const lines = range.getClientRects();
    if (lines.length !== 1) return null; // a wrapped label stays on the static hover
    const line = lines[0];
    const owner = node.parentElement;
    const ownerStyle = getComputedStyle(owner);
    text = ownerStyle.textTransform === 'uppercase' ? node.nodeValue.trim().toUpperCase() : node.nodeValue.trim();
    const probe = document.createElement('canvas').getContext('2d');
    font = `${ownerStyle.fontStyle} ${ownerStyle.fontWeight} ${ownerStyle.fontSize} ${ownerStyle.fontFamily}`;
    probe.font = font;
    letterSpacing = ownerStyle.letterSpacing === 'normal' ? '0px' : ownerStyle.letterSpacing;
    probe.letterSpacing = letterSpacing;
    tx = line.left - rect.left + line.width / 2;
    baseline = line.top - rect.top + probe.measureText(text).fontBoundingBoxAscent;
  } else if (!button.querySelector('svg')) {
    return null;
  }
  return {
    bw: parseFloat(style.borderLeftWidth) || 1,
    w: Math.round(rect.width),
    h: Math.round(rect.height),
    dpr: Math.min(2, window.devicePixelRatio || 1),
    hoverBg,
    hoverFg,
    hoverBorder,
    restBg: hoverFg,
    restFg: hoverBg,
    restBorder: quiet ? `color-mix(in srgb, ${hoverBg} 60%, transparent)` : hoverBg,
    text,
    font,
    letterSpacing,
    tx,
    baseline,
    origin,
    quiet,
    seed,
  };
}

function createController(button, { quiet }) {
  let frame = 0;
  let canvas = null;
  let renderer = null;
  let specKey = '';
  let spec = null;
  let progress = 0;
  let last = 0;
  let direction = 0;
  let hovered = false;
  let count = 0;
  let iconNow = '';

  function teardown() {
    cancelAnimationFrame(frame);
    frame = 0;
    direction = 0;
    if (canvas) {
      canvas.remove();
      canvas = null;
    }
    button.removeAttribute('data-dither');
    button.style.removeProperty('--dither-icon');
    button.style.removeProperty('will-change');
  }

  function loop(now) {
    const dt = Math.min(64, now - last);
    last = now;
    progress += (direction * dt) / (direction > 0 ? IN_MS : OUT_MS);
    if (progress >= 1 || progress <= 0 || !button.isConnected) {
      // The last frame is the static hover face; it is removed in the same frame
      // the button's own label comes back, so there is no gap and no pop.
      teardown();
      return;
    }
    renderer.frame(canvas, progress, { glitch: direction > 0 });
    // An icon inside the button takes the colour of whichever face is mostly showing.
    const iconColor = progress > 0.5 ? spec.hoverFg : spec.restFg;
    if (iconColor !== iconNow) { iconNow = iconColor; button.style.setProperty('--dither-icon', iconColor); }
    frame = requestAnimationFrame(loop);
  }

  function mount(startProgress) {
    progress = startProgress;
    canvas = document.createElement('canvas');
    canvas.width = Math.round(spec.w * spec.dpr);
    canvas.height = Math.round(spec.h * spec.dpr);
    canvas.className = 'dither-hover-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    // Over the whole border box, whatever the padding.
    canvas.style.cssText = `left:${-spec.bw}px;top:${-spec.bw}px;width:${spec.w}px;height:${spec.h}px`;
    button.append(canvas);
    iconNow = progress > 0.5 ? spec.hoverFg : spec.restFg;
    button.style.setProperty('--dither-icon', iconNow);
    button.style.setProperty('will-change', 'contents');
    button.setAttribute('data-dither', 'run');
  }

  function run(dir) {
    direction = dir;
    last = performance.now();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(loop);
  }

  function skipped() {
    return window.matchMedia(REDUCED).matches || window.matchMedia(FORCED).matches;
  }

  return {
    enter(origin) {
      if (skipped()) return;
      hovered = true;
      if (!canvas) {
        count += 1;
        const seed = (count * 2654435761 + Math.round(origin.x) * 40503 + Math.round(origin.y) * 9973) >>> 0;
        const next = specFor(button, origin, quiet, seed);
        if (!next) return;
        // The faces are drawn again only when the button looks different; a new
        // pointer entry point or seed only refills the threshold table.
        const key = [next.w, next.h, next.dpr, next.hoverBg, next.hoverFg, next.text, next.font, next.tx, next.baseline].join('|');
        if (key !== specKey || !renderer) {
          spec = next;
          specKey = key;
          renderer = createRenderer(spec);
        } else {
          renderer.prepare(origin, seed);
        }
        mount(0);
      }
      run(1);
    },
    leave() {
      if (!hovered && !canvas) return;
      hovered = false;
      if (!canvas) {
        if (!renderer || skipped() || !button.isConnected) return;
        mount(1);
      }
      run(-1);
    },
    destroy: teardown,
    get active() { return Boolean(frame); },
  };
}

// One delegated listener set on a container, so buttons that are drawn again
// (setup re-renders its steps) pick the effect up without any re-wiring.
export function installDitherHover(host, { selector, quietSelector }) {
  const controllers = new WeakMap();
  const buttonFor = (event) => event.target?.closest?.(selector);
  const controllerFor = (button) => {
    let controller = controllers.get(button);
    if (!controller) {
      controller = createController(button, { quiet: Boolean(quietSelector && button.matches(quietSelector)) });
      controllers.set(button, controller);
    }
    return controller;
  };
  const onOver = (event) => {
    const button = buttonFor(event);
    if (!button || button.disabled || button.contains(event.relatedTarget)) return;
    if (event.pointerType === 'touch' || !window.matchMedia(CAN_HOVER).matches) return;
    const rect = button.getBoundingClientRect();
    const origin = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const controller = controllerFor(button);
    // The colours are read in the hover state, so wait a frame if it has not applied yet.
    if (button.matches(':hover')) controller.enter(origin);
    else requestAnimationFrame(() => { if (button.matches(':hover')) controller.enter(origin); });
  };
  const onOut = (event) => {
    const button = buttonFor(event);
    if (!button || button.contains(event.relatedTarget)) return;
    if (button.matches(':focus-visible')) return;
    controllers.get(button)?.leave();
  };
  const onFocus = (event) => {
    const button = buttonFor(event);
    if (!button || button.disabled || !button.matches(':focus-visible')) return;
    const rect = button.getBoundingClientRect();
    const rtl = getComputedStyle(button).direction === 'rtl';
    controllerFor(button).enter({ x: rtl ? rect.width : 0, y: rect.height / 2 });
  };
  const onBlur = (event) => {
    const button = buttonFor(event);
    if (!button) return;
    if (button.matches(':hover') && window.matchMedia(CAN_HOVER).matches) return;
    controllers.get(button)?.leave();
  };
  host.addEventListener('pointerover', onOver);
  host.addEventListener('pointerout', onOut);
  host.addEventListener('focusin', onFocus);
  host.addEventListener('focusout', onBlur);
  return () => {
    host.removeEventListener('pointerover', onOver);
    host.removeEventListener('pointerout', onOut);
    host.removeEventListener('focusin', onFocus);
    host.removeEventListener('focusout', onBlur);
  };
}
