// The setup buttons' dither-glitch hover (extension/lib/dither-hover.mjs):
// what a frame is, as pure functions of progress, plus the guards around it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  BAYER4, CELL, IN_MS, OUT_MS, bayer, cellOn, createRenderer, ease, glitchAt, glitchPlan, thresholdFor,
} from '../extension/lib/dither-hover.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const css = read('extension/sidepanel.css');
const moduleSource = read('extension/lib/dither-hover.mjs');

test('pixels are fine and the timing is the agreed length', () => {
  assert.equal(CELL, 2);
  assert.ok(CELL <= 3, 'never larger than 3px');
  assert.ok(IN_MS >= 350 && IN_MS <= 450, `in ${IN_MS}ms`);
  assert.ok(OUT_MS >= 150 && OUT_MS <= 200, `out ${OUT_MS}ms`);
});

test('the Bayer matrix is computed once and is a proper 4x4 ordered threshold set', () => {
  assert.equal(BAYER4.length, 16);
  assert.ok(Object.isFrozen(BAYER4));
  assert.equal(new Set(BAYER4).size, 16, 'sixteen distinct thresholds');
  assert.ok(BAYER4.every((value) => value > 0 && value < 1));
  assert.equal(bayer(5, 9), bayer(1, 1), 'it tiles every 4 cells');
});

test('the fill starts at once and settles gently: an ease-out curve', () => {
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(ease(0.1) > 0.25, 'a quarter of the fill is done in the first tenth');
  assert.ok(ease(0.5) > 0.85);
  let previous = -1;
  for (let i = 0; i <= 20; i += 1) {
    const value = ease(i / 20);
    assert.ok(value >= previous, 'monotonic');
    previous = value;
  }
  assert.equal(ease(-1), 0);
  assert.equal(ease(2), 1);
});

test('the dither mask is a deterministic function of progress, grows only, and starts at the origin', () => {
  const cols = 140;
  const rows = 22;
  const origin = { x: 60, y: 22 };
  const thresholds = [];
  for (let cy = 0; cy < rows; cy += 1) for (let cx = 0; cx < cols; cx += 1) thresholds.push(thresholdFor(cx, cy, cols, rows, origin));
  assert.deepEqual(thresholds, (() => {
    const again = [];
    for (let cy = 0; cy < rows; cy += 1) for (let cx = 0; cx < cols; cx += 1) again.push(thresholdFor(cx, cy, cols, rows, origin));
    return again;
  })(), 'same inputs, same mask');
  const on = (progress) => thresholds.filter((value) => cellOn(value, progress)).length;
  assert.equal(on(0), 0, 'nothing is filled at 0');
  assert.equal(on(1), cols * rows, 'everything is filled at 1: the last frame is the whole hover face');
  let previous = 0;
  for (let i = 1; i <= 20; i += 1) {
    const count = on(i / 20);
    assert.ok(count >= previous, 'a cell that is on stays on as progress grows');
    previous = count;
  }
  // The cell under the pointer goes first; a far corner goes last.
  const under = thresholdFor(30, 11, cols, rows, origin);
  const far = thresholdFor(cols - 1, rows - 1, cols, rows, origin);
  assert.ok(under < 0.25 && far > 0.7, `under ${under.toFixed(2)}, far ${far.toFixed(2)}`);
  // It is dithered: at half the cells it is a mix, not a hard edge (neighbouring cells differ).
  const half = ease(0.2) * 1.02;
  const row = [];
  for (let cx = 0; cx < cols; cx += 1) row.push(thresholdFor(cx, 11, cols, rows, origin) < half);
  let flips = 0;
  for (let cx = 1; cx < cols; cx += 1) if (row[cx] !== row[cx - 1]) flips += 1;
  assert.ok(flips >= 4, `a dithered edge flips ${flips} times along a row`);
  // Starting from the other edge (RTL keyboard focus) mirrors it.
  const mirrored = thresholdFor(cols - 1 - 30, 11, cols, rows, { x: cols * CELL - 60, y: 22 });
  assert.ok(Math.abs(mirrored - thresholdFor(30, 11, cols, rows, origin)) < 0.25, 'the same shape from the far edge');
});

