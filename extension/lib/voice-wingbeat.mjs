// Wingbeat voice glow for Hermes Browser dictation.
// Built on Jon Komet's Wingbeat (abundantbeing/hermes-voice @ 7987ee5): mirrored
// feather plumes, drifting feathers and a sweeping processing comet. This
// version adds a voice-shaped rising bloom and a flowing iridescent palette
// anchored on the active theme, so every theme gets its own colours.
//
// Performance contract. The decoration must never slow the panel down:
// - Idle costs nothing: no animation frame, no observers, no canvas backing store.
//   The side panel does not even load this module until the first dictation, or
//   until the pointer heads for the mic (see prepare()).
// - While dictating, a frame is about 60 batched sprite blits and one colour pass.
//   No paths, gradients, strings or arrays are created per frame, and nothing
//   reads layout or computed style inside the frame loop.
// - Paint pacing: every frame up to ~100 Hz, every other refresh on faster
//   screens, and 30 fps while only the breath moves between words.
// - The recorder owns audio. This module only reads the recorder's analyser.
// - Resolution steps down on its own if the machine starts dropping frames.
import { VOICE_CAPTURE_PEAK_THRESHOLD, voiceCapturePeak } from './voice-capture.mjs';

const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const approach = (value, target, dt, rate) => value + (target - value) * (1 - Math.exp(-rate * dt));
const smoothstep = (value) => { const x = clamp(value); return x * x * (3 - 2 * x); };
const mix = (from, to, ratio) => from.map((channel, index) => Math.round(channel + (to[index] - channel) * ratio));
const css = (color) => `rgb(${color[0]},${color[1]},${color[2]})`;
const NOOP_GLOW = Object.freeze({ prepare() {}, set() {}, destroy() {} });
const NOOP_LEVEL = Object.freeze({ level: () => 0, analyser: null, close() {} });
const NO_MEDIA = Object.freeze({ matches: false, addEventListener() {}, removeEventListener() {} });

const BLEED = 40; // light allowed to spill below the composer edge
const BAND = 116; // tallest part of the composer the canvas ever covers
const INSET = 20; // side margin so light never clips against the canvas edge
const PLUMES = 21;
const SPECTRUM = 10;
const FEATHERS = 12;
const MAX_SCALE = 1.5; // soft light gains nothing from more pixels
const SETTLED = 0.004;
// Paint pacing, as the shortest gap between paints. 9.5 ms paints every frame
// on 60-100 Hz screens and every other refresh on 120 Hz and faster ones.
// Silent stretches, where the glow only breathes, and machines that cannot
// keep up paint at about 30 fps.
const PACE_MS = 9.5;
const CALM_PACE_MS = 31;
const LATE_MS = 25; // a frame the browser delivered late, whatever the cause
// Fixed per-plume height variety, so neighbours never rise as one flat band.
const JITTER = Float32Array.from({ length: PLUMES }, (_, index) => {
  const hash = Math.sin((index + 1) * 12.9898) * 43758.5453;
  return 0.78 + 0.4 * (hash - Math.floor(hash));
});
// Fixed per-plume width variety, so the row never reads as a regular comb.
const BREADTH = Float32Array.from({ length: PLUMES }, (_, index) => {
  const hash = Math.sin((index + 1) * 78.233) * 43758.5453;
  return 0.82 + 0.36 * (hash - Math.floor(hash));
});
const CURL = 14 / 48; // how far the curled feather's tip bends, as a share of its width
const FAN = 0.7; // outermost feathers lean this many radians from upright
const THEME_ATTRIBUTES = Object.freeze({ attributes: true, attributeFilter: ['style', 'class', 'data-hermes-theme', 'data-hermes-mode', 'data-hermes-color-mode'] });
const BODY_ATTRIBUTES = Object.freeze({ attributes: true, attributeFilter: ['style', 'class', 'data-hermes-theme', 'data-hermes-mode'] });

// ---------------------------------------------------------------- signal

export function normalizeVoiceGlowLevel(value = 0) {
  const peak = Number(value);
  if (!Number.isFinite(peak) || peak <= VOICE_CAPTURE_PEAK_THRESHOLD) return 0;
  return Math.pow(clamp((peak - VOICE_CAPTURE_PEAK_THRESHOLD) * 3.2), 0.72);
}

export function voiceGlowSignal(samples) {
  if (!samples?.length) return 0;
  let squares = 0;
  let count = 0;
  // A voice envelope does not need every sample; stepping keeps the shape.
  const step = samples.length > 512 ? 4 : 1;
  for (let index = 0; index < samples.length; index += step) {
    const sample = samples[index];
    if (!Number.isFinite(sample)) continue;
    squares += sample * sample;
    count++;
  }
  return count ? Math.sqrt(squares / count) * 0.7 + voiceCapturePeak(samples) * 0.3 : 0;
}

// Speech lives in three useful regions: voiced body, vowels/consonant bodies, sibilance.
const VOICE_BANDS = Object.freeze([[80, 320], [320, 1600], [1600, 6000]]);

export function voiceGlowBands(frequencyBytes, sampleRate = 48000, fftSize = 2048) {
  if (!frequencyBytes?.length || !(sampleRate > 0) || !(fftSize > 0)) return [0, 0, 0];
  const hz = sampleRate / fftSize;
  return VOICE_BANDS.map(([from, to]) => {
    const low = Math.max(1, Math.floor(from / hz));
    const high = Math.min(frequencyBytes.length, Math.max(low + 1, Math.ceil(to / hz)));
    let sum = 0;
    for (let index = low; index < high; index++) sum += frequencyBytes[index] || 0;
    return clamp(sum / ((high - low) * 255) * 1.8);
  });
}

