import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  createVoiceWingbeat,
  createVoiceLevelSource,
  normalizeVoiceGlowLevel,
  voiceGlowBands,
  voiceGlowSpectrum,
  voiceWingbeatPalette,
} from '../extension/lib/voice-wingbeat.mjs';

function harness({ reduced = false, forced = false, noCanvas = false } = {}) {
  const dom = new JSDOM('<!doctype html><html data-hermes-mode="dark"><body><div id="host"><textarea></textarea><button>Mic</button></div></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const host = window.document.getElementById('host');
  const reads = { layout: 0, style: 0 };
  Object.defineProperties(host, {
    clientWidth: { get() { reads.layout++; return 380; } },
    clientHeight: { get() { reads.layout++; return 112; } },
  });
  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element) => { reads.style++; return computed(element); };
  const frames = new Map();
  let nextFrame = 0;
  window.requestAnimationFrame = (fn) => { frames.set(++nextFrame, fn); return nextFrame; };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  const media = new Map();
  window.matchMedia = (query) => {
    if (!media.has(query)) {
      const listeners = new Set();
      media.set(query, { matches: query.includes('reduced-motion') ? reduced : forced, addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn), change(value) { this.matches = value; for (const fn of listeners) fn(); } });
    }
    return media.get(query);
  };
  const observers = [];
  for (const name of ['ResizeObserver', 'IntersectionObserver']) {
    window[name] = class {
      constructor(callback) { this.callback = callback; this.observing = 0; observers.push(this); }
      observe() { this.observing++; this.disconnected = false; }
      disconnect() { this.observing = 0; this.disconnected = true; }
    };
  }
  const ops = [];
  const gradient = { addColorStop() {} };
  const ctx = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '', filter: 'none',
    setTransform() {}, save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
    clearRect() { ops.push('clear'); },
    fillRect() { ops.push('fill'); },
    drawImage() { ops.push('blit'); },
    createLinearGradient() { ops.push('gradient'); return gradient; },
    createRadialGradient() { ops.push('gradient'); return gradient; },
    beginPath() { ops.push('path'); }, moveTo() {}, lineTo() {}, bezierCurveTo() {}, quadraticCurveTo() {}, closePath() {}, fill() { ops.push('path-fill'); }, ellipse() {},
  };
  window.HTMLCanvasElement.prototype.getContext = () => (noCanvas ? null : ctx);
  host.style.setProperty('--hermes-ink-rgb', '230, 240, 250');
  host.style.setProperty('--hermes-accent-rgb', '20, 120, 180');
  host.style.setProperty('--hermes-paper-rgb', '12, 20, 30');
  const step = (time) => { const callbacks = [...frames.values()]; frames.clear(); for (const fn of callbacks) fn(time); };
  const run = (count, from = 16) => { for (let index = 0; index < count; index++) step(from + index * 16); };
  return { dom, window, host, frames, ops, media, observers, reads, step, run };
}

const hue = ([r, g, b]) => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (!delta) return null;
  let h;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  return (h * 60 + 360) % 360;
};
const hueGap = (a, b) => { const gap = Math.abs(a - b) % 360; return gap > 180 ? 360 - gap : gap; };
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

test('voice glow gates silence and normalizes real mic peaks without poisoning the animation', () => {
  for (const value of [undefined, null, Number.NaN, Infinity, -1, 0, 0.005]) assert.equal(normalizeVoiceGlowLevel(value), 0);
  assert.ok(normalizeVoiceGlowLevel(0.18) > normalizeVoiceGlowLevel(0.04));
  assert.equal(normalizeVoiceGlowLevel(1), 1);
  assert.equal(normalizeVoiceGlowLevel(10), 1);
});

test('chromatic themes get a vivid multi-hue spread that starts on the theme colour', () => {
  for (const dark of [true, false]) {
    const cobalt = voiceWingbeatPalette({ ink: '5, 5, 232', accent: '219, 230, 255', dark });
    assert.equal(cobalt.length, 5);
    const hues = cobalt.map(hue);
    assert.ok(hues.some((value) => hueGap(value, 240) <= 12), `the cobalt anchor stays in the palette (${hues})`);
    const spread = Math.max(...hues.map((a) => Math.max(...hues.map((b) => hueGap(a, b)))));
    assert.ok(spread >= 90, `a colourful spread, not one blue (${spread}°)`);
  }
  assert.notDeepEqual(
    voiceWingbeatPalette({ ink: '200, 180, 250', accent: '100, 50, 200' }),
    voiceWingbeatPalette({ ink: '#d3c6aa', accent: '#a7c080' }),
  );
});