test('glitch frames are seeded, short, few, and tear in one direction', () => {
  const plan = glitchPlan(1234);
  assert.deepEqual(plan, glitchPlan(1234), 'deterministic for a seed');
  assert.notDeepEqual(plan, glitchPlan(1235), 'a different hover tears a little differently');
  assert.ok(plan.length >= 3 && plan.length <= 5, 'three to five glitches');
  for (const window of plan) {
    assert.ok(window.bands.length >= 2 && window.bands.length <= 3, '2-3 bands');
    assert.ok(window.half * 2 * IN_MS <= 30, `a glitch lasts ${(window.half * 2 * IN_MS).toFixed(0)}ms, one or two frames`);
    const signs = new Set(window.bands.map((band) => Math.sign(band.dx)));
    assert.equal(signs.size, 1, 'bands in one window slip the same way: a tear, not a jitter');
    for (const band of window.bands) {
      assert.ok(Math.abs(band.dx) >= 1 && Math.abs(band.dx) <= 3, '1-3px');
      assert.ok(band.y >= 0 && band.y + band.height <= 1, 'inside the button');
    }
  }
  assert.equal(plan.filter((window) => window.split).length, 2, 'the colour split on two of them');
  assert.equal(plan.filter((window) => window.scanlines).length, 1, 'one scanline flicker');
  assert.equal(glitchAt(plan, 0.9), null, 'it has settled well before the end');
  assert.equal(glitchAt(plan, 1), null, 'no glitch on the final frame');
  assert.equal(glitchAt(plan, 0), null);
  assert.ok(glitchAt(plan, plan[1].at));
});

test('the quiet variant (secondary buttons) tears less: two short windows, no split, no scanlines', () => {
  const plan = glitchPlan(99, { quiet: true });
  assert.equal(plan.length, 2);
  assert.ok(plan.every((window) => !window.split && !window.scanlines && window.bands.length === 2));
});

// ---- a recording stand-in for the canvas, to check what a frame draws ----

function fakeCanvasEnvironment() {
  const created = [];
  const makeCtx = (canvas) => {
    const calls = [];
    const ctx = new Proxy({ calls, canvas }, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
        return (...args) => { calls.push([prop, ...args]); };
      },
      set(target, prop, value) { target[prop] = value; return true; },
    });
    return ctx;
  };
  globalThis.document = {
    createElement: () => {
      const canvas = { width: 0, height: 0 };
      const ctx = makeCtx(canvas);
      canvas.getContext = () => ctx;
      canvas.ctx = ctx;
      created.push(canvas);
      return canvas;
    },
  };
  return created;
}

const SPEC = {
  w: 280, h: 44, dpr: 2, bw: 1, quiet: false, seed: 7, origin: { x: 0, y: 22 },
  restBg: '#0d4a9f', restFg: '#f4f8ff', restBorder: '#f4f8ff', hoverBg: '#f4f8ff', hoverFg: '#0d4a9f', hoverBorder: '#0d4a9f',
  text: 'GET STARTED', font: '500 18px sans-serif', letterSpacing: '0.36px', tx: 140, baseline: 28,
};

test('a frame allocates nothing: the canvases and the mask are made once, per button', () => {
  const created = fakeCanvasEnvironment();
  const renderer = createRenderer({ ...SPEC });
  const target = globalThis.document.createElement('canvas');
  target.width = 560;
  target.height = 88;
  const made = created.length;
  for (const progress of [0.05, 0.2, 0.31, 0.43, 0.55, 0.8, 0.95]) renderer.frame(target, progress);
  assert.equal(created.length, made, 'no canvas is created while it animates');
  renderer.prepare({ x: 100, y: 10 }, 8);
  renderer.frame(target, 0.5);
  assert.equal(created.length, made, 'a new hover only refills the tables');
  delete globalThis.document;
});

test('the first and last frames are exactly the resting and the hover faces, with no glitch in the last', () => {
  const created = fakeCanvasEnvironment();
  const renderer = createRenderer({ ...SPEC });
  const [rest, hover] = created;
  const target = globalThis.document.createElement('canvas');
  target.width = 560;
  target.height = 88;
  renderer.frame(target, 1);
  const last = target.ctx.calls.filter((call) => call[0] === 'drawImage');
  assert.equal(last.length, 1);
  assert.equal(last[0][1], hover, 'the final frame is the hover face and nothing else');
  assert.equal(target.ctx.calls.filter((call) => call[0] === 'clip').length, 0, 'no glitch band on the final frame');
  const first = globalThis.document.createElement('canvas');
  renderer.frame(first, 0);
  assert.equal(first.ctx.calls.filter((call) => call[0] === 'drawImage')[0][1], rest);
  // A mid-run frame inside a glitch window slips bands; one outside does not.
  const plan = renderer.plan;
  const inside = globalThis.document.createElement('canvas');
  renderer.frame(inside, plan[0].at);
  assert.ok(inside.ctx.calls.filter((call) => call[0] === 'clip').length >= 2, 'bands are clipped and displaced');
  const outside = globalThis.document.createElement('canvas');
  renderer.frame(outside, 0.15);
  assert.equal(outside.ctx.calls.filter((call) => call[0] === 'clip').length, 0);
  delete globalThis.document;
});