// Log-spaced speech bands from 90 Hz to 6.5 kHz on the analyser's default
// -100…-30 dB byte scale. Room noise sits under the gate; a gentle tilt lets
// sibilance still lift the outer plumes. Writes into `out` without allocating.
const SPECTRUM_LOW = 90;
const SPECTRUM_HIGH = 6500;
export function voiceGlowSpectrum(frequencyBytes, sampleRate = 48000, fftSize = 2048, out = new Float32Array(SPECTRUM)) {
  const count = out.length;
  if (!frequencyBytes?.length || !(sampleRate > 0) || !(fftSize > 0)) { out.fill(0); return out; }
  const hz = sampleRate / fftSize;
  const ratio = Math.pow(SPECTRUM_HIGH / SPECTRUM_LOW, 1 / count);
  let from = SPECTRUM_LOW;
  for (let band = 0; band < count; band++) {
    const to = from * ratio;
    const low = Math.max(1, Math.floor(from / hz));
    const high = Math.min(frequencyBytes.length, Math.max(low + 1, Math.ceil(to / hz)));
    let sum = 0;
    for (let index = low; index < high; index++) sum += frequencyBytes[index] || 0;
    const mean = high > low ? sum / ((high - low) * 255) : 0;
    const tilt = band / Math.max(1, count - 1);
    out[band] = clamp((mean - (0.3 - tilt * 0.08)) / (0.46 - tilt * 0.1));
    from = to;
  }
  return out;
}

// ---------------------------------------------------------------- palette

function colorChannels(value, fallback) {
  const text = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return [1, 3, 5].map((start) => Number.parseInt(text.slice(start, start + 2), 16));
  const channels = text.replace(/^rgba?\(|\)$/g, '').split(/[,\s]+/).slice(0, 3).map(Number);
  return channels.length === 3 && channels.every(Number.isFinite) ? channels.map((channel) => clamp(channel, 0, 255)) : fallback;
}

function rgbToHsl([red, green, blue]) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (!delta) return [0, 0, lightness];
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return [(hue * 60 + 360) % 360, saturation, lightness];
}

function hslToRgb(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const m = lightness - chroma / 2;
  const [r, g, b] = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x]
    : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return [r, g, b].map((channel) => Math.round(clamp(channel + m) * 255));
}

