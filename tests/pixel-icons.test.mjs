import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { CODE_COPIED_ICON, CODE_COPY_ICON } from '../extension/lib/markdown-code-copy.mjs';
import { SUBAGENT_STEER_ICON } from '../extension/lib/subagent-stack.mjs';

// UI icons come from pixelarticons 2.4.2, the set hermes-agent.nousresearch.com
// uses. The vendored SVGs are the source of truth for every inlined copy.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const PIXEL_DIR = 'extension/assets/icons/pixel';
const innerOf = (svg) => svg.trim().replace(/^<svg[^>]*>|<\/svg>$/g, '').replace(/>\s+</g, '><').trim();
const svgsIn = (source) => source.match(/<svg\b[\s\S]*?<\/svg>/g) || [];

const vendored = new Map(readdirSync(new URL(`../${PIXEL_DIR}`, import.meta.url))
  .filter((name) => name.endsWith('.svg'))
  .map((name) => [innerOf(read(`${PIXEL_DIR}/${name}`)), name.replace(/\.svg$/, '')]));

// Wordmarks (role="img") are brand art, not UI icons.
const PAGES = ['extension/sidepanel.html', 'extension/app.html', 'extension/voice-dictation.html'];
const pageIcons = PAGES
  .flatMap((path) => svgsIn(read(path)).filter((svg) => !/^<svg[^>]*\brole="img"/.test(svg)).map((svg) => [path, svg]));
const scriptIcons = [
  ...[...read('extension/sidepanel.js').matchAll(/innerHTML = '(<svg[^']*<\/svg>)'/g)].map((match) => ['extension/sidepanel.js', match[1]]),
  ['SUBAGENT_STEER_ICON', SUBAGENT_STEER_ICON],
  ['CODE_COPY_ICON', CODE_COPY_ICON],
  ['CODE_COPIED_ICON', CODE_COPIED_ICON],
];
const allIcons = [...pageIcons, ...scriptIcons];

test('pixelarticons ship vendored with their MIT license', () => {
  const license = read(`${PIXEL_DIR}/pixelarticons-2.4.2.LICENSE`);
  assert.match(license, /MIT License/);
  assert.match(license, /Gerrit Halfmann/);
  assert.ok(vendored.size > 0, 'vendored icon set must not be empty');
});

test('every UI icon is an unmodified 16px fill-based pixelarticons glyph named by data-icon', () => {
  assert.ok(pageIcons.length >= 50, `expected the panel, web and voice icons, found ${pageIcons.length}`);
  assert.equal(scriptIcons.length, 5, 'group settings, presence warning, steer, copy and copied icons');
  for (const [where, svg] of allIcons) {
    const head = svg.match(/^<svg[^>]*>/)[0];
    for (const attribute of ['viewBox="0 0 24 24"', 'width="16"', 'height="16"', 'fill="currentColor"', 'aria-hidden="true"']) {
      assert.ok(head.includes(attribute), `${where}: ${head} is missing ${attribute}`);
    }
    assert.doesNotMatch(svg, /stroke/, `${where}: pixel icons are filled, never stroked`);
    assert.ok(vendored.has(innerOf(svg)), `${where}: ${head} must match a vendored pixelarticons SVG`);
    assert.equal(head.match(/\bdata-icon="([^"]+)"/)?.[1], vendored.get(innerOf(svg)), `${where}: data-icon must name the vendored glyph`);
  }
});

test('pixel icons snap to device pixels on every surface that shows them', () => {
  const css = read('extension/lib/pixel-icons.css');
  assert.match(css, /svg\[data-icon\]\s*\{\s*shape-rendering:\s*crispEdges;\s*\}/);
  for (const page of PAGES) assert.match(read(page), /<link rel="stylesheet" href="lib\/pixel-icons\.css" \/>/, `${page} must load the pixel icon styles`);
  const glyphs = new Set(vendored.values());
  for (const [, name] of css.matchAll(/data-icon="([^"]+)"/g)) assert.ok(glyphs.has(name), `pixel-icons.css tunes unknown glyph ${name}`);
});

test('every vendored pixel icon is in use', () => {
  const used = new Set(allIcons.map(([, svg]) => vendored.get(innerOf(svg))));
  for (const name of vendored.values()) assert.ok(used.has(name), `${name}.svg is vendored but unused`);
});