// ---- guards, pinned in the source ----

test('the module runs one rAF loop with time-based progress, no timers, and tears down', () => {
  assert.equal((moduleSource.match(/requestAnimationFrame\(/g) || []).length >= 2, true);
  assert.doesNotMatch(moduleSource, /setTimeout|setInterval/, 'no timers left running');
  assert.match(moduleSource, /const dt = Math\.min\(64, now - last\);/, 'time-based, capped so a stalled tab does not jump');
  assert.match(moduleSource, /progress \+= \(direction \* dt\) \/ \(direction > 0 \? IN_MS : OUT_MS\);/);
  assert.match(moduleSource, /cancelAnimationFrame\(frame\);\s*frame = 0;/);
  assert.match(moduleSource, /button\.style\.removeProperty\('will-change'\);/, 'will-change only while active');
  assert.match(moduleSource, /canvas\.remove\(\);/);
});

test('it honours reduced motion, forced colours and hover-only, and keyboard focus gets it too', () => {
  assert.match(moduleSource, /const REDUCED = '\(prefers-reduced-motion: reduce\)';/);
  assert.match(moduleSource, /const FORCED = '\(forced-colors: active\)';/);
  assert.match(moduleSource, /const CAN_HOVER = '\(hover: hover\)';/);
  assert.match(moduleSource, /window\.matchMedia\(REDUCED\)\.matches \|\| window\.matchMedia\(FORCED\)\.matches/);
  assert.match(moduleSource, /event\.pointerType === 'touch' \|\| !window\.matchMedia\(CAN_HOVER\)\.matches/);
  assert.match(moduleSource, /!button\.matches\(':focus-visible'\)\) return;/, 'focus-visible only');
  assert.match(moduleSource, /x: rtl \? rect\.width : 0/, 'keyboard focus starts at the inline-start edge, mirrored in RTL');
  assert.match(moduleSource, /direction = -1|run\(-1\)/, 'an interrupted hover reverses from where it is');
});

test('the stylesheet pins the static hover state, the touch, forced-colour and press guards', () => {
  assert.match(css, /\.onboarding :is\([^)]*\.onboarding-welcome-start, \.onboarding-connect-button\):is\(:focus-visible, :hover:not\(:disabled\)\) \{\s*background: var\(--hermes-primary-fg, var\(--hermes-paper\)\);\s*color: var\(--hermes-primary-bg, var\(--hermes-ink\)\);/);
  assert.match(css, /@media \(hover: none\) \{\s*\.onboarding :is\([^)]*\):hover:not\(:focus-visible\)/, 'no sticky hover on touch');
  assert.match(css, /\.dither-hover-canvas \{ position: absolute; z-index: 2; pointer-events: none; image-rendering: pixelated; \}/, 'never blocks input, crisp pixels');
  assert.match(css, /\.onboarding \[data-dither="run"\] \{ color: transparent !important;/);
  assert.match(css, /@media \(forced-colors: active\) \{\s*\.onboarding :is\([^)]*\) \{ background: ButtonFace;[\s\S]*?\.dither-hover-canvas \{ display: none; \}/, 'forced colours: system colours, no effect');
  assert.match(css, /\.onboarding :is\([^)]*\):active \{ transform: translateY\(1px\); transition: none; \}/, 'an instant 1px press');
});

test('the setup wires the effect once, by delegation, to primary and quieter secondary buttons', () => {
  const flow = read('extension/lib/onboarding-flow.mjs');
  assert.match(flow, /import \{ installDitherHover \} from '\.\/dither-hover\.mjs';/);
  assert.match(flow, /installDitherHover\(host, \{\s*selector: '\.onboarding-welcome-start, \.onboarding-connect-button, \.onboarding-welcome-skip, \[data-onboarding-manual\], \.onboarding-skip, \.onboarding-nav-button',\s*quietSelector: '\.onboarding-welcome-skip, \[data-onboarding-manual\], \.onboarding-skip, \.onboarding-nav-button',/);
});

test('the module is syntax-checked with the rest of the extension', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts['check:js'].includes('node --check extension/lib/dither-hover.mjs'));
});