function relativeLuminance([red, green, blue]) {
  const linear = (channel) => { const v = channel / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

const hueGap = (from, to) => { const gap = Math.abs(from - to) % 360; return gap > 180 ? 360 - gap : gap; };
const hueDelta = (from, to) => ((to - from + 540) % 360) - 180;

// Yellow and cyan read far brighter than blue and violet at the same HSL
// lightness. Pull every hue part of the way toward one perceived brightness so
// the spectrum glows evenly instead of blowing out on one side.
function balancedColor(hue, saturation, lightness, target, weight = 0.5) {
  let low = 0.16;
  let high = 0.94;
  let fit = lightness;
  for (let step = 0; step < 12; step++) {
    fit = (low + high) / 2;
    if (relativeLuminance(hslToRgb(hue, saturation, fit)) < target) low = fit;
    else high = fit;
  }
  return hslToRgb(hue, saturation, fit * weight + lightness * (1 - weight));
}

const NEUTRAL_DARK = Object.freeze([[176, 186, 210], [214, 220, 236], [248, 250, 255], [214, 220, 236], [176, 186, 210]]);
const NEUTRAL_LIGHT = Object.freeze([[112, 116, 130], [78, 82, 96], [40, 42, 52], [78, 82, 96], [112, 116, 130]]);
const IRIDESCENT_HUE = 330; // magenta-pink: the hue that makes a spread read as iridescent

// A wide, vivid spread that starts on the theme's most chromatic colour, so
// each theme gets its own colours. A distinct second theme colour becomes the
// far end of the spread, which keeps two-tone (and custom) themes recognisable.
// Otherwise the spread turns toward magenta, the way Wingbeat's Hermes palette
// runs from blue through violet and pink to coral. Neutral themes stay neutral.
export function voiceWingbeatPalette({ ink = '', accent = '', primary = '', dark = true } = {}) {
  const ranked = [primary, accent, ink]
    .map((value) => colorChannels(value, null))
    .filter(Boolean)
    .map((rgb) => ({ rgb, chroma: (Math.max(...rgb) - Math.min(...rgb)) / 255, hsl: rgbToHsl(rgb) }))
    .sort((a, b) => b.chroma - a.chroma);
  const anchor = ranked[0];
  if (!anchor || anchor.chroma < 0.1) return (dark ? NEUTRAL_DARK : NEUTRAL_LIGHT).map((color) => color.slice());
  const partner = ranked.find((entry) => entry !== anchor && entry.chroma >= 0.12 && hueGap(entry.hsl[0], anchor.hsl[0]) >= 28);
  const root = anchor.hsl[0];
  // Muted themes get a narrower, calmer spread; vivid themes get the full arc.
  const reachOfSpread = clamp(0.55 + anchor.hsl[1] * 0.5, 0.65, 1);
  let hues;
  if (partner) {
    const delta = hueDelta(root, partner.hsl[0]);
    const turn = Math.sign(delta) || 1;
    hues = [root - turn * 36, root, root + delta / 2, root + delta, root + delta + turn * 36];
  } else if (root >= 12 && root <= 68) {
    // Orange, amber and gold themes keep a fire spread (ember red to gold)
    // instead of drifting into violet or pink; it stops short of acid lime,
    // and of olive on light paper.
    const top = Math.min(root + 26, dark ? 62 : 50);
    hues = [top - 56, top - 40, top - 26, top - 12, top].map((hue) => top + (hue - top) * reachOfSpread);
  } else {
    // Greens turn through cyan and blue; everything else turns toward magenta.
    const toward = hueDelta(root, IRIDESCENT_HUE);
    const turn = root > 68 && root < 170 ? 1 : Math.abs(toward) < 30 ? -1 : Math.sign(toward);
    hues = [-36, 0, 35, 70, 100].map((offset) => root + turn * offset * reachOfSpread);
  }
  const saturation = clamp((dark ? 0.55 : 0.5) + anchor.hsl[1] * 0.45, 0.5, dark ? 0.96 : 0.92);
  const lights = dark ? [0.66, 0.62, 0.6, 0.62, 0.66] : [0.5, 0.46, 0.44, 0.46, 0.5];
  const targets = dark ? [0.3, 0.26, 0.24, 0.26, 0.3] : [0.15, 0.12, 0.1, 0.12, 0.15];
  return hues.map((hue, index) => balancedColor(hue, saturation, lights[index], targets[index], dark ? 0.5 : 0.35));
}

function samplePingPong(colors, position) {
  let u = position % 2;
  if (u < 0) u += 2;
  if (u > 1) u = 2 - u;
  const x = u * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(x));
  return mix(colors[index], colors[index + 1], x - index);
}

// ---------------------------------------------------------------- sprites
// Every shape is drawn once into a small white sprite. Per frame the renderer
// only blits sprites, which the GPU batches, then tints them in one pass.

function spriteCanvas(doc, width, height) {
  const canvas = doc.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  return ctx ? { canvas, ctx } : null;
}

const FALLOFF = Object.freeze([[0, 1], [0.2, 0.7], [0.42, 0.33], [0.66, 0.1], [0.84, 0.025], [1, 0]]);

function paintRadial(ctx, cx, cy, rx, ry) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(rx, ry);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  for (const [stop, alpha] of FALLOFF) gradient.addColorStop(stop, `rgba(255,255,255,${alpha})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
}

function buildSprites(doc) {
  const glow = spriteCanvas(doc, 64, 64);
  const rise = spriteCanvas(doc, 128, 48);
  const drop = spriteCanvas(doc, 128, 32);
  const plume = spriteCanvas(doc, 48, 128);
  const curl = spriteCanvas(doc, 48, 128);
  const draft = spriteCanvas(doc, 48, 128);
  const curlDraft = spriteCanvas(doc, 48, 128);
  const line = spriteCanvas(doc, 256, 16);
  if (![glow, rise, drop, plume, curl, draft, curlDraft, line].every(Boolean)) return null;

  paintRadial(glow.ctx, 32, 32, 32, 32);
  paintRadial(rise.ctx, 64, 48, 64, 48); // upper half: brightest along its bottom edge
  paintRadial(drop.ctx, 64, 0, 64, 32); // lower half: the reflection under the edge

  // A feather plume, after Wingbeat: a wide base whose flanks sweep in to a
  // fine tip, with light fading out well before the tip, so tips dissolve like
  // wisps instead of ending in a cap. The curled variant bends its tip to one
  // side; mirrored per side, every feather curls outward like a wing.
  const paintPlume = (target, scratch, tip) => {
    const body = scratch.ctx.createLinearGradient(0, 128, 0, 2);
    body.addColorStop(0, 'rgba(255,255,255,1)');
    body.addColorStop(0.45, 'rgba(255,255,255,0.52)');
    body.addColorStop(0.8, 'rgba(255,255,255,0.12)');
    body.addColorStop(1, 'rgba(255,255,255,0)');
    scratch.ctx.fillStyle = body;
    scratch.ctx.beginPath();
    scratch.ctx.moveTo(2, 128);
    scratch.ctx.quadraticCurveTo(18.2, 52, tip, 2);
    scratch.ctx.quadraticCurveTo(29.8, 52, 46, 128);
    scratch.ctx.closePath();
    scratch.ctx.fill();
    target.ctx.filter = 'blur(1.8px)';
    target.ctx.drawImage(scratch.canvas, 0, 0);
    target.ctx.filter = 'none';
  };
  paintPlume(plume, draft, 24);
  paintPlume(curl, curlDraft, 24 + CURL * 48);

  // The edge line: a thin Gaussian ridge that fades out at both ends.
  const ridge = line.ctx.createLinearGradient(0, 0, 0, 16);
  for (const [stop, alpha] of [[0, 0], [0.28, 0.22], [0.5, 1], [0.72, 0.22], [1, 0]]) ridge.addColorStop(stop, `rgba(255,255,255,${alpha})`);
  line.ctx.fillStyle = ridge;
  line.ctx.fillRect(0, 0, 256, 16);
  line.ctx.globalCompositeOperation = 'destination-in';
  const ends = line.ctx.createLinearGradient(0, 0, 256, 0);
  for (let stop = 0; stop <= 8; stop++) ends.addColorStop(stop / 8, `rgba(0,0,0,${Math.pow(Math.sin(Math.PI * stop / 8), 0.8).toFixed(3)})`);
  line.ctx.fillStyle = ends;
  line.ctx.fillRect(0, 0, 256, 16);
  line.ctx.globalCompositeOperation = 'source-over';

  // The comet streak: the same ridge, fading from nothing at the tail to full at the head.
  const streak = spriteCanvas(doc, 256, 16);
  if (!streak) return null;
  streak.ctx.fillStyle = ridge;
  streak.ctx.fillRect(0, 0, 256, 16);
  streak.ctx.globalCompositeOperation = 'destination-in';
  const taper = streak.ctx.createLinearGradient(0, 0, 256, 0);
  for (let stop = 0; stop <= 8; stop++) taper.addColorStop(stop / 8, `rgba(0,0,0,${Math.pow(stop / 8, 1.7).toFixed(3)})`);
  streak.ctx.fillStyle = taper;
  streak.ctx.fillRect(0, 0, 256, 16);
  streak.ctx.globalCompositeOperation = 'source-over';

  return { glow: glow.canvas, rise: rise.canvas, drop: drop.canvas, plume: plume.canvas, curl: curl.canvas, line: line.canvas, streak: streak.canvas };
}

function tintSprite(doc, source, color) {
  const out = spriteCanvas(doc, source.width, source.height);
  if (!out) return null;
  out.ctx.drawImage(source, 0, 0);
  out.ctx.globalCompositeOperation = 'source-in';
  out.ctx.fillStyle = css(color);
  out.ctx.fillRect(0, 0, source.width, source.height);
  return out.canvas;
}

// The rising bloom: a broad centre lobe on the voiced body and two pairs that
// follow the mids and the highs, so the light swells into a hump as you speak.
const BLOOMS = Object.freeze([
  { offset: 0, width: 1.25, height: 1, from: 0, to: 4 },
  { offset: -0.21, width: 1, height: 0.72, from: 3, to: 7 },
  { offset: 0.21, width: 1, height: 0.72, from: 3, to: 7 },
  { offset: -0.39, width: 0.8, height: 0.48, from: 6, to: 10 },
  { offset: 0.39, width: 0.8, height: 0.48, from: 6, to: 10 },
]);

// ---------------------------------------------------------------- renderer

export function createVoiceWingbeat(host, { level = () => 0, analyser = () => null } = {}) {
  const doc = host?.ownerDocument;
  const view = doc?.defaultView;
  if (!host || !view) return NOOP_GLOW;
  const canvas = doc.createElement('canvas');
  let ctx = null;
  try { ctx = canvas.getContext('2d'); } catch { ctx = null; }
  if (!ctx) return NOOP_GLOW;
  canvas.className = 'voice-wingbeat';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset.voiceState = 'idle';
  canvas.width = 0;
  canvas.height = 0;
  canvas.style.bottom = `${-BLEED}px`;
  host.appendChild(canvas);

  const media = (query) => { try { return view.matchMedia?.(query) || NO_MEDIA; } catch { return NO_MEDIA; } };
  const reduced = media('(prefers-reduced-motion: reduce)');
  const forced = media('(forced-colors: active)');

  let active = false;
  let processing = false;
  let destroyed = false;
  let awake = false;
  let visible = true;
  let frameId = 0;
  let last = 0;
  let time = 0;
  let bornAt = 0;
  let presence = 0;
  let volume = 0;
  let folded = 0;
  let flow = 0;
  let sweep = 0;
  let quality = 1;
  let pace = PACE_MS;
  let lean = false; // still late at the lowest resolution: paint at half rate
  let tick = 0;
  let ticks = 0;
  let lateTicks = 0;
  let tallest = 0; // tallest plume envelope this frame
  let airborne = 0; // feathers still in flight
  let paletteDirty = true;
  let themeKey = '';
  let colors = voiceWingbeatPalette();
  let dark = true;
  let sprites = null;
  let core = null;
  let paletteFill = null;
  let heatFill = null;
  let samples = null;
  let sampleBytes = null;
  let frequency = null;
  // Geometry, recomputed only on resize.
  let width = 0;
  let band = 0;
  let scale = 1;
  let span = 1;
  let mid = 0;
  let base = 0;
  let reach = 0;
  let spacing = 1;
  const env = new Float32Array(PLUMES);
  const tipX = new Float32Array(PLUMES);
  const tipY = new Float32Array(PLUMES);
  const spectrum = new Float32Array(SPECTRUM);
  const feathers = new Float32Array(FEATHERS * 7); // x, y, vx, vy, age, life, size

  function analyserNode() {
    try { return typeof analyser === 'function' ? analyser() : analyser; } catch { return null; }
  }

  function readLevel(node) {
    if (node?.fftSize) {
      try {
        if (node.getFloatTimeDomainData) {
          if (samples?.length !== node.fftSize) samples = new Float32Array(node.fftSize);
          node.getFloatTimeDomainData(samples);
          return voiceGlowSignal(samples);
        }
        if (node.getByteTimeDomainData) {
          if (sampleBytes?.length !== node.fftSize) sampleBytes = new Uint8Array(node.fftSize);
          if (samples?.length !== node.fftSize) samples = new Float32Array(node.fftSize);
          node.getByteTimeDomainData(sampleBytes);
          for (let index = 0; index < samples.length; index++) samples[index] = (sampleBytes[index] - 128) / 128;
          return voiceGlowSignal(samples);
        }
      } catch { /* the recorder may have just closed its analyser */ }
    }
    try { return Number(typeof level === 'function' ? level() : level) || 0; } catch { return 0; }
  }

  // Without a spectrum (fallback page, unusual analysers) the plumes still
  // dance: bands are synthesised from the level so the wings never freeze.
  function readSpectrum(node) {
    if (node?.getByteFrequencyData && node.frequencyBinCount) {
      try {
        if (frequency?.length !== node.frequencyBinCount) frequency = new Uint8Array(node.frequencyBinCount);
        node.getByteFrequencyData(frequency);
        voiceGlowSpectrum(frequency, node.context?.sampleRate || 48000, node.fftSize || frequency.length * 2, spectrum);
        return;
      } catch { /* analyser closed mid-frame */ }
    }
    for (let index = 0; index < SPECTRUM; index++) {
      spectrum[index] = clamp((0.55 + 0.45 * Math.sin(time * 4.1 + index * 1.9)) * (1 - (index / SPECTRUM) * 0.45));
    }
  }

  function spectrumAverage(from, to) {
    let sum = 0;
    for (let index = from; index < to; index++) sum += spectrum[index];
    return sum / Math.max(1, to - from);
  }

  function edgeFade(x) {
    const ramp = Math.max(24, span * 0.14);
    return smoothstep((x - INSET * 0.5) / ramp) * smoothstep((width - INSET * 0.5 - x) / ramp);
  }

  function buildFills() {
    if (!width) return;
    // Three periods of a mirrored palette loop. Flow slides the gradient
    // sideways with a transform, so a frame never allocates a gradient.
    const from = INSET - span * 2;
    const to = INSET + span * 4;
    const gradient = ctx.createLinearGradient(from, 0, to, 0);
    const steps = 24;
    for (let index = 0; index <= steps; index++) {
      const x = from + ((to - from) * index) / steps;
      gradient.addColorStop(index / steps, css(samplePingPong(colors, (x - INSET) / span)));
    }
    paletteFill = gradient;
    const heat = ctx.createLinearGradient(0, base + 3, 0, base - 22);
    heat.addColorStop(0, 'rgba(255,255,255,0.42)');
    heat.addColorStop(0.3, 'rgba(255,255,255,0.12)');
    heat.addColorStop(1, 'rgba(255,255,255,0)');
    heatFill = heat;
  }

  function refreshPalette() {
    paletteDirty = false;
    let style = null;
    try { style = view.getComputedStyle(host); } catch { style = null; }
    const read = (name) => style?.getPropertyValue(name) || '';
    const ink = read('--hermes-ink-rgb');
    const accent = read('--hermes-accent-rgb');
    const primary = read('--hermes-primary-rgb') || read('--hermes-blue-rgb');
    const paperValue = read('--hermes-paper-rgb');
    // The panel also writes layout values (the dock height on resize) to the
    // root style. Those wake the observer too; only re-tint when a colour moved.
    const key = `${ink}|${accent}|${primary}|${paperValue}`;
    if (key === themeKey && core && paletteFill) return;
    themeKey = key;
    const paper = colorChannels(paperValue, [251, 252, 255]);
    dark = paper[0] * 0.2126 + paper[1] * 0.7152 + paper[2] * 0.0722 < 140;
    colors = voiceWingbeatPalette({ ink, accent, primary, dark });
    core = sprites ? tintSprite(doc, sprites.glow, dark ? mix(colors[2], [255, 255, 255], 0.62) : colors[2]) : null;
    buildFills();
  }

  function applySize() {
    scale = Math.min(view.devicePixelRatio || 1, MAX_SCALE) * quality;
    const pixelWidth = Math.max(1, Math.round(width * scale));
    const pixelHeight = Math.max(1, Math.round((band + BLEED) * scale));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const cssHeight = `${band + BLEED}px`;
    if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
    span = Math.max(1, width - INSET * 2);
    mid = INSET + span / 2;
    base = band - 1;
    reach = Math.max(6, Math.min(62, band - 12));
    spacing = span / PLUMES;
    buildFills();
  }

  // Layout is read on wake and from ResizeObserver callbacks, where it is
  // already clean. The frame loop never reads it.
  function measure() {
    width = host.clientWidth || 0;
    band = Math.max(0, Math.min(host.clientHeight || 0, BAND));
    applySize();
  }

  function wake() {
    if (awake || destroyed) return;
    awake = true;
    if (!sprites) { try { sprites = buildSprites(doc); } catch { sprites = null; } }
    quality = 1;
    lean = false;
    pace = PACE_MS;
    ticks = 0;
    lateTicks = 0;
    resizeObserver?.observe(host);
    intersectionObserver?.observe(host);
    themeObserver?.observe(doc.documentElement, THEME_ATTRIBUTES);
    if (doc.body) themeObserver?.observe(doc.body, BODY_ATTRIBUTES);
    measure();
    refreshPalette();
  }

  function sleep() {
    cancel();
    if (!awake) return;
    awake = false;
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    themeObserver?.disconnect();
    visible = true;
    clear();
    canvas.width = 0; // release the backing store while idle
    canvas.height = 0;
    paletteFill = null;
    heatFill = null;
    presence = 0;
    volume = 0;
    folded = 0;
    env.fill(0);
    feathers.fill(0);
  }

  function clear() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // Feathers leave from the tip of one of the taller plumes and stay near the
  // light, so none of them reads as a stray speck.
  function spawnFeather() {
    let slot = -1;
    for (let index = 0; index < FEATHERS; index++) if (feathers[index * 7 + 5] <= 0) { slot = index; break; }
    if (slot < 0) return;
    let pick = -1;
    for (let tries = 0, best = 0.18; tries < 3; tries++) {
      const index = Math.floor(Math.random() * PLUMES);
      if (env[index] > best) { best = env[index]; pick = index; }
    }
    if (pick < 0) return;
    const u = ((pick + 0.5) / PLUMES) * 2 - 1;
    const o = slot * 7;
    feathers[o] = tipX[pick];
    feathers[o + 1] = tipY[pick] + 2;
    feathers[o + 2] = u * 16 + (Math.random() - 0.5) * 10;
    feathers[o + 3] = -(14 + Math.random() * 18) * (0.6 + volume);
    feathers[o + 4] = 0;
    feathers[o + 5] = 0.45 + Math.random() * 0.4;
    feathers[o + 6] = 3.6 + Math.random() * 2;
  }

  function step(dt) {
    presence = approach(presence, active ? 1 : 0, dt, active ? 14 : 11);
    const listening = active && !processing;
    const node = listening ? analyserNode() : null;
    const target = listening ? normalizeVoiceGlowLevel(readLevel(node)) : 0;
    volume = approach(volume, target, dt, target > volume ? 42 : 7.5);
    folded = approach(folded, active && processing ? 1 : 0, dt, 7);
    if (listening) readSpectrum(node);
    flow += dt * (0.035 + volume * 0.42);
    if (folded > 0.01) sweep += dt * 1.55;
    const drive = Math.pow(volume, 0.85);
    tallest = 0;
    for (let index = 0; index < PLUMES; index++) {
      const distance = Math.abs(((index + 0.5) / PLUMES) * 2 - 1);
      const energy = spectrum[Math.min(SPECTRUM - 1, Math.floor(distance * SPECTRUM))];
      const goal = listening ? clamp(drive * (0.28 + 1.2 * Math.pow(energy, 1.15))) : 0;
      env[index] = approach(env[index], goal, dt, goal > env[index] ? 30 : 6.5);
      if (env[index] > tallest) tallest = env[index];
    }
    if (listening && volume > 0.3 && Math.random() < volume * dt * 4.5) spawnFeather();
    const ceiling = base - reach * 1.3;
    airborne = 0;
    for (let index = 0; index < FEATHERS; index++) {
      const o = index * 7;
      if (feathers[o + 5] <= 0) continue;
      feathers[o + 4] += dt;
      feathers[o] += feathers[o + 2] * dt;
      feathers[o + 1] += feathers[o + 3] * dt;
      feathers[o + 2] *= 1 - 0.4 * dt;
      feathers[o + 3] *= 1 - 0.9 * dt;
      if (feathers[o + 4] >= feathers[o + 5] || feathers[o + 1] < Math.max(6, ceiling)) feathers[o + 5] = 0;
      else airborne++;
    }
  }

  function paint(still = false) {
    clear();
    if (!sprites || !paletteFill || width < 48 || band < 12 || presence <= 0.002) return;
    const s = scale;
    const k = (dark ? 1 : 0.92) * presence;
    const age = time - bornAt;
    const open = 1 - folded;
    const flash = still ? 0 : Math.exp(-age * 4.2);
    const breath = still ? 0.5 : 0.5 + 0.5 * Math.sin(time * 1.7);
    const unfold = still ? 1 : 1 - Math.pow(1 - clamp(age / 0.5), 3);
    const wings = 0.62 + 0.38 * presence; // the wings close toward the centre as dictation ends
    ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    ctx.setTransform(s, 0, 0, s, 0, 0);

    // 1. The rising bloom: soft light that swells into a hump as you speak.
    if (open > 0.01) {
      for (let index = 0; index < BLOOMS.length; index++) {
        const bloom = BLOOMS[index];
        const drive = clamp(volume * (0.5 + 0.8 * spectrumAverage(bloom.from, bloom.to)));
        const lift = Math.min(band - 6, (7 + reach * 0.72 * drive * bloom.height + 3 * breath * bloom.height) * open * (0.5 + 0.5 * unfold));
        const half = span * (0.15 + 0.07 * drive) * bloom.width * (0.45 + 0.55 * unfold);
        const x = mid + span * bloom.offset * (0.55 + 0.45 * unfold) * wings;
        ctx.globalAlpha = clamp((0.1 + 0.32 * drive + 0.14 * flash) * open * k * edgeFade(x));
        ctx.drawImage(sprites.rise, x - half, base - lift, half * 2, lift + 1);
        // Its reflection: one smooth skirt of light under the edge.
        ctx.globalAlpha = clamp((0.06 + 0.22 * drive + 0.08 * flash) * open * k * edgeFade(x));
        ctx.drawImage(sprites.drop, x - half * 0.9, base + 1, half * 1.8, Math.min(BLEED - 14, 6 + lift * 0.34));
      }
    }

    // 2. Feather plumes: the spectrum mirrored from the centre out, lows in the
    // middle and highs fanning out like wings. Each feather's angle grows
    // toward the edges and its tip curls outward; a brighter shaft sits inside
    // every wisp, and neighbours overlap.
    const plumeWidth = spacing * 2.3;
    for (let index = 0; index < PLUMES; index++) {
      const u = ((index + 0.5) / PLUMES) * 2 - 1;
      const distance = Math.abs(u);
      const shown = still ? 1 : smoothstep((age * 2.6 - distance * 0.9) / 0.55);
      const lift = env[index] * JITTER[index] * (still ? 1 : 1 + 0.1 * Math.sin(time * 2.3 + index * 1.7));
      const height = Math.min(band - 4, (reach * lift * (1 - 0.3 * distance) + 2.4 * breath * (1 - distance)) * open * shown);
      const x = mid + u * (span / 2 - spacing / 2) * wings;
      const w = plumeWidth * (1 - 0.3 * distance) * BREADTH[index];
      const sway = still ? 0 : Math.sin(time * 1.7 + index * 0.6) * 0.06;
      const lean = (Math.tan(u * FAN * wings) + sway) * height * 0.9;
      const curled = distance > 0.05;
      const flip = u < 0 ? -1 : 1;
      const sprite = curled ? sprites.curl : sprites.plume;
      tipX[index] = x + lean + (curled ? flip * CURL * w : 0);
      tipY[index] = base - height;
      if (height < 0.8) continue;
      const fade = k * edgeFade(x) * shown;
      ctx.globalAlpha = clamp((0.34 + 0.2 * lift) * fade);
      ctx.setTransform(s * w * flip, 0, -s * lean, s * height, s * x, s * base);
      ctx.drawImage(sprite, -0.5, -1, 1, 1);
      ctx.globalAlpha = clamp((0.5 + 0.3 * lift) * fade);
      ctx.setTransform(s * w * 0.42 * flip, 0, -s * lean * 0.7, s * height * 0.72, s * x, s * base);
      ctx.drawImage(sprite, -0.5, -1, 1, 1);
    }

    // 3. Feathers shed from the plume tips drift up a little and fade.
    for (let index = 0; !still && index < FEATHERS; index++) {
      const o = index * 7;
      if (feathers[o + 5] <= 0) continue;
      const fade = Math.pow(Math.sin(Math.PI * clamp(feathers[o + 4] / feathers[o + 5])), 1.2);
      const size = feathers[o + 6];
      const angle = Math.atan2(feathers[o + 3], feathers[o + 2]) + Math.PI / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      ctx.globalAlpha = clamp(0.55 * fade * k * edgeFade(feathers[o]));
      ctx.setTransform(s * cos * size * 0.7, s * sin * size * 0.7, -s * sin * size * 2, s * cos * size * 2, s * feathers[o], s * feathers[o + 1]);
      ctx.drawImage(sprites.glow, -0.5, -0.5, 1, 1);
    }
    ctx.setTransform(s, 0, 0, s, 0, 0);

    // 4. The edge line, and the light spilling under the composer. While the
    // comet runs, the line dims so the comet carries the motion.
    ctx.globalAlpha = clamp(((0.26 + 0.36 * volume + 0.12 * breath + 0.5 * flash) * (1 - 0.45 * folded) + 0.1 * folded) * k);
    ctx.drawImage(sprites.line, INSET - 10, base - 2.5, span + 20, 5);
    ctx.globalAlpha = clamp((0.1 + 0.24 * volume + 0.16 * flash) * open * k);
    ctx.drawImage(sprites.drop, mid - span * 0.4, base + 1, span * 0.8, Math.min(BLEED - 12, 10 + volume * 18 + flash * 6));

    // 5. Processing: the plumes fold and a comet sweeps the edge, easing into
    // each turn, with a tapered trail that follows its curve.
    let head = mid;
    if (folded > 0.01) {
      const travel = span * 0.43;
      head = mid + travel * Math.sin(sweep);
      for (let tail = 6; tail >= 1; tail--) {
        const x = mid + travel * Math.sin(sweep - tail * 0.08);
        const fade = Math.pow(1 - tail / 7, 1.8);
        const size = 9 + 14 * fade;
        ctx.globalAlpha = clamp(0.36 * fade * folded * k * edgeFade(x));
        ctx.drawImage(sprites.rise, x - size, base - size * 0.55, size * 2, size * 0.55 + 1);
      }
      ctx.globalAlpha = clamp(0.95 * folded * k * edgeFade(head));
      ctx.drawImage(sprites.rise, head - 15, base - 12, 30, 13);
      const speed = Math.abs(Math.cos(sweep));
      const length = 16 + Math.min(span * 0.32, 104) * Math.sqrt(speed);
      const heading = Math.cos(sweep) >= 0 ? 1 : -1;
      ctx.globalAlpha = clamp(0.55 * folded * k);
      ctx.setTransform(s * heading * length, 0, 0, s, s * head, s * base);
      ctx.drawImage(sprites.streak, -1, -2.5, 1.04, 5);
      ctx.globalAlpha = clamp(0.8 * folded * k);
      ctx.setTransform(s * heading * length * 0.38, 0, 0, s, s * head, s * base);
      ctx.drawImage(sprites.streak, -1, -5, 1.06, 10);
      ctx.setTransform(s, 0, 0, s, 0, 0);
    }

    // 6. One pass tints every white shape with the flowing palette.
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-in';
    const period = span * 2;
    const shift = ((((still ? 0 : flow) * span) % period) + period) % period;
    ctx.setTransform(s, 0, 0, s, -s * shift, 0);
    ctx.fillStyle = paletteFill;
    ctx.fillRect(shift, 0, width, band + BLEED);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    if (dark) {
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = heatFill;
      ctx.fillRect(0, base - 28, width, 34);
    }

    // 7. Hot light on top: bright cores in the strands and the epicentre where
    // the voice enters the edge.
    ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    if (dark && open > 0.01) {
      for (let index = 0; index < PLUMES; index++) {
        const height = (base - tipY[index]) * 0.74;
        if (height < 3) continue;
        const u = ((index + 0.5) / PLUMES) * 2 - 1;
        const x = mid + u * (span / 2 - spacing / 2) * wings;
        const w = plumeWidth * (1 - 0.3 * Math.abs(u)) * 0.24;
        ctx.globalAlpha = clamp((0.16 + 0.4 * env[index]) * k * edgeFade(x) * open);
        ctx.setTransform(s * w, 0, -s * (tipX[index] - x) * 0.74, s * height, s * x, s * base);
        ctx.drawImage(sprites.plume, -0.5, -1, 1, 1);
      }
      ctx.setTransform(s, 0, 0, s, 0, 0);
    }
    if (core) {
      const listeningCore = 1 - folded;
      const coreWidth = span * (0.11 + 0.1 * volume + 0.12 * flash) * listeningCore + 18 * folded;
      const coreHeight = (8 + 16 * volume + 10 * flash) * listeningCore + 9 * folded;
      const x = folded > 0.5 ? head : mid;
      ctx.globalAlpha = clamp((0.26 + 0.5 * volume + 0.6 * flash + 0.55 * folded) * k * (dark ? 1 : 0.55) * edgeFade(x));
      ctx.drawImage(core, x - coreWidth / 2, base - coreHeight * 0.55, coreWidth, coreHeight);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // Reduced motion: one still composition, redrawn only when state or theme changes.
  function paintStill() {
    if (paletteDirty) refreshPalette();
    presence = 1;
    volume = processing ? 0 : 0.32;
    folded = processing ? 1 : 0;
    sweep = 0;
    for (let index = 0; index < PLUMES; index++) env[index] = processing ? 0 : 0.42 * (1 - 0.55 * Math.abs(((index + 0.5) / PLUMES) * 2 - 1));
    feathers.fill(0);
    paint(true);
  }

  function cancel() {
    if (frameId) view.cancelAnimationFrame(frameId);
    frameId = 0;
    last = 0;
    tick = 0;
  }

  // Frame pacing guard. It watches the browser's own frame rhythm, so it sees
  // jank from any source. If more than one frame in twelve arrives late, it
  // renders fewer pixels; at the lowest resolution it paints at half rate. A
  // machine that keeps up never pays for any of this.
  function govern(interval) {
    ticks++;
    if (interval > LATE_MS) lateTicks++;
    if (ticks < 60) return;
    if (lateTicks > ticks * 0.08) {
      if (quality > 0.5) {
        quality = Math.max(0.5, quality * 0.75);
        applySize();
        paint(); // resizing cleared the canvas; repaint now so it never blinks
      } else lean = true;
    }
    ticks = 0;
    lateTicks = 0;
  }

  function frame(timestamp) {
    frameId = 0;
    if (!awake || destroyed || !visible || doc.hidden || reduced.matches || forced.matches) return;
    if (tick) govern(timestamp - tick);
    tick = timestamp;
    if (last && timestamp - last < pace) {
      frameId = view.requestAnimationFrame(frame);
      return;
    }
    const dt = last ? Math.min(0.05, (timestamp - last) / 1000) : 1 / 60;
    last = timestamp;
    time += dt;
    if (paletteDirty) refreshPalette();
    step(dt);
    if (!active && presence <= SETTLED) { sleep(); return; }
    paint();
    // Between words nothing moves but a slow breath, so paint at half rate.
    const calm = active && !processing && volume < 0.04 && tallest < 0.06 && airborne === 0 && time - bornAt > 0.6;
    pace = lean || calm ? CALM_PACE_MS : PACE_MS;
    frameId = view.requestAnimationFrame(frame);
  }

  function reconcile() {
    if (destroyed) return;
    if (!active) {
      // Nothing to fade when nobody can see it; otherwise let the loop settle.
      if (!awake) return;
      if (forced.matches || reduced.matches || !visible || doc.hidden || presence <= SETTLED) { sleep(); return; }
    } else if (!awake) wake();
    if (forced.matches) { cancel(); clear(); return; }
    if (reduced.matches) { cancel(); paintStill(); return; }
    if (!visible || doc.hidden) { cancel(); return; }
    if (!frameId) { last = 0; frameId = view.requestAnimationFrame(frame); }
  }

  const resizeObserver = view.ResizeObserver ? new view.ResizeObserver(() => {
    if (!awake || destroyed) return;
    measure();
    if (reduced.matches) paintStill();
    else paint(); // resizing cleared the canvas; repaint this frame to avoid a flash
  }) : null;
  const intersectionObserver = view.IntersectionObserver ? new view.IntersectionObserver((entries) => {
    visible = entries[entries.length - 1]?.isIntersecting !== false;
    reconcile();
  }) : null;
  const themeObserver = view.MutationObserver ? new view.MutationObserver(() => {
    paletteDirty = true;
    if (awake && reduced.matches && active) paintStill();
  }) : null;
  reduced.addEventListener?.('change', reconcile);
  forced.addEventListener?.('change', reconcile);
  doc.addEventListener('visibilitychange', reconcile);
  view.addEventListener('pagehide', destroy);

  function destroy() {
    if (destroyed) return;
    sleep();
    destroyed = true;
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    themeObserver?.disconnect();
    reduced.removeEventListener?.('change', reconcile);
    forced.removeEventListener?.('change', reconcile);
    doc.removeEventListener('visibilitychange', reconcile);
    view.removeEventListener('pagehide', destroy);
    canvas.remove();
  }

  return {
    // Builds the sprites ahead of the first dictation (the panel calls this as
    // the pointer heads for the mic), so the glow starts without a hitch. No
    // loop, observers or backing store; the glow stays asleep.
    prepare() {
      if (destroyed || sprites) return;
      try { sprites = buildSprites(doc); } catch { sprites = null; }
    },
    set(next = {}) {
      if (destroyed) return;
      const nextActive = typeof next.active === 'boolean' ? next.active : active;
      const nextProcessing = typeof next.processing === 'boolean' ? next.processing : processing;
      // The status meter calls this four times a second; unchanged state is free.
      if (nextActive === active && nextProcessing === processing) return;
      const starting = nextActive && !active;
      active = nextActive;
      processing = nextProcessing;
      const label = active ? (processing ? 'processing' : 'recording') : 'idle';
      if (canvas.dataset.voiceState !== label) canvas.dataset.voiceState = label;
      if (starting) {
        const fresh = !awake || presence < 0.3;
        wake();
        if (fresh) {
          bornAt = time;
          flow = 0;
          sweep = 0;
        }
      }
      reconcile();
    },
    destroy,
  };
}

// Only the standalone fallback page needs its own meter. Side-panel capture
// already has one, so it passes its existing analyser instead of opening this graph.
export function createVoiceLevelSource(stream, view = globalThis.window) {
  const AudioContextClass = view?.AudioContext || view?.webkitAudioContext;
  if (!stream || !AudioContextClass) return NOOP_LEVEL;
  let context;
  let source;
  let analyser;
  let gain;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const node of [source, analyser, gain]) { try { node?.disconnect(); } catch { /* already detached */ } }
    try { context?.close()?.catch?.(() => {}); } catch { /* already closed */ }
  };
  try {
    context = new AudioContextClass();
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    gain = context.createGain();
    gain.gain.value = 0;
    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(context.destination);
    if (context.state === 'suspended') context.resume()?.catch?.(() => {});
    const samples = new Float32Array(analyser.fftSize);
    return {
      get analyser() { return closed || context.state !== 'running' ? null : analyser; },
      level() {
        if (closed || context.state !== 'running') return 0;
        try { analyser.getFloatTimeDomainData(samples); return voiceGlowSignal(samples); } catch { return 0; }
      },
      close,
    };
  } catch {
    close();
    return NOOP_LEVEL;
  }
}