test('two-tone themes keep both colours and warm themes stay warm', () => {
  const custom = voiceWingbeatPalette({ ink: '17, 17, 17', accent: '255, 212, 0', primary: '5, 5, 232', dark: false }).map(hue);
  assert.ok(custom.some((value) => hueGap(value, 240) <= 12), 'the custom primary survives');
  assert.ok(custom.some((value) => hueGap(value, 50) <= 12), 'the custom accent survives');
  for (const dark of [true, false]) {
    const ember = voiceWingbeatPalette({ ink: '255, 208, 164', accent: '255, 157, 77', dark }).map(hue);
    for (const value of ember) assert.ok(value >= 345 || value <= 66, `ember stays in fire colours, never pink (${ember})`);
  }
});

test('neutral themes stay neutral and every palette channel is a valid byte', () => {
  for (const palette of [voiceWingbeatPalette({ ink: '#ffffff', accent: '#ffffff' }), voiceWingbeatPalette({ ink: '229, 229, 229', accent: '201, 201, 201', dark: false })]) {
    for (const [r, g, b] of palette) assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 40, 'grey stays grey');
  }
  for (const palette of [voiceWingbeatPalette(), voiceWingbeatPalette({ ink: 'not a colour', accent: '' }), voiceWingbeatPalette({ accent: '#e6ff57', primary: '#4c59e8' })]) {
    assert.equal(palette.length, 5);
    for (const color of palette) for (const channel of color) assert.ok(Number.isInteger(channel) && channel >= 0 && channel <= 255);
  }
});

test('light paper gets deeper colours than dark paper', () => {
  const input = { ink: '0, 0, 242', accent: '0, 0, 242' };
  const mean = (palette) => palette.reduce((sum, color) => sum + luminance(color), 0) / palette.length;
  assert.ok(mean(voiceWingbeatPalette({ ...input, dark: false })) < mean(voiceWingbeatPalette({ ...input, dark: true })) - 30);
});

test('idle costs nothing: no frame, no observers and no backing store until dictation starts', () => {
  const h = harness();
  const glow = createVoiceWingbeat(h.host, { level: () => 0.3 });
  const canvas = h.host.querySelector('canvas');
  assert.equal(canvas.getAttribute('aria-hidden'), 'true');
  assert.equal(canvas.dataset.voiceState, 'idle');
  assert.equal(h.host.querySelectorAll('textarea').length, 1);
  assert.equal(h.host.querySelectorAll('button').length, 1);
  assert.equal(h.frames.size, 0);
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
  assert.ok(h.observers.every((observer) => observer.observing === 0), 'observers stay disconnected while idle');
  assert.equal(h.reads.layout + h.reads.style, 0, 'creating the glow reads no layout or style');

  glow.set({ active: true });
  assert.equal(canvas.dataset.voiceState, 'recording');
  assert.equal(h.frames.size, 1);
  assert.ok(canvas.width > 0 && canvas.height > 0);
  assert.ok(h.observers.every((observer) => observer.observing > 0));
  h.step(16);
  assert.ok(h.ops.includes('blit'));
  assert.equal(h.frames.size, 1);

  glow.set({ active: false });
  assert.equal(canvas.dataset.voiceState, 'idle');
  assert.equal(h.frames.size, 1, 'the glow folds away instead of cutting off');
  h.run(60, 32);
  assert.equal(h.frames.size, 0, 'and then the loop stops');
  assert.equal(canvas.width, 0, 'the backing store is released again');
  assert.equal(canvas.height, 0);
  assert.ok(h.observers.every((observer) => observer.observing === 0), 'observers disconnect again');
  glow.destroy();
  h.dom.window.close();
});

