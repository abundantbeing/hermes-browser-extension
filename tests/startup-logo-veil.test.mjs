import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BAYER_8,
  LOGO_VEIL_OPTIONS,
  VEIL_CRISP,
  VEIL_GAP,
  VEIL_INK,
  VEIL_RIM,
  bayerThreshold,
  createLogoVeil,
  stampTrail,
  veilCell,
} from '../extension/lib/startup-logo-veil.mjs';

const grid = (fn) => {
  const out = [];
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) out.push(fn(x, y));
  return out;
};

test('the 8x8 Bayer matrix holds every level once and thresholds sit inside 0-1', () => {
  assert.deepEqual([...BAYER_8].sort((a, b) => a - b), Array.from({ length: 64 }, (_, i) => i));
  const thresholds = grid(bayerThreshold);
  assert.ok(thresholds.every((t) => t > 0 && t < 1));
  assert.equal(bayerThreshold(8, 8), bayerThreshold(0, 0));
});

test('a full veil dithers solid logo to the tone and leaves empty cells clear', () => {
  const ink = grid((x, y) => veilCell({ veil: 1, heat: 0, coverage: 1, threshold: bayerThreshold(x, y), tone: 0.5 }));
  assert.equal(ink.filter((k) => k === VEIL_INK).length, 32);
  assert.equal(ink.filter((k) => k === VEIL_GAP).length, 32);
  const empty = grid((x, y) => veilCell({ veil: 1, heat: 0, coverage: 0, threshold: bayerThreshold(x, y) }));
  assert.ok(empty.every((k) => k === VEIL_GAP));
});

test('no veil or a fully burnt cell shows the crisp logo', () => {
  const off = grid((x, y) => veilCell({ veil: 0, heat: 0, coverage: 1, threshold: bayerThreshold(x, y) }));
  const burnt = grid((x, y) => veilCell({ veil: 1, heat: 1, coverage: 1, threshold: bayerThreshold(x, y) }));
  assert.ok(off.every((k) => k === VEIL_CRISP));
  assert.ok(burnt.every((k) => k === VEIL_CRISP));
});

test('a half-burnt edge dissolves through the dither and only rims where it burns', () => {
  const edge = grid((x, y) => veilCell({ veil: 1, heat: 0.5, coverage: 1, threshold: bayerThreshold(x, y) }));
  const crisp = edge.filter((k) => k === VEIL_CRISP).length;
  assert.ok(crisp > 24 && crisp < 40, `crisp cells ${crisp}`);
  assert.ok(edge.includes(VEIL_RIM));
  const cold = grid((x, y) => veilCell({ veil: 0.5, heat: 0, coverage: 1, threshold: bayerThreshold(x, y) }));
  assert.ok(!cold.includes(VEIL_RIM));
  const noRim = grid((x, y) => veilCell({ veil: 1, heat: 0.5, coverage: 1, threshold: bayerThreshold(x, y), rim: 0 }));
  assert.ok(!noRim.includes(VEIL_RIM));
});

test('the trail burns a soft-edged hole along the whole swipe', () => {
  const cols = 40;
  const rows = 20;
  const heat = new Float32Array(cols * rows);
  stampTrail(heat, cols, rows, { x: 5, y: 10 }, { x: 35, y: 10 }, 6, LOGO_VEIL_OPTIONS.softness);
  const at = (x, y) => heat[y * cols + x];
  for (let x = 5; x <= 34; x += 1) assert.ok(at(x, 10) > 0.95, `gap in the trail at ${x}`);
  assert.equal(at(20, 1), 0);
  const edge = at(20, 15);
  assert.ok(edge > 0 && edge < 1, `soft edge ${edge}`);
  // Stamping never cools a cell that is already burning.
  heat.fill(1);
  stampTrail(heat, cols, rows, { x: 20, y: 10 }, { x: 20, y: 10 }, 6, 0.6);
  assert.ok(heat.every((v) => v === 1));
});

test('the veil is inert without a logo and the startup screen wires and rests it', () => {
  assert.doesNotThrow(() => createLogoVeil(null).rest());
  const screen = readFileSync(new URL('../extension/lib/startup-screen.mjs', import.meta.url), 'utf8');
  assert.match(screen, /import \{ createLogoVeil \} from '\.\/startup-logo-veil\.mjs'/);
  assert.match(screen, /createLogoVeil\(root\.querySelector\('\.startup-brand-icon'\)\)/);
  assert.match(screen, /if \(!view\?\.visible\) veil\.rest\(\);/);
  const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
  assert.match(css, /\.startup-logo-veil\s*\{[^}]*pointer-events:\s*none;[^}]*image-rendering:\s*pixelated;/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.startup-screen::before,[^@]*?\.startup-logo-veil \{ display: none; \}/);
  const veil = readFileSync(new URL('../extension/lib/startup-logo-veil.mjs', import.meta.url), 'utf8');
  assert.match(veil, /prefers-reduced-motion: reduce/);
});
