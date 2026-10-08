import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync('extension/lib/effort-control.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const DARK = 'html[data-hermes-theme="anti-nous"][data-hermes-mode="dark"]';
const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].includes(DARK));

// Anti-Nous dark must read red, not pink: the generic effort colour mixes accent
// into cream ink and the theme accent still reads coral on navy, so every slider
// element uses a true red and none of these rules may mix in the cream ink.
test('Anti-Nous dark effort slider is a true red with no cream ink mixed in', () => {
  const root = blocks.find((m) => /\.effort-control\s*$/.test(m[1].trim()))?.[2] || '';
  assert.match(root, /--effort-red:\s*#ff[0-3][0-9a-f]{3}/i, 'pure red token');
  assert.match(root, /--effort-color:\s*var\(--effort-red\)/);
  assert.match(root, /--effort-thumb:\s*var\(--effort-red\)/);
  assert.ok(blocks.length >= 8, 'fill, charge streaks, flare, lane, sparks, stops and thumb are all recoloured');
  for (const [, selector, body] of blocks) assert.doesNotMatch(body, /--effort-ink|--hermes-ink/, `${selector.trim()} must not mix cream ink`);
});