test('the frame loop draws only batched sprites and never reads layout or computed style', () => {
  const h = harness();
  const analyser = { fftSize: 128, frequencyBinCount: 64, context: { sampleRate: 48000 }, getFloatTimeDomainData: (s) => s.fill(0.3), getByteFrequencyData: (b) => b.fill(210) };
  const glow = createVoiceWingbeat(h.host, { analyser: () => analyser });
  glow.set({ active: true });
  const reads = { ...h.reads };
  h.ops.length = 0;
  h.run(40);
  assert.deepEqual(h.reads, reads, 'no layout or style reads inside the frame loop');
  assert.ok(h.ops.filter((op) => op === 'blit').length > 40 * 10, 'plumes, blooms and the edge are sprite blits');
  assert.equal(h.ops.filter((op) => op === 'path' || op === 'path-fill').length, 0, 'no path tessellation per frame');
  assert.equal(h.ops.filter((op) => op === 'gradient').length, 0, 'no gradients are created per frame');
  glow.destroy();
  h.dom.window.close();
});

test('the status meter can call set() every tick for free', async () => {
  const h = harness();
  const glow = createVoiceWingbeat(h.host);
  const canvas = h.host.querySelector('canvas');
  const records = [];
  const watcher = new h.window.MutationObserver((list) => records.push(...list));
  watcher.observe(canvas, { attributes: true });
  glow.set({ active: true, processing: false });
  for (let tick = 0; tick < 20; tick++) glow.set({ active: true, processing: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(records.filter((record) => record.attributeName === 'data-voice-state').length, 1);
  assert.equal(h.frames.size, 1);
  watcher.disconnect();
  glow.destroy();
  h.dom.window.close();
});

test('a theme change refreshes the palette once, on the next frame', async () => {
  const h = harness();
  const glow = createVoiceWingbeat(h.host);
  glow.set({ active: true });
  h.run(3);
  const before = h.reads.style;
  for (let burst = 0; burst < 5; burst++) h.window.document.documentElement.dataset.hermesTheme = `theme-${burst}`;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.reads.style, before, 'mutations only mark the palette stale');
  h.run(4, 200);
  assert.equal(h.reads.style, before + 1, 'one computed-style read per theme change');
  glow.destroy();
  h.dom.window.close();
});

test('layout writes to the root style do not re-tint; a real colour change does', async () => {
  const h = harness();
  const glow = createVoiceWingbeat(h.host);
  glow.set({ active: true });
  h.run(3);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  h.ops.length = 0;
  for (let px = 80; px < 90; px++) h.window.document.documentElement.style.setProperty('--hermes-bottom-dock-height', `${px}px`);
  await settle();
  h.run(3, 200);
  assert.equal(h.ops.filter((op) => op === 'gradient').length, 0, 'the dock height moving is not a theme change');
  h.host.style.setProperty('--hermes-accent-rgb', '200, 60, 120');
  h.window.document.documentElement.dataset.hermesTheme = 'ember';
  await settle();
  h.run(3, 300);
  assert.ok(h.ops.filter((op) => op === 'gradient').length > 0, 'a new accent rebuilds the palette fills');
  glow.destroy();
  h.dom.window.close();
});

test('processing reuses the same canvas and settles when transcription ends', () => {
  const h = harness();
  const glow = createVoiceWingbeat(h.host);
  glow.set({ active: true });
  h.step(16);
  glow.set({ active: true, processing: true });
  assert.equal(h.host.querySelector('canvas').dataset.voiceState, 'processing');
  assert.equal(h.host.querySelectorAll('canvas').length, 1);
  assert.equal(h.frames.size, 1);
  h.run(15, 32);
  glow.set({ active: false, processing: false });
  h.run(60, 400);
  assert.equal(h.frames.size, 0);
  glow.destroy();
  h.dom.window.close();
});

function speakingAnalyser() {
  const voice = { amplitude: 0.3 };
  voice.node = {
    fftSize: 128, frequencyBinCount: 64, context: { sampleRate: 48000 },
    getFloatTimeDomainData: (samples) => samples.fill(voice.amplitude),
    getByteFrequencyData: (bins) => bins.fill(voice.amplitude ? 210 : 0),
  };
  return voice;
}
const paints = (ops) => ops.filter((op) => op === 'clear').length;
function runAt(h, count, interval, from) {
  let time = from;
  for (let index = 0; index < count; index++) { time += typeof interval === 'function' ? interval(index) : interval; h.step(time); }
  return time;
}

test('paints every frame up to ~100 Hz and every other refresh on faster screens', () => {
  const h = harness();
  const voice = speakingAnalyser();
  const glow = createVoiceWingbeat(h.host, { analyser: () => voice.node });
  glow.set({ active: true });
  let time = runAt(h, 4, 1000 / 60, 0);
  h.ops.length = 0;
  time = runAt(h, 48, 1000 / 120, time);
  assert.equal(paints(h.ops), 24, '120 Hz refresh paints every other frame');
  h.ops.length = 0;
  time = runAt(h, 45, 1000 / 90, time);
  assert.equal(paints(h.ops), 45, 'a 90 Hz screen paints every frame, never a juddery half rate');
  h.ops.length = 0;
  runAt(h, 30, 1000 / 60, time);
  assert.equal(paints(h.ops), 30, 'a 60 Hz screen paints every frame');
  glow.destroy();
  h.dom.window.close();
});

test('prepare() builds the sprites ahead of time without waking anything', () => {
  const h = harness();
  const glow = createVoiceWingbeat(h.host, { level: () => 0.3 });
  const canvas = h.host.querySelector('canvas');
  glow.prepare();
  assert.ok(h.ops.includes('path-fill'), 'sprites are drawn once, up front');
  assert.equal(h.frames.size, 0, 'no animation frame');
  assert.equal(canvas.width, 0, 'no backing store');
  assert.ok(h.observers.every((observer) => observer.observing === 0), 'no observers');
  assert.equal(h.reads.layout + h.reads.style, 0, 'no layout or style reads');
  h.ops.length = 0;
  glow.prepare();
  glow.set({ active: true });
  assert.equal(h.ops.filter((op) => op === 'path' || op === 'path-fill').length, 0, 'starting dictation reuses the prepared sprites');
  assert.equal(h.frames.size, 1);
  glow.destroy();
  assert.doesNotThrow(() => glow.prepare());
  h.dom.window.close();
});

test('silence between words paints at half rate and speech snaps back to full rate', () => {
  const h = harness();
  const voice = speakingAnalyser();
  voice.amplitude = 0;
  const glow = createVoiceWingbeat(h.host, { analyser: () => voice.node });
  glow.set({ active: true });
  let time = runAt(h, 60, 16, 0);
  h.ops.length = 0;
  time = runAt(h, 40, 16, time);
  assert.ok(paints(h.ops) >= 19 && paints(h.ops) <= 21, `a silent stretch paints about every other frame (${paints(h.ops)})`);
  voice.amplitude = 0.3;
  time = runAt(h, 2, 16, time);
  h.ops.length = 0;
  runAt(h, 30, 16, time);
  assert.equal(paints(h.ops), 30, 'speaking again paints every frame');
  glow.destroy();
  h.dom.window.close();
});

test('a struggling machine sheds resolution first, then paints at half rate', () => {
  const h = harness();
  const voice = speakingAnalyser();
  const glow = createVoiceWingbeat(h.host, { analyser: () => voice.node });
  const canvas = h.host.querySelector('canvas');
  glow.set({ active: true });
  const full = canvas.width;
  const janky = (index) => (index % 5 === 4 ? 40 : 16); // one frame in five arrives late
  let time = runAt(h, 61, janky, 0);
  assert.ok(canvas.width < full, `late frames lower the resolution (${full} -> ${canvas.width})`);
  time = runAt(h, 60 * 3, janky, time);
  assert.equal(canvas.width, Math.round(full * 0.5), 'resolution stops at half');
  h.ops.length = 0;
  runAt(h, 40, 16, time);
  assert.ok(paints(h.ops) <= 21, `still late at the floor: half-rate painting (${paints(h.ops)})`);
  glow.destroy();
  h.dom.window.close();
});

test('a machine that keeps up keeps full resolution and full rate', () => {
  const h = harness();
  const voice = speakingAnalyser();
  const glow = createVoiceWingbeat(h.host, { analyser: () => voice.node });
  const canvas = h.host.querySelector('canvas');
  glow.set({ active: true });
  const full = canvas.width;
  const time = runAt(h, 300, (index) => (index % 40 === 39 ? 34 : 16), 0); // an occasional hiccup
  assert.equal(canvas.width, full);
  h.ops.length = 0;
  runAt(h, 30, 16, time);
  assert.equal(paints(h.ops), 30);
  glow.destroy();
  h.dom.window.close();
});

test('reduced motion draws a still composition with no animation loop', () => {
  const h = harness({ reduced: true });
  const glow = createVoiceWingbeat(h.host, { level: () => 0.6 });
  glow.set({ active: true });
  assert.equal(h.frames.size, 0);
  assert.ok(h.ops.includes('blit'), 'a still glow is painted');
  glow.set({ processing: true });
  assert.equal(h.frames.size, 0);
  glow.set({ active: false });
  assert.equal(h.host.querySelector('canvas').width, 0);
  glow.destroy();
  h.dom.window.close();
});

test('motion preference changes cancel and resume a single loop', () => {
  const h = harness();
  const glow = createVoiceWingbeat(h.host);
  glow.set({ active: true });
  h.media.get('(prefers-reduced-motion: reduce)').change(true);
  assert.equal(h.frames.size, 0);
  h.media.get('(prefers-reduced-motion: reduce)').change(false);
  assert.equal(h.frames.size, 1);
  glow.destroy();
  assert.equal(h.frames.size, 0);
  h.dom.window.close();
});

test('hidden documents and offscreen hosts pause, then resume without duplicate loops', () => {
  const h = harness();
  const glow = createVoiceWingbeat(h.host);
  glow.set({ active: true });
  Object.defineProperty(h.window.document, 'hidden', { configurable: true, value: true });
  h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));
  assert.equal(h.frames.size, 0);
  Object.defineProperty(h.window.document, 'hidden', { configurable: true, value: false });
  h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));
  assert.equal(h.frames.size, 1);
  const intersection = h.observers.find((observer) => observer !== h.observers[0]);
  intersection.callback([{ isIntersecting: false }]);
  assert.equal(h.frames.size, 0);
  intersection.callback([{ isIntersecting: true }]);
  assert.equal(h.frames.size, 1);
  glow.destroy();
  h.dom.window.close();
});

test('ending dictation while hidden goes straight back to idle', () => {
  const h = harness();
  const glow = createVoiceWingbeat(h.host);
  glow.set({ active: true });
  h.run(5);
  Object.defineProperty(h.window.document, 'hidden', { configurable: true, value: true });
  h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));
  glow.set({ active: false });
  assert.equal(h.frames.size, 0);
  assert.equal(h.host.querySelector('canvas').width, 0);
  glow.destroy();
  h.dom.window.close();
});

test('forced colors suppress the decoration without affecting existing controls', () => {
  const h = harness({ forced: true });
  const glow = createVoiceWingbeat(h.host);
  glow.set({ active: true });
  assert.equal(h.frames.size, 0);
  assert.equal(h.host.querySelector('button').textContent, 'Mic');
  glow.destroy();
  h.dom.window.close();
});

test('unavailable Canvas 2D is harmless to dictation', () => {
  const h = harness({ noCanvas: true });
  const glow = createVoiceWingbeat(h.host);
  assert.doesNotThrow(() => { glow.set({ active: true }); glow.destroy(); glow.destroy(); });
  assert.equal(h.frames.size, 0);
  assert.equal(h.host.querySelectorAll('canvas').length, 0);
  h.dom.window.close();
});

test('page teardown disconnects observers, removes the canvas and cancels rendering', () => {
  const h = harness();
  const glow = createVoiceWingbeat(h.host);
  glow.set({ active: true });
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  assert.equal(h.frames.size, 0);
  assert.equal(h.host.querySelectorAll('canvas').length, 0);
  assert.ok(h.observers.every((observer) => observer.disconnected));
  assert.doesNotThrow(() => glow.destroy());
  h.dom.window.close();
});

test('the fallback voice-page meter consumes the existing stream and never owns its tracks', () => {
  let closed = 0;
  let stopped = 0;
  const stream = { getTracks: () => [{ stop: () => stopped++ }] };
  const node = { connect() {}, disconnect() {} };
  class AudioContext {
    state = 'running';
    destination = node;
    createMediaStreamSource(value) { assert.equal(value, stream); return node; }
    createAnalyser() { return { ...node, fftSize: 64, getFloatTimeDomainData: (samples) => samples.fill(0.25) }; }
    createGain() { return { ...node, gain: { value: 1 } }; }
    close() { closed++; return Promise.resolve(); }
  }
  const meter = createVoiceLevelSource(stream, { AudioContext });
  assert.equal(meter.level(), 0.25);
  meter.close();
  meter.close();
  assert.equal(meter.level(), 0);
  assert.equal(closed, 1);
  assert.equal(stopped, 0, 'the recorder remains the only stream owner');
});

test('missing or failing Web Audio produces a silent visual source rather than aborting recording', () => {
  const unavailable = createVoiceLevelSource({}, {});
  assert.equal(unavailable.level(), 0);
  assert.doesNotThrow(() => unavailable.close());
  class BrokenAudioContext { constructor() { throw new Error('AudioContext unavailable'); } }
  const broken = createVoiceLevelSource({}, { AudioContext: BrokenAudioContext });
  assert.equal(broken.level(), 0);
  assert.doesNotThrow(() => broken.close());
});

test('speech bands split voiced body, mids and sibilance and survive bad input', () => {
  assert.deepEqual(voiceGlowBands(null), [0, 0, 0]);
  assert.deepEqual(voiceGlowBands(new Uint8Array(0), 48000, 2048), [0, 0, 0]);
  assert.deepEqual(voiceGlowBands(new Uint8Array(10), 0, 2048), [0, 0, 0]);
  const bins = new Uint8Array(1024);
  const hz = 48000 / 2048;
  for (let i = Math.floor(120 / hz); i < Math.floor(250 / hz); i++) bins[i] = 255;
  const low = voiceGlowBands(bins, 48000, 2048);
  assert.ok(low[0] > 0.5 && low[1] === 0 && low[2] === 0);
  bins.fill(0);
  for (let i = Math.floor(2500 / hz); i < Math.floor(5000 / hz); i++) bins[i] = 255;
  const high = voiceGlowBands(bins, 48000, 2048);
  assert.ok(high[2] > 0.5 && high[0] === 0);
  for (const value of low.concat(high)) assert.ok(value >= 0 && value <= 1);
});

test('the plume spectrum gates room noise, separates lows from highs and never allocates', () => {
  const out = new Float32Array(10);
  const hz = 48000 / 2048;
  const quiet = new Uint8Array(1024).fill(40);
  assert.equal(voiceGlowSpectrum(quiet, 48000, 2048, out), out, 'writes into the caller array');
  assert.ok(out.every((value) => value === 0), 'room noise stays under the gate');
  const voiced = new Uint8Array(1024).fill(40);
  for (let i = Math.floor(100 / hz); i < Math.floor(400 / hz); i++) voiced[i] = 240;
  voiceGlowSpectrum(voiced, 48000, 2048, out);
  assert.ok(out[0] > 0.5 && out[1] > 0.5, 'voiced body lifts the centre bands');
  assert.equal(out[9], 0, 'without sibilance the outer band stays down');
  voiceGlowSpectrum(null, 48000, 2048, out);
  assert.ok(out.every((value) => value === 0));
});

test('the spectrum is read every frame while speaking and not while the plumes are folded', () => {
  const h = harness();
  let spectrumReads = 0;
  const analyser = { fftSize: 128, frequencyBinCount: 64, context: { sampleRate: 48000 }, getFloatTimeDomainData: (s) => s.fill(0.2), getByteFrequencyData: (b) => { spectrumReads++; b.fill(200); } };
  const glow = createVoiceWingbeat(h.host, { analyser: () => analyser });
  glow.set({ active: true });
  h.run(5);
  assert.ok(spectrumReads >= 4, 'the spectrum is sampled every frame while speaking');
  glow.set({ processing: true });
  const before = spectrumReads;
  h.run(2, 96);
  assert.equal(spectrumReads, before, 'the spectrum is not read while transcribing');
  glow.destroy();
  h.dom.window.close();
});
